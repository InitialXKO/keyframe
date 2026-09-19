import { OPFSStorage } from "./opfs_storage.js";
import { EvaluatedInstance } from "./builder/types.js";
export interface StreamBakeOptions {
    startMs: number;
    endMs: number;
    fps?: number;
    chunkSizeMs?: number;
    onProgress?: (progressPercent: number) => void;
}
export interface LoadBakeDataOptions {
    decode?: boolean;
}
export declare class StorageAdapter {
    private opfs;
    getOPFS(): OPFSStorage;
    saveIR(key: string, irObject: any): Promise<void>;
    loadIR(key: string): Promise<any>;
    saveBakeData(key: string, bakeBytes: Uint8Array): Promise<void>;
    loadBakeData(key: string, decode?: false): Promise<Uint8Array>;
    loadBakeData(key: string, decode: true): Promise<EvaluatedInstance[]>;
    loadBakeData(key: string, options: {
        decode: true;
    }): Promise<EvaluatedInstance[]>;
    loadBakeData(key: string, options?: LoadBakeDataOptions): Promise<Uint8Array | EvaluatedInstance[]>;
    bakeStreamToOPFS(engine: any, key: string, options: StreamBakeOptions): Promise<void>;
}
