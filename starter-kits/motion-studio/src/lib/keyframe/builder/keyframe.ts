import { Easing, KeyframeData, CubicBezierParams, TransformData, SpringConfig, InterpolateConfig } from "./types";
import { TransformBuilder } from "./transform";

export class Keyframe {
  private data: KeyframeData;

  constructor(time: number) {
    this.data = {
      time,
      transform: new TransformBuilder().build(),
      opacity: 1.0,
      easing: Easing.Linear,
    };
  }

  public transform(t: TransformData): this {
    this.data.transform = t;
    return this;
  }

  public opacity(o: number): this {
    this.data.opacity = o;
    return this;
  }

  public easing(e: Easing, cubicParams?: CubicBezierParams): this {
    this.data.easing = e;
    if (cubicParams) {
      this.data.cubic_params = cubicParams;
    }
    return this;
  }

  public springConfig(config: SpringConfig): this {
    this.data.springConfig = config;
    return this;
  }

  public interpolateConfig(config: InterpolateConfig): this {
    this.data.interpolateConfig = config;
    return this;
  }

  public build(): KeyframeData {
    return { ...this.data };
  }
}
