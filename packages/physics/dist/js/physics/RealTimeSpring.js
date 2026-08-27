export class RealTimeSpring {
    static activeInstanceCount = 0;
    mass;
    damping;
    stiffness;
    value;
    velocity;
    constructor(config = {}) {
        this.mass = config.mass ?? 1.0;
        this.damping = config.damping ?? 10;
        this.stiffness = config.stiffness ?? 100;
        this.value = config.initialValue ?? 0;
        this.velocity = config.initialVelocity ?? 0;
        RealTimeSpring.activeInstanceCount++;
        if (RealTimeSpring.activeInstanceCount > 200) {
            console.warn("[@keyframe/physics] Large number of live springs (>200). Consider using baked physics or reducing update frequency.");
        }
    }
    static getActiveInstanceCount() {
        return RealTimeSpring.activeInstanceCount;
    }
    static resetInstanceCount() {
        RealTimeSpring.activeInstanceCount = 0;
    }
    /**
     * Advances the spring simulation state towards target by deltaTime.
     * Automatically handles deltaTime passed in seconds (e.g. 0.016) or milliseconds (e.g. 16.66).
     * @returns current value after step
     */
    step(target, deltaTime) {
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
    reset(value, velocity) {
        this.value = value ?? 0;
        this.velocity = velocity ?? 0;
    }
    /**
     * Returns current spring velocity.
     */
    getVelocity() {
        return this.velocity;
    }
    /**
     * Returns current spring value.
     */
    getValue() {
        return this.value;
    }
}
