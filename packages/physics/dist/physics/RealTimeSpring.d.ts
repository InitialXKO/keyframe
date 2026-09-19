export interface RealTimeSpringConfig {
    mass?: number;
    damping?: number;
    stiffness?: number;
    initialValue?: number;
    initialVelocity?: number;
}
export declare class RealTimeSpring {
    private static activeInstanceCount;
    private mass;
    private damping;
    private stiffness;
    private value;
    private velocity;
    constructor(config?: RealTimeSpringConfig);
    static getActiveInstanceCount(): number;
    static resetInstanceCount(): void;
    /**
     * Advances the spring simulation state towards target by deltaTime.
     * Automatically handles deltaTime passed in seconds (e.g. 0.016) or milliseconds (e.g. 16.66).
     * @returns current value after step
     */
    step(target: number, deltaTime: number): number;
    /**
     * Resets spring position and velocity state.
     */
    reset(value?: number, velocity?: number): void;
    /**
     * Returns current spring velocity.
     */
    getVelocity(): number;
    /**
     * Returns current spring value.
     */
    getValue(): number;
}
