/// <reference types="@webgpu/types" />
/**
 * 星系渲染器 —— WebGPU 主路径 / WebGL2 回退
 *
 * 数据流：Rust WASM 内核 evaluate_frame_fast() → WebAssembly.Memory 中的
 * 80B/实例 GpuInstanceData（mat4×16 + opacity + visible + clipIndex + pad）
 * → queue.writeBuffer / texSubImage2D 零拷贝上传 → 实例化渲染 + 加性混合。
 *
 * 拖影：ping-pong 双缓冲，每帧先以 fade 系数衰减上一帧，再叠加本帧粒子。
 */

export type RenderBackend = "webgpu" | "webgl2";

export interface RendererFrame {
  /** wasm memory 中的实例视图（count × 20 floats） */
  instances: Float32Array | null;
  /** wasm memory 的 ArrayBuffer 引用（writeBuffer 直接切片用） */
  instanceBuffer: ArrayBuffer | null;
  byteOffset: number;
  byteLength: number;
  count: number;
  viewProj: Float32Array;
  pointScale: number;
  colorMode: number;
  selectedIdx: number;
  trails: boolean;
}

export interface GalaxyRenderer {
  backend: RenderBackend;
  resize(widthPx: number, heightPx: number): void;
  setColorBuffer(colors: Float32Array, count: number): void;
  render(frame: RendererFrame): void;
  destroy(): void;
}

const MAX_INSTANCES_CAP = 48000;

/* ---------------- 视图矩阵工具（列主序） ---------------- */

export function makeViewProj(
  zoom: number,
  panX: number,
  panY: number,
  rotZ: number,
  aspect: number,
): Float32Array {
  // proj = 正交(-aspect..aspect, -1..1)
  // view = T(pan) * Rz(rot) * S(zoom)
  const c = Math.cos(rotZ) * zoom;
  const s = Math.sin(rotZ) * zoom;
  // view (列主序):
  // | c -s  0  panX |
  // | s  c  0  panY |
  // | 0  0  1  0    |
  const v00 = c, v01 = s, v10 = -s, v11 = c;
  const tx = panX, ty = panY;
  // proj * view（正交矩阵为对角，直接组合）
  const out = new Float32Array(16);
  out[0] = (1 / aspect) * v00;
  out[1] = (1 / aspect) * v01;
  out[4] = v10;
  out[5] = v11;
  out[10] = 1;
  out[12] = (1 / aspect) * tx;
  out[13] = ty;
  out[15] = 1;
  return out;
}

/* ---------------- WGSL 着色器 ---------------- */

const WGSL = /* wgsl */ `
// ⚠ Uni 在 uniform 地址空间的 ABI：64B(mat4) + 4×4B 标量 + 3×4B padding = 92B
// → 按 struct 对齐(16)向上取整 = 96B（minBindingSize）。
// JS 端必须配 96B 缓冲 + 24-float 视图（viewData/uni），否则 draw 时
// "bound with size 80 ... requires at least 96 bytes" 整帧丢弃 → 黑屏。
struct Uni {
  viewProj : mat4x4<f32>,
  pointScale : f32,
  colorMode : u32,
  selected : i32,
  fade : f32,
  _p0 : u32,
  _p1 : u32,
  _p2 : u32,
}

struct Instance {
  m : mat4x4<f32>,
  opacity : f32,
  visible : u32,
  clipIndex : u32,
  _pad : u32,
}

@group(0) @binding(0) var<uniform> U : Uni;
@group(0) @binding(1) var<storage, read> parts : array<Instance>;
@group(0) @binding(2) var<storage, read> colors : array<vec4<f32>>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) sel : f32,
}

fn rampColor(t : f32) -> vec3<f32> {
  // IQ cosine palette：amber → rose → cyan
  return 0.55 + 0.45 * cos(6.28318 * (vec3<f32>(0.02, 0.28, 0.5) + vec3<f32>(t) * vec3<f32>(0.9, 0.7, 0.55)));
}

@vertex
fn vs_main(@location(0) corner : vec2<f32>, @builtin(instance_index) ii : u32) -> VOut {
  var out : VOut;
  let p = parts[ii];
  if (p.visible == 0u || p.opacity <= 0.001) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.local = corner;
    out.color = vec4<f32>(0.0);
    out.sel = 0.0;
    return out;
  }
  let selF = select(0.0, 1.0, i32(ii) == U.selected);
  let halfExtent = select(U.pointScale, U.pointScale * 2.2, selF > 0.5);
  let world = p.m * vec4<f32>(corner * 0.5 * halfExtent, 0.0, 1.0);
  out.pos = U.viewProj * world;
  out.local = corner;

  var base = colors[ii];
  if (U.colorMode == 1u) {
    let t = f32(p.clipIndex) * 0.083;
    base = vec4<f32>(rampColor(t), 1.0);
  } else if (U.colorMode == 2u) {
    base = vec4<f32>(1.0, 0.72, 0.35, 1.0);
  }
  let mixed = mix(base.rgb, vec3<f32>(1.0, 0.96, 0.9), selF * 0.85);
  out.color = vec4<f32>(mixed, p.opacity);
  out.sel = selF;
  return out;
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4<f32> {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let core = pow(max(0.0, 1.0 - d), 2.4);
  let glow = pow(max(0.0, 1.0 - d), 1.15) * 0.55;
  var a = clamp(core + glow, 0.0, 1.0) * in.color.a;
  if (in.sel > 0.5) { a = max(a, 0.55); }
  return vec4<f32>(in.color.rgb * a, a);
}

`;

