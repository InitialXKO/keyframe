/**
 * Bake chunk cache — OPFS (Origin Private File System) persistence for
 * BakedReplayPlayer chunks.
 *
 * The bake step (engine.bakeChunk) is pure math over the scene — its output
 * only depends on the scene content, so it can be cached and reloaded across
 * page reloads instead of being recomputed. This is the client-side echo of
 * the P0 "Motion-as-a-Service" strategy: baked 80-byte/instance records as
 * a distributable asset format.
 *
 * OPFS is used because it is fast, synchronous-friendly, quota-managed, and
 * survives reloads without IndexedDB ceremony. Every helper degrades
 * gracefully (returns false/null) when the API is unavailable.
 */

const PREFIX = "keyforge-bake";

/** true when the current environment exposes a usable OPFS API */
export function opfsAvailable(): boolean {
  if (typeof navigator === "undefined") return false;
  const st = navigator.storage as (Storage & { getDirectory?: () => Promise<unknown> }) | undefined;
  return typeof st?.getDirectory === "function";
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === "undefined") return null;
  try {
    const st = navigator.storage as (Storage & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
    if (!st || typeof st.getDirectory !== "function") return null;
    return await st.getDirectory();
  } catch {
    return null;
  }
}

/**
 * Persist a baked chunk under a logical key (e.g. "perflab-250").
 * Returns true when the write succeeded.
 */
export async function saveBakeChunk(key: string, bytes: Uint8Array): Promise<boolean> {
  const d = await dir();
  if (!d) return false;
  try {
    const fh = await d.getFileHandle(`${PREFIX}-${key}.kfbake`, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a previously cached chunk. Returns null on miss, corruption, or when
 * OPFS is unavailable.
 */
export async function loadBakeChunk(key: string): Promise<Uint8Array | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const fh = await d.getFileHandle(`${PREFIX}-${key}.kfbake`);
    const file = await fh.getFile();
    if (file.size === 0) return null;
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Delete one cached chunk (or every chunk when key is omitted). */
export async function clearBakeCache(key?: string): Promise<number> {
  const d = await dir();
  if (!d) return 0;
  let removed = 0;
  try {
    if (key) {
      await d.removeEntry(`${PREFIX}-${key}.kfbake`);
      return 1;
    }
    // iterate + remove all known entries (async iterator over names)
    const names: string[] = [];
    for await (const name of (d as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(`${PREFIX}-`)) names.push(name);
    }
    for (const name of names) {
      try {
        await d.removeEntry(name);
        removed++;
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* directory unavailable */
  }
  return removed;
}
