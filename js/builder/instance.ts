import { InstanceData, TransformData } from "./types.js";
import { TransformBuilder } from "./transform.js";

let instanceIdCounter = 0;

export class Instance {
  public id: string;
  public clipId: string;
  private _opacity = 1.0;
  private _visible = true;
  private _delay = 0;
  private _durationScale = 1.0;
  private _initialTransform: TransformData = new TransformBuilder().build();

  constructor(clipId: string, id?: string) {
    this.clipId = clipId;
    this.id = id || `inst_${++instanceIdCounter}`;
  }

  public opacity(o: number): this {
    this._opacity = o;
    return this;
  }

  public visible(v: boolean): this {
    this._visible = v;
    return this;
  }

  public delay(d: number): this {
    this._delay = d;
    return this;
  }

  public durationScale(s: number): this {
    this._durationScale = s;
    return this;
  }

  public initialTransform(t: TransformData): this {
    this._initialTransform = t;
    return this;
  }

  public build(): InstanceData {
    return {
      id: this.id,
      clip_id: this.clipId,
      opacity: this._opacity,
      visible: this._visible,
      delay: this._delay,
      duration_scale: this._durationScale,
      initial_transform: this._initialTransform,
    };
  }
}