// ---- fade 全屏 pass（独立模块）----
// ⚠ 不能与主模块共用：主模块的 U(uniform) 已占据 group(0) binding(0)，
// 若 fs_fade 同时静态引用 U 与 sampF(sampler @0) 会触发绑定槽冲突，
// createRenderPipeline 验证失败 → invalid pipeline → queue.submit 整帧丢弃 → 黑屏。
// （headless 无 WebGPU 走 WebGL2 从未暴露；真机 Chrome 首次暴露。）
const WGSL_FADE = /* wgsl */ `
struct FadeUni {
  fade : f32,
  _p0 : u32,
  _p1 : u32,
  _p2 : u32,
}

@group(0) @binding(0) var sampF : sampler;
@group(0) @binding(1) var texF : texture_2d<f32>;
@group(0) @binding(2) var<uniform> FU : FadeUni;

struct FOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }

@vertex
fn vs_fade(@location(0) corner : vec2<f32>) -> FOut {
  var out : FOut;
  out.pos = vec4<f32>(corner, 0.0, 1.0);
  out.uv = vec2<f32>(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

@fragment
fn fs_fade(in : FOut) -> @location(0) vec4<f32> {
  return textureSample(texF, sampF, in.uv) * vec4<f32>(vec3<f32>(FU.fade), 1.0);
}
`;

const WGSL_BLIT = /* wgsl */ `
@group(0) @binding(0) var sampB : sampler;
@group(0) @binding(1) var texB : texture_2d<f32>;

struct BOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }

@vertex
fn vs_blit(@location(0) corner : vec2<f32>) -> BOut {
  var out : BOut;
  out.pos = vec4<f32>(corner, 0.0, 1.0);
  out.uv = vec2<f32>(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

@fragment
fn fs_blit(in : BOut) -> @location(0) vec4<f32> {
  var c = textureSample(texB, sampB, in.uv);
  c = c / (1.0 + c * 0.22); // 轻量色调映射防高光死白
  return vec4<f32>(c.rgb, 1.0);
}
`;

/* ---------------- WebGPU 实现 ---------------- */

class WebGPURenderer implements GalaxyRenderer {
  backend: RenderBackend = "webgpu";
  private device: GPUDevice;
  private ctx: GPUCanvasContext;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private uni: GPUBuffer;
  private parts: GPUBuffer;
  private colors: GPUBuffer;
  private quad: GPUBuffer;
  private particlePipe: GPURenderPipeline;
  private fadePipe: GPURenderPipeline;
  private blitPipe: GPURenderPipeline;
  private sampler: GPUSampler;
  private texA: GPUTexture | null = null;
  private texB: GPUTexture | null = null;
  private flip = false;
  private maxInstances: number;
  /** 96B = 24 floats（WGSL Uni 布局：16 矩阵 + 4 标量 + 4 padding，见 WGSL 注释） */
  private viewData = new Float32Array(24);
  /** 同一 buffer 的 u32 视图 —— colorMode(u32)/selected(i32) 必须按位型写入 */
  private viewU32 = new Uint32Array(this.viewData.buffer);
  private fadeData = new Float32Array(4);
  private fadeUni: GPUBuffer;
  /** 运行期致命错误（设备丢失 / 未捕获验证错误）回调 —— 用于自愈回退 WebGL2 */
  onFatal: ((reason: string) => void) | null = null;
  private dead = false;
  private bindParticle: GPUBindGroup;
  private width = 1;
  private height = 1;

