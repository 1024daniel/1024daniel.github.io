"""Generate a two-column SVG explaining Houmo input naming and runtime I/O."""

from html import escape
from pathlib import Path
import xml.etree.ElementTree as ET


TASK = Path(__file__).resolve().parents[1]
WORKSPACE = TASK.parents[1]
assert TASK.is_relative_to(WORKSPACE / "ai")
ASSETS = (TASK / "assets").resolve()
assert ASSETS.is_relative_to(TASK)
ASSETS.mkdir(exist_ok=True)
OUT = ASSETS / "input-name-contract.svg"
assert OUT.resolve().is_relative_to(TASK)

parts = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1480" viewBox="0 0 1800 1480" role="img" aria-labelledby="title description">
<title id="title">Houmo 输入命名约定：左侧导出前转换，右侧 TCIM 加载后的查询、绑定和写入</title>
<desc id="description">导出代码构造语义名称，经兼容函数改名后交给 HMONNX 导出器，TCIM 编译产生最终 HMM 输入接口。推理端加载后按编号查询名称、按名称查询规格、获取设备 KV 并绑定 prefill，再写入长度并执行。输入名称列表与设备缓存存储分开。</desc>
<defs>
  <marker id="arrow-blue" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 Z" fill="#3b69a7"/></marker>
  <marker id="arrow-green" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 Z" fill="#27816a"/></marker>
  <marker id="arrow-amber" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L12,6 L0,12 Z" fill="#b97819"/></marker>
