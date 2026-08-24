// WGSL Keyframe Math Library

struct CubicBezierParams {
    p1x: f32,
    p1y: f32,
    p2x: f32,
    p2y: f32,
}

fn solve_cubic_bezier(p1x: f32, p1y: f32, p2x: f32, p2y: f32, t: f32) -> f32 {
    if (t <= 0.0) { return 0.0; }
    if (t >= 1.0) { return 1.0; }

    var u: f32 = t;
    for (var i: i32 = 0; i < 8; i = i + 1) {
        let one_minus_u = 1.0 - u;
        let x = 3.0 * one_minus_u * one_minus_u * u * p1x + 3.0 * one_minus_u * u * u * p2x + u * u * u;
        let dx = 3.0 * one_minus_u * one_minus_u * p1x + 6.0 * one_minus_u * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
        if (abs(dx) < 1e-7) {
            break;
        }
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
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;

    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;

    return mat4x4<f32>(
        vec4<f32>(1.0 - (yy + zz), xy + wz, xz - wy, 0.0),
        vec4<f32>(xy - wz, 1.0 - (xx + zz), yz + wx, 0.0),
        vec4<f32>(xz + wy, yz - wx, 1.0 - (xx + yy), 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 1.0)
    );
}

fn compose_trs(translation: vec3<f32>, rotation: vec4<f32>, scale: vec3<f32>, origin: vec3<f32>) -> mat4x4<f32> {
    let rot_mat = quat_to_mat4(rotation);

    // Mat4 column-major construction
    let scale_mat = mat4x4<f32>(
        vec4<f32>(scale.x, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, scale.y, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, scale.z, 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 1.0)
    );

    let t_vec = translation + origin;
    let trans_mat = mat4x4<f32>(
        vec4<f32>(1.0, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, 1.0, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, 1.0, 0.0),
        vec4<f32>(t_vec.x, t_vec.y, t_vec.z, 1.0)
    );

    let neg_origin_mat = mat4x4<f32>(
        vec4<f32>(1.0, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, 1.0, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, 1.0, 0.0),
        vec4<f32>(-origin.x, -origin.y, -origin.z, 1.0)
    );

    return trans_mat * rot_mat * scale_mat * neg_origin_mat;
}
