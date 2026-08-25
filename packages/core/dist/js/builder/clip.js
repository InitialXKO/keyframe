import { Easing } from "./types.js";
import { Keyframe } from "./keyframe.js";
export class Clip {
    id;
    _duration = 1000;
    _easing = Easing.Linear;
    _iterations = 1;
    _keyframes = [];
    constructor(id) {
        this.id = id;
    }
    duration(d) {
        this._duration = d;
        return this;
    }
    easing(e) {
        this._easing = e;
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
            easing: this._easing,
            iterations: this._iterations,
            keyframes: [...this._keyframes],
        };
    }
}
