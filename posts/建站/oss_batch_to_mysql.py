"""将 OSS 对象的图片信息同步到 MySQL。

运行前需通过环境变量提供 OSS 和 MySQL 凭据，不要将凭据写入源码。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import TypedDict

import oss2
import piexif
import pymysql
from PIL import Image, ImageEnhance, ImageOps, ImageStat


OSS_ENDPOINT = os.getenv("OSS_ENDPOINT", "oss-cn-hangzhou.aliyuncs.com")
BUCKET_NAME = os.getenv("OSS_BUCKET_NAME", "1024daniel")
BATCH_SIZE = 100
ENABLE_GPS_OCR = os.getenv("ENABLE_GPS_OCR", "0") == "1"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIRECTORY = PROJECT_ROOT / "static" / "data"
PHOTO_TABLE = os.getenv("MYSQL_PHOTO_TABLE", "photos")

if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", PHOTO_TABLE):
    raise RuntimeError("MYSQL_PHOTO_TABLE 只能包含字母、数字和下划线")


class ImageInfo(TypedDict):
    width: int | None
    height: int | None
    capture_time: datetime | None
    latitude: float | None
    longitude: float | None
    camera_make: str | None
    camera_model: str | None


MYSQL_CONFIG = {
    "host": os.getenv("MYSQL_HOST", "rm-bp1d50kgabwb7m6e3.rwlb.rds.aliyuncs.com"),
    "port": int(os.getenv("MYSQL_PORT", "3306")),
    "user": os.getenv("MYSQL_USER"),
    "password": os.getenv("MYSQL_PASSWORD"),
    "database": os.getenv("MYSQL_DATABASE", "album"),
    "charset": "utf8mb4",
}


def required_env(name):
    """读取必填环境变量，并在连接外部服务前给出明确错误。"""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"缺少必填环境变量: {name}")
    return value


def rational_to_float(value):
    """将 EXIF 有理数转为 float，同时兼容 piexif 的 tuple 表示。"""
    if isinstance(value, tuple):
        numerator, denominator = value
        if denominator == 0:
            raise ValueError("EXIF 有理数的分母为 0")
        return numerator / denominator
    return float(value)


def gps_to_decimal(coordinates, reference):
    degrees, minutes, seconds = (rational_to_float(item) for item in coordinates)
    decimal = degrees + minutes / 60 + seconds / 3600
    ref = reference.decode(errors="ignore") if isinstance(reference, bytes) else reference
    return -decimal if ref in {"S", "W"} else decimal


def parse_gps_coordinate(coordinates, reference, axis, source):
    """单独解析一个 GPS 坐标，避免纬度损坏时同时丢失经度。"""
    if not coordinates or not reference:
        return None

    # 小米会在未记录定位时保留 GPS IFD，但把坐标写成
    # ((0, 0), (0, 0), (0, 0))，方向写成 NUL。这是空占位而非坐标。
    ref = (
        reference.decode(errors="ignore")
        if isinstance(reference, bytes)
        else str(reference)
    ).strip("\x00 ")
    if not ref or all(
        isinstance(item, tuple) and len(item) == 2 and item == (0, 0)
        for item in coordinates
    ):
        return None

    try:
        value = gps_to_decimal(coordinates, ref)
        limit = 90 if axis == "latitude" else 180
        if not 0 <= abs(value) <= limit:
            raise ValueError(f"坐标超出范围: {value}")
        return value
    except (ValueError, TypeError, ZeroDivisionError) as exc:
        print(
            f"GPS {axis} 解析失败: {source}: {exc}; "
            f"raw={coordinates!r}, ref={reference!r}"
        )
        return None


WATERMARK_GPS_PATTERN = re.compile(
    r"(\d{1,2})\s*(?:°|[oO])\s*(\d{1,2})\s*['′]\s*"
    r"(\d{1,2}(?:\.\d+)?)\s*(?:[\"″])?\s*([NS])"
    r"[^\d]{1,30}"
    r"(\d{1,3})\s*(?:°|[oO])\s*(\d{1,2})\s*['′]\s*"
    r"(\d{1,2}(?:\.\d+)?)\s*(?:[\"″])?\s*([EW])",
    re.IGNORECASE,
)


def parse_watermark_gps_text(text):
    """从小米徕卡水印文本中读取 DMS 坐标。"""
    normalized = " ".join(text.replace("\n", " ").split())
    match = WATERMARK_GPS_PATTERN.search(normalized)
    if not match:
        return None

    lat_d, lat_m, lat_s, lat_ref, lon_d, lon_m, lon_s, lon_ref = match.groups()
    latitude = float(lat_d) + float(lat_m) / 60 + float(lat_s) / 3600
    longitude = float(lon_d) + float(lon_m) / 60 + float(lon_s) / 3600
    if lat_ref.upper() == "S":
        latitude = -latitude
    if lon_ref.upper() == "W":
        longitude = -longitude
    if abs(latitude) > 90 or abs(longitude) > 180:
        return None
    return latitude, longitude


def extract_xiaomi_watermark_gps(data, source):
    """标准 EXIF GPS 损坏时，从小米徕卡水印像素中 OCR 读取坐标。"""
    if not shutil.which("tesseract"):
        return None

    try:
        with Image.open(BytesIO(data)) as image:
            # 徕卡相框的拍摄参数与坐标位于底部白色区域。
            top = int(image.height * 0.74)
            watermark = image.crop((0, top, image.width, image.height)).convert("L")
            if ImageStat.Stat(watermark).mean[0] < 160:
                return None
            watermark = ImageOps.autocontrast(watermark)
            watermark = ImageEnhance.Contrast(watermark).enhance(2.0)
            watermark = watermark.resize(
                (watermark.width * 2, watermark.height * 2), Image.Resampling.LANCZOS
            )
            buffer = BytesIO()
            watermark.save(buffer, format="PNG")

        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "--psm", "6", "-l", "eng"],
            input=buffer.getvalue(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=15,
        )
        coordinates = parse_watermark_gps_text(result.stdout.decode(errors="ignore"))
        if coordinates:
            print(
                f"GPS 已从小米徕卡水印恢复: {source}: "
                f"{coordinates[0]:.7f}, {coordinates[1]:.7f}"
            )
        return coordinates
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def parse_image_info(data: bytes, source: str = "<unknown>") -> ImageInfo:
    info: ImageInfo = {
        "width": None,
        "height": None,
        "capture_time": None,
        "latitude": None,
        "longitude": None,
        "camera_make": None,
        "camera_model": None,
    }

    try:
        with Image.open(BytesIO(data)) as image:
            info["width"], info["height"] = image.size
            exif_bytes = image.info.get("exif")

        if exif_bytes:
            exif_data = piexif.load(exif_bytes)
            date_time = exif_data["Exif"].get(piexif.ExifIFD.DateTimeOriginal)
            if date_time:
                info["capture_time"] = datetime.strptime(
                    date_time.decode(errors="ignore"), "%Y:%m:%d %H:%M:%S"
                )

            make = exif_data["0th"].get(piexif.ImageIFD.Make)
            model = exif_data["0th"].get(piexif.ImageIFD.Model)
            if make:
                info["camera_make"] = make.decode(errors="ignore").strip("\x00 ")
            if model:
                info["camera_model"] = model.decode(errors="ignore").strip("\x00 ")

            gps = exif_data.get("GPS", {})
            info["latitude"] = parse_gps_coordinate(
                gps.get(piexif.GPSIFD.GPSLatitude),
                gps.get(piexif.GPSIFD.GPSLatitudeRef),
                "latitude",
                source,
            )
            info["longitude"] = parse_gps_coordinate(
                gps.get(piexif.GPSIFD.GPSLongitude),
                gps.get(piexif.GPSIFD.GPSLongitudeRef),
                "longitude",
                source,
            )
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError) as exc:
        print(f"EXIF 解析失败: {exc}")

    if ENABLE_GPS_OCR and (
        info["latitude"] is None or info["longitude"] is None
    ):
        watermark_gps = extract_xiaomi_watermark_gps(data, source)
        if watermark_gps:
            info["latitude"], info["longitude"] = watermark_gps

    return info


def insert_photo(conn, info):
    sql = f"""
        INSERT INTO `{PHOTO_TABLE}` (
            oss_key, file_name, file_type, file_size,
            upload_time, capture_time, sort_time,
            width, height, camera_make, camera_model, latitude, longitude,
            metadata
        ) VALUES (
            %(oss_key)s, %(file_name)s, %(file_type)s, %(file_size)s,
            %(upload_time)s, %(capture_time)s, %(sort_time)s,
            %(width)s, %(height)s, %(camera_make)s, %(camera_model)s,
            %(latitude)s, %(longitude)s, %(metadata)s
        )
        ON DUPLICATE KEY UPDATE
            file_name = VALUES(file_name),
            file_type = VALUES(file_type),
            file_size = VALUES(file_size),
            upload_time = VALUES(upload_time),
            capture_time = VALUES(capture_time),
            sort_time = VALUES(sort_time),
            width = VALUES(width),
            height = VALUES(height),
            camera_make = VALUES(camera_make),
            camera_model = VALUES(camera_model),
            latitude = VALUES(latitude),
            longitude = VALUES(longitude),
            metadata = JSON_SET(
                COALESCE(metadata, JSON_OBJECT()),
                '$.ossEtag', %(oss_etag)s
            ),
            updated_at = CURRENT_TIMESTAMP
    """
    with conn.cursor() as cursor:
        cursor.execute(sql, info)


def normalize_etag(value):
    """OSS SDK 在不同接口中可能返回带引号的 ETag。"""
    if value is None:
        return None
    normalized = str(value).strip().strip('"')
    return normalized or None


def load_existing_photos(conn, prefix):
    """一次性读取已有对象的轻量指纹，避免循环内逐条查库。"""
    sql = f"""
        SELECT
            oss_key, file_size, upload_time,
            JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.ossEtag')) AS oss_etag
        FROM `{PHOTO_TABLE}`
        WHERE oss_key LIKE %s
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(sql, (f"{prefix}%",))
        rows = cursor.fetchall()
    return {row["oss_key"]: row for row in rows}


