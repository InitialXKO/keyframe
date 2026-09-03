import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * 引擎元数据：编译产物大小、crate 版本、构建信息。
 * 由前端「粒子引擎」页在初始化时拉取展示。
 */
export async function GET() {
  try {
    const wasmDir = path.join(process.cwd(), "public", "wasm");
    const [wasmStat, glueStat] = await Promise.all([
      stat(path.join(wasmDir, "keyframe_engine_bg.wasm")),
      stat(path.join(wasmDir, "keyframe_engine.js")),
    ]);

    let crateVersion = "0.1.0";
    let rustEdition = "2021";
    try {
      const toml = await readFile(
        path.join(process.cwd(), "rust", "keyframe-engine", "Cargo.toml"),
        "utf8",
      );
      const m = toml.match(/version\s*=\s*"([^"]+)"/);
      if (m) crateVersion = m[1];
      const e = toml.match(/edition\s*=\s*"([^"]+)"/);
      if (e) rustEdition = e[1];
    } catch {
      /* vendor 目录缺失时降级 */
    }

    return NextResponse.json({
      ok: true,
      wasmBytes: wasmStat.size,
      glueBytes: glueStat.size,
      crateVersion,
      rustEdition,
      abi: {
        instanceSize: 80,
        layout: "mat4(f32×16) + opacity(f32) + visible(u32) + clipIndex(u32) + pad(u32)",
      },
      target: "wasm32-unknown-unknown",
      features: ["fast-path 零分配逐帧求值", "bake 离线烘焙", "零拷贝 GPU 上传"],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
