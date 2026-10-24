#!/usr/bin/env python3
"""Generate client profiles from claude.yaml; never connect to a subscription."""

import argparse
import copy
import ipaddress
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit

try:
    import yaml
except ImportError:
    sys.exit("缺少 PyYAML；请运行 python3 -m pip install -r requirements.txt")


CLIENT_FILES = {
    "verge": "clash_verge_claude.yaml",
    "cmfa": "clash_meta_for_android_claude.yaml",
    "openclash": "openclash_claude.yaml",
}
IPV6_GUARD = "AND,((RULE-SET,claude-domains),(IP-CIDR6,::/0,no-resolve)),REJECT"
PROCESS_RULES = ("RULE-SET,claude-processes,Claude", "RULE-SET,claude-processes,REJECT")
HEADER = "# 自动生成，请编辑 claude.yaml 后运行 generate_claude_configs.py；不要手改此文件。\n"
OPENCLASH_GENERAL_KEYS = set("""
CORE_TYPE EN_MODE PROXY_MODE MIXED_PORT ENABLE_UDP_PROXY DISABLE_UDP_QUIC
ROUTER_SELF_PROXY ENABLE_REDIRECT_DNS CHINA_IP_ROUTE CHINA_IP6_ROUTE COMMON_PORTS
ENABLE_RULE_PROXY IPV6_ENABLE IPV6_DNS IPV6_MODE AUTO_SMART_SWITCH FIND_PROCESS_MODE
ENABLE_CUSTOM_DNS CUSTOM_NAME_POLICY CUSTOM_FALLBACK_FILTER CUSTOM_FAKEIP_FILTER
APPEND_WAN_DNS APPEND_DEFAULT_DNS ENABLE_RESPECT_RULES ENABLE_CUSTOM_CLASH_RULES
ENABLE_META_SNIFFER ENABLE_META_SNIFFER_CUSTOM ENABLE_META_SNIFFER_PURE_IP
ENABLE_TCP_CONCURRENT ENABLE_UNIFIED_DELAY GITHUB_ADDRESS_MOD URLTEST_ADDRESS_MOD
URLTEST_INTERVAL_MOD TOLERANCE
""".split())


class ConfigError(ValueError):
    pass


class UniqueLoader(yaml.SafeLoader):
    """Reject duplicate keys instead of silently discarding a policy."""

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise ConfigError("统一源不支持 YAML 别名；请使用 common 与 clients 分层配置")
        return super().compose_node(parent, index)


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            raise ConfigError("YAML 配置键必须是字符串")
        if key in result:
            raise ConfigError(f"YAML 第 {key_node.start_mark.line + 1} 行存在重复键")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def load_source(path):
    try:
        source = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueLoader)
    except yaml.YAMLError as error:
        # Parser diagnostics can contain the user's subscription token.
        mark = getattr(error, "problem_mark", None)
        location = f"（第 {mark.line + 1} 行，第 {mark.column + 1} 列）" if mark else ""
        raise ConfigError(f"源 YAML 格式错误{location}；未输出可能含凭据的原文") from None
    if not isinstance(source, dict) or type(source.get("schema-version")) is not int or source.get("schema-version") != 1:
        raise ConfigError("源配置需要 schema-version: 1")
    if set(source) != {"schema-version", "common", "clients", "local-services"}:
        raise ConfigError("源配置只允许 schema-version/common/clients/local-services")
    if not isinstance(source["common"], dict):
        raise ConfigError("common 必须是配置映射")
    clients = source["clients"]
    if not isinstance(clients, dict) or set(clients) != set(CLIENT_FILES):
        raise ConfigError("clients 必须包含 verge、cmfa、openclash")
    for name, client in clients.items():
        allowed = {"config", "process-rules", "general"} if name == "openclash" else {"config", "process-rules"}
        if not isinstance(client, dict) or set(client) != allowed:
            raise ConfigError(f"clients.{name} 的字段不符合源配置格式")
        if not isinstance(client["config"], dict) or type(client["process-rules"]) is not bool:
            raise ConfigError(f"clients.{name} 需要 config 映射与 process-rules 布尔值")
    return source


