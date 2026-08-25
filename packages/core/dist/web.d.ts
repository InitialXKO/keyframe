export * from "./index.js";
export { WasmLoader } from "./wasm_loader.js";
/**
 * High performance Track B entry: initSync / fetch loading.
 */
export declare function initWasmWeb(input?: string | URL | ArrayBuffer | Response): Promise<any>;
export declare function initWasmSync(bytes: BufferSource): any;
