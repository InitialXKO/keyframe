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

/// Reference 64-iteration Newton-Raphson cubic-bezier solver for precision validation
pub fn solve_cubic_bezier_ref_64(p1x: f64, p1y: f64, p2x: f64, p2y: f64, t: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }

    let mut u = t;
    for _ in 0..64 {
        let one_minus_u = 1.0 - u;
        let x = 3.0 * one_minus_u * one_minus_u * u * p1x
            + 3.0 * one_minus_u * u * u * p2x
            + u * u * u;
        let dx = 3.0 * one_minus_u * one_minus_u * p1x
            + 6.0 * one_minus_u * u * (p2x - p1x)
            + 3.0 * u * u * (1.0 - p2x);
        if dx.abs() < 1e-12 {
            break;
        }
        let err = x - t;
        u -= err / dx;
        u = u.clamp(0.0, 1.0);
    }

    let one_minus_u = 1.0 - u;
    3.0 * one_minus_u * one_minus_u * u * p1y
        + 3.0 * one_minus_u * u * u * p2y
        + u * u * u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cubic_bezier_degenerate_cases_convergence() {
        // Degenerate curve cases: flat slopes, Y overshooting, extreme compression
        let degenerate_cases = [
            (0.5, 0.0, 0.5, 1.0),       // Flat slope
            (0.0, 1.5, 1.0, -0.5),      // Y overshoot
            (0.001, 0.001, 0.999, 0.999), // Compressed
            (0.1, 0.9, 0.9, 0.1),       // Steep S-curve
        ];

        for &(p1x, p1y, p2x, p2y) in &degenerate_cases {
            for step in 0..=1000 {
                let t = (step as f64) / 1000.0;
                let val_8 = solve_cubic_bezier(p1x, p1y, p2x, p2y, t);
                let val_64 = solve_cubic_bezier_ref_64(p1x, p1y, p2x, p2y, t);

                let diff = (val_8 - val_64).abs();
                assert!(
                    diff < 1e-5,
                    "Degenerate curve ({}, {}, {}, {}) divergence at t={}: 8-step={}, 64-step={}, diff={}",
                    p1x, p1y, p2x, p2y, t, val_8, val_64, diff
                );
            }
        }
    }
}

fn bounce_out(t: f64) -> f64 {
    if t < 1.0 / 2.75 {
        7.5625 * t * t
    } else if t < 2.0 / 2.75 {
        let t = t - 1.5 / 2.75;
        7.5625 * t * t + 0.75
    } else if t < 2.5 / 2.75 {
        let t = t - 2.25 / 2.75;
        7.5625 * t * t + 0.9375
    } else {
        let t = t - 2.625 / 2.75;
        7.5625 * t * t + 0.984375
    }
}

fn bounce_in(t: f64) -> f64 {
    1.0 - bounce_out(1.0 - t)
}

fn bounce_in_out(t: f64) -> f64 {
    if t < 0.5 {
        (1.0 - bounce_out(1.0 - 2.0 * t)) / 2.0
    } else {
        (1.0 + bounce_out(2.0 * t - 1.0)) / 2.0
    }
}

fn elastic_out(t: f64) -> f64 {
    if t == 0.0 || t == 1.0 {
        return t;
    }
    (2.0_f64.powf(-10.0 * t)) * ((t - 0.075) * (2.0 * std::f64::consts::PI) / 0.3).sin() + 1.0
}

fn elastic_in(t: f64) -> f64 {
    if t == 0.0 || t == 1.0 {
        return t;
    }
    -(2.0_f64.powf(10.0 * t - 10.0)) * ((t * 10.0 - 10.75) * (2.0 * std::f64::consts::PI) / 3.0).sin()
}

fn elastic_in_out(t: f64) -> f64 {
    if t == 0.0 || t == 1.0 {
        return t;
    }
    if t < 0.5 {
        -0.5 * (2.0_f64.powf(20.0 * t - 10.0)) * (((20.0 * t - 11.125) * (2.0 * std::f64::consts::PI)) / 4.5).sin()
    } else {
        0.5 * (2.0_f64.powf(-20.0 * t + 10.0)) * (((20.0 * t - 11.125) * (2.0 * std::f64::consts::PI)) / 4.5).sin() + 1.0
    }
}

const S: f64 = 1.70158;

fn back_in(t: f64) -> f64 {
    t * t * ((S + 1.0) * t - S)
}

fn back_out(t: f64) -> f64 {
    let t = t - 1.0;
    t * t * ((S + 1.0) * t + S) + 1.0
}

fn back_in_out(t: f64) -> f64 {
    let s = S * 1.525;
    if t < 0.5 {
        let t = 2.0 * t;
        (t * t * ((s + 1.0) * t - s)) / 2.0
    } else {
        let t = 2.0 * t - 2.0;
        (t * t * ((s + 1.0) * t + s) + 2.0) / 2.0
    }
}

fn expo_in(t: f64) -> f64 {
    if t == 0.0 { 0.0 } else { 2.0_f64.powf(10.0 * t - 10.0) }
}

fn expo_out(t: f64) -> f64 {
    if t == 1.0 { 1.0 } else { 1.0 - 2.0_f64.powf(-10.0 * t) }
}

fn expo_in_out(t: f64) -> f64 {
    if t == 0.0 {
        0.0
    } else if t == 1.0 {
        1.0
    } else if t < 0.5 {
        2.0_f64.powf(20.0 * t - 10.0) / 2.0
    } else {
        (2.0 - 2.0_f64.powf(-20.0 * t + 10.0)) / 2.0
    }
}

fn sine_in(t: f64) -> f64 {
    1.0 - ((t * std::f64::consts::PI) / 2.0).cos()
}

fn sine_out(t: f64) -> f64 {
    ((t * std::f64::consts::PI) / 2.0).sin()
}

fn sine_in_out(t: f64) -> f64 {
    -(((t * std::f64::consts::PI).cos()) - 1.0) / 2.0
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
        EasingType::BounceIn => bounce_in(clamped_t),
        EasingType::BounceOut => bounce_out(clamped_t),
        EasingType::BounceInOut => bounce_in_out(clamped_t),
        EasingType::ElasticIn => elastic_in(clamped_t),
        EasingType::ElasticOut => elastic_out(clamped_t),
        EasingType::ElasticInOut => elastic_in_out(clamped_t),
        EasingType::BackIn => back_in(clamped_t),
        EasingType::BackOut => back_out(clamped_t),
        EasingType::BackInOut => back_in_out(clamped_t),
        EasingType::ExpoIn => expo_in(clamped_t),
        EasingType::ExpoOut => expo_out(clamped_t),
        EasingType::ExpoInOut => expo_in_out(clamped_t),
        EasingType::SineIn => sine_in(clamped_t),
        EasingType::SineOut => sine_out(clamped_t),
        EasingType::SineInOut => sine_in_out(clamped_t),
        EasingType::SpringEasing => solve_spring(clamped_t, 1.0, 0.5, 100.0, 1.0),
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
