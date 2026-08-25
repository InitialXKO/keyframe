export interface PlayerOptions {
  fps?: number;
  timeScale?: number;
  audioContext?: any;
  duration?: number;
}

export type PlayerEvent = "frame" | "play" | "pause" | "ended" | "seek";
export type PlayerListener = (...args: any[]) => void;

export class AnimationPlayer {
  public engine: any;
  public fps: number;
  public timeScale: number;
  public audioContext: any | null;

  private isPlaying: boolean = false;
  private currentTimeMs: number = 0;
  private isLooping: boolean = false;
  private durationMs: number;

  private listeners: Map<PlayerEvent, Set<PlayerListener>> = new Map();
  private timerId: any = null;
  private lastTimestamp: number = 0;
  private audioBaseTime: number | null = null;
  private adaptiveTimeScaleMultiplier: number = 1.0;

  constructor(engine: any, options?: PlayerOptions) {
    this.engine = engine;
    this.fps = options?.fps ?? 60;
    this.timeScale = options?.timeScale ?? 1.0;
    this.audioContext = options?.audioContext ?? null;
    this.durationMs = options?.duration ?? Infinity;
  }

  public play(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.lastTimestamp = typeof performance !== "undefined" ? performance.now() : Date.now();

    if (this.audioContext && typeof this.audioContext.currentTime === "number") {
      // First-frame audio lock: capture t0 offset
      this.audioBaseTime = this.audioContext.currentTime * 1000 - this.currentTimeMs;
    }

    this.startLoop();
    this.emit("play");
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.stopLoop();
    this.emit("pause");
  }

  public seek(ms: number): void {
    this.currentTimeMs = Math.max(0, ms);
    if (this.audioContext && typeof this.audioContext.currentTime === "number") {
      this.audioBaseTime = this.audioContext.currentTime * 1000 - this.currentTimeMs;
    }
    this.emit("seek", this.currentTimeMs);
    this.emit("frame", this.currentTimeMs);
  }

  public loop(enable = true): void {
    this.isLooping = enable;
  }

  public getCurrentTime(): number {
    return this.currentTimeMs;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public on(event: PlayerEvent, callback: PlayerListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  public off(event: PlayerEvent, callback: PlayerListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
    }
  }

  private emit(event: PlayerEvent, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        cb(...args);
      }
    }
  }

  private startLoop(): void {
    const intervalMs = 1000 / this.fps;
    const tick = () => {
      if (!this.isPlaying) return;

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const deltaRealMs = now - this.lastTimestamp;
      this.lastTimestamp = now;

      // Audio Clock Master: Adaptive Convergence Method
      if (this.audioContext && typeof this.audioContext.currentTime === "number") {
        if (this.audioBaseTime === null) {
          this.audioBaseTime = this.audioContext.currentTime * 1000 - this.currentTimeMs;
        }

        const audioCurrentTimeMs = this.audioContext.currentTime * 1000 - this.audioBaseTime;
        const drift = this.currentTimeMs - audioCurrentTimeMs;

        if (Math.abs(drift) > 100) {
          // Hard boundary re-lock (> ±100ms drift): jump directly
          this.currentTimeMs = audioCurrentTimeMs;
          this.adaptiveTimeScaleMultiplier = 1.0;
        } else if (Math.abs(drift) < 50 && Math.abs(drift) > 0.1) {
          // Adaptive rate convergence (< ±50ms drift): fine-tune multiplier (0.998 ~ 1.002)
          if (drift > 0) {
            this.adaptiveTimeScaleMultiplier = 0.998;
          } else {
            this.adaptiveTimeScaleMultiplier = 1.002;
          }
          this.currentTimeMs += deltaRealMs * this.timeScale * this.adaptiveTimeScaleMultiplier;
        } else {
          this.adaptiveTimeScaleMultiplier = 1.0;
          this.currentTimeMs += deltaRealMs * this.timeScale;
        }
      } else {
        this.currentTimeMs += deltaRealMs * this.timeScale;
      }

      if (this.currentTimeMs >= this.durationMs) {
        if (this.isLooping) {
          this.currentTimeMs = this.currentTimeMs % this.durationMs;
        } else {
          this.currentTimeMs = this.durationMs;
          this.emit("frame", this.currentTimeMs);
          this.pause();
          this.emit("ended");
          return;
        }
      }

      this.emit("frame", this.currentTimeMs);

      this.timerId = setTimeout(tick, intervalMs);
    };

    this.timerId = setTimeout(tick, 1000 / this.fps);
  }

  private stopLoop(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}

export class ControllerAdapter {
  public createPlayer(engine: any, options?: PlayerOptions): AnimationPlayer {
    return new AnimationPlayer(engine, options);
  }
}

export const controller = new ControllerAdapter();