def object_is_unchanged(existing, obj, upload_time):
    """优先比较 ETag；老数据没有 ETag 时兼容大小+修改时间。"""
    if existing is None:
        return False

    current_etag = normalize_etag(getattr(obj, "etag", None))
    stored_etag = normalize_etag(existing.get("oss_etag"))
    if current_etag and stored_etag:
        return current_etag == stored_etag

    stored_time = existing.get("upload_time")
    if isinstance(stored_time, datetime):
        stored_time = stored_time.replace(microsecond=0)
    return (
        existing.get("file_size") == obj.size
        and stored_time == upload_time.replace(microsecond=0)
    )


def json_value(value):
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, Decimal):
        return float(value)
    return value


def dataset_name(prefix):
    """将 album/杭州 这类 prefix 映射为 album.json。"""
    name = prefix.strip("/").split("/", 1)[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise RuntimeError(f"无法将 prefix 映射为数据集文件名: {prefix}")
    return name


def normalize_dataset_prefix(prefix):
    normalized = prefix.strip().lstrip("/")
    if not normalized:
        raise RuntimeError("OSS_PREFIX 不能为空")
    if "%" in normalized:
        raise RuntimeError("OSS_PREFIX 不能包含 %")
    return normalized if normalized.endswith("/") else f"{normalized}/"


def export_dataset(conn, prefix):
    """以数据库全局顺序生成指定 OSS prefix 的 Hugo 数据集。"""
    normalized_prefix = normalize_dataset_prefix(prefix)
    sql = f"""
        SELECT
            id, oss_key, file_name, file_type, file_size,
            upload_time, capture_time, sort_time,
            width, height
        FROM `{PHOTO_TABLE}`
        WHERE oss_key LIKE %s
          AND LOWER(file_type) IN ('jpg', 'jpeg', 'png', 'gif', 'webp', 'avif')
        ORDER BY sort_time DESC, id DESC
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(sql, (f"{normalized_prefix}%",))
        rows = cursor.fetchall()

    items = []
    for row in rows:
        items.append(
            {
                "id": row["id"],
                "key": row["oss_key"],
                "fileName": row["file_name"],
                "fileType": row["file_type"],
                "fileSize": row["file_size"],
                "uploadTime": json_value(row["upload_time"]),
                "captureTime": json_value(row["capture_time"]),
                "sortTime": json_value(row["sort_time"]),
                "width": row["width"],
                "height": row["height"],
            }
        )

    payload = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "prefix": normalized_prefix,
        "sort": ["sortTime:desc", "id:desc"],
        "total": len(items),
        "items": items,
    }
    data_file = DATA_DIRECTORY / f"{dataset_name(normalized_prefix)}.json"
    data_file.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = data_file.with_suffix(".json.tmp")
    temporary_file.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_file.replace(data_file)
    print(f"数据集已导出: {data_file} ({len(items)} 条)")


def main():
    parser = argparse.ArgumentParser(
        description="同步 OSS 图片到 MySQL，并生成 Hugo 相册数据。"
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="仅从 MySQL 生成 static/data/*.json，不扫描 OSS。",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="强制下载并重新解析所有图片，忽略 ETag/修改时间。",
    )
    args = parser.parse_args()
    prefix = normalize_dataset_prefix(required_env("OSS_PREFIX"))

    MYSQL_CONFIG["user"] = required_env("MYSQL_USER")
    MYSQL_CONFIG["password"] = required_env("MYSQL_PASSWORD")

    if args.export_only:
        conn = pymysql.connect(**MYSQL_CONFIG)
        try:
            export_dataset(conn, prefix)
        finally:
            conn.close()
        return

    auth = oss2.Auth(
        required_env("OSS_ACCESS_KEY_ID"),
        required_env("OSS_ACCESS_KEY_SECRET"),
    )
    bucket = oss2.Bucket(auth, OSS_ENDPOINT, BUCKET_NAME)

    inserted = 0
    updated = 0
    skipped = 0
    failed = 0
    print("开始扫描 OSS...")

    conn = pymysql.connect(**MYSQL_CONFIG)
    try:
        existing_photos = load_existing_photos(conn, prefix)
        print(f"已加载数据库记录: {len(existing_photos)} 条")

        for obj in oss2.ObjectIterator(bucket, prefix=prefix, max_keys=1000):
            key = obj.key
            if key.endswith("/"):
                continue

            upload_time = datetime.fromtimestamp(obj.last_modified)
            existing = existing_photos.get(key)
            if not args.force and object_is_unchanged(existing, obj, upload_time):
                skipped += 1
                continue

            action = "updating" if existing else "inserting"
            print(f"{action}: {key}")
            try:
                data = bucket.get_object(key).read()
                image_info = parse_image_info(data, key)
                filename = key.rsplit("/", 1)[-1]
                _, separator, extension = filename.rpartition(".")
                file_type = extension.lower() if separator else ""
                oss_etag = normalize_etag(getattr(obj, "etag", None))

                row = {
                    "oss_key": key,
                    "file_name": filename,
                    "file_type": file_type,
                    "file_size": obj.size,
                    "upload_time": upload_time,
                    "capture_time": image_info["capture_time"],
                    "sort_time": image_info["capture_time"] or upload_time,
                    "width": image_info["width"],
                    "height": image_info["height"],
                    "camera_make": image_info["camera_make"],
                    "camera_model": image_info["camera_model"],
                    "latitude": image_info["latitude"],
                    "longitude": image_info["longitude"],
                    "oss_etag": oss_etag,
                    "metadata": json.dumps(
                        {"ossEtag": oss_etag},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                }
                insert_photo(conn, row)
                if existing:
                    updated += 1
                else:
                    inserted += 1
                if (inserted + updated) % BATCH_SIZE == 0:
                    conn.commit()
            except Exception as exc:
                failed += 1
                print(f"失败: {key}: {exc}")

        conn.commit()
        export_dataset(conn, prefix)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(
        f"完成，新增: {inserted}，更新: {updated}，"
        f"跳过: {skipped}，失败: {failed}"
    )


if __name__ == "__main__":
    main()
