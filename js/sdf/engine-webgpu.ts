// ============================================================
// SDF 实体构造与渲染引擎 —— WebGPU 后端（WGSL）
// 与 WebGL2 后端同一公开接口（frame/probe/pickAt/setScene/loadScene），
// 共用 pack.ts 的 uniform 打包，保证双后端场景数据逐位一致。
// 探针拾取：1×1 rgba32float 渲染 + copyTextureToBuffer 异步读回。
// ============================================================
import { PRESETS, LABELS, SdfScene, SdfPrim, solveKinematics, axisAngle, qmul } from './scene.js';
import { WGSL } from './shader-wgsl.js';
import { cpuProbe, makePickCtx } from './eval-cpu.js';
import { MAXP, packStatic, packPoses, packBlock, sceneSeed } from './pack.js';
import type { PackedStatic, ProbeResult } from './pack.js';
import { solvePoses, initKeyframeBridge, disposeKeyframeBridge, isKeyframeBridgeActive, type SdfKeyframeConfig } from './keyframe-bridge.js';

export interface SdfWebGPUPickResult {
  hit: boolean;
  source: string;
  point: [number, number, number];
  normal: [number, number, number];
  distance: number;
  unit: string;
  label: string;
  labelA: number;
  labelB: number;
  blend: number;
  curvature: number;
  extra?: Record<string, any>;
}

export type UnifiedPick = SdfWebGPUPickResult;

const TANF = 0.3839;

type Q = [number, number, number, number];
type V3 = [number, number, number];

function qrot(q: Q, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const c1: V3 = [qy * v[2] - qz * v[1], qz * v[0] - qx * v[2], qx * v[1] - qy * v[0]];
  const w1: V3 = [c1[0] + qw * v[0], c1[1] + qw * v[1], c1[2] + qw * v[2]];
  const c2: V3 = [qy * w1[2] - qz * w1[1], qz * w1[0] - qx * w1[2], qx * w1[1] - qy * w1[0]];
  return [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]];
}
function qrotInv(q: Q, v: V3): V3 {
  return qrot([-q[0], -q[1], -q[2], q[3]], v);
}
function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// GPUBufferUsage / GPUTextureUsage / GPUMapMode 常量（避免引入 @webgpu/types 依赖）
// 对齐 WebGPU 规范：MAP_READ=0x0001, MAP_WRITE=0x0002, COPY_SRC=0x0004, COPY_DST=0x0008, UNIFORM=0x0040
const BUF_UNIFORM = 0x40, BUF_COPY_DST = 0x08, BUF_MAP_READ = 0x01, BUF_COPY_SRC = 0x04;
const TEX_RENDER_ATTACHMENT = 0x10, TEX_COPY_SRC = 0x01;
const MAP_READ = 0x1;
// uniform block 大小：9 头部 vec4（含 uCluster）+ 6 组 × 16 vec4 = 420 floats = 1680 字节
// 与 pack.ts BLOCK_FLOATS 单一数据源对齐（扩容时两处必须同步）
const BLOCK_BYTES = (36 + MAXP * 4 * 6) * 4;

export class SdfWebGPUEngine {
  readonly backend = 'WebGPU / WGSL';
  adapterName = '';
  floatProbe = true;
  private canvas: HTMLCanvasElement;
  private device: any;
  private ctx: any;
  private pipeline: any;
  private probePipeline: any;
  private ubuf: any;
  private bind: any;
  private probeBind: any;
  private probeTex: any;
  private probeBuf: any;
  private ready = false;
  onError?: (msg: string) => void;

  sc!: SdfScene;
  private st!: PackedStatic;
  private P1 = new Float32Array(MAXP * 4);
  private P3 = new Float32Array(MAXP * 4);
  private waveMax = 0;
  // 磨损痕迹持久化层（与 WebGL2 后端同语义）
  private wearAges = new Map<string, number>();
  private wearKey = '';
  wearAge = 0;

  yaw = 0.55;
  pitch = 0.30;
  dist = 2.3;
  zoom = 1.0;
  timeSec = 0;
  paused = false;
  speed = 1;
  renderScale = 0.72;
  fps = 0;
  private fpsEma = 0;
  private frames = 0;
  private lastT = 0;
  private animId = 0;

