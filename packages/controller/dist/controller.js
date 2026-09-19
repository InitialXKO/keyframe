export class ApplyAligner {
    player;
    pendingBarriers = [];
    constructor(player) {
        this.player = player;
    }
    waitUntil(targetInstanceId, condition = { trigger: "onComplete" }) {
        return {
            then: (callback) => {
                this.pendingBarriers.push({
                    targetInstanceId,
                    condition,
                    callback,
                });
            },
        };
    }
    checkBarriers(currentTimeMs) {
        if (this.pendingBarriers.length === 0)
            return;
        const remainingBarriers = [];
        const evaluatedList = this.player.engine?.getEvaluatedInstances
            ? this.player.engine.getEvaluatedInstances(currentTimeMs, true)
            : [];
        for (const barrier of this.pendingBarriers) {
            let released = false;
            if (barrier.condition.timeMs !== undefined) {
                if (currentTimeMs >= barrier.condition.timeMs) {
                    released = true;
                }
            }
            else {
                const targetInst = evaluatedList.find((inst) => inst.id === barrier.targetInstanceId);
                if (targetInst) {
                    if (barrier.condition.trigger === "onComplete") {
                        // Check if global time exceeded delay + duration
                        const instData = this.player.engine.instances?.find((item) => item.id === barrier.targetInstanceId);
                        const clipData = instData ? this.player.engine.clips?.get(instData.clip_id) : null;
                        const delay = instData?.delay ?? 0;
                        const duration = (clipData?.duration ?? 0) * (instData?.duration_scale || 1.0);
                        if (currentTimeMs >= delay + duration) {
                            released = true;
                        }
                    }
                    else if (barrier.condition.trigger === "onStart") {
                        const instData = this.player.engine.instances?.find((item) => item.id === barrier.targetInstanceId);
                        const delay = instData?.delay ?? 0;
                        if (currentTimeMs >= delay) {
                            released = true;
                        }
                    }
                }
            }
            if (released) {
                barrier.callback();
            }
            else {
                remainingBarriers.push(barrier);
            }
        }
        this.pendingBarriers = remainingBarriers;
    }
}
export class AnimationPlayer {
    engine;
    fps;
    timeScale;
    audioContext;
    isPlaying = false;
    currentTimeMs = 0;
    isLooping = false;
    durationMs;
    listeners = new Map();
    timerId = null;
    aligners = [];
    lastTimestamp = 0;
    audioBaseTime = null;
    adaptiveTimeScaleMultiplier = 1.0;
    constructor(engine, options) {
        this.engine = engine;
        this.fps = options?.fps ?? 60;
        this.timeScale = options?.timeScale ?? 1.0;
        this.audioContext = options?.audioContext ?? null;
        this.durationMs = options?.duration ?? Infinity;
    }
    play() {
        if (this.isPlaying)
            return;
        this.isPlaying = true;
        this.lastTimestamp = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (this.audioContext && typeof this.audioContext.currentTime === "number") {
            // First-frame audio lock: capture t0 offset
            this.audioBaseTime = this.audioContext.currentTime * 1000 - this.currentTimeMs;
        }
        this.startLoop();
        this.emit("play");
    }
    pause() {
        if (!this.isPlaying)
            return;
        this.isPlaying = false;
        this.stopLoop();
        this.emit("pause");
    }
    seek(ms) {
        this.currentTimeMs = Math.max(0, ms);
        if (this.audioContext && typeof this.audioContext.currentTime === "number") {
            this.audioBaseTime = this.audioContext.currentTime * 1000 - this.currentTimeMs;
        }
        this.emit("seek", this.currentTimeMs);
        this.emit("frame", this.currentTimeMs);
    }
    createAligner() {
        const aligner = new ApplyAligner(this);
        this.aligners.push(aligner);
        return aligner;
    }
    loop(enable = true) {
        this.isLooping = enable;
    }
    getCurrentTime() {
        return this.currentTimeMs;
    }
    getIsPlaying() {
        return this.isPlaying;
    }
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
    }
    off(event, callback) {
        const set = this.listeners.get(event);
        if (set) {
            set.delete(callback);
        }
    }
    emit(event, ...args) {
        const set = this.listeners.get(event);
        if (set) {
            for (const cb of set) {
                cb(...args);
            }
        }
    }
    startLoop() {
        const intervalMs = 1000 / this.fps;
        const tick = () => {
            if (!this.isPlaying)
                return;
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
                }
                else if (Math.abs(drift) < 50 && Math.abs(drift) > 0.1) {
                    // Adaptive rate convergence (< ±50ms drift): fine-tune multiplier (0.998 ~ 1.002)
                    if (drift > 0) {
                        this.adaptiveTimeScaleMultiplier = 0.998;
                    }
                    else {
                        this.adaptiveTimeScaleMultiplier = 1.002;
                    }
                    this.currentTimeMs += deltaRealMs * this.timeScale * this.adaptiveTimeScaleMultiplier;
                }
                else {
                    this.adaptiveTimeScaleMultiplier = 1.0;
                    this.currentTimeMs += deltaRealMs * this.timeScale;
                }
            }
            else {
                this.currentTimeMs += deltaRealMs * this.timeScale;
            }
            if (this.currentTimeMs >= this.durationMs) {
                if (this.isLooping) {
                    this.currentTimeMs = this.currentTimeMs % this.durationMs;
                }
                else {
                    this.currentTimeMs = this.durationMs;
                    this.emit("frame", this.currentTimeMs);
                    this.pause();
                    this.emit("ended");
                    return;
                }
            }
            for (const aligner of this.aligners) {
                aligner.checkBarriers(this.currentTimeMs);
            }
            this.emit("frame", this.currentTimeMs);
            this.timerId = setTimeout(tick, intervalMs);
        };
        this.timerId = setTimeout(tick, 1000 / this.fps);
    }
    stopLoop() {
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }
}
export class ControllerAdapter {
    createPlayer(engine, options) {
        return new AnimationPlayer(engine, options);
    }
}
export const controller = new ControllerAdapter();
