/**
 * WASM Dual-Rail Loader for @keyframe/core
 * Track A (Default): WASM bundler target / inlined module for Webpack/Vite zero-config.
 * Track B (High Performance): WASM web target / initSync(fetch()) for off-main-thread async loading.
 */
export class WasmLoader {
    static instance = null;
    static mode = "bundler";
    /**
     * Track A: Set or register bundler/inline WASM module.
     */
    static setBundlerModule(wasmModule) {
        this.instance = wasmModule;
        this.mode = "bundler";
    }
    /**
     * Track B: Async initialization with initSync or fetch for web target.
     */
    static async initWeb(input) {
        this.mode = "web";
        if (typeof input === "string" || input instanceof URL) {
            const response = await fetch(input);
            const bytes = await response.arrayBuffer();
            const results = await WebAssembly.instantiate(bytes);
            this.instance = results.instance.exports;
        }
        else if (input instanceof ArrayBuffer) {
            const results = await WebAssembly.instantiate(input);
            this.instance = results.instance.exports;
        }
        else if (input instanceof Response) {
            const bytes = await input.arrayBuffer();
            const results = await WebAssembly.instantiate(bytes);
            this.instance = results.instance.exports;
        }
        return this.instance;
    }
    /**
     * Track B (Sync): Synchronous initialization with ArrayBuffer or Compiled Module.
     */
    static initSync(bytes) {
        this.mode = "web";
        const mod = new WebAssembly.Module(bytes);
        const inst = new WebAssembly.Instance(mod, {});
        this.instance = inst.exports;
        return this.instance;
    }
    static getWasmInstance() {
        return this.instance;
    }
    static getMode() {
        return this.mode;
    }
}
