/**
 * Rust WASM 关键帧内核加载器
 *
 * 加载由 `rust/keyframe-engine`（vendor 自 InitialXKO/keyframe + 自研 fast-path）
 * 编译出的 wasm-bindgen `--target web` 胶水模块：
 *   - 胶水 JS 从 /public/wasm 以 blob 模块动态导入（绕开打包器静态分析）
 *   - .wasm 以 ArrayBuffer 手动传入 init()（绕开胶水内部基于 import.meta.url 的 fetch）
 *   - init() 返回 InitOutput，其中的 WebAssembly.Memory 用于零拷贝 GPU 上传
 */

export interface KernelEngine {
  add_clip_json(clipJson: string): void;
  add_instance_json(instanceJson: string): void;
  set_root_timeline_json(timelineJson: string): void;
  prepare(): void;
  prepare_fast(): void;
  evaluate_frame(globalTime: number): number;
  evaluate_frame_fast(globalTime: number): number;
  get_instance_buffer_ptr(): number;
  get_instance_buffer_byte_length(): number;
  fast_buffer_ptr(): number;
  fast_buffer_byte_length(): number;
  instance_size(): number;
  export_ir_json(): string;
  import_ir_json(irJson: string): void;
  bake_chunk(startMs: number, endMs: number, fps: number): Uint8Array;
  free(): void;
}

interface GlueModule {
  default(init?: unknown): Promise<{ memory: WebAssembly.Memory }>;
  KeyframeEngine: new () => KernelEngine;
  kernel_build_info(): string;
}

export interface Kernel {
  /** 新建一个内核实例（重建场景时调用，旧实例应 free()） */
  createEngine(): KernelEngine;
  /** wasm 线性内存 —— fast_buffer_ptr() 指向其中的 80B/实例 GPU 实例数据 */
  memory: WebAssembly.Memory;
  buildInfo: string;
}

export const WASM_GLUE_URL = "/wasm/keyframe_engine.js";
export const WASM_BIN_URL = "/wasm/keyframe_engine_bg.wasm";

let kernelPromise: Promise<Kernel> | null = null;

export function loadKeyframeKernel(): Promise<Kernel> {
  if (!kernelPromise) {
    kernelPromise = loadKernelInternal().catch((err) => {
      kernelPromise = null;
      throw err;
    });
  }
  return kernelPromise;
}

/**
 * 动态导入 blob 模块，双通道：
 * 1. new Function("u","return import(u)") —— 常规路径（打包器不可见）
 * 2. <script type="module"> 注入 —— 受限 CSP（无 unsafe-eval）环境回退，
 *    如预览容器 iframe 注入了不带 eval 的 script-src 时路径 1 抛 EvalError
 */
function importGlueModule(url: string): Promise<GlueModule> {
  try {
    const importDynamic = new Function("u", "return import(u)") as (
      u: string,
    ) => Promise<GlueModule>;
    return importDynamic(url);
  } catch (err) {
    // CSP 拦截 eval → 走 script 标签模块注入
    if (typeof document === "undefined") throw err;
    return new Promise<GlueModule>((resolve, reject) => {
      const anchor = "__kfGlueModule" + Math.random().toString(36).slice(2);
      const w = window as unknown as Record<string, unknown>;
      w[anchor] = (m: GlueModule) => {
        delete w[anchor];
        script.remove();
        resolve(m);
      };
      const script = document.createElement("script");
      script.type = "module";
      script.textContent =
        `import * as M from ${JSON.stringify(url)};` +
        `window[${JSON.stringify(anchor)}]?.(M);`;
      script.onerror = () => {
        delete w[anchor];
        reject(new Error("胶水模块 script 注入失败（CSP/网络）"));
      };
      document.head.appendChild(script);
    });
  }
}

async function loadKernelInternal(): Promise<Kernel> {
  if (typeof WebAssembly === "undefined") {
    throw new Error("当前环境不支持 WebAssembly");
  }

  const [glueSrc, wasmBytes] = await Promise.all([
    fetch(WASM_GLUE_URL).then((r) => {
      if (!r.ok) throw new Error(`胶水模块加载失败: ${r.status}`);
      return r.text();
    }),
    fetch(WASM_BIN_URL).then((r) => {
      if (!r.ok) throw new Error(`WASM 内核加载失败: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  // 以 blob 模块导入胶水（绕开打包器静态分析）
  const blobUrl = URL.createObjectURL(
    new Blob([glueSrc], { type: "text/javascript" }),
  );
  const glue = await importGlueModule(blobUrl);

  // 手动喂 wasm 字节，避免胶水内部基于 import.meta.url 的相对路径 fetch
  const exports = await glue.default(new Uint8Array(wasmBytes));

  return {
    createEngine() {
      return new glue.KeyframeEngine();
    },
    memory: exports.memory,
    buildInfo: glue.kernel_build_info(),
  };
}
