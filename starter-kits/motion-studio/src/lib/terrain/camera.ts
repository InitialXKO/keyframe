/**
 * 相机基与射线求交 —— 渲染后端无关的共享数学。
 *
 * WebGL2 与 WebGPU 两条渲染路径都从这里取相机基（eye/fwd/right/up）
 * 与空间交互求交（纯数学迭代：自适应步长推进 + 二分收敛），
 * 保证两个后端的相机行为与拾取结果严格一致。
 */

import { curvatureDrop, PLANET_RADIUS } from "./planet";
import { detailRelief, heightAt, waterAt, type TerrainTable } from "./table";

export interface CameraState {
  fx: number;
  fz: number;
  yaw: number;
  pitch: number;
  dist: number;
  fovY: number;
  /** 视口纵横比（拾取反投影用） */
  aspect: number;
}

export interface CameraBasis {
  eye: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

/** 相机派生：eye / fwd / right / up（右 = fwd×up），eye 高度钳制在地面之上 */
export function cameraBasis(cam: CameraState, table: TerrainTable, exagg: number): CameraBasis {
  const cp = Math.cos(cam.pitch);
  // 曲率弯曲：焦点/眼位高度均按球面下沉量修正（与渲染几何同一弯曲场）
  const focusY = heightAt(table, cam.fx, cam.fz) * exagg - curvatureDrop(cam.fx, cam.fz);
  const eye: [number, number, number] = [
    cam.fx + Math.sin(cam.yaw) * cp * cam.dist,
    focusY + Math.sin(cam.pitch) * cam.dist,
    cam.fz + Math.cos(cam.yaw) * cp * cam.dist,
  ];
  const groundEye =
    heightAt(table, eye[0], eye[2]) * exagg - curvatureDrop(eye[0], eye[2]);
  if (eye[1] < groundEye + 60) eye[1] = groundEye + 60;
  const fx = cam.fx - eye[0], fy = focusY - eye[1], fz = cam.fz - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  const fwd: [number, number, number] = [fx / fl, fy / fl, fz / fl];
  const right: [number, number, number] = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(right[0], right[2]) || 1;
  right[0] /= rl; right[2] /= rl;
  const up: [number, number, number] = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { eye, fwd, right, up };
}

export interface PickResult {
  x: number;
  z: number;
  elevM: number;
  waterDepthM: number | null;
  slopeDeg: number;
  aspectDeg: number;
  water: number;
}

/**
 * 空间交互求交：从观察点出发的虚拟直线 × 数字派生表面，纯数学迭代
 * （自适应步长推进 + 16 轮二分收敛），返回首个交点的海拔与表面朝向。
 * detailAmp>0 时射线与含近景浮雕带的地表求交（与渲染网格/树基/草基严格同式）。
 */
export function pickSurface(
  table: TerrainTable,
  cam: CameraState,
  exagg: number,
  ndcX: number,
  ndcY: number,
  detailAmp = 0,
): PickResult | null {
  const t = table;
  const { eye, fwd, right, up } = cameraBasis(cam, t, exagg);
  const tanH = Math.tan(cam.fovY / 2);
  const aspect = cam.aspect > 0 ? cam.aspect : 1.6;
  let dx = fwd[0] + ndcX * tanH * aspect * right[0] + ndcY * tanH * up[0];
  let dy = fwd[1] + ndcX * tanH * aspect * right[1] + ndcY * tanH * up[1];
  let dz = fwd[2] + ndcX * tanH * aspect * right[2] + ndcY * tanH * up[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  const eyeY = eye[1];
  if (dy > 0.2 && eyeY > t.maxH * exagg + 600) return null;
  // 眼位海拔（高于弯曲地表）：升空后推进步长按其放大（420 步内覆盖行星尺度）
  const eyeAlt = eyeY - (heightAt(t, eye[0], eye[2]) * exagg - curvatureDrop(eye[0], eye[2]));
  const stepScale = 1 + Math.max(0, eyeAlt - 20000) * 0.00004;
  /** 含近景浮雕的地表海拔（米，未夸张）—— 浮雕为窗口锚点系纯位置场（与网格/树基同式） */
  const surf = (px: number, pz: number): number => {
    const hM = heightAt(t, px, pz);
    return hM + detailRelief(px, pz, hM, detailAmp);
  };

  let tLo = 1;
  let tHi = -1;
  let tt = 1;
  const tCap = Math.max(620000, eyeAlt * 2 + PLANET_RADIUS * 2.2);
  for (let step = 0; step < 420 && tt < tCap; step++) {
    const px = eye[0] + dx * tt;
    const py = eyeY + dy * tt;
    const pz = eye[2] + dz * tt;
    // 弯曲表面：海拔减去曲率下沉（与渲染几何同一弯曲场）
    if (py <= surf(px, pz) * exagg - curvatureDrop(px, pz)) {
      tHi = tt;
      break;
    }
    tLo = tt;
    tt += Math.max(24, tt * 0.016 * stepScale);
  }
  if (tHi < 0) return null;
  for (let k = 0; k < 16; k++) {
    const mid = (tLo + tHi) / 2;
    const px = eye[0] + dx * mid;
    const py = eyeY + dy * mid;
    const pz = eye[2] + dz * mid;
    if (py <= surf(px, pz) * exagg - curvatureDrop(px, pz)) tHi = mid;
    else tLo = mid;
  }
  const tHit = (tLo + tHi) / 2;
  const hx = eye[0] + dx * tHit;
  const hz = eye[2] + dz * tHit;
  // 高空拾取只对区域表格负责：落在区域之外的全球命中不返回（避免错位假交点）
  if (Math.abs(hx) > t.spanX / 2 + 4000 || Math.abs(hz) > t.spanZ / 2 + 4000) {
    return null;
  }
  const elevM = surf(hx, hz);
  const e = Math.max(t.dxEast, t.dzNorth);
  const gx = ((surf(hx + e, hz) - surf(hx - e, hz)) / (2 * e)) * exagg;
  const gz = ((surf(hx, hz + e) - surf(hx, hz - e)) / (2 * e)) * exagg;
  const slopeDeg = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  let aspectDeg = (Math.atan2(-gx, -gz) * 180) / Math.PI;
  if (aspectDeg < 0) aspectDeg += 360;
  const w = waterAt(t, hx, hz);
  return {
    x: hx,
    z: hz,
    elevM,
    waterDepthM: elevM <= 0.2 ? Math.max(0, -elevM) : w !== 0 ? 0 : null,
    slopeDeg,
    aspectDeg,
    water: w,
  };
}

/** 通用 lookAt（列主序） */
export function lookAt(eye: number[], center: number[], up: number[]): Float32Array {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

/** 通用 mul4（列主序） */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
