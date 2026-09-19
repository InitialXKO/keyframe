export interface PlayerOptions {
    fps?: number;
    timeScale?: number;
    audioContext?: any;
    duration?: number;
}
export type PlayerEvent = "frame" | "play" | "pause" | "ended" | "seek";
export type PlayerListener = (...args: any[]) => void;
export interface AlignerCondition {
    trigger?: "onComplete" | "onStart" | "onKeyframe" | string;
    keyframeIndex?: number;
    timeMs?: number;
}
export declare class ApplyAligner {
    private player;
    private pendingBarriers;
    constructor(player: AnimationPlayer);
    waitUntil(targetInstanceId: string, condition?: AlignerCondition): {
        then: (callback: () => void) => void;
    };
    checkBarriers(currentTimeMs: number): void;
}
export declare class AnimationPlayer {
    engine: any;
    fps: number;
    timeScale: number;
    audioContext: any | null;
    private isPlaying;
    private currentTimeMs;
    private isLooping;
    private durationMs;
    private listeners;
    private timerId;
    private aligners;
    private lastTimestamp;
    private audioBaseTime;
    private adaptiveTimeScaleMultiplier;
    constructor(engine: any, options?: PlayerOptions);
    play(): void;
    pause(): void;
    seek(ms: number): void;
    createAligner(): ApplyAligner;
    loop(enable?: boolean): void;
    getCurrentTime(): number;
    getIsPlaying(): boolean;
    on(event: PlayerEvent, callback: PlayerListener): void;
    off(event: PlayerEvent, callback: PlayerListener): void;
    private emit;
    private startLoop;
    private stopLoop;
}
export declare class ControllerAdapter {
    createPlayer(engine: any, options?: PlayerOptions): AnimationPlayer;
}
export declare const controller: ControllerAdapter;
