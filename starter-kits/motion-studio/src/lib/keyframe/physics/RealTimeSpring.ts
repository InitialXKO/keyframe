export interface RealTimeSpringConfig {
  mass?: number;        // Default 1.0
  damping?: number;     // Default 10
  stiffness?: number;   // Default 100
  initialValue?: number; // Default 0
  initialVelocity?: number; // Default 0
}

export class RealTimeSpring {
  private static activeInstanceCount = 0;

  private mass: number;
  private damping: number;
  private stiffness: number;
  private value: number;
  private velocity: number;

  constructor(config: RealTimeSpringConfig = {}) {
    this.mass = config.mass ?? 1.0;
    this.damping = config.damping ?? 10;
    this.stiffness = config.stiffness ?? 100;
    this.value = config.initialValue ?? 0;
    this.velocity = config.initialVelocity ?? 0;

    RealTimeSpring.activeInstanceCount++;
    if (RealTimeSpring.activeInstanceCount > 200) {
      console.warn(
        "[@keyframe/physics] Large number of live springs (>200). Consider using baked physics or reducing update frequency."
      );
    }
  }

  public static getActiveInstanceCount(): number {
    return RealTimeSpring.activeInstanceCount;
  }

  public static resetInstanceCount(): void {
    RealTimeSpring.activeInstanceCount = 0;
  }

  /**
   * Advances the spring simulation state towards target by deltaTime.
   * Automatically handles deltaTime passed in seconds (e.g. 0.016) or milliseconds (e.g. 16.66).
   * @returns current value after step
   */
  public step(target: number, deltaTime: number): number {
    if (deltaTime <= 0) {
      return this.value;
    }

    // Convert milliseconds to seconds if deltaTime is > 1.0
    let dt = deltaTime > 1.0 ? deltaTime / 1000 : deltaTime;

    // Sub-stepping for numerical stability (max sub-step = 1ms = 0.001s)
    const subStep = 0.001;
    while (dt > 0) {
      const currentDt = Math.min(dt, subStep);

      // Spring force equation: F = -stiffness * (x - target) - damping * v
      const force = -this.stiffness * (this.value - target) - this.damping * this.velocity;
      const accel = force / (this.mass || 1.0);

      // Semi-implicit Euler step
      this.velocity += accel * currentDt;
      this.value += this.velocity * currentDt;

      dt -= currentDt;
    }

    return this.value;
  }

  /**
   * Resets spring position and velocity state.
   */
  public reset(value?: number, velocity?: number): void {
    this.value = value ?? 0;
    this.velocity = velocity ?? 0;
  }

  /**
   * Returns current spring velocity.
   */
  public getVelocity(): number {
    return this.velocity;
  }

  /**
   * Returns current spring value.
   */
  public getValue(): number {
    return this.value;
  }
}
