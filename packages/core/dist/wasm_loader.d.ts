export interface WasmInitOptions {
    moduleOrPath?: string | URL | ArrayBuffer | Response;
    wasmMemory?: WebAssembly.Memory;
}
export declare class WasmLoader {
    private static instance;
    private static mode;
    static setBundlerModule(wasmModule: any): void;
    static initWeb(input?: string | URL | ArrayBuffer | Response): Promise<any>;
    static initSync(bytes: BufferSource): any;
    static getWasmInstance(): any;
    static getMode(): "bundler" | "web" | "custom";
}
