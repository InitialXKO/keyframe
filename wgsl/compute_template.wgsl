// WGSL Compute Shader Template for Mass Instance Parallel Animation Evaluation

struct InstanceInput {
    transform_matrix: mat4x4<f32>,
    opacity: f32,
    visible: u32,
    clip_index: u32,
    _padding: u32,
}

struct KeyframeData {
    time: f32,
    easing_type: u32,
    p1x: f32,
    p1y: f32,
    p2x: f32,
    p2y: f32,
    translation: vec3<f32>,
    rotation: vec4<f32>,
    scale: vec3<f32>,
    opacity: f32,
}

struct ClipState {
    clip_index: u32,
    current_time: f32,
    progress: f32,
    opacity: f32,
}

struct Uniforms {
    global_time: f32,
    instance_count: u32,
    keyframe_count: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> clip_states: array<ClipState>;
@group(0) @binding(2) var<storage, read_write> instances: array<InstanceInput>;
@group(0) @binding(3) var<storage, read> keyframes: array<KeyframeData>;

fn solve_cubic_bezier(p1x: f32, p1y: f32, p2x: f32, p2y: f32, t: f32) -> f32 {
    if (t <= 0.0) { return 0.0; }
    if (t >= 1.0) { return 1.0; }

    var u: f32 = t;
    for (var i: i32 = 0; i < 8; i = i + 1) {
        let one_minus_u = 1.0 - u;
        let x = 3.0 * one_minus_u * one_minus_u * u * p1x + 3.0 * one_minus_u * u * u * p2x + u * u * u;
        let dx = 3.0 * one_minus_u * one_minus_u * p1x + 6.0 * one_minus_u * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
        if (abs(dx) < 1e-7) { break; }
        let err = x - t;
        u = clamp(u - err / dx, 0.0, 1.0);
    }
    let one_minus_u = 1.0 - u;
    return 3.0 * one_minus_u * one_minus_u * u * p1y + 3.0 * one_minus_u * u * u * p2y + u * u * u;
}

fn quat_slerp(q1: vec4<f32>, q2: vec4<f32>, t: f32) -> vec4<f32> {
    var cos_half_theta = dot(q1, q2);
    var q2_adj = q2;
    if (cos_half_theta < 0.0) {
        q2_adj = -q2;
        cos_half_theta = -cos_half_theta;
    }
    if (abs(cos_half_theta) >= 1.0) {
        return q1;
    }
    let half_theta = acos(cos_half_theta);
    let sin_half_theta = sqrt(1.0 - cos_half_theta * cos_half_theta);
    if (abs(sin_half_theta) < 0.001) {
        return mix(q1, q2_adj, t);
    }
    let ratio_a = sin((1.0 - t) * half_theta) / sin_half_theta;
    let ratio_b = sin(t * half_theta) / sin_half_theta;
    return q1 * ratio_a + q2_adj * ratio_b;
}

fn quat_to_mat4(q: vec4<f32>) -> mat4x4<f32> {
    let x = q.x; let y = q.y; let z = q.z; let w = q.w;
    let x2 = x + x; let y2 = y + y; let z2 = z + z;
    let xx = x * x2; let xy = x * y2; let xz = x * z2;
    let yy = y * y2; let yz = y * z2; let zz = z * z2;
    let wx = w * x2; let wy = w * y2; let wz = w * z2;

    return mat4x4<f32>(
        vec4<f32>(1.0 - (yy + zz), xy + wz, xz - wy, 0.0),
        vec4<f32>(xy - wz, 1.0 - (xx + zz), yz + wx, 0.0),
        vec4<f32>(xz + wy, yz - wx, 1.0 - (xx + yy), 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 1.0)
    );
}

fn compose_trs(translation: vec3<f32>, rotation: vec4<f32>, scale: vec3<f32>) -> mat4x4<f32> {
    let rot_mat = quat_to_mat4(rotation);
    return mat4x4<f32>(
        rot_mat[0] * scale.x,
        rot_mat[1] * scale.y,
        rot_mat[2] * scale.z,
        vec4<f32>(translation, 1.0)
    );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= uniforms.instance_count) {
        return;
    }

    var inst = instances[index];
    let clip_idx = inst.clip_index;
    let state = clip_states[clip_idx];

    let time = state.current_time;

    var kf0 = keyframes[0];
    var kf1 = keyframes[0];

    if (uniforms.keyframe_count > 0u) {
        kf0 = keyframes[0];
        kf1 = keyframes[uniforms.keyframe_count - 1u];

        for (var i: u32 = 0u; i < uniforms.keyframe_count - 1u; i = i + 1u) {
            if (time >= keyframes[i].time && time <= keyframes[i + 1u].time) {
                kf0 = keyframes[i];
                kf1 = keyframes[i + 1u];
                break;
            }
        }
    }

    let dt = kf1.time - kf0.time;
    var raw_t: f32 = 0.0;
    if (dt > 1e-5) {
        raw_t = clamp((time - kf0.time) / dt, 0.0, 1.0);
    }

    var eased_t: f32 = raw_t;
    if (kf0.easing_type == 1u) {
        eased_t = solve_cubic_bezier(0.25, 0.1, 0.25, 1.0, raw_t);
    } else if (kf0.easing_type == 2u) {
        eased_t = solve_cubic_bezier(kf0.p1x, kf0.p1y, kf0.p2x, kf0.p2y, raw_t);
    }

    let trans = mix(kf0.translation, kf1.translation, eased_t);
    let rot = quat_slerp(kf0.rotation, kf1.rotation, eased_t);
    let scale = mix(kf0.scale, kf1.scale, eased_t);

    inst.transform_matrix = compose_trs(trans, rot, scale);
    inst.opacity = mix(kf0.opacity, kf1.opacity, eased_t) * state.opacity;
    instances[index] = inst;
}
