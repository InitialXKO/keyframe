import type { Clip } from './builder/clip.js';
import type { Instance } from './builder/instance.js';
import type { AnimationClipData, InstanceData } from './builder/types.js';
import { Easing } from './builder/types.js';

export class Validator {
  static validateClip(clipInput: Clip | AnimationClipData): { ok: boolean; error?: string } {
    const clip = typeof (clipInput as any).build === 'function' ? (clipInput as Clip).build() : (clipInput as AnimationClipData);

    if (!clip.id || !clip.id.trim()) {
      return { ok: false, error: 'Clip ID cannot be empty' };
    }
    if (clip.duration < 0) {
      return { ok: false, error: `Clip '${clip.id}' duration cannot be negative (${clip.duration})` };
    }

    let prevTime = -1;
    const keyframes = clip.keyframes || [];
    for (let idx = 0; idx < keyframes.length; idx++) {
      const kf = keyframes[idx];
      if (kf.time < 0) {
        return { ok: false, error: `Clip '${clip.id}' keyframe #${idx} time cannot be negative (${kf.time})` };
      }
      if (kf.time > clip.duration) {
        return { ok: false, error: `Clip '${clip.id}' keyframe #${idx} time (${kf.time}) exceeds duration (${clip.duration})` };
      }
      if (kf.time < prevTime) {
        return { ok: false, error: `Clip '${clip.id}' keyframes must be monotonically non-decreasing in time: keyframe #${idx} (${kf.time}) < previous (${prevTime})` };
      }
      prevTime = kf.time;

      if (kf.easing === Easing.CubicBezier && kf.cubic_params) {
        const { p1x, p2x } = kf.cubic_params;
        if (p1x < 0 || p1x > 1) {
          return { ok: false, error: `Clip '${clip.id}' keyframe #${idx} cubic bezier p1x must be in [0, 1], got ${p1x}` };
        }
        if (p2x < 0 || p2x > 1) {
          return { ok: false, error: `Clip '${clip.id}' keyframe #${idx} cubic bezier p2x must be in [0, 1], got ${p2x}` };
        }
      }
    }

    return { ok: true };
  }

  static validateInstance(instInput: Instance | InstanceData): { ok: boolean; error?: string } {
    const inst = typeof (instInput as any).build === 'function' ? (instInput as Instance).build() : (instInput as InstanceData);

    if (!inst.id || !inst.id.trim()) {
      return { ok: false, error: 'Instance ID cannot be empty' };
    }
    if (!inst.clip_id || !inst.clip_id.trim()) {
      return { ok: false, error: `Instance '${inst.id}' must specify a clip_id` };
    }
    if (inst.time_remapping_speed !== undefined && inst.time_remapping_speed <= 0) {
      return { ok: false, error: `Instance '${inst.id}' time remapping speed must be positive, got ${inst.time_remapping_speed}` };
    }
    return { ok: true };
  }

  static validateReferences(instancesInput: (Instance | InstanceData)[], clipsInput: (Clip | AnimationClipData)[]): { ok: boolean; error?: string } {
    const clips = clipsInput.map((c) => typeof (c as any).build === 'function' ? (c as Clip).build() : (c as AnimationClipData));
    const instances = instancesInput.map((i) => typeof (i as any).build === 'function' ? (i as Instance).build() : (i as InstanceData));

    const clipIds = new Set(clips.map((c) => c.id));
    for (const inst of instances) {
      if (!clipIds.has(inst.clip_id)) {
        return { ok: false, error: `Instance '${inst.id}' references clip_id '${inst.clip_id}' which does not exist` };
      }
    }
    return { ok: true };
  }
}
