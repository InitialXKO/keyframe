import { WasmLoader } from "./wasm_loader.js";
export * from "./core.js";
export { WasmLoader };
export async function initWasmWeb(input) {
    return await WasmLoader.initWeb(input);
}
export function initWasmSync(bytes) {
    return WasmLoader.initSync(bytes);
}
