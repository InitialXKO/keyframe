import { AnimationClipData, KeyframeData } from "./types.js";
import { Keyframe } from "./keyframe.js";

export class Clip {
  public id: string;
  private _duration = 1000;
  private _iterations = 1;
  private _keyframes: KeyframeData[] = [];
  private _metadata?: Record<string, any>;

  constructor(id: string) {
    this.id = id;
  }

  public duration(d: number): this {
    this._duration = d;
    return this;
  }

  public metadata(data: Record<string, any>): this {
    this._metadata = { ...this._metadata, ...data };
    return this;
  }

  public iterations(i: number): this {
    this._iterations = i;
    return this;
  }

  public addKeyframe(kf: Keyframe | KeyframeData): this {
    if (kf instanceof Keyframe) {
      this._keyframes.push(kf.build());
    } else {
      this._keyframes.push(kf);
    }
    return this;
  }

  public build(): AnimationClipData {
    return {
      id: this.id,
      duration: this._duration,
      iterations: this._iterations,
      keyframes: [...this._keyframes],
      ...(this._metadata ? { metadata: { ...this._metadata } } : {}),
    };
  }
}