  private constructor(
    device: GPUDevice,
    ctx: GPUCanvasContext,
    canvas: HTMLCanvasElement,
    format: GPUTextureFormat,
    maxInstances: number,
  ) {
    this.device = device;
    this.ctx = ctx;
    this.canvas = canvas;
    this.format = format;
    this.maxInstances = maxInstances;

    // 96B：与 WGSL Uni 结构对齐后尺寸一致（80B 会在 draw 时验证失败）
    this.uni = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.parts = device.createBuffer({
      size: maxInstances * 80,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.colors = device.createBuffer({
      size: maxInstances * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const corners = new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]);
    this.quad = device.createBuffer({
      size: corners.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quad, 0, corners);
    this.fadeUni = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({ code: WGSL });
    const blitModule = device.createShaderModule({ code: WGSL_BLIT });

    const particleLayout = device.createBindGroupLayout({
      entries: [
        // minBindingSize 显式等于 WGSL 派生值：未来若 JS/WGSL 尺寸再漂移，
        // createBindGroup 会在初始化 error scope 内就失败（同步回退），
        // 而不是每帧 draw 时静默丢帧
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 96 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const fadeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16 } },
      ],
    });
    // blit 只用 sampler+texture 两个绑定 —— 不能复用 3-entry 的 fadeLayout，
    // 否则 createBindGroup(2 entries) 与布局(3 entries)不匹配 → 整帧丢弃
    const blitLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    this.particlePipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [particleLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { operation: "add", srcFactor: "one", dstFactor: "one" },
              alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    const fadeModule = device.createShaderModule({ code: WGSL_FADE });
    this.fadePipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [fadeLayout] }),
      vertex: {
        module: fadeModule,
        entryPoint: "vs_fade",
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: fadeModule,
        entryPoint: "fs_fade",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.blitPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blitLayout] }),
      vertex: {
        module: blitModule,
        entryPoint: "vs_blit",
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: blitModule,
        entryPoint: "fs_blit",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

    this.bindParticle = device.createBindGroup({
      layout: particleLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uni } },
        { binding: 1, resource: { buffer: this.parts } },
        { binding: 2, resource: { buffer: this.colors } },
      ],
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    maxInstances: number,
    onFatal?: (reason: string) => void,
  ): Promise<WebGPURenderer | null> {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    if (isWebGPUDead()) return null; // 运行期已致命失败 → 直接走 WebGL2
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const ctx = canvas.getContext("webgpu");
    if (!ctx) return null;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "opaque" });

    // 初始化期验证错误同步捕获：管线/着色器绑定错误（如 fade 绑定冲突这类）
    // 在 createRenderPipeline 时即入 scope，若命中则抛出 → 工厂回退 WebGL2，
    // 而不是带着 invalid pipeline 每帧静默丢帧（用户视角 = 黑屏）。
    device.pushErrorScope("validation");
    let renderer: WebGPURenderer;
    try {
      renderer = new WebGPURenderer(
        device,
        ctx,
        canvas,
        format,
        Math.min(maxInstances, MAX_INSTANCES_CAP),
      );
    } catch (e) {
      device.popErrorScope().catch(() => {});
      throw e;
    }
    const initErr = await device.popErrorScope().catch(() => null);
    if (initErr) {
      console.error("[massviz] WebGPU 管线验证失败 → 回退 WebGL2:", initErr.message);
      renderer.destroy();
      markWebGPUDead();
      return null;
    }

    // 运行期致命错误（设备丢失 / 未捕获验证错误）→ 通知宿主自愈
    device.onuncapturederror = (ev) => {
      console.error("[massviz] WebGPU 未捕获错误:", ev.error?.message ?? ev.error);
      renderer.dead = true;
      markWebGPUDead();
      onFatal?.("webgpu-uncaptured-error");
    };
    void device.lost.then((info) => {
      // dead=true 时是我们自愈流程主动 device.destroy() 触发的连锁事件，
      // 属预期行为 → warn 即可；否则才是真正的意外设备丢失
      if (renderer.dead) {
        console.warn("[massviz] WebGPU 设备已主动释放:", info.reason);
        return;
      }
      console.error("[massviz] WebGPU 设备丢失:", info.reason, info.message);
      renderer.dead = true;
      markWebGPUDead();
      onFatal?.(`device-lost:${info.reason}`);
    });
    renderer.onFatal = onFatal ?? null;
    return renderer;
  }

  resize(widthPx: number, heightPx: number) {
    this.width = Math.max(1, widthPx);
    this.height = Math.max(1, heightPx);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.texA?.destroy();
    this.texB?.destroy();
    const desc: GPUTextureDescriptor = {
      size: [this.width, this.height],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };
    this.texA = this.device.createTexture(desc);
    this.texB = this.device.createTexture(desc);
    this.flip = false;
  }

  setColorBuffer(colors: Float32Array, _count: number) {
    this.device.queue.writeBuffer(
      this.colors,
      0,
      colors.buffer as ArrayBuffer,
      colors.byteOffset,
      colors.byteLength,
    );
  }

  render(frame: RendererFrame) {
    if (this.dead) return;
    const device = this.device;
    const fade = frame.trails ? 0.86 : 0.0;
    const data = this.viewData;
    data[0] = frame.viewProj[0];
    data[1] = frame.viewProj[1];
    for (let i = 2; i < 16; i++) data[i] = frame.viewProj[i];
    data[16] = frame.pointScale;
    // WGSL: colorMode: u32, selected: i32 —— 必须按整型位型写入，
    // 用 f32 写 1.0 会被读成 0x3F800000(1065353216)，着色模式/选中高亮全部失效
    this.viewU32[17] = frame.colorMode >>> 0;
    this.viewU32[18] = frame.selectedIdx | 0;
    data[19] = fade;
    device.queue.writeBuffer(this.uni, 0, data);
    this.fadeData[0] = fade;
    device.queue.writeBuffer(this.fadeUni, 0, this.fadeData);

    if (frame.instances && frame.count > 0 && frame.instanceBuffer) {
      device.queue.writeBuffer(
        this.parts,
        0,
        frame.instanceBuffer,
        frame.byteOffset,
        frame.byteLength,
      );
    }

    const src = this.flip ? this.texB : this.texA;
    const dst = this.flip ? this.texA : this.texB;
    this.flip = !this.flip;
    if (!src || !dst) return;

    const encoder = device.createCommandEncoder();

    // 1) 衰减上一帧 → dst
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dst.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.fadePipe);
      pass.setBindGroup(0, device.createBindGroup({
        layout: this.fadePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: src.createView() },
          { binding: 2, resource: { buffer: this.fadeUni } },
        ],
      }));
      pass.setVertexBuffer(0, this.quad);
      pass.draw(6);
      pass.end();
    }

    // 2) 粒子叠加 → dst
    if (frame.count > 0) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dst.createView(),
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.particlePipe);
      pass.setBindGroup(0, this.bindParticle);
      pass.setVertexBuffer(0, this.quad);
      pass.draw(6, frame.count);
      pass.end();
    }

    // 3) blit → 画布
    {
      const view = this.ctx.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.blitPipe);
      pass.setBindGroup(0, device.createBindGroup({
        layout: this.blitPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: dst.createView() },
        ],
      }));
      pass.setVertexBuffer(0, this.quad);
      pass.draw(6);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.dead = true;
    this.texA?.destroy();
    this.texB?.destroy();
    this.uni.destroy();
    this.parts.destroy();
    this.colors.destroy();
    this.quad.destroy();
    this.fadeUni.destroy();
    this.device.destroy();
  }
}

