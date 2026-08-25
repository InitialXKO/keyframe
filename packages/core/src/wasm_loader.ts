/**
 * WASM Dual-Rail Loader for @keyframe/core
 * Track A (Default): WASM bundler target / inlined module for Webpack/Vite zero-config.
 * Track B (High Performance): WASM web target / initSync(fetch()) for off-main-thread async loading.
 */

export interface WasmInitOptions {
  moduleOrPath?: string | URL | ArrayBuffer | Response;
  wasmMemory?: WebAssembly.Memory;
}

export class WasmLoader {
  private static instance: any = null;
  private static mode: "bundler" | "web" | "custom" = "bundler";

  /**
   * Track A: Set or register bundler/inline WASM module.
   */
  public static setBundlerModule(wasmModule: any): void {
    this.instance = wasmModule;
    this.mode = "bundler";
  }

  /**
   * Track B: Async initialization with initSync or fetch for web target.
   */
  public static async initWeb(input?: string | URL | ArrayBuffer | Response): Promise<any> {
    this.mode = "web";
    if (typeof input === "string" || input instanceof URL) {
      const response = await fetch(input);
      const bytes = await response.arrayBuffer();
      const results = await WebAssembly.instantiate(bytes);
      this.instance = results.instance.exports;
    } else if (input instanceof ArrayBuffer) {
      const results = await WebAssembly.instantiate(input);
      this.instance = results.instance.exports;
    } else if (input instanceof Response) {
      const bytes = await input.arrayBuffer();
      const results = await WebAssembly.instantiate(bytes);
      this.instance = results.instance.exports;
    }
    return this.instance;
  }

  /**
   * Track B (Sync): Synchronous initialization with ArrayBuffer or Compiled Module.
   */
  public static initSync(bytes: BufferSource): any {
    this.mode = "web";
    const mod = new WebAssembly.Module(bytes);
    const inst = new WebAssembly.Instance(mod, {});
    this.instance = inst.exports;
    return this.instance;
  }

  public static getWasmInstance(): any {
    return this.instance;
  }

  public static getMode(): "bundler" | "web" | "custom" {
    return this.mode;
  }
}
