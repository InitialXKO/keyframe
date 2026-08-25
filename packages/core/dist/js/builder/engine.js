import { Clip } from "./clip.js";
import { Instance } from "./instance.js";
export class Engine {
    clips = new Map();
    instances = [];
    rootTimeline;
    wasmInstance = null;
    devToolsEnabled = false;
    notifyingDevTools = false;
    constructor(wasmInstance) {
        this.wasmInstance = wasmInstance;
    }
    setWasmInstance(wasm) {
        this.wasmInstance = wasm;
    }
    enableDevTools() {
        this.devToolsEnabled = true;
        if (typeof window !== "undefined") {
            window.__KEYFRAME_ENGINE_DEVTOOLS_ACTIVE__ = true;
        }
    }
    isDevToolsEnabled() {
        return this.devToolsEnabled;
    }
    addClip(clip) {
        const data = clip instanceof Clip ? clip.build() : clip;
        this.clips.set(data.id, data);
        if (this.wasmInstance) {
            this.wasmInstance.add_clip_json(JSON.stringify(data));
        }
        return this;
    }
    addInstances(instances) {
        for (const inst of instances) {
            const data = inst instanceof Instance ? inst.build() : inst;
            this.instances.push(data);
            if (this.wasmInstance) {
                this.wasmInstance.add_instance_json(JSON.stringify(data));
            }
        }
        return this;
    }
    setRootTimeline(node) {
        this.rootTimeline = node;
        if (this.wasmInstance) {
            this.wasmInstance.set_root_timeline_json(JSON.stringify(node));
        }
        return this;
    }
    async prepare() {
        if (this.wasmInstance) {
            this.wasmInstance.prepare();
        }
    }
    evaluateFrame(globalTime) {
        let result = { count: this.instances.length };
        if (this.wasmInstance) {
            const count = this.wasmInstance.evaluate_frame(globalTime);
            const ptr = this.wasmInstance.get_instance_buffer_ptr();
            const len = this.wasmInstance.get_instance_buffer_byte_length();
            result = { count, ptr, len };
        }
        if (this.devToolsEnabled && !this.notifyingDevTools) {
            this.notifyingDevTools = true;
            const evaluated = this.getEvaluatedInstances(globalTime, true);
            this.notifyDevTools(globalTime, evaluated);
            this.notifyingDevTools = false;
        }
        return result;
    }
    getEvaluatedInstances(globalTime, skipEvaluate = false) {
        const evalResult = skipEvaluate ? { count: this.instances.length } : this.evaluateFrame(globalTime);
        const result = [];
        if (this.wasmInstance &&
            evalResult.ptr &&
            evalResult.len > 0 &&
            (this.wasmInstance.memory || globalThis.wasmMemory)) {
            const memoryBuffer = (this.wasmInstance.memory || globalThis.wasmMemory).buffer;
            const count = evalResult.count;
            const floatsPerInst = 20;
            const floatView = new Float32Array(memoryBuffer, evalResult.ptr, count * floatsPerInst);
            const uintView = new Uint32Array(memoryBuffer, evalResult.ptr, count * floatsPerInst);
            for (let i = 0; i < count; i++) {
                const offset = i * floatsPerInst;
                const transformMatrix = floatView.slice(offset, offset + 16);
                const opacity = floatView[offset + 16];
                const visible = uintView[offset + 17] === 1;
                const clipIndex = uintView[offset + 18];
                const instData = this.instances[i];
                result.push({
                    id: instData?.id,
                    clipId: instData?.clip_id,
                    transformMatrix,
                    opacity,
                    visible,
                    clipIndex,
                });
            }
        }
        else {
            // Fallback JS evaluation if WASM buffer is not accessible directly
            for (let i = 0; i < this.instances.length; i++) {
                const inst = this.instances[i];
                const identityMatrix = new Float32Array([
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, 0,
                    0, 0, 0, 1
                ]);
                const elapsed = Math.max(0, globalTime - inst.delay);
                const t = Math.min(1, elapsed / 2000);
                identityMatrix[12] = (t - 0.5) * 200; // tx
                identityMatrix[13] = Math.sin(t * Math.PI) * 100; // ty
                result.push({
                    id: inst.id,
                    clipId: inst.clip_id,
                    transformMatrix: identityMatrix,
                    opacity: inst.opacity ?? 1.0,
                    visible: inst.visible ?? true,
                    clipIndex: i,
                });
            }
        }
        return result;
    }
    notifyDevTools(globalTime, evaluatedInstances) {
        if (typeof window !== "undefined" && window.postMessage) {
            window.postMessage({
                source: "keyframe-engine-devtools",
                type: "FRAME_EVALUATED",
                payload: {
                    globalTime,
                    clips: Array.from(this.clips.values()),
                    instances: this.instances,
                    evaluatedInstances: evaluatedInstances.map((inst) => ({
                        id: inst.id,
                        clipId: inst.clipId,
                        opacity: inst.opacity,
                        visible: inst.visible,
                        clipIndex: inst.clipIndex,
                        matrix: Array.from(inst.transformMatrix),
                    })),
                },
            }, "*");
        }
    }
    bakeChunk(startMs, endMs, fps = 30) {
        if (this.wasmInstance && this.wasmInstance.bake_chunk) {
            return this.wasmInstance.bake_chunk(startMs, endMs, fps);
        }
        else if (this.wasmInstance && this.wasmInstance.bake_range) {
            return this.wasmInstance.bake_range(startMs, endMs, fps);
        }
        const duration = Math.max(0, endMs - startMs);
        const numFrames = Math.max(1, Math.floor((duration / 1000) * fps));
        const instCount = this.instances.length || 1;
        return new Uint8Array(numFrames * instCount * 80);
    }
    bakeRange(startMs, endMs, fps = 30) {
        return this.bakeChunk(startMs, endMs, fps);
    }
    exportIR() {
        return {
            clips: Array.from(this.clips.values()),
            instances: [...this.instances],
            root_timeline: this.rootTimeline,
        };
    }
    importIR(ir) {
        this.clips.clear();
        this.instances = [];
        for (const c of ir.clips) {
            this.addClip(c);
        }
        this.addInstances(ir.instances);
        if (ir.root_timeline) {
            this.setRootTimeline(ir.root_timeline);
        }
    }
}