def merge(base, patch):
    """Mappings merge recursively; scalars and arrays replace as a whole."""
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def local_services(source):
    services = source["local-services"]
    if not isinstance(services, dict) or set(services) != {"domains", "ipv6-prefixes"}:
        raise ConfigError("local-services 需要 domains 与 ipv6-prefixes 两个列表")
    domains, prefixes = [], []
    for key in ("domains", "ipv6-prefixes"):
        if not isinstance(services[key], list) or any(not isinstance(v, str) for v in services[key]):
            raise ConfigError(f"local-services.{key} 必须是字符串列表")
    for value in services["domains"]:
        domain = value.rstrip(".").lower()
        if len(domain) > 253 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in domain.split(".")
        ):
            raise ConfigError("local-services.domains 仅接受完整域名，不接受 URL、通配符或规则文本")
        claude_domains = source["common"].get("rule-providers", {}).get("claude-domains", {}).get("payload", [])
        if any(domain == d.removeprefix("+.") or domain.endswith("." + d.removeprefix("+.")) for d in claude_domains):
            raise ConfigError("local-services.domains 不能将 Claude 域名设为直连")
        if domain not in domains:
            domains.append(domain)
    for value in services["ipv6-prefixes"]:
        try:
            network = ipaddress.IPv6Network(value, strict=True)
        except ValueError:
            raise ConfigError("local-services.ipv6-prefixes 必须是合法且不含主机位的 IPv6 网络前缀") from None
        if network.prefixlen == 0:
            raise ConfigError("禁止使用 ::/0 绕过所有 IPv6")
        # 固定 IPv4-mapped IPv6 的点分形式，保持跨 Python 版本产物一致。
        mapped = network.network_address.ipv4_mapped
        prefix = f"::ffff:{mapped}/{network.prefixlen}" if mapped is not None else str(network)
        if prefix not in prefixes:
            prefixes.append(prefix)
    rules = [f"DOMAIN,{v},DIRECT" for v in domains]
    rules.extend(f"IP-CIDR6,{v},DIRECT,no-resolve" for v in prefixes)
    return rules, prefixes


def validate_config(config, name):
    for key in ("dns", "sniffer", "proxy-providers", "rule-providers"):
        if not isinstance(config.get(key), dict):
            raise ConfigError(f"{name}: {key} 必须是映射")
    for key in ("proxy-providers", "rule-providers"):
        if any(not isinstance(value, dict) for value in config[key].values()):
            raise ConfigError(f"{name}: {key} 中每个 provider 必须是映射")
    for key in ("claude-domains", "claude-processes"):
        provider = config["rule-providers"].get(key)
        if not isinstance(provider, dict) or not isinstance(provider.get("payload"), list) or any(
            not isinstance(value, str) for value in provider["payload"]
        ):
            raise ConfigError(f"{name}: rule-providers.{key} 需要字符串 payload 列表")
    groups = config.get("proxy-groups")
    if not isinstance(groups, list) or any(not isinstance(group, dict) or not isinstance(group.get("name"), str) for group in groups):
        raise ConfigError(f"{name}: proxy-groups 必须是具名策略组列表")
    names = [group["name"] for group in groups]
    if len(names) != len(set(names)) or not {"Claude", "自动选择", "节点选择"}.issubset(names):
        raise ConfigError(f"{name}: 需要三个无重名的 Claude/自动选择/节点选择策略组")
    if config.get("mixed-port") != 7893 or config.get("mode") != "rule":
        raise ConfigError(f"{name}: 当前示例要求 mixed-port: 7893 与 mode: rule")
    if config.get("ipv6") is not True or config.get("dns", {}).get("ipv6") is not True:
        raise ConfigError(f"{name}: 必须保留全局和 DNS 的 IPv6")
    rules = config.get("rules")
    if not isinstance(rules, list) or not rules or any(not isinstance(rule, str) for rule in rules) or rules[0] != IPV6_GUARD or rules[-1] != "MATCH,REJECT":
        raise ConfigError(f"{name}: 必须保留首条 Claude IPv6 限制与末尾拒绝兜底")
    providers = config.get("proxy-providers", {})
    for provider in providers.values():
        if provider.get("type") == "http":
            try:
                url = urlsplit(provider.get("url", ""))
                valid = url.scheme in ("http", "https") and bool(url.hostname)
            except (TypeError, ValueError):
                valid = False
            if not valid:
                raise ConfigError(f"{name}: 节点订阅需要合法 HTTP(S) 地址")
            # 未指定下载出口时，Mihomo 会按规则路由订阅请求，可能命中空组的 REJECT。
            proxy = provider.get("proxy")
            if not isinstance(proxy, str) or not proxy.strip():
                raise ConfigError(f"{name}: HTTP 节点订阅必须显式设置 proxy（本示例使用 DIRECT），避免首次下载依赖空策略组")


