/**
 * WASM Dual-Rail Loader for @keyframe/core
 * Track A (Default): WASM bundler target / inlined module for Webpack/Vite zero-config.
 * Track B (High Performance): WASM web target / initSync(fetch()) for off-main-thread async loading.
 */
export interface WasmInitOptions {
    moduleOrPath?: string | URL | ArrayBuffer | Response;
    wasmMemory?: WebAssembly.Memory;
}
export declare class WasmLoader {
    private static instance;
    private static mode;
    /**
     * Track A: Set or register bundler/inline WASM module.
     */
    static setBundlerModule(wasmModule: any): void;
    /**
     * Track B: Async initialization with initSync or fetch for web target.
     */
    static initWeb(input?: string | URL | ArrayBuffer | Response): Promise<any>;
    /**
     * Track B (Sync): Synchronous initialization with ArrayBuffer or Compiled Module.
     */
    static initSync(bytes: BufferSource): any;
    static getWasmInstance(): any;
    static getMode(): "bundler" | "web" | "custom";
}
