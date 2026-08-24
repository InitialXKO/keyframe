export interface SpringConfig {
  damping?: number;
  stiffness?: number;
  mass?: number;
}

export interface SpringOptions {
  frame: number;
  fps: number;
  config?: SpringConfig;
}

export function spring(options: SpringOptions): number {
  const { frame, fps, config } = options;
  const damping = config?.damping ?? 10;
  const stiffness = config?.stiffness ?? 100;
  const mass = config?.mass ?? 1;

  const t = frame / fps;
  if (t <= 0) return 0;

  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (Math.abs(zeta - 1) < 1e-5) {
    // Critically damped
    return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
  } else if (zeta < 1) {
    // Underdamped
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * w0 * t) *
        ((zeta * w0 / wd) * Math.sin(wd * t) + Math.cos(wd * t))
    );
  } else {
    // Overdamped
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    const c2 = r1 / (r2 - r1);
    const c1 = 1 - c2;
    return 1 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
  }
}