/* ---------------- WebGL2 实现（回退） ---------------- */
//
// 实例数据通路：WebGL2 核心 instancing（vertexAttribDivisor）+ 每实例
// 5×vec4 矩阵/元数据属性 + 1×vec4 颜色属性。每帧先从 WASM 视图拷贝到
// 常规缓冲（部分实现对 grow 过的 WebAssembly.Memory 视图上传不可靠），
// 再 bufferSubData 一次上传。POINTS 绘制，加性混合。

const GL2_PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aM0;
layout(location = 1) in vec4 aM1;
layout(location = 2) in vec4 aM2;
layout(location = 3) in vec4 aM3;
layout(location = 4) in vec4 aMeta; // opacity, visible, clipIndex, pad
layout(location = 5) in vec4 aColor;
uniform mat4 uViewProj;
uniform float uPointScale;
uniform float uPxPerWorld;
uniform int uSelected;
uniform int uColorMode; // 0=星系调色板 1=母题色带 2=单色琥珀（与 WebGPU 语义对齐）
out vec4 vColor;
out float vSel;
vec3 rampColor(float t) {
  // IQ cosine palette：amber → rose → cyan（与 WGSL rampColor 同参数）
  return 0.55 + 0.45 * cos(6.28318 * (vec3(0.02, 0.28, 0.5) + t * vec3(0.9, 0.7, 0.55)));
}
void main() {
  vSel = (gl_InstanceID == uSelected) ? 1.0 : 0.0;
  // ⚠ visible 是 u32 位型（0x00000001），按 float 读是 1.4e-45 —— 必须按位重解释
  if (aMeta.x <= 0.001 || floatBitsToUint(aMeta.y) == 0u) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vColor = vec4(0.0);
    return;
  }
  mat4 m = mat4(aM0, aM1, aM2, aM3);
  float size = aM0.x * uPointScale * (1.0 + vSel * 1.2);
  gl_PointSize = clamp(size * uPxPerWorld, 1.0, 200.0);
  gl_Position = uViewProj * m * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 base = aColor;
  if (uColorMode == 1) {
    base = vec4(rampColor(float(aMeta.z) * 0.083), 1.0);
  } else if (uColorMode == 2) {
    base = vec4(1.0, 0.72, 0.35, 1.0);
  }
  vColor = vec4(base.rgb, aMeta.x);
}`;

const GL2_PARTICLE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in float vSel;
out vec4 frag;
void main() {
  vec2 d2 = gl_PointCoord * 2.0 - 1.0;
  float d = length(d2);
  if (d > 1.0) discard;
  float core = pow(max(0.0, 1.0 - d), 2.4);
  float glow = pow(max(0.0, 1.0 - d), 1.15) * 0.55;
  float a = clamp(core + glow, 0.0, 1.0) * vColor.a;
  if (vSel > 0.5) a = max(a, 0.55);
  vec3 rgb = mix(vColor.rgb, vec3(1.0, 0.96, 0.9), vSel * 0.85);
  frag = vec4(rgb * a, a);
}`;

