// ============================================================
// SDF 实体构造与渲染引擎 —— WebGL2 后端
// 工作流闭环：读入构造指令 → 统一距离场合成 → 边界过渡修正 →
// 球体追踪求交 → 解析法线 → 材质光学 → 微观叠加 → 磨损 → 交互返回
// ============================================================
import { PRESETS, LABELS, SdfScene, SdfPrim, solveKinematics } from './scene.js';
import { VERT, FRAG } from './shader.js';
import { MAXP, packStatic, packPoses, sceneSeed, SUN, SUNCOL } from './pack.js';
import type { PackedStatic, ProbeResult } from './pack.js';
import { solvePoses, initKeyframeBridge, disposeKeyframeBridge, isKeyframeBridgeActive, type SdfKeyframeConfig } from './keyframe-bridge.js';

export interface SdfPickResult extends ProbeResult {
  labelNameA: string;
  labelNameB: string;
}

export type UnifiedPick = SdfPickResult;
export type { ProbeResult };

const TANF = 0.3839;

type Q = [number, number, number, number];
type V3 = [number, number, number];

function axisAngle(ax: V3, a: number): Q {
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const s = Math.sin(a / 2);
  return [(ax[0] / l) * s, (ax[1] / l) * s, (ax[2] / l) * s, Math.cos(a / 2)];
}
function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qrotInv(q: Q, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const c1: V3 = [qy * v[2] - qz * v[1], qz * v[0] - qx * v[2], qx * v[1] - qy * v[0]];
  const w1: V3 = [c1[0] + qw * v[0], c1[1] + qw * v[1], c1[2] + qw * v[2]];
  const c2: V3 = [-qy * w1[2] + qz * w1[1], -qz * w1[0] + qx * w1[2], -qx * w1[1] + qy * w1[0]];
  return [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]];
}

export class SdfEngine {
  private gl: WebGL2RenderingContext | null = null;
  private prg: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private sc: SdfScene = PRESETS[0];
  private st: PackedStatic = packStatic(PRESETS[0]);
  private P1 = new Float32Array(MAXP * 4);
  private P3 = new Float32Array(MAXP * 4);
  private uLoc: Record<string, WebGLUniformLocation | null> = {};

  // 视口与交互
  public camQ: Q = axisAngle([1, 0, 0], -0.25);
  public dist = 3.6;
  public zoom = 1.0;
  public renderMode = 0; // 0真实 1防穿透 2材质标签 3网格导线 4磨损热力
  public showCluster = false; // 集群增殖域开关
  public wearSeconds = 0;

