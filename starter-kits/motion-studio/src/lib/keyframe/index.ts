/**
 * Vendored Keyframe Engine (from https://github.com/InitialXKO/keyframe)
 * Integration fixes applied vs upstream:
 *  - Type-only re-exports converted to `export type` (upstream breaks under SWC/esbuild/Bun)
 *  - `.js` extension imports normalized for Next.js webpack resolution
 *  - OPFS storage replaced with a memory-mode stub (same public surface)
 *  - Engine runs in pure-JS fallback mode (upstream WASM artifact is not published;
 *    CDN URL 404s). JS fallback implements identical math: cubic-bezier easing,
 *    quaternion slerp, timeline flattening, zero-copy Float32Array buffer layout.
 */
export * from "./builder/types";
export { Engine } from "./builder/engine";
export { Clip } from "./builder/clip";
export { Instance } from "./builder/instance";
export { Keyframe } from "./builder/keyframe";
export { TransformBuilder } from "./builder/transform";
export { AnimationPlayer, ControllerAdapter, controller } from "./controller";
export type { PlayerEvent, PlayerListener, PlayerOptions } from "./controller";
export { DOMAdapter, domAdapter } from "./dom_binder";
export type { BatchApplyOptions } from "./dom_binder";
export { RealTimeSpring } from "./physics/RealTimeSpring";
export * as Remotion from "./remotion/index";
