export class OPFSStorage {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private memoryFallback: Map<string, Uint8Array> = new Map();
  private frameIndex: Map<number, any> = new Map();
  private mounted = false;

  constructor() {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      this.rootPromise = navigator.storage.getDirectory();
    }
  }

  public isOPFSSupported(): boolean {
    return this.rootPromise !== null;
  }

  public isMounted(): boolean {
    return this.mounted;
  }

  public async mount(): Promise<boolean> {
    if (!this.rootPromise) {
      return false;
    }
    try {
      const root = await this.rootPromise;
      try {
        const metaHandle = await root.getFileHandle("cache.meta");
        const file = await metaHandle.getFile();
        const buffer = await file.arrayBuffer();
        const view = new DataView(buffer);
        // Magic Number check: "KFBA" (0x4B464241) or ABI version check
        if (buffer.byteLength >= 4) {
          const magic = view.getUint32(0, true);
          // If magic number invalid, warn and fail mount
          if (magic !== 0x4B464241 && magic !== 0x4142464B) {
            console.warn("OPFS mount failed: cache.meta Magic Number / ABI version mismatch");
            return false;
          }
        }
      } catch (metaErr) {
        // cache.meta doesn't exist yet, which is valid for fresh storage
      }
      this.mounted = true;
      return true;
    } catch (err) {
      console.warn("OPFS mount failed, falling back to memory mode:", err);
      this.mounted = false;
      return false;
    }
  }

  public async buildFrameIndex(): Promise<Map<number, any>> {
    this.frameIndex.clear();
    if (!this.rootPromise) {
      return this.frameIndex;
    }
    try {
      const root = await this.rootPromise;
      for await (const entry of (root as any).values()) {
        if (entry.kind === "file" && entry.name.endsWith(".bake")) {
          // Parse timestamp from filename (e.g. frame_1000.bake -> 1000) or file metadata
          const match = entry.name.match(/(\d+)/);
          if (match) {
            const timestamp = parseInt(match[1], 10);
            this.frameIndex.set(timestamp, entry);
          }
        }
      }
    } catch (err) {
      console.warn("OPFS buildFrameIndex failed, falling back to memory mode:", err);
    }
    return this.frameIndex;
  }

  public getFrameFromIndex(timestamp: number): any {
    return this.frameIndex.get(timestamp);
  }

  public async appendChunk(filename: string, chunk: Uint8Array): Promise<void> {
    if (this.rootPromise) {
      try {
        const root = await this.rootPromise;
        const fileHandle = await root.getFileHandle(filename, { create: true });
        const writable = await (fileHandle as any).createWritable({ keepExistingData: true });
        const file = await fileHandle.getFile();
        await writable.seek(file.size);
        await writable.write(chunk);
        await writable.close();
        return;
      } catch (err) {
        console.warn("OPFS appendChunk failed, falling back to memory append:", err);
      }
    }
    const existing = this.memoryFallback.get(filename) || new Uint8Array(0);
    const combined = new Uint8Array(existing.byteLength + chunk.byteLength);
    combined.set(existing, 0);
    combined.set(chunk, existing.byteLength);
    this.memoryFallback.set(filename, combined);
  }

  public async write(filename: string, data: Uint8Array): Promise<void> {
    if (this.rootPromise) {
      try {
        const root = await this.rootPromise;
        const fileHandle = await root.getFileHandle(filename, { create: true });
        const writable = await (fileHandle as any).createWritable();
        await writable.write(data);
        await writable.close();
        return;
      } catch (err) {
        console.warn("OPFS write failed, falling back to memory:", err);
      }
    }
    this.memoryFallback.set(filename, data);
  }

  public async read(filename: string): Promise<Uint8Array> {
    if (this.rootPromise) {
      try {
        const root = await this.rootPromise;
        const fileHandle = await root.getFileHandle(filename);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (err) {
        console.warn("OPFS read failed, searching memory fallback:", err);
      }
    }
    const memData = this.memoryFallback.get(filename);
    if (!memData) {
      throw new Error(`File ${filename} not found in OPFS or memory fallback`);
    }
    return memData;
  }

  public async remove(filename: string): Promise<void> {
    if (this.rootPromise) {
      try {
        const root = await this.rootPromise;
        await root.removeEntry(filename);
        return;
      } catch (err) {
        // Ignore or fallback
      }
    }
    this.memoryFallback.delete(filename);
  }
}

export interface OPFSWriter {
  write(chunk: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  flush?(): void | Promise<void>;
  getBytes?(): Uint8Array;
}

export class SyncOPFSWriter implements OPFSWriter {
  private accessHandle: any;

  constructor(accessHandle: any) {
    this.accessHandle = accessHandle;
  }

  public write(chunk: Uint8Array): void {
    this.accessHandle.write(chunk);
  }

  public flush(): void {
    if (typeof this.accessHandle.flush === "function") {
      this.accessHandle.flush();
    }
  }

  public close(): void {
    this.flush();
    if (typeof this.accessHandle.close === "function") {
      this.accessHandle.close();
    }
  }
}

export class AsyncOPFSWriter implements OPFSWriter {
  private writableStream: any;

  constructor(writableStream: any) {
    this.writableStream = writableStream;
  }

  public async write(chunk: Uint8Array): Promise<void> {
    await this.writableStream.write(chunk);
  }

  public async close(): Promise<void> {
    await this.writableStream.close();
  }
}

export class MemoryWriter implements OPFSWriter {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  public write(chunk: Uint8Array): void {
    const copy = Uint8Array.from(chunk);
    this.chunks.push(copy);
    this.totalLength += copy.byteLength;
  }

  public close(): void {}

  public getBytes(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

export async function createSyncOPFSWriter(filename: string): Promise<OPFSWriter> {
  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(filename, { create: true });
      if (typeof (fileHandle as any).createSyncAccessHandle === "function") {
        const accessHandle = await (fileHandle as any).createSyncAccessHandle();
        return new SyncOPFSWriter(accessHandle);
      }
    } catch (err) {
      console.warn("createSyncOPFSWriter failed (e.g. main thread restriction), falling back to AsyncOPFSWriter:", err);
    }
  }
  return createAsyncOPFSWriter(filename);
}

export async function createAsyncOPFSWriter(filename: string): Promise<OPFSWriter> {
  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(filename, { create: true });
      if (typeof (fileHandle as any).createWritable === "function") {
        const writable = await (fileHandle as any).createWritable();
        return new AsyncOPFSWriter(writable);
      }
    } catch (err) {
      console.warn("createAsyncOPFSWriter failed, falling back to MemoryWriter:", err);
    }
  }
  return new MemoryWriter();
}

export function createMemoryWriter(): MemoryWriter {
  return new MemoryWriter();
}

export async function createOPFSWriter(filename: string): Promise<OPFSWriter> {
  try {
    return await createSyncOPFSWriter(filename);
  } catch (err) {
    return await createAsyncOPFSWriter(filename);
  }
}
