import { OPFSStorage } from "./opfs_storage.js";
export class StorageAdapter {
    opfs = new OPFSStorage();
    getOPFS() {
        return this.opfs;
    }
    async saveIR(key, irObject) {
        const jsonStr = JSON.stringify(irObject);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(jsonStr);
        await this.opfs.write(key, bytes);
    }
    async loadIR(key) {
        const bytes = await this.opfs.read(key);
        const decoder = new TextDecoder();
        const jsonStr = decoder.decode(bytes);
        return JSON.parse(jsonStr);
    }
    async saveBakeData(key, bakeBytes) {
        await this.opfs.write(key, bakeBytes);
    }
    async loadBakeData(key) {
        return await this.opfs.read(key);
    }
    async bakeStreamToOPFS(engine, key, options) {
        const { startMs, endMs, fps = 30, chunkSizeMs = 1000, onProgress } = options;
        const totalDuration = endMs - startMs;
        if (totalDuration <= 0)
            return;
        await this.opfs.remove(key);
        let current = startMs;
        const frameDuration = 1000 / fps;
        while (current <= endMs) {
            const nextEnd = Math.min(endMs, current + chunkSizeMs);
            const chunkBytes = engine.bakeChunk
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
