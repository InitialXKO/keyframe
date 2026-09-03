/**
 * kfbake — file packaging for baked motion chunks (P0 "Motion-as-a-Service").
 *
 * `engine.bakeChunk()` produces a flat run of 80-byte GpuInstanceData records
 * (16 floats matrix + opacity + visible + clipIndex + padding — the engine's
 * GPU-aligned ABI). A .kfbake file wraps that raw payload with a tiny binary
 * header so a player can decode it WITHOUT the engine, the scene, or any
 * easing math:
 *
 *   offset  size  field
 *   0       8     magic  "KFBAKE1"
 *   8       4     header JSON length (u32 LE)
 *   12      n     header JSON (utf-8): meta describing the payload
 *   12+n    …     raw chunk payload (frames × instances × 80 bytes)
 *
 * This turns a baked animation into a self-contained, shareable asset —
 * export from PerfLab, then play it back anywhere with the standalone
 * BakePlayer (pure Canvas2D, zero engine dependency).
 */

export const KFBAKE_MAGIC = "KFBAKE1";
const HEADER_LEN_OFFSET = 8;
const HEADER_OFFSET = 12;
/** bytes per GpuInstanceData record (engine GPU ABI) */
export const BYTES_PER_INSTANCE = 80;

/** JSON header carried inside a .kfbake file */
export interface KfbakeMeta {
  version: 1;
  /** source scene title (informational) */
  title: string;
  /** instances per frame */
  instances: number;
  /** baked frame rate */
  fps: number;
  /** number of frames actually contained in the payload */
  frames: number;
  /** bake window */
  startMs: number;
  endMs: number;
  /** ISO date of the bake */
  bakedAt: string;
  /** payload size in bytes (redundant checksum of intent) */
  payloadBytes: number;
}

export interface KfbakeFile {
  meta: KfbakeMeta;
  chunk: Uint8Array;
}

/** Wrap a raw baked chunk into a self-contained .kfbake byte blob. */
export function packKfbake(meta: Omit<KfbakeMeta, "version" | "payloadBytes" | "frames"> & { frames?: number }, chunk: Uint8Array): Uint8Array {
  const frames = meta.frames ?? Math.floor(chunk.byteLength / (BYTES_PER_INSTANCE * Math.max(1, meta.instances)));
  const header: KfbakeMeta = { ...meta, frames, version: 1, payloadBytes: chunk.byteLength };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(HEADER_OFFSET + json.byteLength + chunk.byteLength);
  // magic
  for (let i = 0; i < KFBAKE_MAGIC.length; i++) out[i] = KFBAKE_MAGIC.charCodeAt(i);
  // header length (u32 LE)
  new DataView(out.buffer).setUint32(HEADER_LEN_OFFSET, json.byteLength, true);
  out.set(json, HEADER_OFFSET);
  out.set(chunk, HEADER_OFFSET + json.byteLength);
  return out;
}

/**
 * Parse a .kfbake byte blob. Returns null on any structural problem
 * (bad magic, truncated header, payload size mismatch).
 */
export function parseKfbake(bytes: Uint8Array): KfbakeFile | null {
  try {
    if (bytes.byteLength < HEADER_OFFSET + 2) return null;
    for (let i = 0; i < KFBAKE_MAGIC.length; i++) {
      if (bytes[i] !== KFBAKE_MAGIC.charCodeAt(i)) return null;
    }
    const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER_LEN_OFFSET, true);
    if (headerLen <= 0 || headerLen > 64 * 1024) return null;
    if (HEADER_OFFSET + headerLen > bytes.byteLength) return null;
    const json = new TextDecoder().decode(bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLen));
    const meta = JSON.parse(json) as KfbakeMeta;
    if (!meta || typeof meta.instances !== "number" || meta.instances <= 0 || typeof meta.fps !== "number") return null;
    const chunk = bytes.subarray(HEADER_OFFSET + headerLen);
    const expect = meta.frames * meta.instances * BYTES_PER_INSTANCE;
    if (chunk.byteLength < expect) return null;
    return { meta, chunk };
  } catch {
    return null;
  }
}

/** Trigger a browser download of a .kfbake asset. */
export function downloadKfbake(bytes: Uint8Array, title: string) {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title || "motion"}.kfbake`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Human-readable byte formatter (shared with export flows). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}