  // 演示动画与集群增殖（取长补短移植自 solid-demo：装配波/过渡脉动/自动环视/域重复实例层）
  assemble = false;
  pulse = false;
  orbit = false;
  clusterOn = false;
  clusterCell = 5.5;
  clusterSpread = 0.6;
  private radius0 = new Float32Array(MAXP); // 过渡半径基线（脉动调制用）

  private constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement, onError?: (msg: string) => void): Promise<SdfWebGPUEngine> {
    const inflight = SdfWebGPUEngine.inflight.get(canvas);
    if (inflight) return inflight;
    const p = this.createInner(canvas, onError).finally(() => SdfWebGPUEngine.inflight.delete(canvas));
    SdfWebGPUEngine.inflight.set(canvas, p);
    return p;
  }

  private static inflight = new Map<HTMLCanvasElement, Promise<SdfWebGPUEngine>>();

  private static async createInner(canvas: HTMLCanvasElement, onError?: (msg: string) => void): Promise<SdfWebGPUEngine> {
    const nav = navigator as any;
    if (!nav.gpu) throw new Error('navigator.gpu 不可用（浏览器无 WebGPU 入口）');
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter 枚举失败（无可用图形后端）');
    const device = await adapter.requestDevice();
    const format: string = nav.gpu.getPreferredCanvasFormat();

    const eng = new SdfWebGPUEngine(canvas);
    eng.onError = onError;
    eng.device = device;
    try {
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      eng.adapterName = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'WebGPU 适配器';
    } catch { eng.adapterName = 'WebGPU 适配器'; }

    device.addEventListener?.('uncapturederror', (ev: any) => {
      eng.onError?.(String(ev?.error?.message || ev));
    });
    device.lost?.then((dinfo: any) => {
      if (dinfo?.reason !== 'destroyed') eng.onError?.('WebGPU 设备丢失: ' + (dinfo?.reason || ''));
    });

    const module = device.createShaderModule({ code: WGSL });
    if (module.getCompilationInfo) {
      const ci = await module.getCompilationInfo();
      const errs = (ci.messages || []).filter((m: any) => m.type === 'error');
      if (errs.length) {
        throw new Error('WGSL 编译失败: ' + errs.map((m: any) => `L${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
      }
    }

    const mkPipeline = async (targetFormat: string, tag: string) => {
      device.pushErrorScope?.('validation');
      const p = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: targetFormat }] },
        primitive: { topology: 'triangle-list' },
      });
      const perr = device.popErrorScope ? await device.popErrorScope() : null;
      if (perr) throw new Error(`WebGPU 管线(${tag})创建失败: ${perr.message}`);
      return p;
    };
    eng.pipeline = await mkPipeline(format, 'canvas');
    eng.probePipeline = await mkPipeline('rgba32float', 'probe');

    eng.ubuf = device.createBuffer({ size: BLOCK_BYTES, usage: BUF_UNIFORM | BUF_COPY_DST });
    eng.bind = device.createBindGroup({
      layout: eng.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: eng.ubuf } }],
    });
    eng.probeBind = device.createBindGroup({
      layout: eng.probePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: eng.ubuf } }],
    });
    eng.probeTex = device.createTexture({
      size: [1, 1],
      format: 'rgba32float',
      usage: TEX_RENDER_ATTACHMENT | TEX_COPY_SRC,
    });
    eng.probeBuf = device.createBuffer({ size: 256, usage: BUF_MAP_READ | BUF_COPY_DST });
    eng.setScene(0);

    const ctx = canvas.getContext('webgpu') as any;
    if (!ctx) throw new Error('canvas webgpu 上下文获取失败（画布已被其他 API 占用）');
    ctx.configure({ device, format, alphaMode: 'premultiplied' });
    eng.ctx = ctx;
    eng.ready = true;
    return eng;
  }

  setScene(idx: number) { this.loadScene(PRESETS[idx]); }

  loadScene(raw: SdfScene) {
    this.sc = JSON.parse(JSON.stringify(raw)) as SdfScene;
    this.st = packStatic(this.sc);
    this.waveMax = this.st.waveMax;
    this.radius0.set(this.st.B0.filter((_: number, i: number) => i % 4 === 2));
    packPoses(this.sc, this.P1, this.P3);
    this.wearKey = this.sc.name + '#' + this.sc.prims.length;
    this.wearAge = this.wearAges.get(this.wearKey) ?? 0;
    if (this.sc.cluster) {
      this.clusterOn = this.sc.cluster.on;
      this.clusterCell = this.sc.cluster.cellSize;
      this.clusterSpread = this.sc.cluster.spreadAmp;
    }
    this.dist = Math.min(9, Math.max(0.9, this.sc.boundR * 2.6 + 0.9));
  }

  public async setKeyframeConfig(config: SdfKeyframeConfig): Promise<boolean> {
    return await initKeyframeBridge(this.sc, config);
  }

  public async enableKeyframeEngine(config: SdfKeyframeConfig): Promise<boolean> {
    return await initKeyframeBridge(this.sc, config);
  }

  public disableKeyframeBridge(): void {
    disposeKeyframeBridge();
  }

  public disableKeyframeEngine(): void {
    disposeKeyframeBridge();
  }

  public get isKeyframeActive(): boolean {
    return isKeyframeBridgeActive();
  }

  public start() {
    const loop = (now: number) => {
      this.frame(now);
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  public stop() {
    cancelAnimationFrame(this.animId);
  }

  private camQ(): Q {
    return qmul(axisAngle([0, 1, 0], this.yaw), axisAngle([1, 0, 0], this.pitch));
  }

  private draw(block: Float32Array) {
    if (!this.ready) return;
    const d = this.device;
    d.queue.writeBuffer(this.ubuf, 0, block);
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  frame(nowMs: number) {
    const dt = this.lastT ? Math.min((nowMs - this.lastT) / 1000, 0.1) : 0.016;
    this.lastT = nowMs;
    if (!this.paused) { this.timeSec += dt * this.speed; this.wearAge += dt * this.speed; }
    if (this.wearKey) this.wearAges.set(this.wearKey, this.wearAge);
    if (this.orbit && !this.paused) this.yaw += dt * this.speed * 0.28;

    this.fpsEma = this.fpsEma * 0.92 + (1 / Math.max(dt, 1e-3)) * 0.08;
    this.fps = this.fpsEma;
    if (++this.frames % 30 === 0) {
      if (this.fpsEma < 13 && this.renderScale > 0.35) this.renderScale *= 0.85;
      else if (this.fpsEma > 38 && this.renderScale < 1.0) this.renderScale = Math.min(1.0, this.renderScale * 1.12);
    }
    const w = Math.max(64, Math.round((this.canvas.clientWidth || 800) * this.renderScale));
    const h = Math.max(48, Math.round((this.canvas.clientHeight || 500) * this.renderScale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    solvePoses(this.sc, this.timeSec, () => solveKinematics(this.sc, this.timeSec));
    if (this.assemble) {
      const c = this.sc.boundC;
      for (let i = 0; i < this.sc.prims.length; i++) {
        const pr = this.sc.prims[i];
        const wp = pr._wp ?? pr.pos;
        const wave = 0.5 - 0.5 * Math.cos(this.timeSec * 0.9 - i * 0.55);
        const s = 1 + 1.1 * wave;
        pr._wp = [c[0] + (wp[0] - c[0]) * s, c[1] + (wp[1] - c[1]) * s, c[2] + (wp[2] - c[2]) * s];
      }
    }
    const km = this.pulse ? 1 + 0.3 * Math.sin(this.timeSec * 1.1) : 1;
    for (let i = 0; i < MAXP; i++) this.st.B0[i * 4 + 2] = this.radius0[i] * km;
    packPoses(this.sc, this.P1, this.P3);
    const cl: [number, number, number, number] = [this.clusterOn ? 1 : 0, this.clusterCell, this.clusterSpread, this.timeSec];
    const block = packBlock(
      [w, h], this.camQ(), this.dist, this.zoom, this.waveMax,
      Math.min(this.sc.prims.length, MAXP),
      [this.sc.boundC[0], this.sc.boundC[1], this.sc.boundC[2], this.sc.boundR],
      0, [0, 0, -1],
      [this.wearAge, sceneSeed(this.sc.name)],
      this.st, this.P1, this.P3, cl,
    );
    this.draw(block);
  }

  async probe(ndcX: number, ndcY: number): Promise<ProbeResult | null> {
    if (!this.ready) return null;
    const aspect = (this.canvas.width || 1) / (this.canvas.height || 1);
    const rd = norm3([ndcX * TANF * aspect, ndcY * TANF, -1]);
    try {
      if (!this.probePipeline) throw new Error('probe pipeline 不可用');
      const read = async (mode: number): Promise<Float32Array> => {
      const cl: [number, number, number, number] = [this.clusterOn ? 1 : 0, this.clusterCell, this.clusterSpread, this.timeSec];
      const block = packBlock(
        [this.canvas.width, this.canvas.height], this.camQ(), this.dist, this.zoom, this.waveMax,
        Math.min(this.sc.prims.length, MAXP),
        [this.sc.boundC[0], this.sc.boundC[1], this.sc.boundC[2], this.sc.boundR],
        mode, rd,
        [this.wearAge, sceneSeed(this.sc.name)],
        this.st, this.P1, this.P3, cl,
      );
      const d = this.device;
      d.queue.writeBuffer(this.ubuf, 0, block);
      const enc = d.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.probeTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.probePipeline);
      pass.setBindGroup(0, this.probeBind);
      pass.draw(3);
      pass.end();
      enc.copyTextureToBuffer(
        { texture: this.probeTex },
        { buffer: this.probeBuf, bytesPerRow: 256 },
        [1, 1, 1],
      );
      d.queue.submit([enc.finish()]);
      await d.queue.onSubmittedWorkDone();
      await this.probeBuf.mapAsync(MAP_READ);
      const out = new Float32Array(this.probeBuf.getMappedRange().slice(0));
      this.probeBuf.unmap();
      return out;
    };
    const m1 = await read(1);
      if (m1[0] <= 0) {
        return { hit: false, tCam: 0, point: [0, 0, 0], normal: [0, 1, 0], labelA: -1, labelB: -1, w: 0, curv: 0 };
      }
      const m2 = await read(2);
      const tCam = m1[0];
      const pCam: V3 = [rd[0] * tCam, rd[1] * tCam, rd[2] * tCam + this.dist];
      const pw = qrotInv(this.camQ(), pCam).map((v) => v * this.zoom) as V3;
      const nCam: V3 = [m2[0], m2[1], m2[2]];
      const nw = qrotInv(this.camQ(), nCam);
      return { hit: true, tCam, point: pw, normal: nw, labelA: Math.round(m1[1]), labelB: Math.round(m1[2]), w: m1[3], curv: m2[3] };
    } catch {
      const ctx = makePickCtx(this.sc, this.st, this.P1, this.P3, this.camQ(), this.dist, this.zoom, this.canvas.height || 1,
        { on: this.clusterOn, cellSize: this.clusterCell, spreadAmp: this.clusterSpread, time: this.timeSec });
      return cpuProbe(qrotInv(this.camQ(), rd), ctx);
    }
  }

  async pickAt(clientX: number, clientY: number): Promise<UnifiedPick | null> {
    const r = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    const p = await this.probe(ndcX, ndcY);
    if (!p || !p.hit) return null;
    const nm = (i: number) => (i >= 0 && i < LABELS.length ? LABELS[i] : '未知');
    let label = nm(p.labelA);
    if (p.labelB >= 0 && p.labelB !== p.labelA) label += ` ⇄ ${nm(p.labelB)}（混合 ${(p.w * 100).toFixed(0)}%）`;
    return {
      hit: true,
      source: 'sdf',
      point: p.point,
      normal: p.normal,
      distance: p.tCam,
      unit: 'scene',
      label,
      labelA: p.labelA,
      labelB: p.labelB,
      blend: p.w,
      curvature: p.curv,
      extra: { 材质A: p.labelA, 材质B: p.labelB },
    };
  }

  resetView() {
    this.yaw = 0.55;
    this.pitch = 0.30;
    this.zoom = 1.0;
    if (this.sc) this.dist = Math.min(9, Math.max(0.9, this.sc.boundR * 2.6 + 0.9));
    else this.dist = 2.3;
  }

  dispose() {
    this.stop();
    this.disableKeyframeBridge();
    this.onError = undefined;
    try { this.probeBuf?.destroy?.(); } catch { /* 忽略 */ }
    try { this.probeTex?.destroy?.(); } catch { /* 忽略 */ }
    try { this.ubuf?.destroy?.(); } catch { /* 忽略 */ }
    try { this.device?.destroy?.(); } catch { /* 忽略 */ }
  }
}