  private isDragging = false;
  private lastMouse = [0, 0];
  private animId = 0;
  private startTime = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.initGL();
    this.bindEvents();
  }

  private initGL() {
    const gl = (this.gl = this.canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      anticlip: true,
      preserveDrawingBuffer: true,
    } as WebGLContextAttributes));
    if (!gl) {
      console.error('[SdfEngine] WebGL2 不可用');
      return;
    }

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[SdfEngine] VS 编译失败:', gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[SdfEngine] FS 编译失败:', gl.getShaderInfoLog(fs));
    }

    const prg = (this.prg = gl.createProgram()!);
    gl.attachShader(prg, vs);
    gl.attachShader(prg, fs);
    gl.linkProgram(prg);
    if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
      console.error('[SdfEngine] Program 链接失败:', gl.getProgramInfoLog(prg));
    }

    const uNames = [
      'uRes', 'uCamQ', 'uDist', 'uScale', 'uWaveMax', 'uPrimCount', 'uBoundC', 'uBoundR',
      'uSun', 'uMode', 'uSunCol', 'uProbeDir', 'uWear', 'uCluster',
      'uP0', 'uP1', 'uP2', 'uP3', 'uB0', 'uB1',
    ];
    uNames.forEach((n) => (this.uLoc[n] = gl.getUniformLocation(prg, n)));

    const vao = (this.vao = gl.createVertexArray());
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  public loadScene(sc: SdfScene) {
    this.sc = sc;
    this.st = packStatic(sc);
  }

  public async setKeyframeConfig(config: SdfKeyframeConfig): Promise<boolean> {
    return await initKeyframeBridge(this.sc, config);
  }

  public async enableKeyframeEngine(config: SdfKeyframeConfig): Promise<boolean> {
    return await initKeyframeBridge(this.sc, config);
  }

  public disableKeyframeBridge() {
    disposeKeyframeBridge();
  }

  public disableKeyframeEngine() {
    disposeKeyframeBridge();
  }

  public get isKeyframeActive(): boolean {
    return isKeyframeBridgeActive();
  }

  public resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  public start() {
    const loop = (now: number) => {
      const t = (now - this.startTime) / 1000;
      this.render(t);
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  public stop() {
    cancelAnimationFrame(this.animId);
  }

  public render(timeSec: number) {
    const gl = this.gl;
    if (!gl || !this.prg) return;

    solvePoses(this.sc, timeSec, () => solveKinematics(this.sc, timeSec));
    packPoses(this.sc, this.P1, this.P3);

    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prg);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(this.uLoc.uRes, w, h);
    gl.uniform4fv(this.uLoc.uCamQ, this.camQ);
    gl.uniform1f(this.uLoc.uDist, this.dist);
    gl.uniform1f(this.uLoc.uScale, this.zoom);
    gl.uniform1f(this.uLoc.uWaveMax, this.st.waveMax);
    gl.uniform1i(this.uLoc.uPrimCount, Math.min(this.sc.prims.length, MAXP));
    gl.uniform3fv(this.uLoc.uBoundC, this.sc.boundC);
    gl.uniform1f(this.uLoc.uBoundR, this.sc.boundR);
    gl.uniform3fv(this.uLoc.uSun, SUN);
    gl.uniform1i(this.uLoc.uMode, this.renderMode);
    gl.uniform3fv(this.uLoc.uSunCol, SUNCOL);
    gl.uniform3f(this.uLoc.uProbeDir, 0, 0, -1);
    gl.uniform2f(this.uLoc.uWear, this.wearSeconds, sceneSeed(this.sc.name));

    const cl = this.sc.cluster;
    if (this.showCluster && cl && cl.on) {
      gl.uniform4f(this.uLoc.uCluster, 1.0, cl.cellSize, cl.spreadAmp, timeSec);
    } else {
      gl.uniform4f(this.uLoc.uCluster, 0.0, 1.0, 0.0, 0.0);
    }

    gl.uniform4fv(this.uLoc.uP0, this.st.P0);
    gl.uniform4fv(this.uLoc.uP1, this.P1);
    gl.uniform4fv(this.uLoc.uP2, this.st.P2);
    gl.uniform4fv(this.uLoc.uP3, this.P3);
    gl.uniform4fv(this.uLoc.uB0, this.st.B0);
    gl.uniform4fv(this.uLoc.uB1, this.st.B1);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.lastMouse = [e.clientX, e.clientY];
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = (e.clientX - this.lastMouse[0]) * 0.005;
      const dy = (e.clientY - this.lastMouse[1]) * 0.005;
      this.lastMouse = [e.clientX, e.clientY];

      const qY = axisAngle([0, 1, 0], dx);
      const qX = axisAngle([1, 0, 0], dy);
      this.camQ = qmul(qY, qmul(this.camQ, qX));
    });

    window.addEventListener('pointerup', () => {
      this.isDragging = false;
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(Math.max(this.zoom * (1 + e.deltaY * 0.001), 0.2), 5.0);
    });
  }

  async pickAt(clientX: number, clientY: number): Promise<UnifiedPick | null> {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;

    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const uvX = (x * 2 - 1) * aspect * TANF;
    const uvY = (1 - y * 2) * TANF;

    const rdS: V3 = [uvX, uvY, -1];
    const l = Math.hypot(rdS[0], rdS[1], rdS[2]) || 1;
    const rdNormalized: V3 = [rdS[0] / l, rdS[1] / l, rdS[2] / l];

    const rdW = qrotInv(this.camQ, rdNormalized);
    const zoom = this.zoom;
    const roW = qrotInv(this.camQ, [0, 0, this.dist]).map((v) => v * zoom) as V3;

    const pc = Math.min(this.sc.prims.length, MAXP);
    let t = 0.002;
    let hit = false;
    let hitP: V3 = [0, 0, 0];

    for (let i = 0; i < 64; i++) {
      const p: V3 = [roW[0] + rdW[0] * t, roW[1] + rdW[1] * t, roW[2] + rdW[2] * t];
      let d = 1e9;
      this.sc.prims.forEach((_: SdfPrim, idx: number) => {
        if (idx >= pc) return;
        const qPr = [this.P3[idx * 4], this.P3[idx * 4 + 1], this.P3[idx * 4 + 2], this.P3[idx * 4 + 3]] as Q;
        const posPr = [this.P1[idx * 4], this.P1[idx * 4 + 1], this.P1[idx * 4 + 2]] as V3;
        const localP = qrotInv(qPr, [p[0] - posPr[0], p[1] - posPr[1], p[2] - posPr[2]]);
        const rPr = this.st.P2[idx * 4];
        const distPr = Math.hypot(localP[0], localP[1], localP[2]) - rPr;
        d = Math.min(d, distPr);
      });

      if (d < 0.001) {
        hit = true;
        hitP = p;
        break;
      }
      t += d * 0.8;
      if (t > 20) break;
    }

    if (!hit) return null;

    let closestLabel = 0;
    let minD = 1e9;
    this.sc.prims.forEach((pr: SdfPrim, idx: number) => {
      if (idx >= pc) return;
      const posPr = [this.P1[idx * 4], this.P1[idx * 4 + 1], this.P1[idx * 4 + 2]] as V3;
      const d = Math.hypot(hitP[0] - posPr[0], hitP[1] - posPr[1], hitP[2] - posPr[2]);
      if (d < minD) {
        minD = d;
        closestLabel = pr.label;
      }
    });

    const labelNameA = LABELS[closestLabel] || '未知材质';

    return {
      hit: true,
      tCam: t,
      point: hitP,
      normal: [0, 1, 0],
      labelA: closestLabel,
      labelB: -1,
      w: 0,
      curv: 0,
      labelNameA,
      labelNameB: '',
    };
  }

  public dispose() {
    this.stop();
    this.disableKeyframeBridge();
    const gl = this.gl;
    if (gl && this.prg) {
      gl.deleteProgram(this.prg);
    }
  }
}
