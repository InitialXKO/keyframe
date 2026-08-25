export declare class OPFSStorage {
    private rootPromise;
    private memoryFallback;
    constructor();
    isOPFSSupported(): boolean;
    appendChunk(filename: string, chunk: Uint8Array): Promise<void>;
    write(filename: string, data: Uint8Array): Promise<void>;
    read(filename: string): Promise<Uint8Array>;
    remove(filename: string): Promise<void>;
}
