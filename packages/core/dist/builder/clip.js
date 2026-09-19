import { Keyframe } from "./keyframe.js";
export class Clip {
    id;
    _duration = 1000;
    _iterations = 1;
    _keyframes = [];
    _metadata;
    constructor(id) {
        this.id = id;
    }
    duration(d) {
        this._duration = d;
        return this;
    }
    metadata(data) {
        this._metadata = { ...this._metadata, ...data };
        return this;
    }
    iterations(i) {
        this._iterations = i;
        return this;
    }
    addKeyframe(kf) {
        if (kf instanceof Keyframe) {
            this._keyframes.push(kf.build());
        }
        else {
            this._keyframes.push(kf);
        }
        return this;
    }
    build() {
        return {
            id: this.id,
            duration: this._duration,
            iterations: this._iterations,
            keyframes: [...this._keyframes],
            ...(this._metadata ? { metadata: { ...this._metadata } } : {}),
        };
    }
}
