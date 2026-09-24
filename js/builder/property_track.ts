import { TransformData } from "./types.js";

export type PropertyInterpolator<T = any> = (a: T, b: T, factor: number) => T;

function normalizeQuat(q: [number, number, number, number], out: [number, number, number, number]): void {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-6) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return;
  }
  out[0] = q[0] / len;
  out[1] = q[1] / len;
  out[2] = q[2] / len;
  out[3] = q[3] / len;
}

function slerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number
): [number, number, number, number] {
  const q1: [number, number, number, number] = [0, 0, 0, 1];
  const q2: [number, number, number, number] = [0, 0, 0, 1];
  normalizeQuat(a, q1);
  normalizeQuat(b, q2);

  let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];
  if (dot < 0) {
    q2[0] = -q2[0]; q2[1] = -q2[1]; q2[2] = -q2[2]; q2[3] = -q2[3];
    dot = -dot;
  }

  const out: [number, number, number, number] = [0, 0, 0, 1];
  if (dot > 0.9995) {
    q1[0] += t * (q2[0] - q1[0]);
    q1[1] += t * (q2[1] - q1[1]);
    q1[2] += t * (q2[2] - q1[2]);
    q1[3] += t * (q2[3] - q1[3]);
    normalizeQuat(q1, out);
    return out;
  }

  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);

  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  out[0] = s0 * q1[0] + s1 * q2[0];
  out[1] = s0 * q1[1] + s1 * q2[1];
  out[2] = s0 * q1[2] + s1 * q2[2];
  out[3] = s0 * q1[3] + s1 * q2[3];
  return out;
}

export function interpolateTransform(a: TransformData, b: TransformData, factor: number): TransformData {
  return {
    translation: [
      a.translation[0] + (b.translation[0] - a.translation[0]) * factor,
      a.translation[1] + (b.translation[1] - a.translation[1]) * factor,
      a.translation[2] + (b.translation[2] - a.translation[2]) * factor,
    ],
    rotation_quat: slerpQuat(a.rotation_quat, b.rotation_quat, factor),
    scale: [
      a.scale[0] + (b.scale[0] - a.scale[0]) * factor,
      a.scale[1] + (b.scale[1] - a.scale[1]) * factor,
      a.scale[2] + (b.scale[2] - a.scale[2]) * factor,
    ],
    origin: [
      a.origin[0] + (b.origin[0] - a.origin[0]) * factor,
      a.origin[1] + (b.origin[1] - a.origin[1]) * factor,
      a.origin[2] + (b.origin[2] - a.origin[2]) * factor,
    ],
  };
}

export class PropertyTrackRegistry {
  private static registry = new Map<string, PropertyInterpolator>();

  public static register<T = any>(trackName: string, interpolator: PropertyInterpolator<T>): void {
    this.registry.set(trackName, interpolator as PropertyInterpolator);
  }

  public static get<T = any>(trackName: string): PropertyInterpolator<T> | undefined {
    return this.registry.get(trackName) as PropertyInterpolator<T> | undefined;
  }

  public static interpolate<T = any>(trackName: string, a: T, b: T, factor: number): T {
    const interpolator = this.get<T>(trackName);
    if (interpolator) {
      return interpolator(a, b, factor);
    }
    // Default numeric fallback
    if (typeof a === "number" && typeof b === "number") {
      return ((a + (b - a) * factor) as unknown) as T;
    }
    return factor >= 1 ? b : a;
  }
}

// Register default built-in track interpolators
PropertyTrackRegistry.register("transform", interpolateTransform);
PropertyTrackRegistry.register("opacity", (a: number, b: number, factor: number) => a + (b - a) * factor);
PropertyTrackRegistry.register("number", (a: number, b: number, factor: number) => a + (b - a) * factor);
PropertyTrackRegistry.register("color_rgb", (a: number[], b: number[], factor: number) => {
  return [
    a[0] + (b[0] - a[0]) * factor,
    a[1] + (b[1] - a[1]) * factor,
    a[2] + (b[2] - a[2]) * factor,
  ];
});
PropertyTrackRegistry.register("path_points", (a: any[], b: any[], factor: number) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return factor >= 1 ? b : a;
  const len = Math.min(a.length, b.length);
  const result: any[] = [];
  for (let i = 0; i < len; i++) {
    const ptA = a[i];
    const ptB = b[i];
    if (Array.isArray(ptA) && Array.isArray(ptB)) {
      result.push(ptA.map((val, idx) => val + ((ptB[idx] ?? val) - val) * factor));
    } else {
      result.push(ptB);
    }
  }
  return result;
});
PropertyTrackRegistry.register("color", (a: number[], b: number[], factor: number) => {
  return [
    a[0] + (b[0] - a[0]) * factor,
    a[1] + (b[1] - a[1]) * factor,
    a[2] + (b[2] - a[2]) * factor,
  ];
});
