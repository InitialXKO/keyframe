import { AnimationClipData, Easing, KeyframeData } from "./types.js";
import { Keyframe } from "./keyframe.js";

export class Clip {
  public id: string;
  private _duration = 1000;
  private _easing: Easing = Easing.Linear;
  private _iterations = 1;
  private _keyframes: KeyframeData[] = [];

  constructor(id: string) {
    this.id = id;
  }

  public duration(d: number): this {
    this._duration = d;
    return this;
  }

  public easing(e: Easing): this {
    this._easing = e;
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
      easing: this._easing,
      iterations: this._iterations,
      keyframes: [...this._keyframes],
    };
  }
}
