import { BlendMode } from "./types.js";
import { TransformBuilder } from "./transform.js";
let instanceIdCounter = 0;
export class Instance {
    id;
    clipId;
    _opacity = 1.0;
    _visible = true;
    _delay = 0;
    _durationScale = 1.0;
    _timeRemappingSpeed = 1.0;
    _blendMode = BlendMode.Override;
    _initialTransform = new TransformBuilder().build();
    _dependencies = [];
    _transformBindings = [];
    constructor(clipId, id) {
        this.clipId = clipId;
        this.id = id || `inst_${++instanceIdCounter}`;
    }
    opacity(o) {
        this._opacity = o;
        return this;
    }
    visible(v) {
        this._visible = v;
        return this;
    }
    delay(d) {
        this._delay = d;
        return this;
    }
    durationScale(s) {
        this._durationScale = s;
        return this;
    }
    timeRemappingSpeed(speed) {
        this._timeRemappingSpeed = speed;
        return this;
    }
    blendMode(mode) {
        this._blendMode = mode;
        return this;
    }
    initialTransform(t) {
        this._initialTransform = t;
        return this;
    }
    dependsOn(targetInstanceId, options) {
        this._dependencies.push({
            target_instance_id: targetInstanceId,
            trigger: options?.trigger ?? "onComplete",
            keyframe_index: options?.keyframeIndex,
            offset_ms: options?.offsetMs ?? 0,
        });
        return this;
    }
    bindTransformFrom(sourceInstanceId, options) {
        this._transformBindings.push({
            source_instance_id: sourceInstanceId,
            source_property: options.sourceProperty,
            target_property: options.targetProperty,
            offset: options.offset ?? 0,
        });
        return this;
    }
    build() {
        return {
            id: this.id,
            clip_id: this.clipId,
            opacity: this._opacity,
            visible: this._visible,
            delay: this._delay,
            duration_scale: this._durationScale,
            time_remapping_speed: this._timeRemappingSpeed,
            blend_mode: this._blendMode,
            initial_transform: this._initialTransform,
            dependencies: this._dependencies.length > 0 ? [...this._dependencies] : undefined,
            transform_bindings: this._transformBindings.length > 0 ? [...this._transformBindings] : undefined,
        };
    }
}
