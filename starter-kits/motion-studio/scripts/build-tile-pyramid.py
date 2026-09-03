#!/usr/bin/env python3
"""
全球地形瓦片金字塔构建（一次性数据准备 → /home/z/terrain-data/pyramid（项目外，App Router 路由按需读盘））

源：/tmp/dem-high.zip（kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high）
  172 瓦片 15°×15° @15″（≈450m/px），RGB 编码：value = R + G·256，
  海拔 = value/a − b（a/b 逐瓦片 index.json）；B>0 = 水体/无数据哨兵。

输出（确定性：固定瓦片顺序 + 固定填充/均值归约 + 固定取整）：
  pyramid/l3/{ty}_{tx}.ktdt   432²px @15″  —— 全分辨率层（200×100 瓦片格）
  pyramid/l2/{ty}_{tx}.ktdt   432²px @30″  —— L3 2×2 均值（100×50）
  pyramid/l1/{ty}_{tx}.ktdt   432²px @60″  —— L2 2×2 均值（50×25）
  pyramid/manifest.json       各级陆地瓦片清单 + 格网参数

瓦片格式：[u32 'KTDT'][u32 level][u32 tx][u32 ty][u32 w][u32 h]
          + zlib(w*h 个 i16 海拔 + w*h 个 u8 水体掩膜)
  掩膜：0=陆 1=海 2=内陆水；纯水瓦片不落盘（客户端回退粗层海面）。
哨兵处理：B>0 像素高度未知 → 3×3 邻域迭代填充（8 轮）；
  填充后 ≤2m → 海面(1,h=0)，否则内陆水(2,保留填充面)。
磁盘预算：仅陆地瓦片落盘（约 30% 格）+ zlib ≈ 1.8GB。
"""
import io
import json
import os
import struct
import sys
import time
import zipfile
import zlib

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ZIP = "/tmp/dem-high.zip"
OUT = "/home/z/terrain-data/pyramid"
RAW = "/tmp/pyr-raw"

TILE = 432
D_DEG = 1.0 / 240.0            # 15″
G3_W, G3_H = 86400, 43200      # L3 全分辨率格网（15″）
L3C, L3R = G3_W // TILE, G3_H // TILE          # 200 × 100
L2C, L2R = L3C // 2, L3R // 2                  # 100 × 50
L1C, L1R = L2C // 2, L2R // 2                  # 50 × 25
SENTINEL = -32768
MAGIC = 0x4B544454             # "KTDT"


def iter_fill(h: np.ndarray, known: np.ndarray, rounds: int = 8) -> np.ndarray:
    """哨兵填充：每轮用 3×3 邻域已知均值推进（numpy 向量，确定性）"""
    acc = h.astype(np.float32)
    kn = known.astype(np.float32)
    for _ in range(rounds):
        if kn.min() > 0:
            break
        s = np.zeros_like(acc)
        c = np.zeros_like(kn)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sa = acc[max(dy, 0):acc.shape[0] + min(dy, 0), max(dx, 0):acc.shape[1] + min(dx, 0)]
                sk = kn[max(dy, 0):kn.shape[0] + min(dy, 0), max(dx, 0):kn.shape[1] + min(dx, 0)]
                s[max(-dy, 0):s.shape[0] + min(-dy, 0), max(-dx, 0):s.shape[1] + min(-dx, 0)] += sa
                c[max(-dy, 0):c.shape[0] + min(-dy, 0), max(-dx, 0):c.shape[1] + min(-dx, 0)] += sk
        fill = c > 0
        upd = (kn == 0) & fill
        acc[upd] = s[upd] / c[upd]
        kn[upd] = 1
    return acc


class SourceCache:
    """源瓦片 LRU（解码 3600² i16，含哨兵 −32768；容量 28 ≈ 725MB）"""

    def __init__(self, z: zipfile.ZipFile, idx_files: dict):
        self.z = z
        self.idx = idx_files
        self.cap = 28
        self.cache: dict = {}
        self.order: list = []

    def get(self, sr: int, sc: int):
        key = (sr, sc)
        if key in self.cache:
            return self.cache[key]
        name = self.idx.get((sr, sc))
        if name is None:
            arr = None  # 缺失瓦片（纯海洋/极区）
        else:
            ent = self.idx[(sr, sc, "ent")]
            im = Image.open(io.BytesIO(self.z.read(name)))
            if im.size != (3600, 3600):
                arr = None
            else:
                a = np.asarray(im, dtype=np.uint32)
                valid = a[:, :, 2] == 0
                v = a[:, :, 0] + a[:, :, 1] * 256
                h = np.where(valid, v / ent["a"] - ent["b"], SENTINEL)
                arr = np.rint(h).astype(np.int16)
        self.cache[key] = arr
        self.order.append(key)
        while len(self.order) > self.cap:
            old = self.order.pop(0)
            self.cache.pop(old, None)
        return arr


