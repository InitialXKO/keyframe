import { WasmLoader } from "./wasm_loader.js";
export * from "./index.js";
export { WasmLoader };
/**
 * High performance Track B entry: initSync / fetch loading.
 */
export async function initWasmWeb(input) {
    return await WasmLoader.initWeb(input);
}
export function initWasmSync(bytes) {
    return WasmLoader.initSync(bytes);
}
