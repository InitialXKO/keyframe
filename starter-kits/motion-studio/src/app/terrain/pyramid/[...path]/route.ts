/**
 * 全球地形金字塔瓦片服务（App Router 路由处理器）
 *
 * 瓦片数据存放在项目目录之外（/home/z/terrain-data/pyramid），原因：
 * 6193 个静态文件放在 public/ 会使 Turbopack dev 启动扫描内存暴涨至 OOM；
 * 路由处理器按需读盘返回，dev server 内存不受瓦片数量影响。
 *
 * 路径：GET /terrain/pyramid/manifest.json
 *       GET /terrain/pyramid/l3/{ty}_{tx}.ktdt（l1/l2 同理）
 * 防目录穿越：解析后必须落在数据根内；仅 GET。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DATA_ROOT = "/home/z/terrain-data/pyramid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  if (!parts || parts.length === 0 || parts.length > 4) {
    return new Response("not found", { status: 404 });
  }
  for (const seg of parts) {
    if (seg.includes("..") || seg.includes("/") || seg.includes("\\")) {
      return new Response("bad path", { status: 400 });
    }
  }
  const file = path.join(DATA_ROOT, ...parts);
  if (!file.startsWith(DATA_ROOT)) {
    return new Response("bad path", { status: 400 });
  }
  try {
    const st = await stat(file);
    if (!st.isFile()) return new Response("not found", { status: 404 });
    const buf = await readFile(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(st.size),
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