def write_tile(path: str, level: int, tx: int, ty: int, h16: np.ndarray, mask: np.ndarray):
    payload = zlib.compress(h16.tobytes() + mask.tobytes(), 6)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(struct.pack("<IIIIII", MAGIC, level, tx, ty, h16.shape[1], h16.shape[0]))
        f.write(payload)
    os.replace(tmp, path)


def phase_a_l3(z, src: SourceCache):
    os.makedirs(f"{OUT}/l3", exist_ok=True)
    land = []
    t0 = time.time()
    for ty in range(L3R):
        for tx in range(L3C):
            path = f"{OUT}/l3/{ty}_{tx}.ktdt"
            if os.path.exists(path) and os.path.getsize(path) > 24:
                land.append(ty * L3C + tx)   # 断点续跑：已写瓦片跳过
                continue
            x0, y0 = tx * TILE, ty * TILE
            g = np.full((TILE, TILE), 0.0, dtype=np.float32)
            known = np.zeros((TILE, TILE), dtype=np.uint8)
            missing = True
            # 组装：可能与 1-2×1-2 个源瓦片相交（432 不整除 3600）
            sr0, sr1 = y0 // 3600, (y0 + TILE - 1) // 3600
            sc0, sc1 = x0 // 3600, (x0 + TILE - 1) // 3600
            for sr in range(sr0, sr1 + 1):
                for sc in range(sc0, sc1 + 1):
                    raw = src.get(sr, sc)
                    if raw is None:
                        continue
                    missing = False
                    oy = max(0, y0 - sr * 3600)
                    ox = max(0, x0 - sc * 3600)
                    hy = min(3600, y0 + TILE - sr * 3600) - oy
                    hx = min(3600, x0 + TILE - sc * 3600) - ox
                    if hy <= 0 or hx <= 0:
                        continue
                    ly, lx = sr * 3600 + oy - y0, sc * 3600 + ox - x0
                    seg = raw[oy:oy + hy, ox:ox + hx].astype(np.float32)
                    kn = (seg != SENTINEL).astype(np.uint8)
                    g[ly:ly + hy, lx:lx + hx] = np.where(seg == SENTINEL, 0.0, seg)
                    known[ly:ly + hy, lx:lx + hx] = kn
            if missing:
                continue  # 纯海洋/极区：不落盘
            sent = known == 0
            if sent.any():
                filled = iter_fill(g, (~sent).astype(np.uint8))
                g = np.where(sent, filled, g)
            m = np.zeros((TILE, TILE), dtype=np.uint8)
            m[(g <= 0) & ~sent] = 1            # 源数据以 ≤0 标记海面
            lakes = sent & (g > 2)
            m[lakes] = 2                        # 内陆水体（填充面）
            sea = sent & (g <= 2)
            m[sea] = 1
            g[sea] = 0.0
            if not (m == 0).any():
                continue                        # 纯水瓦片不落盘
            h16 = np.rint(np.clip(g, -32000, 9000)).astype("<i2")
            write_tile(path, 3, tx, ty, h16, m)
            land.append(ty * L3C + tx)
        if ty % 10 == 0:
            sys.stdout.write(f"  l3 row {ty}/{L3R} tiles={len(land)} {time.time()-t0:.0f}s\n")
            sys.stdout.flush()
    return land


def load_tile(path: str):
    """读取瓦片 → (h float32, mask uint8)；缺失文件 = 纯海洋"""
    if path is None or not os.path.exists(path):
        return np.zeros((TILE, TILE), dtype=np.float32), np.ones((TILE, TILE), dtype=np.uint8)
    buf = open(path, "rb").read()
    _, _, _, _, w, hh = struct.unpack("<IIIIII", buf[:24])
    body = zlib.decompress(buf[24:])
    h = np.frombuffer(body[: w * hh * 2], dtype="<i2").reshape(hh, w).astype(np.float32)
    m = np.frombuffer(body[w * hh * 2:], dtype=np.uint8).reshape(hh, w)
    return h, m


