use crate::types::TransformData;
use glam::{Mat4, Quat, Vec3};

pub fn transform_to_matrix(t: &TransformData) -> Mat4 {
    let translation = Vec3::from_slice(&t.translation);
    let rotation = Quat::from_slice(&t.rotation_quat).normalize();
    let scale = Vec3::from_slice(&t.scale);
    let origin = Vec3::from_slice(&t.origin);

    // TRS with origin pivot:
    // T_final = Translation * Pivot * Rotation * Scale * Pivot^(-1)
    let t_trans = Mat4::from_translation(translation + origin);
    let t_rot = Mat4::from_quat(rotation);
    let t_scale = Mat4::from_scale(scale);
    let t_neg_origin = Mat4::from_translation(-origin);

    t_trans * t_rot * t_scale * t_neg_origin
}

pub fn interpolate_transforms(a: &TransformData, b: &TransformData, factor: f32) -> TransformData {
    let t_a = Vec3::from_slice(&a.translation);
    let t_b = Vec3::from_slice(&b.translation);
    let t_interp = t_a.lerp(t_b, factor);

    let q_a = Quat::from_slice(&a.rotation_quat).normalize();
    let q_b = Quat::from_slice(&b.rotation_quat).normalize();
    let q_interp = q_a.slerp(q_b, factor);

    let s_a = Vec3::from_slice(&a.scale);
    let s_b = Vec3::from_slice(&b.scale);
    let s_interp = s_a.lerp(s_b, factor);

    let o_a = Vec3::from_slice(&a.origin);
    let o_b = Vec3::from_slice(&b.origin);
    let o_interp = o_a.lerp(o_b, factor);

    TransformData {
        translation: t_interp.to_array(),
        rotation_quat: q_interp.to_array(),
        scale: s_interp.to_array(),
        origin: o_interp.to_array(),
    }
}
