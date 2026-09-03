use crate::types::{CubicBezierParams, EasingType};

pub fn solve_cubic_bezier(p1x: f64, p1y: f64, p2x: f64, p2y: f64, t: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }

    // Solve for u given x = t using Newton-Raphson
    let mut u = t;
    for _ in 0..8 {
        let one_minus_u = 1.0 - u;
        let x = 3.0 * one_minus_u * one_minus_u * u * p1x
            + 3.0 * one_minus_u * u * u * p2x
            + u * u * u;
        let dx = 3.0 * one_minus_u * one_minus_u * p1x
            + 6.0 * one_minus_u * u * (p2x - p1x)
            + 3.0 * u * u * (1.0 - p2x);
        if dx.abs() < 1e-7 {
            break;
        }
        let err = x - t;
        u -= err / dx;
        u = u.clamp(0.0, 1.0);
    }

    // Evaluate y(u)
    let one_minus_u = 1.0 - u;
    3.0 * one_minus_u * one_minus_u * u * p1y
        + 3.0 * one_minus_u * u * u * p2y
        + u * u * u
}

pub fn evaluate_easing(easing: EasingType, cubic_params: Option<&CubicBezierParams>, t: f64) -> f64 {
    let clamped_t = t.clamp(0.0, 1.0);
    match easing {
        EasingType::Linear => clamped_t,
        EasingType::Ease => solve_cubic_bezier(0.25, 0.1, 0.25, 1.0, clamped_t),
        EasingType::EaseIn => solve_cubic_bezier(0.42, 0.0, 1.0, 1.0, clamped_t),
        EasingType::EaseOut => solve_cubic_bezier(0.0, 0.0, 0.58, 1.0, clamped_t),
        EasingType::EaseInOut => solve_cubic_bezier(0.42, 0.0, 0.58, 1.0, clamped_t),
        EasingType::CubicBezier => {
            if let Some(params) = cubic_params {
                solve_cubic_bezier(params.p1x, params.p1y, params.p2x, params.p2y, clamped_t)
            } else {
                // Fallback to standard EaseInOut curve (0.42, 0.0, 0.58, 1.0) when cubic_params is omitted
                solve_cubic_bezier(0.42, 0.0, 0.58, 1.0, clamped_t)
            }
        }
        EasingType::Step => {
            if clamped_t >= 1.0 {
                1.0
            } else {
                0.0
            }
        }
    }
}

pub fn solve_spring(frame: f64, fps: f64, damping: f64, stiffness: f64, mass: f64) -> f64 {
    let m = if mass <= 0.0 { 1.0 } else { mass };
    let t = frame / fps;
    if t <= 0.0 {
        return 0.0;
    }

    let w0 = (stiffness / m).sqrt();
    let zeta = damping / (2.0 * (stiffness * m).sqrt());

    if (zeta - 1.0).abs() < 1e-5 {
        // Critically damped
        let val = 1.0 - (1.0 + w0 * t) * (-w0 * t).exp();
        val
    } else if zeta < 1.0 {
        // Underdamped
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        let val = 1.0
            - (-zeta * w0 * t).exp()
                * ((zeta * w0 / wd) * (wd * t).sin() + (wd * t).cos());
        val
    } else {
        // Overdamped
        let r1 = -w0 * (zeta - (zeta * zeta - 1.0).sqrt());
        let r2 = -w0 * (zeta + (zeta * zeta - 1.0).sqrt());
        let c2 = (r1) / (r2 - r1);
        let c1 = 1.0 - c2;
        let val = 1.0 - (c1 * (r1 * t).exp() + c2 * (r2 * t).exp());
        val
    }
}
