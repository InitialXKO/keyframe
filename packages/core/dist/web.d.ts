import { WasmLoader } from "./wasm_loader.js";
export * from "./core.js";
export { WasmLoader };
export declare function initWasmWeb(input?: string | URL | ArrayBuffer | Response): Promise<any>;
export declare function initWasmSync(bytes: BufferSource): any;
