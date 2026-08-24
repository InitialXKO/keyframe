import { AnimationClipData, EngineIR, InstanceData, TimelineNodeData } from "./types.js";
import { Clip } from "./clip.js";
import { Instance } from "./instance.js";

export class Engine {
  private clips: Map<string, AnimationClipData> = new Map();
  private instances: InstanceData[] = [];
  private rootTimeline?: TimelineNodeData;
  private wasmInstance: any = null;

  constructor(wasmInstance?: any) {
    this.wasmInstance = wasmInstance;
  }

  public setWasmInstance(wasm: any): void {
    this.wasmInstance = wasm;
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
    if (this.wasmInstance) {
      const count = this.wasmInstance.evaluate_frame(globalTime);
      const ptr = this.wasmInstance.get_instance_buffer_ptr();
      const len = this.wasmInstance.get_instance_buffer_byte_length();
      return { count, ptr, len };
    }
    return { count: this.instances.length };
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
