#!/usr/bin/env python3
"""
全球 DEM 拼接构建脚本（一次性数据准备，产物提交到 public/terrain/）。

输入：kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high.zip
  - index.json：瓦片元数据（a=缩放、b=偏移、经纬范围、15″ 分辨率）
  - *.webp：15°×15° 瓦片，3600×3600，RGB 通道编码 24-bit 值
      value = R + G·256 + B·65536
      海拔(米) = value / a - b      （a=0.25 → 每值 4m 步进）
      水体 = 海拔 ≤ 0（数据源以负值标记海面，无真实测深）
  - 缺失瓦片（纯海洋/极区）按海面 0m 填充

输出：
  public/terrain/earth.ktdem —— 全球等距圆柱格网 2880×1440（0.125°）
      [u32 magic 'KFG1'][u32 w][u32 h][u32 resDeg×1000] + w*h 个 i16 海拔（row 0 = +90°）
  meta.json 增加 earth 字段

确定性：固定瓦片遍历顺序、固定块均值归约（numpy reshape-mean）、固定取整规则。
"""
import io
import json
import struct
import zipfile

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ZIP = "/tmp/dem-high.zip"
OUT = "/home/z/my-project/public/terrain/earth.ktdem"
META = "/home/z/my-project/public/terrain/meta.json"

GW, GH = 2880, 1440          # 0.125° 全球格网
RES_X1000 = 125
PX_PER_DEG = 240             # 15″ 源分辨率
BLOCK = 30                   # 240 × 0.125° → 30×30 像元/块

MAGIC_GLOBE = 0x4B464731     # "KFG1"


def main():
    z = zipfile.ZipFile(ZIP)
    idx = json.loads(z.read("index.json").decode())
    print(f"tiles in index: {len(idx['files'])}, resolution: {idx['resolution_arc_seconds']}\"")

    acc = np.zeros((GH, GW), dtype=np.float64)   # value 均值累加
    cnt = np.zeros((GH, GW), dtype=np.uint8)     # 覆盖标记
    decoded = 0
    for ent in idx["files"]:
        name = ent["filename"]
        if not name.endswith(".webp"):
            continue
        latN, latS = ent["latitude_start"], ent["latitude_end"]
        lonW, lonE = ent["longitude_start"], ent["longitude_end"]
        # 全球块范围（0.125°）
        c0 = int(round((lonW + 180.0) / 0.125))
        c1 = int(round((lonE + 180.0) / 0.125))
        r0 = int(round((90.0 - latN) / 0.125))
        r1 = int(round((90.0 - latS) / 0.125))
        if c1 - c0 != 120 or r1 - r0 != 120:
            print(f"  !! {name}: unexpected block span {c0}:{c1} {r0}:{r1}, skipped")
            continue
        im = Image.open(io.BytesIO(z.read(name)))
        if im.size != (3600, 3600):
            print(f"  !! {name}: size {im.size}, skipped")
            continue
        arr = np.asarray(im, dtype=np.uint32)
        # B>0 = 水体/无数据哨兵填充（真实海拔 v=(R+G·256) ≤ ~2500，永不需要 B 位）
        valid = arr[:, :, 2] == 0
        v = arr[:, :, 0] + arr[:, :, 1] * 256
        v = np.where(valid, v, 0).astype(np.float64)
        # 30×30 块均值（仅有效像素；固定归约顺序，确定性）
        vw = v.reshape(120, BLOCK, 120, BLOCK)
        sm = vw.sum(axis=(1, 3))
        cntw = valid.reshape(120, BLOCK, 120, BLOCK).sum(axis=(1, 3)).astype(np.float64)
        bm = np.divide(sm, cntw, out=np.zeros_like(sm), where=cntw > 0)
        h = bm / ent["a"] - ent["b"]
        # 全无效块（哨兵海洋/冰区）→ 海面 0m
        h[cntw == 0] = 0.0
        acc[r0:r1, c0:c1] = h
        cnt[r0:r1, c0:c1] = 1
        decoded += 1
        if decoded % 24 == 0:
            print(f"  decoded {decoded} tiles...")

    # 缺失瓦片（纯海洋/南极区）→ 海面 0m
    missing = int((cnt == 0).sum())
    acc[cnt == 0] = 0.0
    print(f"decoded {decoded} tiles; missing blocks (filled 0m): {missing} ({missing / (GW * GH) * 100:.1f}%)")

    heights = np.rint(acc).astype("<i2")
    print("global heights range:", heights.min(), heights.max())

    # ---- 校验：抽样比对著名地理点 + 区域表一致性 ----
    def sample(lat, lon):
        r = int((90 - lat) / 0.125)
        c = int((lon + 180) / 0.125) % GW
        return int(heights[r, c])

    checks = [
        ("Everest", 27.988, 86.925, "块均值 5500-7000（含深谷稀释）"),
        ("K2", 35.881, 76.513, "块均值 5000-6500"),
        ("Pacific ocean", -11.35, -142.2, "≈ 0 (哨兵填充)"),
        ("BC Mt. Waddington", 51.376, -125.257, "块均值 1500-2600"),
        ("Denali", 63.07, -151.007, "块均值 2500-4500"),
        ("Alps Mont Blanc", 45.83, 6.865, "块均值 2000-3300"),
        ("Kilimanjaro", -3.066, 37.356, "块均值 2500-4200"),
        ("Amazon lowland", -3.4, -62.2, "≈ 0-150"),
        ("Sahara", 23.4, 12.6, "≈ 300-600"),
        ("Tibet plateau", 33.0, 88.0, "≈ 4500-5500"),
    ]
    for nm, la, lo, expect in checks:
        print(f"  {nm:20s} ({la},{lo}) = {sample(la, lo):>6} m  (expect {expect})")

    # 与区域高分辨率表一致性：同一 4.27° 区域的全表均值对比
    buf = open("/home/z/my-project/public/terrain/bc-coast.ktdem", "rb").read()
    _, w, hh, _ = struct.unpack("<IIII", buf[:16])
    bc = np.frombuffer(buf, dtype="<i2", count=w * hh, offset=16).reshape(hh, w).astype(np.float64)
    r0 = int(round((90 - 53.50417) / 0.125))
    c0 = int(round((-127.39583 + 180) / 0.125))
    gC = float(heights[r0:r0 + 34, c0:c0 + 34].astype(np.float64).mean())
    print(f"region mean: bc-coast={bc.mean():.0f}m vs globe={gC:.0f}m (同源降采样应接近)")

    with open(OUT, "wb") as f:
        f.write(struct.pack("<IIII", MAGIC_GLOBE, GW, GH, RES_X1000))
        f.write(heights.tobytes())
    print(f"written {OUT} ({GW * GH * 2 + 16} bytes)")

    meta = json.load(open(META))
    meta["earth"] = {
        "file": "earth.ktdem",
        "w": GW,
        "h": GH,
        "resDeg": 0.125,
        "tiles": decoded,
        "source": "kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high 全瓦片拼接 (172×15°tiles → 0.125° equirect)",
    }
    json.dump(meta, open(META, "w"), ensure_ascii=False, indent=1)
    print("meta.json updated with earth section")


if __name__ == "__main__":
    main()
