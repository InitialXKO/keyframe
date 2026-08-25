export class OPFSStorage {
    rootPromise = null;
    memoryFallback = new Map();
    constructor() {
        if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
            this.rootPromise = navigator.storage.getDirectory();
        }
    }
    isOPFSSupported() {
        return this.rootPromise !== null;
    }
    async appendChunk(filename, chunk) {
        if (this.rootPromise) {
            try {
                const root = await this.rootPromise;
                const fileHandle = await root.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable({ keepExistingData: true });
                const file = await fileHandle.getFile();
                await writable.seek(file.size);
                await writable.write(chunk);
                await writable.close();
                return;
            }
            catch (err) {
                console.warn("OPFS appendChunk failed, falling back to memory append:", err);
            }
        }
        const existing = this.memoryFallback.get(filename) || new Uint8Array(0);
        const combined = new Uint8Array(existing.byteLength + chunk.byteLength);
        combined.set(existing, 0);
        combined.set(chunk, existing.byteLength);
        this.memoryFallback.set(filename, combined);
    }
    async write(filename, data) {
        if (this.rootPromise) {
            try {
                const root = await this.rootPromise;
                const fileHandle = await root.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(data);
                await writable.close();
                return;
            }
            catch (err) {
                console.warn("OPFS write failed, falling back to memory:", err);
            }
        }
        this.memoryFallback.set(filename, data);
    }
    async read(filename) {
        if (this.rootPromise) {
            try {
                const root = await this.rootPromise;
                const fileHandle = await root.getFileHandle(filename);
                const file = await fileHandle.getFile();
                const buffer = await file.arrayBuffer();
                return new Uint8Array(buffer);
            }
            catch (err) {
                console.warn("OPFS read failed, searching memory fallback:", err);
            }
        }
        const memData = this.memoryFallback.get(filename);
        if (!memData) {
            throw new Error(`File ${filename} not found in OPFS or memory fallback`);
        }
        return memData;
    }
    async remove(filename) {
        if (this.rootPromise) {
            try {
                const root = await this.rootPromise;
                await root.removeEntry(filename);
                return;
            }
            catch (err) {
                // Ignore or fallback
            }
        }
        this.memoryFallback.delete(filename);
    }
}
