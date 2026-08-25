use crate::easing::evaluate_easing;
use crate::transform::interpolate_transforms;
use crate::types::{KeyframeData, TransformData};
use glam::{Quat, Vec3};

pub fn slerp_quaternions(a: [f32; 4], b: [f32; 4], factor: f32) -> [f32; 4] {
    let q1 = Quat::from_slice(&a).normalize();
    let q2 = Quat::from_slice(&b).normalize();
    q1.slerp(q2, factor).to_array()
}

pub fn interpolate_keyframes(
    kf_prev: &KeyframeData,
    kf_next: &KeyframeData,
    current_time: f64,
) -> (TransformData, f32) {
    if current_time <= kf_prev.time {
        return (kf_prev.transform.clone(), kf_prev.opacity);
    }
    if current_time >= kf_next.time {
        return (kf_next.transform.clone(), kf_next.opacity);
    }

    let duration = kf_next.time - kf_prev.time;
    if duration <= 0.0001 {
        return (kf_next.transform.clone(), kf_next.opacity);
    }

    let linear_t = (current_time - kf_prev.time) / duration;
    let eased_t = evaluate_easing(kf_prev.easing, kf_prev.cubic_params.as_ref(), linear_t) as f32;

    let transform = interpolate_transforms(&kf_prev.transform, &kf_next.transform, eased_t);
    let opacity = kf_prev.opacity + (kf_next.opacity - kf_prev.opacity) * eased_t;

    (transform, opacity)
}

pub fn interpolate_cubic_bezier_path_3d(
    p0: [f32; 3],
    p1: [f32; 3],
    p2: [f32; 3],
    p3: [f32; 3],
    t: f32,
) -> [f32; 3] {
    let clamped_t = t.clamp(0.0, 1.0);
    let v0 = Vec3::from_slice(&p0);
    let v1 = Vec3::from_slice(&p1);
    let v2 = Vec3::from_slice(&p2);
    let v3 = Vec3::from_slice(&p3);

    let one_minus_t = 1.0 - clamped_t;
    let res = one_minus_t * one_minus_t * one_minus_t * v0
        + 3.0 * one_minus_t * one_minus_t * clamped_t * v1
        + 3.0 * one_minus_t * clamped_t * clamped_t * v2
        + clamped_t * clamped_t * clamped_t * v3;

    res.to_array()
}
