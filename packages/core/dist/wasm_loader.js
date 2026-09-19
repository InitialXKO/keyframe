export class WasmLoader {
    static instance = null;
    static mode = "bundler";
    static setBundlerModule(wasmModule) {
        this.instance = wasmModule;
        this.mode = "bundler";
    }
    static async initWeb(input) {
        this.mode = "web";
        if (typeof input === "string" || input instanceof URL) {
            const response = await fetch(input);
            this.instance = (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
        }
        else if (input instanceof ArrayBuffer) {
            this.instance = (await WebAssembly.instantiate(input)).instance.exports;
        }
        else if (input instanceof Response) {
            this.instance = (await WebAssembly.instantiate(await input.arrayBuffer())).instance.exports;
        }
        return this.instance;
    }
    static initSync(bytes) {
        this.mode = "web";
        this.instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
        return this.instance;
    }
    static getWasmInstance() { return this.instance; }
    static getMode() { return this.mode; }
}
