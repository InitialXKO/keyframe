import { OPFSStorage } from "./opfs_storage.js";
import { Engine } from "./builder/engine.js";
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
    async loadBakeData(key, optionsOrDecode) {
        const bytes = await this.opfs.read(key);
        const shouldDecode = typeof optionsOrDecode === "boolean"
            ? optionsOrDecode
            : optionsOrDecode?.decode === true;
        if (shouldDecode) {
            return Engine.decodeBakedChunk(bytes);
        }
        return bytes;
    }
    async bakeStreamToOPFS(engine, key, options) {
        const { startMs, endMs, fps = 30, chunkSizeMs = 1000, onProgress } = options;
        const totalDuration = endMs - startMs;
        if (totalDuration <= 0)
            return;
        await this.opfs.remove(key);
        if (typeof engine.bakeStream === "function") {
            let bytesWritten = 0;
            const totalFrames = Math.floor(totalDuration / (1000 / fps)) + 1;
            const bytesPerFrame = (engine.instances?.length || 1) * 80;
            const estimatedTotalBytes = totalFrames * bytesPerFrame;
            await engine.bakeStream({ startMs, endMs, fps }, async (chunk) => {
                if (chunk && chunk.byteLength > 0) {
                    await this.opfs.appendChunk(key, chunk);
                    bytesWritten += chunk.byteLength;
                    if (onProgress && estimatedTotalBytes > 0) {
                        const progress = Math.min(100, Math.round((bytesWritten / estimatedTotalBytes) * 100));
                        onProgress(progress);
                    }
                }
            });
            if (onProgress)
                onProgress(100);
            return;
        }
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
