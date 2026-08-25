import { OPFSStorage } from "./opfs_storage.js";

export interface StreamBakeOptions {
  startMs: number;
  endMs: number;
  fps?: number;
  chunkSizeMs?: number;
  onProgress?: (progressPercent: number) => void;
}

export class StorageAdapter {
  private opfs: OPFSStorage = new OPFSStorage();

  public getOPFS(): OPFSStorage {
    return this.opfs;
  }

  public async saveIR(key: string, irObject: any): Promise<void> {
    const jsonStr = JSON.stringify(irObject);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonStr);
    await this.opfs.write(key, bytes);
  }

  public async loadIR(key: string): Promise<any> {
    const bytes = await this.opfs.read(key);
    const decoder = new TextDecoder();
    const jsonStr = decoder.decode(bytes);
    return JSON.parse(jsonStr);
  }

  public async saveBakeData(key: string, bakeBytes: Uint8Array): Promise<void> {
    await this.opfs.write(key, bakeBytes);
  }

  public async loadBakeData(key: string): Promise<Uint8Array> {
    return await this.opfs.read(key);
  }

  public async bakeStreamToOPFS(
    engine: any,
    key: string,
    options: StreamBakeOptions
  ): Promise<void> {
    const { startMs, endMs, fps = 30, chunkSizeMs = 1000, onProgress } = options;
    const totalDuration = endMs - startMs;
    if (totalDuration <= 0) return;

    await this.opfs.remove(key);

    let current = startMs;
    const frameDuration = 1000 / fps;

    while (current <= endMs) {
      const nextEnd = Math.min(endMs, current + chunkSizeMs);
      const chunkBytes: Uint8Array = engine.bakeChunk
        ? engine.bakeChunk(current, nextEnd, fps)
        : engine.bakeRange(current, nextEnd, fps);

      if (chunkBytes && chunkBytes.byteLength > 0) {
        await this.opfs.appendChunk(key, chunkBytes);
      }

      current = nextEnd + frameDuration;
      if (onProgress) {
        const progress = Math.min(100, Math.round(((Math.min(current, endMs) - startMs) / totalDuration) * 100));
        onProgress(progress);
      }
    }
  }
}
