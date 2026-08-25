import { WasmLoader } from "./wasm_loader.js";
export * from "./index.js";
export { WasmLoader };

/**
 * High performance Track B entry: initSync / fetch loading.
 */
export async function initWasmWeb(input?: string | URL | ArrayBuffer | Response) {
  return await WasmLoader.initWeb(input);
}

export function initWasmSync(bytes: BufferSource) {
  return WasmLoader.initSync(bytes);
}