const GL2_QUAD_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0))[gl_VertexID];
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

function gl2QuadFS(body: string) {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uFade;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv);
  ${body}
}`;
}

class WebGL2Renderer implements GalaxyRenderer {
  backend: RenderBackend = "webgl2";
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private progP: WebGLProgram;
  private progFade: WebGLProgram;
  private progBlit: WebGLProgram;
  private uniP: Record<string, WebGLUniformLocation | null> = {};
  private bufInst: WebGLBuffer;
  private bufColor: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private fboA: WebGLFramebuffer;
  private fboB: WebGLFramebuffer;
  private flip = false;
  private width = 1;
  private height = 1;
  private maxInstances: number;
  private scratch: Float32Array;

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, maxInstances: number) {
    this.gl = gl;
    this.canvas = canvas;
    this.maxInstances = maxInstances;
    this.progP = this.link(GL2_PARTICLE_VS, GL2_PARTICLE_FS);
    this.progFade = this.link(GL2_QUAD_VS, gl2QuadFS("frag = c * vec4(vec3(uFade), 1.0);"));
    this.progBlit = this.link(GL2_QUAD_VS, gl2QuadFS("frag = vec4(c.rgb / (1.0 + c.rgb * 0.22), 1.0);"));

    for (const n of ["uViewProj", "uPointScale", "uPxPerWorld", "uSelected", "uColorMode"]) {
      this.uniP[n] = gl.getUniformLocation(this.progP, n);
    }

    // 实例矩阵/元数据缓冲（80B/实例，与内核 GpuInstanceData 同构）
    this.bufInst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufInst);
    gl.bufferData(gl.ARRAY_BUFFER, maxInstances * 80, gl.DYNAMIC_DRAW);
    this.bufColor = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.bufferData(gl.ARRAY_BUFFER, maxInstances * 16, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufInst);
    for (let i = 0; i < 5; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 80, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    this.texA = this.allocTex();
    this.texB = this.allocTex();
    this.fboA = this.allocFbo(this.texA);
    this.fboB = this.allocFbo(this.texB);
    this.scratch = new Float32Array(maxInstances * 20);
  }

  private allocTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private allocFbo(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`着色器编译失败: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`程序链接失败: ${gl.getProgramInfoLog(p)}`);
    }
    return p;
  }

  static create(canvas: HTMLCanvasElement, maxInstances: number): WebGL2Renderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    try {
      return new WebGL2Renderer(gl, canvas, Math.min(maxInstances, MAX_INSTANCES_CAP));
    } catch {
      return null;
    }
  }

  resize(widthPx: number, heightPx: number) {
    this.width = Math.max(1, widthPx);
    this.height = Math.max(1, heightPx);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const gl = this.gl;
    for (const tex of [this.texA, this.texB]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.clearColor(0, 0, 0, 1);
    for (const fbo of [this.fboA, this.fboB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.flip = false;
  }

  setColorBuffer(colors: Float32Array, _count: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
  }

  render(frame: RendererFrame) {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    const src = this.flip ? this.texB : this.texA;
    const dst = this.flip ? this.texA : this.texB;
    const dstFbo = this.flip ? this.fboA : this.fboB;
    this.flip = !this.flip;

    // 实例数据：WASM 视图 → scratch 拷贝 → 一次 bufferSubData
    if (frame.instances && frame.count > 0) {
      const floats = frame.count * 20;
      if (this.scratch.length < floats) this.scratch = new Float32Array(floats);
      this.scratch.set(frame.instances.subarray(0, floats));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufInst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.scratch, 0, floats);
    }

    // 1) 衰减（拖影）
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progFade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(this.progFade, "uTex"), 0);
    gl.uniform1f(gl.getUniformLocation(this.progFade, "uFade"), frame.trails ? 0.86 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) 粒子（加性混合，instanced POINTS）
    if (frame.count > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.progP);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix4fv(this.uniP.uViewProj!, false, frame.viewProj);
      gl.uniform1f(this.uniP.uPointScale!, frame.pointScale);
      gl.uniform1f(this.uniP.uPxPerWorld!, (this.height / 2) * frame.viewProj[5]);
      gl.uniform1i(this.uniP.uSelected!, frame.selectedIdx);
      gl.uniform1i(this.uniP.uColorMode!, frame.colorMode | 0);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, frame.count);
      gl.bindVertexArray(null);
    }

    // 3) blit 到画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst);
    gl.uniform1i(gl.getUniformLocation(this.progBlit, "uTex"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

  }

  destroy() {
    const gl = this.gl;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/* ---------------- 工厂 ---------------- */

let webgpuDead = false;
/** 运行期致命错误后置位：后续 createRenderer 一律直接走 WebGL2（自愈） */
export function markWebGPUDead() {
  webgpuDead = true;
}
export function isWebGPUDead() {
  return webgpuDead;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  maxInstances: number,
  onFatal?: (reason: string) => void,
): Promise<{ renderer: GalaxyRenderer | null; error?: string }> {
  try {
    const gpu = await WebGPURenderer.create(canvas, maxInstances, onFatal);
    if (gpu) return { renderer: gpu };
  } catch (err) {
    // WebGPU 初始化失败 → 回退
    console.warn("[massviz] WebGPU 初始化失败，尝试 WebGL2 回退:", err);
  }
  try {
    const gl2 = WebGL2Renderer.create(canvas, maxInstances);
    if (gl2) return { renderer: gl2 };
  } catch (err) {
    console.error("[massviz] WebGL2 回退也失败:", err);
    return { renderer: null, error: String(err) };
  }
  return { renderer: null, error: "WebGPU 与 WebGL2 均不可用" };
}