def downsample(src_dir: str, dst_dir: str, level: int, cols: int, rows: int):
    """2×2 均值降采样：本层 432² 瓦片 = 下一级 2×2 瓦片（864² 源窗口）；≥3 水像素→水"""
    os.makedirs(dst_dir, exist_ok=True)
    land = []
    N = TILE * 2
    for ty in range(rows):
        for tx in range(cols):
            path = f"{dst_dir}/{ty}_{tx}.ktdt"
            if os.path.exists(path) and os.path.getsize(path) > 24:
                land.append(ty * cols + tx)
                continue
            big = np.zeros((N, N), dtype=np.float32)
            bm = np.ones((N, N), dtype=np.uint8)
            any_land = False
            for cy in (0, 1):
                for cx in (0, 1):
                    h, m = load_tile(f"{src_dir}/{ty*2+cy}_{tx*2+cx}.ktdt")
                    big[cy*TILE:(cy+1)*TILE, cx*TILE:(cx+1)*TILE] = h
                    bm[cy*TILE:(cy+1)*TILE, cx*TILE:(cx+1)*TILE] = m
                    if (m == 0).any():
                        any_land = True
            if not any_land:
                continue
            h = big.reshape(TILE, 2, TILE, 2).mean(axis=(1, 3))
            wc = bm.reshape(TILE, 2, TILE, 2).sum(axis=(1, 3))
            lake = bm.reshape(TILE, 2, TILE, 2).max(axis=(1, 3))
            m = np.where(wc >= 3, np.where(lake == 2, 2, 1), 0).astype(np.uint8)
            if not (m == 0).any():
                continue
            h16 = np.rint(h).astype("<i2")
            write_tile(f"{dst_dir}/{ty}_{tx}.ktdt", level, tx, ty, h16, m)
            land.append(ty * cols + tx)
        sys.stdout.write(f"  {os.path.basename(dst_dir)} row {ty+1}/{rows} tiles={len(land)}\n")
        sys.stdout.flush()
    return land


def main():
    t0 = time.time()
    z = zipfile.ZipFile(ZIP)
    idx = json.loads(z.read("index.json").decode())
    idx_files = {}
    for ent in idx["files"]:
        nm = ent["filename"]
        if not nm.endswith(".webp"):
            continue
        # 瓦片命名 N60W135 → 行（北纬起始）、列（西经起始）
        latS = ent["latitude_start"]
        lonW = ent["longitude_start"]
        sr = int(round((90.0 - max(latS, ent["latitude_end"])) / 15.0))
        sc = int(round((lonW + 180.0) / 15.0))
        idx_files[(sr, sc)] = nm
        idx_files[(sr, sc, "ent")] = ent
    print(f"source tiles indexed: {len(idx_files) // 2}")

    src = SourceCache(z, idx_files)
    land3 = phase_a_l3(z, src)
    print(f"L3 done: {len(land3)} land tiles, {time.time()-t0:.0f}s")

    land2 = downsample(f"{OUT}/l3", f"{OUT}/l2", 2, L2C, L2R)
    print(f"L2 done: {len(land2)} tiles, {time.time()-t0:.0f}s")
    land1 = downsample(f"{OUT}/l2", f"{OUT}/l1", 1, L1C, L1R)
    print(f"L1 done: {len(land1)} tiles, {time.time()-t0:.0f}s")

    def runs(arr):
        arr = sorted(arr)
        out = []
        for v in arr:
            if out and v == out[-1][1] + 1:
                out[-1][1] = v
            else:
                out.append([v, v])
        return out

    manifest = {
        "v": 1,
        "tile": TILE,
        "dDeg": D_DEG,
        "levels": {
            "3": {"cols": L3C, "rows": L3R, "runs": runs(land3)},
            "2": {"cols": L2C, "rows": L2R, "runs": runs(land2)},
            "1": {"cols": L1C, "rows": L1R, "runs": runs(land1)},
        },
    }
    with open(f"{OUT}/manifest.json", "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(OUT) for fn in fns)
    print(f"manifest written; pyramid total {total/1e6:.0f}MB, elapsed {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
