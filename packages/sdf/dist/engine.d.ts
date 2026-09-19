import { SdfScene } from './scene.js';
import type { ProbeResult } from './pack.js';
import { type SdfKeyframeConfig } from './keyframe-bridge.js';
export interface SdfPickResult extends ProbeResult {
    labelNameA: string;
    labelNameB: string;
}
export type UnifiedPick = SdfPickResult;
export type { ProbeResult };
type Q = [number, number, number, number];
export declare class SdfEngine {
    private canvas;
    private gl;
    private prg;
    private vao;
    private sc;
    private st;
    private P1;
    private P3;
    private uLoc;
    camQ: Q;
    dist: number;
    zoom: number;
    renderMode: number;
    showCluster: boolean;
    wearSeconds: number;
    private isDragging;
    private lastMouse;
    private animId;
    private startTime;
    constructor(canvas: HTMLCanvasElement);
    private initGL;
    loadScene(sc: SdfScene): void;
    setKeyframeConfig(config: SdfKeyframeConfig): Promise<boolean>;
    enableKeyframeEngine(config: SdfKeyframeConfig): Promise<boolean>;
    disableKeyframeBridge(): void;
    disableKeyframeEngine(): void;
    get isKeyframeActive(): boolean;
    resize(w: number, h: number): void;
    start(): void;
    stop(): void;
    render(timeSec: number): void;
    private bindEvents;
    pickAt(clientX: number, clientY: number): Promise<UnifiedPick | null>;
    dispose(): void;
}
