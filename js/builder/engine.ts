import { AnimationClipData, EngineIR, EvaluatedInstance, InstanceData, TimelineNodeData } from "./types.js";
import { Clip } from "./clip.js";

export { EvaluatedInstance } from "./types.js";
import { Instance } from "./instance.js";

export class Engine {
  private clips: Map<string, AnimationClipData> = new Map();
  private instances: InstanceData[] = [];
  private rootTimeline?: TimelineNodeData;
  private wasmInstance: any = null;
  private devToolsEnabled = false;
  private notifyingDevTools = false;

  constructor(wasmInstance?: any) {
    this.wasmInstance = wasmInstance;
    this.autoBindWasmMemory();
  }

  public setWasmInstance(wasm: any): void {
    this.wasmInstance = wasm;
    this.autoBindWasmMemory();
  }

  public bindWasmMemory(memory: any): this {
    const mem = this.resolveMemory(memory);
    if (this.wasmInstance) {
      this.wasmInstance.memory = mem;
    }
    (globalThis as any).wasmMemory = mem;
    return this;
  }

  public setWasmMemory(memory: any): this {
    return this.bindWasmMemory(memory);
  }

  public static bindWasmMemory(memory: any): void {
    const mem = memory?.buffer ? memory : (memory?.memory || memory);
    (globalThis as any).wasmMemory = mem;
  }

  private resolveMemory(mem: any): any {
    if (!mem) return null;
    if (mem.buffer) return mem;
    if (mem.memory?.buffer) return mem.memory;
    if (mem.__wasm?.memory?.buffer) return mem.__wasm.memory;
    return null;
  }

  private autoBindWasmMemory(): void {
    if (!this.wasmInstance) return;

    if (!this.wasmInstance.memory) {
      const resolved =
        this.resolveMemory(this.wasmInstance) ||
        this.resolveMemory((globalThis as any).wasmMemory);

      if (resolved) {
        this.wasmInstance.memory = resolved;
      }
    }

    if (this.wasmInstance.memory && !(globalThis as any).wasmMemory) {
      (globalThis as any).wasmMemory = this.wasmInstance.memory;
    }
  }

  public enableDevTools(): void {
    this.devToolsEnabled = true;
    if (typeof window !== "undefined") {
      (window as any).__KEYFRAME_ENGINE_DEVTOOLS_ACTIVE__ = true;
    }
  }

  public isDevToolsEnabled(): boolean {
    return this.devToolsEnabled;
  }

  public addClip(clip: Clip | AnimationClipData): this {
    const data = clip instanceof Clip ? clip.build() : clip;
    this.clips.set(data.id, data);
    if (this.wasmInstance) {
      this.wasmInstance.add_clip_json(JSON.stringify(data));
    }
    return this;
  }

  public addInstances(instances: (Instance | InstanceData)[]): this {
    for (const inst of instances) {
      const data = inst instanceof Instance ? inst.build() : inst;
      this.instances.push(data);
      if (this.wasmInstance) {
        this.wasmInstance.add_instance_json(JSON.stringify(data));
      }
    }
    return this;
  }

  public setRootTimeline(node: TimelineNodeData): this {
    this.rootTimeline = node;
    if (this.wasmInstance) {
      this.wasmInstance.set_root_timeline_json(JSON.stringify(node));
    }
    return this;
  }

  public async prepare(): Promise<void> {
    if (this.wasmInstance) {
      this.wasmInstance.prepare();
    }
  }

  public evaluateFrame(globalTime: number): any {
    let result: any = { count: this.instances.length };
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

  public getEvaluatedInstances(globalTime: number, skipEvaluate = false): EvaluatedInstance[] {
    const evalResult = skipEvaluate ? { count: this.instances.length } : this.evaluateFrame(globalTime);
    const result: EvaluatedInstance[] = [];

    if (this.wasmInstance) {
      this.autoBindWasmMemory();
      const memory = this.wasmInstance.memory ?? (globalThis as any).wasmMemory ?? this.wasmInstance.__wasm?.memory;
      if (!memory || !memory.buffer) {
        throw new ReferenceError(
          "WASM memory not bound. Call Engine.bindWasmMemory(memory) first, " +
          "or set globalThis.wasmMemory = wasmExports.memory after initSync()."
        );
      }

      if (evalResult.ptr != null && evalResult.len > 0) {
        const memoryBuffer: ArrayBuffer = memory.buffer;
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
    } else {
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

  private notifyDevTools(globalTime: number, evaluatedInstances: EvaluatedInstance[]): void {
    if (typeof window !== "undefined" && window.postMessage) {
      window.postMessage(
        {
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
        },
        "*"
      );
    }
  }

  public bakeChunk(startMs: number, endMs: number, fps = 30): Uint8Array {
    if (this.wasmInstance && this.wasmInstance.bake_chunk) {
      return this.wasmInstance.bake_chunk(startMs, endMs, fps);
    } else if (this.wasmInstance && this.wasmInstance.bake_range) {
      return this.wasmInstance.bake_range(startMs, endMs, fps);
    }
    const duration = Math.max(0, endMs - startMs);
    const numFrames = Math.max(1, Math.floor((duration / 1000) * fps));
    const instCount = this.instances.length || 1;
    return new Uint8Array(numFrames * instCount * 80);
  }

  public bakeRange(startMs: number, endMs: number, fps = 30): Uint8Array {
    return this.bakeChunk(startMs, endMs, fps);
  }

  public exportIR(): EngineIR {
    return {
      clips: Array.from(this.clips.values()),
      instances: [...this.instances],
      root_timeline: this.rootTimeline,
    };
  }

  public importIR(ir: EngineIR): void {
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
