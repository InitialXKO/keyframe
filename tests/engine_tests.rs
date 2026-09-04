#[cfg(test)]
mod unit_tests {
    use keyframe_engine::easing::{solve_cubic_bezier, solve_spring};
    use keyframe_engine::engine::EngineState;
    use keyframe_engine::interpolator::{interpolate_cubic_bezier_path_3d, slerp_quaternions};
    use keyframe_engine::timeline::TimelineManager;
    use keyframe_engine::types::{
        AnimationClipData, BlendMode, EasingType, InstanceData, KeyframeData, TimelineNode,
        TransformData,
    };
    use std::time::Instant;

    use keyframe_engine::transform::transform_to_matrix;
    use keyframe_engine::types::GpuInstanceData;
    use std::mem::{align_of, size_of};

    #[test]
    fn test_gpu_instance_data_layout_and_alignment() {
        assert_eq!(size_of::<GpuInstanceData>(), 80);
        assert_eq!(align_of::<GpuInstanceData>(), 16);

        let inst = GpuInstanceData {
            transform_matrix: [0.0; 16],
            opacity: 1.0,
            visible: 1,
            clip_index: 0,
            _padding: 0,
        };
        let base = &inst as *const _ as usize;
        let opacity_offset = (&inst.opacity as *const _ as usize) - base;
        let visible_offset = (&inst.visible as *const _ as usize) - base;
        let clip_index_offset = (&inst.clip_index as *const _ as usize) - base;
        let padding_offset = (&inst._padding as *const _ as usize) - base;

        assert_eq!(opacity_offset, 64, "opacity offset must be 64 bytes (16 * 4 f32s)");
        assert_eq!(visible_offset, 68, "visible offset must be 68 bytes");
        assert_eq!(clip_index_offset, 72, "clip_index offset must be 72 bytes");
        assert_eq!(padding_offset, 76, "_padding offset must be 76 bytes");
    }

    #[test]
    fn test_rotate_x_90_snapshot() {
        let t = TransformData {
            rotation_quat: [0.70710678, 0.0, 0.0, 0.70710678],
            ..Default::default()
        };
        let mat = transform_to_matrix(&t);
        let cols = mat.to_cols_array();
        // Column-major order: index 6 corresponds to column 1, row 2 (m21)
        assert!(
            (cols[6] - 1.0).abs() < 1e-4,
            "Expected m21 (cols[6]) == 1.0 for 90° X-axis rotation, got {}",
            cols[6]
        );
    }

    #[test]
    fn test_rotate_z_45_snapshot() {
        let t = TransformData {
            rotation_quat: [0.0, 0.0, 0.38268343, 0.92387953],
            ..Default::default()
        };
        let mat = transform_to_matrix(&t);
        let cols = mat.to_cols_array();
        let expected_cos = 0.70710678;
        let expected_sin = 0.70710678;

        assert!((cols[0] - expected_cos).abs() < 1e-4); // m00
        assert!((cols[1] - expected_sin).abs() < 1e-4); // m10
        assert!((cols[4] - (-expected_sin)).abs() < 1e-4); // m01
        assert!((cols[5] - expected_cos).abs() < 1e-4); // m11
    }

