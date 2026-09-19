export declare class OPFSStorage {
    private rootPromise;
    private memoryFallback;
    private frameIndex;
    private mounted;
    constructor();
    isOPFSSupported(): boolean;
    isMounted(): boolean;
    mount(): Promise<boolean>;
    buildFrameIndex(): Promise<Map<number, any>>;
    getFrameFromIndex(timestamp: number): any;
    appendChunk(filename: string, chunk: Uint8Array): Promise<void>;
    write(filename: string, data: Uint8Array): Promise<void>;
    read(filename: string): Promise<Uint8Array>;
    remove(filename: string): Promise<void>;
}
export interface OPFSWriter {
    write(chunk: Uint8Array): void | Promise<void>;
    close(): void | Promise<void>;
    flush?(): void | Promise<void>;
    getBytes?(): Uint8Array;
}
export declare class SyncOPFSWriter implements OPFSWriter {
    private accessHandle;
    constructor(accessHandle: any);
    write(chunk: Uint8Array): void;
    flush(): void;
    close(): void;
}
export declare class AsyncOPFSWriter implements OPFSWriter {
    private writableStream;
    constructor(writableStream: any);
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
export declare class MemoryWriter implements OPFSWriter {
    private chunks;
    private totalLength;
    write(chunk: Uint8Array): void;
    close(): void;
    getBytes(): Uint8Array;
}
export declare function createSyncOPFSWriter(filename: string): Promise<OPFSWriter>;
export declare function createAsyncOPFSWriter(filename: string): Promise<OPFSWriter>;
export declare function createMemoryWriter(): MemoryWriter;
export declare function createOPFSWriter(filename: string): Promise<OPFSWriter>;
