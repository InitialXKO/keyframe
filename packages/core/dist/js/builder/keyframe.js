import { Easing } from "./types.js";
import { TransformBuilder } from "./transform.js";
export class Keyframe {
    data;
    constructor(time) {
        this.data = {
            time,
            transform: new TransformBuilder().build(),
            opacity: 1.0,
            easing: Easing.Linear,
        };
    }
    transform(t) {
        this.data.transform = t;
        return this;
    }
    opacity(o) {
        this.data.opacity = o;
        return this;
    }
    easing(e, cubicParams) {
        this.data.easing = e;
        if (cubicParams) {
            this.data.cubic_params = cubicParams;
        }
        return this;
    }
    springConfig(config) {
        this.data.springConfig = config;
        return this;
    }
    interpolateConfig(config) {
        this.data.interpolateConfig = config;
        return this;
    }
    build() {
        return { ...this.data };
    }
}