    #[test]
    fn test_scale_2_05_1_snapshot() {
        let t = TransformData {
            scale: [2.0, 0.5, 1.0],
            ..Default::default()
        };
        let mat = transform_to_matrix(&t);
        let cols = mat.to_cols_array();

        assert!((cols[0] - 2.0).abs() < 1e-6);
        assert!((cols[5] - 0.5).abs() < 1e-6);
        assert!((cols[10] - 1.0).abs() < 1e-6);
        assert!((cols[15] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_all_easing_variants() {
        use keyframe_engine::easing::evaluate_easing;

        let easings = [
            EasingType::BounceIn,
            EasingType::BounceOut,
            EasingType::BounceInOut,
            EasingType::ElasticIn,
            EasingType::ElasticOut,
            EasingType::ElasticInOut,
            EasingType::BackIn,
            EasingType::BackOut,
            EasingType::BackInOut,
            EasingType::ExpoIn,
            EasingType::ExpoOut,
            EasingType::ExpoInOut,
            EasingType::SineIn,
            EasingType::SineOut,
            EasingType::SineInOut,
            EasingType::SpringEasing,
        ];

        for &easing in &easings {
            let start = evaluate_easing(easing, None, 0.0);
            let end = evaluate_easing(easing, None, 1.0);
            let mid = evaluate_easing(easing, None, 0.5);

            assert!((start - 0.0).abs() < 1e-3, "Start boundary failed for {:?}", easing);
            if easing == EasingType::SpringEasing {
                assert!(end.is_finite(), "End value not finite for {:?}", easing);
            } else {
                assert!((end - 1.0).abs() < 1e-3, "End boundary failed for {:?}", easing);
            }
            assert!(mid.is_finite(), "Mid value not finite for {:?}", easing);
        }
    }

    #[test]
    fn test_cubic_bezier_solving() {
        let res_start = solve_cubic_bezier(0.25, 0.1, 0.25, 1.0, 0.0);
        let res_end = solve_cubic_bezier(0.25, 0.1, 0.25, 1.0, 1.0);
        let res_mid = solve_cubic_bezier(0.25, 0.1, 0.25, 1.0, 0.5);

        assert!((res_start - 0.0).abs() < 1e-4);
        assert!((res_end - 1.0).abs() < 1e-4);
        assert!(res_mid > 0.0 && res_mid < 1.0);
    }

    #[test]
    fn test_cubic_bezier_degenerate_curves_error_bound() {
        let degenerate_cases = [
            (0.5, 0.0, 0.5, 1.0),   // Near-degenerate horizontal tangent
            (0.0, 1.5, 1.0, -0.5),  // y overshoot
            (0.001, 0.001, 0.999, 0.999), // Extreme compression
        ];

        fn solve_cubic_bezier_ref(p1x: f64, p1y: f64, p2x: f64, p2y: f64, target_x: f64) -> f64 {
            if target_x <= 0.0 { return 0.0; }
            if target_x >= 1.0 { return 1.0; }

            let mut low = 0.0;
            let mut high = 1.0;
            let mut u = target_x;

            for _ in 0..64 {
                let one_minus_u = 1.0 - u;
                let x = 3.0 * one_minus_u * one_minus_u * u * p1x + 3.0 * one_minus_u * u * u * p2x + u * u * u;
                let err = x - target_x;
                if err.abs() < 1e-9 { break; }
                if err > 0.0 {
                    high = u;
                } else {
                    low = u;
                }
                let dx = 3.0 * one_minus_u * one_minus_u * p1x + 6.0 * one_minus_u * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
                if dx.abs() > 1e-7 {
                    let next_u = u - err / dx;
                    if next_u > low && next_u < high {
                        u = next_u;
                        continue;
                    }
                }
                u = 0.5 * (low + high);
            }

            let one_minus_u = 1.0 - u;
            3.0 * one_minus_u * one_minus_u * u * p1y + 3.0 * one_minus_u * u * u * p2y + u * u * u
        }

        for &(p1x, p1y, p2x, p2y) in &degenerate_cases {
            let mut step = 0;
            while step <= 1000 {
                let t = step as f64 / 1000.0;
                let result = solve_cubic_bezier(p1x, p1y, p2x, p2y, t);
                let reference = solve_cubic_bezier_ref(p1x, p1y, p2x, p2y, t);
                let diff = (result - reference).abs();
                assert!(
                    diff < 1e-6,
                    "Divergence at t={}: result={}, reference={}, diff={}",
                    t, result, reference, diff
                );
                step += 1;
            }
        }
    }

    #[test]
    fn test_spring_solver() {
        let val_start = solve_spring(0.0, 30.0, 10.0, 100.0, 1.0);
        let val_mid = solve_spring(15.0, 30.0, 10.0, 100.0, 1.0);
        let val_late = solve_spring(150.0, 30.0, 10.0, 100.0, 1.0);

        assert_eq!(val_start, 0.0);
        assert!(val_mid > 0.0);
        assert!((val_late - 1.0).abs() < 0.05);
    }

    #[test]
    fn test_analytical_spring_remotion_parity() {
        let configs = [
            (10.0, 100.0, 1.0), // Underdamped
            (0.5, 200.0, 1.0),  // Very underdamped
            (20.0, 100.0, 1.0), // Critically damped (zeta = 1.0)
            (30.0, 100.0, 1.0), // Overdamped
        ];

        for &(damping, stiffness, mass) in &configs {
            for frame in 0..300 {
                let frame_f = frame as f64;
                let rust_val = solve_spring(frame_f, 30.0, damping, stiffness, mass);

                // Re-evaluate analytical formula independently
                let t = frame_f / 30.0;
                let ref_val = if t <= 0.0 {
                    0.0
                } else {
                    let w0 = (stiffness / mass).sqrt();
                    let zeta = damping / (2.0 * (stiffness * mass).sqrt());

                    if (zeta - 1.0).abs() < 1e-5 {
                        1.0 - (1.0 + w0 * t) * (-w0 * t).exp()
                    } else if zeta < 1.0 {
                        let wd = w0 * (1.0 - zeta * zeta).sqrt();
                        1.0 - (-zeta * w0 * t).exp() * ((zeta * w0 / wd) * (wd * t).sin() + (wd * t).cos())
                    } else {
                        let r1 = -w0 * (zeta - (zeta * zeta - 1.0).sqrt());
                        let r2 = -w0 * (zeta + (zeta * zeta - 1.0).sqrt());
                        let c2 = r1 / (r2 - r1);
                        let c1 = 1.0 - c2;
                        1.0 - (c1 * (r1 * t).exp() + c2 * (r2 * t).exp())
                    }
                };

                let diff = (rust_val - ref_val).abs();
                assert!(
                    diff < 1e-10,
                    "Mismatch frame={} config=({},{},{}): rust={}, ref={}, diff={}",
                    frame, damping, stiffness, mass, rust_val, ref_val, diff
                );
            }
        }
    }

    #[test]
    fn test_slerp() {
        let q1 = [0.0, 0.0, 0.0, 1.0];
        let q2 = [0.0, 0.70710678, 0.0, 0.70710678];
        let q_half = slerp_quaternions(q1, q2, 0.5);

        assert!((q_half[1] - 0.38268343).abs() < 0.01);
    }

    #[test]
    fn test_bezier_path_3d() {
        let p0 = [0.0, 0.0, 0.0];
        let p1 = [0.0, 10.0, 0.0];
        let p2 = [10.0, 10.0, 0.0];
        let p3 = [10.0, 0.0, 0.0];

        let start = interpolate_cubic_bezier_path_3d(p0, p1, p2, p3, 0.0);
        let end = interpolate_cubic_bezier_path_3d(p0, p1, p2, p3, 1.0);
        let mid = interpolate_cubic_bezier_path_3d(p0, p1, p2, p3, 0.5);

        assert_eq!(start, [0.0, 0.0, 0.0]);
        assert_eq!(end, [10.0, 0.0, 0.0]);
        assert_eq!(mid[0], 5.0);
        assert_eq!(mid[1], 7.5);
    }

    #[test]
    fn test_additive_and_time_remapping() {
        let mut engine = EngineState::new();
        let clip_data = AnimationClipData {
            id: "clip1".to_string(),
            duration: 1000.0,
            iterations: 1.0,
            keyframes: vec![
                KeyframeData {
                    time: 0.0,
                    transform: TransformData::default(),
                    opacity: 1.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
                KeyframeData {
                    time: 1000.0,
                    transform: TransformData {
                        translation: [100.0, 0.0, 0.0],
                        ..Default::default()
                    },
                    opacity: 0.5,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
            ],
            metadata: None,
        };
        engine.add_clip(clip_data).unwrap();

        let inst_data = InstanceData {
            id: "inst1".to_string(),
            clip_id: "clip1".to_string(),
            opacity: 1.0,
            visible: true,
            delay: 0.0,
            duration_scale: 1.0,
            time_remapping_speed: 2.0,
            blend_mode: BlendMode::Additive,
            initial_transform: TransformData::default(),
        };
        engine.add_instance(inst_data).unwrap();

        let gpu_instances = engine.evaluate_frame(250.0);
        assert_eq!(gpu_instances.len(), 1);
        assert!((gpu_instances[0].transform_matrix[12] - 50.0).abs() < 0.1);
    }

    #[test]
    fn test_bake_range_benchmark() {
        let mut engine = EngineState::new();
        let clip_data = AnimationClipData {
            id: "particle_clip".to_string(),
            duration: 2000.0,
            iterations: 1.0,
            keyframes: vec![
                KeyframeData {
                    time: 0.0,
                    transform: TransformData::default(),
                    opacity: 1.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
                KeyframeData {
                    time: 2000.0,
                    transform: TransformData {
                        translation: [500.0, 300.0, 0.0],
                        ..Default::default()
                    },
                    opacity: 0.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
            ],
            metadata: None,
        };
        engine.add_clip(clip_data).unwrap();

        for i in 0..1000 {
            let inst_data = InstanceData {
                id: format!("p_{}", i),
                clip_id: "particle_clip".to_string(),
                opacity: 1.0,
                visible: true,
                delay: (i as f64) * 0.5,
                duration_scale: 1.0,
                time_remapping_speed: 1.0,
                blend_mode: BlendMode::Override,
                initial_transform: TransformData::default(),
            };
            engine.add_instance(inst_data).unwrap();
        }

        let start_time = Instant::now();
        let baked_bytes = engine.bake_range(0.0, 2000.0, 30.0);
        let elapsed = start_time.elapsed();

        println!("Bake Benchmark: 1000 instances over 60 frames took {:?}", elapsed);
        assert!(!baked_bytes.is_empty());
    }

    #[test]
    fn test_bake_chunk() {
        let mut engine = EngineState::new();
        let clip_data = AnimationClipData {
            id: "chunk_clip".to_string(),
            duration: 2000.0,
            iterations: 1.0,
            keyframes: vec![
                KeyframeData {
                    time: 0.0,
                    transform: TransformData::default(),
                    opacity: 1.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
                KeyframeData {
                    time: 2000.0,
                    transform: TransformData {
                        translation: [100.0, 0.0, 0.0],
                        ..Default::default()
                    },
                    opacity: 0.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
            ],
            metadata: None,
        };
        engine.add_clip(clip_data).unwrap();

        let inst_data = InstanceData {
            id: "inst1".to_string(),
            clip_id: "chunk_clip".to_string(),
            opacity: 1.0,
            visible: true,
            delay: 0.0,
            duration_scale: 1.0,
            time_remapping_speed: 1.0,
            blend_mode: BlendMode::Override,
            initial_transform: TransformData::default(),
        };
        engine.add_instance(inst_data).unwrap();

        let chunk1 = engine.bake_chunk(0.0, 1000.0, 30.0);
        let chunk2 = engine.bake_chunk(1000.0, 2000.0, 30.0);

        assert!(!chunk1.is_empty());
        assert!(!chunk2.is_empty());
    }

    #[test]
    fn test_bake_stream_chunking_and_early_termination() {
        let mut engine = EngineState::new();
        let clip_data = AnimationClipData {
            id: "stream_clip".to_string(),
            duration: 2000.0,
            iterations: 1.0,
            keyframes: vec![
                KeyframeData {
                    time: 0.0,
                    transform: TransformData::default(),
                    opacity: 1.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
                KeyframeData {
                    time: 2000.0,
                    transform: TransformData {
                        translation: [100.0, 0.0, 0.0],
                        ..Default::default()
                    },
                    opacity: 1.0,
                    easing: EasingType::Linear,
                    cubic_params: None,
                },
            ],
            metadata: None,
        };
        engine.add_clip(clip_data).unwrap();

        // 100 instances x 80 bytes = 8KB per frame
        for i in 0..100 {
            let inst_data = InstanceData {
                id: format!("inst_{}", i),
                clip_id: "stream_clip".to_string(),
                opacity: 1.0,
                visible: true,
                delay: 0.0,
                duration_scale: 1.0,
                time_remapping_speed: 1.0,
                blend_mode: BlendMode::Override,
                initial_transform: TransformData::default(),
            };
            engine.add_instance(inst_data).unwrap();
        }

        let mut chunks_received = 0;
        let mut total_bytes_received = 0usize;

        let total_baked = engine
            .bake_stream(0.0, 2000.0, 30.0, |chunk| {
                chunks_received += 1;
                total_bytes_received += chunk.len();
                true
            })
            .unwrap();

        assert!(chunks_received > 0);
        assert_eq!(total_baked as usize, total_bytes_received);

        // Test early termination
        let mut early_chunks = 0;
        let early_baked = engine
            .bake_stream(0.0, 2000.0, 30.0, |_chunk| {
                early_chunks += 1;
                false // Stop immediately after first chunk
            })
            .unwrap();

        assert_eq!(early_chunks, 1);
        assert!(early_baked < total_baked);
    }

    #[test]
    fn test_timeline_flattening() {
        let root = TimelineNode {
            id: "root".to_string(),
            instance_id: None,
            start_time: 0.0,
            duration: 1000.0,
            is_parallel: false,
            children: vec![
                TimelineNode {
                    id: "child1".to_string(),
                    instance_id: Some("inst1".to_string()),
                    start_time: 0.0,
                    duration: 200.0,
                    children: vec![],
                    is_parallel: true,
                },
                TimelineNode {
                    id: "child2".to_string(),
                    instance_id: Some("inst2".to_string()),
                    start_time: 0.0,
                    duration: 300.0,
                    children: vec![],
                    is_parallel: true,
                },
            ],
        };

        let tm = TimelineManager::new(Some(root));
        let flattened = tm.flatten();
        assert_eq!(flattened.len(), 2);
        assert_eq!(flattened[0].instance_id, "inst1");
        assert_eq!(flattened[0].absolute_start_time, 0.0);
        assert_eq!(flattened[1].instance_id, "inst2");
        assert_eq!(flattened[1].absolute_start_time, 200.0);
    }
}
