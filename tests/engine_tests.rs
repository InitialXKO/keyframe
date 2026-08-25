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
    fn test_spring_solver() {
        let val_start = solve_spring(0.0, 30.0, 10.0, 100.0, 1.0);
        let val_mid = solve_spring(15.0, 30.0, 10.0, 100.0, 1.0);
        let val_late = solve_spring(150.0, 30.0, 10.0, 100.0, 1.0);

        assert_eq!(val_start, 0.0);
        assert!(val_mid > 0.0);
        assert!((val_late - 1.0).abs() < 0.05);
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
            easing: EasingType::Linear,
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
            easing: EasingType::EaseInOut,
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