</defs>
<style>
  text { font-family: 'DejaVu Sans', 'Droid Sans Fallback', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif; fill: #243449; }
  .code { font-family: 'DejaVu Sans Mono', 'Droid Sans Fallback', 'Noto Sans CJK SC', monospace; }
</style>
<rect width="1800" height="1480" fill="#f7f9fc"/>
''']


def rect(x, y, w, h, fill, stroke="none", radius=14):
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')


def text(x, y, value, size=23, color="#243449", weight="normal", code=False):
    css_class = ' class="code"' if code else ""
    parts.append(f'<text x="{x}" y="{y}" font-size="{size}" style="fill:{color}" font-weight="{weight}"{css_class}>{escape(value)}</text>')


def card(x, y, h, title, color, border):
    rect(x, y, 772, h, "#ffffff", border)
    rect(x, y, 7, h, color, radius=3)
    text(x + 24, y + 38, title, 26, color, "bold")


def arrow(x, y1, y2, color, marker):
    parts.append(f'<path d="M{x},{y1} V{y2}" fill="none" stroke="{color}" stroke-width="2.5" marker-end="url(#{marker})"/>')


BLUE, GREEN = "#245a9c", "#176f5c"
text(48, 66, "输入命名约定：导出前转换，推理时查询与读写", 36, "#16283e", "bold")
text(48, 108, "同一组输入有三类信息：名称是索引键，TensorInfo 是规格，Tensor 承载数据或设备存储。", 22, "#526478")

rect(40, 144, 820, 1144, "#edf3fc", "#d2e0f3", 20)
rect(940, 144, 820, 1144, "#edf7f3", "#cce7dc", 20)
text(64, 190, "左｜模型准备与导出", 29, BLUE, "bold")
text(964, 190, "右｜加载与推理：以普通插件路径为例", 29, GREEN, "bold")

card(64, 220, 160, "01  先构造模型侧的语义名称", BLUE, "#c7d8ee")
text(88, 292, "名称来自导出代码构造的 Python 列表。")
text(88, 326, "inputs_embeds, past_seq_length, …", 22, code=True)
text(88, 357, "名称与展开后的输入张量按约定顺序对应。", 21, "#526478")

card(64, 408, 264, "02  命名兼容：xh1_hmonnx_compatible", BLUE, "#c7d8ee")
text(88, 478, "inputs_embeds        → input_1", 21, code=True)
text(88, 509, "past_seq_length      → valid_length", 21, code=True)
text(88, 540, "current_input_length → current_length", 21, code=True)
text(88, 571, "past_key_cache_0", 21, code=True)
text(88, 599, "  → model_layers_0_self_attn_kcache_input", 21, code=True)
text(88, 628, "V 同类改名；复制列表、保序、未匹配项原样。", 20, "#526478")
text(88, 655, "规则可复用；此步骤不修改张量内容。", 20, "#526478")

card(64, 700, 180, "03  导出器定义整张图的输入接口", BLUE, "#c7d8ee")
text(88, 777, "convert_quanted_model_to_hmonnx(...)", 21, code=True)
text(88, 814, "input_names  → 图输入的名称", 22, code=True)
text(88, 850, "decode_inputs → 导出时使用的张量", 22, code=True)

card(64, 908, 160, "04  TCIM 编译确定最终接口", BLUE, "#c7d8ee")
text(88, 982, "modify_llm.batch → 请求多 batch 改写", 21, code=True)
text(88, 1014, "具体复制与重排位于外部 builder。", 21, "#526478")
text(88, 1045, "最终输入名称与编号以编译产物为准。", 21, "#526478")

card(64, 1096, 166, "05  HMM 保存编译后的模型接口", BLUE, "#c7d8ee")
text(88, 1172, "包含最终输入声明与模型执行信息。")
text(88, 1208, "独立文件，或 GGUF 内嵌的模型数据段。", 21, "#526478")
text(88, 1240, "接口信息不是请求运行中产生的 KV 数据。", 21, "#526478")

for y1, y2 in [(380, 403), (672, 695), (880, 903), (1068, 1091)]:
    arrow(450, y1, y2, "#3b69a7", "arrow-blue")

card(964, 220, 160, "01  TCIM Runtime 加载编译模型", GREEN, "#c1dfd2")
text(988, 292, "prefill = tcim.runtime.load(prefill_path, option1)", 21, code=True)
text(988, 325, "decode = tcim.runtime.load(decode_path, option2)", 21, code=True)
text(988, 357, "prefill 的 KV 设为 dummy；加载后缓存接口元信息。", 20, "#526478")

card(964, 408, 220, "02  查询名称与规格：尚未读取 KV 内容", GREEN, "#c1dfd2")
text(988, 481, "name = decode.get_input_name(i)", 22, code=True)
text(988, 514, "编号 → 名称字符串；查询的是 C++ Module。", 21, "#526478")
text(988, 550, "info = decode.get_input_info(name)", 22, code=True)
text(988, 583, "名称 → shape / dtype / format 等输入描述。", 21, "#526478")
text(988, 612, "核对最终输入表；索引连续不代表物理地址连续。", 20, "#526478")

card(964, 656, 302, "03  获取并绑定设备 KV：传递 Tensor 对象", GREEN, "#c1dfd2")
text(988, 734, "k_name = decode.get_input_name(i)", 21, code=True)
text(988, 769, "p_name = prefill.get_input_name(j)", 21, code=True)
text(988, 804, "kv = decode.get_dev_input(k_name)", 21, code=True)
text(988, 839, "prefill.set_input(p_name, kv)", 21, code=True)
text(988, 878, "普通插件：将 decode 的设备 KV 绑定给 prefill。", 20, "#526478")
text(988, 909, "另有 set_dev_input(name, tensor) 显式设备接口。", 20, "#526478")
text(988, 939, "需匹配目标规格与设备；dummy 输入须在执行前绑定。", 20, "#526478")

card(964, 986, 150, "04  写入长度：向已有输入提供数据", GREEN, "#c1dfd2")
text(988, 1058, "prefill.set_input(valid_name, valid_array)", 21, code=True)
text(988, 1093, "prefill.set_input(current_name, current_array)", 21, code=True)
text(988, 1121, "主机数组按输入描述包装，再交给 runtime。", 20, "#526478")

card(964, 1164, 98, "05  执行模型，读写已绑定的缓存", GREEN, "#c1dfd2")
text(988, 1238, "prefill.run() / prefill.sync()", 22, code=True)
for y1, y2 in [(380, 403), (628, 651), (958, 981), (1136, 1159)]:
    arrow(1350, y1, y2, "#27816a", "arrow-green")

parts.append('<path d="M836,1178 H900 V296 H956" fill="none" stroke="#b97819" stroke-width="3" stroke-dasharray="8 6" marker-end="url(#arrow-amber)"/>')
parts.append('<text x="929" y="842" font-size="18" style="fill:#996317" transform="rotate(-90 929 842)">编译产物传递到加载端</text>')

rect(40, 1310, 1720, 134, "#ffffff", "#d7dfe9", 16)
text(64, 1348, "接口约定：左侧统一名称；右侧按最终名称和规格提供数据。直接改名也可行，但需同步所有消费者。", 22, "#243449", "bold")
text(64, 1384, "设备 Tensor 按接口契约可复用已有存储；绑定不等于清零或执行。后续 decode 使用对应槽位缓存继续推理。", 20, "#526478")
text(64, 1419, "依据：模型导出代码、Houmo model_runner、TCIM runtime 1.4.0 接口；图内变量为语义示例，未执行设备推理。", 18, "#526478")
text(48, 1466, "Houmo KVSpec 深入分析 · 图 8 · 2026-10-18", 16, "#6b7b8e")

parts.append("</svg>")
svg = "\n".join(parts) + "\n"
ET.fromstring(svg)
OUT.write_text(svg)
print(OUT)