def build_config(source, name):
    client = source["clients"][name]
    config = merge(source["common"], client["config"])
    validate_config(config, name)
    if name == "openclash":
        if client["process-rules"]:
            raise ConfigError("openclash: 网关配置必须关闭终端进程规则")
        validate_openclash_general(client["general"])
    if not client["process-rules"]:
        config["rule-providers"].pop("claude-processes", None)
        config["rules"] = [rule for rule in config["rules"] if rule not in PROCESS_RULES]
        config["find-process-mode"] = "off"
    direct_rules, _ = local_services(source)
    config["rules"][1:1] = direct_rules
    return config


def validate_openclash_general(general):
    if not isinstance(general, dict) or any(
        k not in OPENCLASH_GENERAL_KEYS or not isinstance(v, str) or any(c in v for c in "\r\n\0")
        for k, v in general.items()
    ):
        raise ConfigError("clients.openclash.general 仅接受本示例支持的原生 General 键及单行字符串值")
    for key, expected in {"MIXED_PORT": "7893", "PROXY_MODE": "rule", "IPV6_ENABLE": "1", "IPV6_DNS": "1", "FIND_PROCESS_MODE": "off"}.items():
        if general.get(key) != expected:
            raise ConfigError(f"clients.openclash.general.{key} 与公共配置不一致")


def dump_yaml(value):
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=120)


def generate(source, platforms):
    outputs = {}
    for name in platforms:
        config = build_config(source, name)
        description = {
            "verge": "# Clash Verge：导入本地配置，确认 TUN/IPv6 开启且 DNS 覆写关闭。\n",
            "cmfa": "# CMFA：导入本地配置；VPN 授权及网络 IPv6/访问控制仍需客户端设置。\n",
            "openclash": "# OpenClash：导入此完整配置，并启用同次生成、仅关联此配置的原生 .conf 模块。\n",
        }[name]
        config_text = HEADER + description + "# 需要 Mihomo v1.19.19+；机场仅供应节点。\n" + dump_yaml(config)
        outputs[CLIENT_FILES[name]] = config_text
        if name == "openclash":
            # 原生模块补齐客户端运行参数；不执行自定义部署代码。
            general = "\n".join(f"{key}={value}" for key, value in source["clients"][name]["general"].items())
            patch = {
                "sniffer!": config["sniffer"],
                "dns": {
                    "proxy-server-nameserver-policy!": config["dns"].get("proxy-server-nameserver-policy", {}),
                },
            }
            outputs["openclash_claude.conf"] = (
                HEADER + "# OpenClash 原生兼容模块，仅关联 openclash_claude.yaml 后启用。\n"
                + "# General 覆盖当前运行参数；YAML 恢复共同嗅探和节点 DNS 策略，保留插件 DNS 监听。\n"
                + "[General]\n" + general + "\n\n[YAML]\n" + dump_yaml(patch)
            )
    return outputs


def main(argv=None):
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=directory / "claude.yaml", help="唯一源 YAML，默认脚本旁 claude.yaml")
    parser.add_argument("--platform", choices=["all", *CLIENT_FILES], default="all")
    parser.add_argument("--output-dir", type=Path, default=directory, help="产物目录，默认脚本所在目录")
    parser.add_argument("--check", action="store_true", help="只检查生成产物是否与源一致，不写文件")
    args = parser.parse_args(argv)
    try:
        source = load_source(args.source)
        platforms = list(CLIENT_FILES) if args.platform == "all" else [args.platform]
        outputs = generate(source, platforms)
        # Reject all source/output collisions before touching any output file.
        if any((args.output_dir / name).resolve() == args.source.resolve() for name in outputs):
            raise ConfigError("输出文件不能覆盖源配置")
        if args.check:
            stale = [name for name, value in outputs.items() if not (args.output_dir / name).exists() or (args.output_dir / name).read_text(encoding="utf-8") != value]
            if stale:
                for name in stale:
                    print(f"需要重新生成：{args.output_dir / name}", file=sys.stderr)
                return 1
            print(f"检查通过：{len(outputs)} 个产物与源配置一致")
            return 0
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for name, value in outputs.items():
            target = args.output_dir / name
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=args.output_dir, delete=False) as handle:
                    temporary = Path(handle.name)
                    handle.write(value)
                os.replace(temporary, target)
            finally:
                if temporary and temporary.exists():
                    temporary.unlink()
            print(f"已生成：{target}")
        return 0
    except (ConfigError, OSError) as error:
        print(f"生成失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
