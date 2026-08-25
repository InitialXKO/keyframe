import { OPFSStorage } from "./opfs_storage.js";
export interface StreamBakeOptions {
    startMs: number;
    endMs: number;
    fps?: number;
    chunkSizeMs?: number;
    onProgress?: (progressPercent: number) => void;
}
export declare class StorageAdapter {
    private opfs;
    getOPFS(): OPFSStorage;
    saveIR(key: string, irObject: any): Promise<void>;
    loadIR(key: string): Promise<any>;
    saveBakeData(key: string, bakeBytes: Uint8Array): Promise<void>;
    loadBakeData(key: string): Promise<Uint8Array>;
    bakeStreamToOPFS(engine: any, key: string, options: StreamBakeOptions): Promise<void>;
}
