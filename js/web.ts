import { WasmLoader } from "./wasm_loader.js";
export * from "./core.js";
export { WasmLoader };

export async function initWasmWeb(input?: string | URL | ArrayBuffer | Response) {
  return await WasmLoader.initWeb(input);
}

export function initWasmSync(bytes: BufferSource) {
  return WasmLoader.initSync(bytes);
}
