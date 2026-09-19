export interface WasmInitOptions {
  moduleOrPath?: string | URL | ArrayBuffer | Response;
  wasmMemory?: WebAssembly.Memory;
}

export class WasmLoader {
  private static instance: any = null;
  private static mode: "bundler" | "web" | "custom" = "bundler";

  public static setBundlerModule(wasmModule: any): void {
    this.instance = wasmModule;
    this.mode = "bundler";
  }

  public static async initWeb(input?: string | URL | ArrayBuffer | Response): Promise<any> {
    this.mode = "web";
    if (typeof input === "string" || input instanceof URL) {
      const response = await fetch(input);
      this.instance = (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
    } else if (input instanceof ArrayBuffer) {
      this.instance = (await WebAssembly.instantiate(input)).instance.exports;
    } else if (input instanceof Response) {
      this.instance = (await WebAssembly.instantiate(await input.arrayBuffer())).instance.exports;
    }
    return this.instance;
  }

  public static initSync(bytes: BufferSource): any {
    this.mode = "web";
    this.instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
    return this.instance;
  }

  public static getWasmInstance(): any { return this.instance; }
  public static getMode(): "bundler" | "web" | "custom" { return this.mode; }
}
