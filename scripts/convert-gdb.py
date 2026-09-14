"""Chuyển toàn bộ layer CÓ DỮ LIỆU trong các File Geodatabase CSDL quy hoạch (TT16) -> GeoJSON WGS84.

Input : data/01.HaNoi.CTDL_QuyHoachDTNT_TT16_VN2000_105-00_gdb_template/*.gdb
Output: data/gdb/<Gdb>__<Layer>.geojson + data/gdb/manifest.json (web đọc manifest để tạo lớp)

Cài: pip install geopandas pyogrio
Chạy: python scripts/convert-gdb.py
"""
import json
import re
import unicodedata
import warnings
from collections import Counter
from pathlib import Path

import pyogrio
import geopandas as gpd

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "01.HaNoi.CTDL_QuyHoachDTNT_TT16_VN2000_105-00_gdb_template"
OUT = ROOT / "data" / "gdb"

# CRS trong GDB là VN-2000 TM-3 (không kèm tham số datum) -> thêm 7 tham số VN2000->WGS84 (QĐ 05/2007/QĐ-BTNMT)
TOWGS84 = "-191.90441429,-39.30318279,-111.45032835,-0.00928836,0.01975479,-0.00427372,0.252906278"


def source_crs(crs_wkt):
    """Dựng lại CRS proj4 từ tham số TM trong WKT, bổ sung towgs84."""
    param = lambda name, default: float(re.search(rf'"{name}",([-\d.]+)', crs_wkt, re.I).group(1)) if re.search(rf'"{name}"', crs_wkt, re.I) else default
    return (
        f"+proj=tmerc +lat_0={param('latitude_of_origin', 0)} +lon_0={param('central_meridian', 105)} "
        f"+k={param('scale_factor', 0.9999)} +x_0={param('false_easting', 500000)} +y_0={param('false_northing', 0)} "
        f"+ellps=WGS84 +towgs84={TOWGS84} +units=m +no_defs"
    )


def slug(s):
    s = unicodedata.normalize("NFD", str(s or "")).replace("đ", "d").replace("Đ", "D").replace("Ð", "D")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "", s)


# Chuẩn hoá phanLoai (dữ liệu nhập tay không thống nhất) -> nhóm hiển thị
NEN_DIA_HINH_GROUPS = [
    ("nha", ("nha", "tuongxay")),
    ("duong", ("duong", "viahe", "caucong", "taluy")),
    ("thuy-he", ("thuyhe", "hoga", "ranh", "raosat")),
    ("thuc-vat", ("thucvat",)),
    ("dien", ("caothe", "dien")),
    ("cao-do", ("caodo", "moc")),
    ("dia-vat", ("diavat",)),
]


def group_of(phan_loai):
    s = slug(phan_loai)
    if s == "ranhgioikhu":
        return "ranh-gioi"
    for group, keys in NEN_DIA_HINH_GROUPS:
        if any(s.startswith(k) for k in keys):
            return group
    return "khac"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for gdb in sorted(SRC.glob("*.gdb")):
        layers = pyogrio.list_layers(gdb)
        print(f"{gdb.name}: {len(layers)} layers")
        for name, _ in layers:
            info = pyogrio.read_info(gdb, layer=name)
            if info["features"] == 0 or not info.get("geometry_type"):
                continue
            df = gpd.read_file(gdb, layer=name, engine="pyogrio")
            df = df[df.geometry.notna() & ~df.geometry.is_empty]
            # Bỏ điểm thừa (dung sai 0.1 m, tính trong hệ mét trước khi đổi sang độ).
            # Nét quá ngắn có thể bị suy biến thành Point/GeometryCollection -> giữ hình học gốc
            simplified = df.geometry.simplify(0.1, preserve_topology=True)
            family = lambda s: s.geom_type.str.replace("Multi", "")
            keep = (family(simplified) == family(df.geometry)) & ~simplified.is_empty
            df["geometry"] = simplified.where(keep, df.geometry)
            df = df.set_crs(source_crs(info["crs"]), allow_override=True).to_crs(4326)
            df = df.drop(columns=[c for c in df.columns if c.startswith("Shape_")])
            if "phanLoai" in df.columns:
                df["nhom"] = df["phanLoai"].map(group_of)

            # Cột hằng số (cùng 1 giá trị/ rỗng toàn layer) đưa vào manifest thay vì lặp trên từng feature
            attrs = [c for c in df.columns if c != "geometry"]
            constants = {c: df[c].iloc[0] for c in attrs if df[c].nunique(dropna=False) <= 1}
            df = df.drop(columns=list(constants))

            file = f"{gdb.stem}__{name}.geojson"
            df.to_file(OUT / file, driver="GeoJSON", COORDINATE_PRECISION=6, RFC7946="YES")
            # GDAL ghi có khoảng trắng -> nén lại JSON để giảm dung lượng tải.
            # Làm tròn 6 chữ số (~0.1 m) biến nét < 10 cm thành Point/GeometryCollection -> loại bỏ
            geojson = json.loads((OUT / file).read_text(encoding="utf-8"))
            src_family = info["geometry_type"].replace("Multi", "")
            geojson["features"] = [f for f in geojson["features"] if f["geometry"]["type"].replace("Multi", "") == src_family]
            (OUT / file).write_text(json.dumps(geojson, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            minx, miny, maxx, maxy = df.total_bounds
            entry = {
                "gdb": gdb.stem,
                "layer": name,
                "file": f"data/gdb/{file}",
                "geometry": info["geometry_type"],
                "features": len(geojson["features"]),
                "dropped": info["features"] - len(geojson["features"]),
                "bbox": [round(float(v), 6) for v in (minx, miny, maxx, maxy)],
                "constants": {k: (None if v is None or v != v else str(v)) for k, v in constants.items()},
                "groups": dict(Counter(f["properties"]["nhom"] for f in geojson["features"]).most_common()) if "nhom" in df.columns else {},
            }
            manifest.append(entry)
            size = (OUT / file).stat().st_size / 1e6
            print(f"  {name}: {entry['features']}/{info['features']} features (bỏ {entry['dropped']} rỗng/suy biến) -> {file} ({size:.1f} MB)")

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"manifest.json: {len(manifest)} layers")


if __name__ == "__main__":
    main()
