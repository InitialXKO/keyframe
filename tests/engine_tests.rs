#[cfg(test)]
mod unit_tests {
    use keyframe_engine::easing::{solve_cubic_bezier, solve_spring};
    use keyframe_engine::engine::EngineState;
    use keyframe_engine::interpolator::slerp_quaternions;
    use keyframe_engine::timeline::TimelineManager;

    use keyframe_engine::types::{
        AnimationClipData, EasingType, KeyframeData, TimelineNode, TransformData,
    };


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
    fn test_timeline_flattening() {
        let root = TimelineNode {
            id: "root".to_string(),
            instance_id: None,
            start_time: 0.0,
            duration: 1000.0,
            is_parallel: false, // Serial
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

    #[test]
    fn test_verify_matrices() {
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
        engine.prepare().unwrap();

        let evaluated = engine.evaluate_frame(500.0);
        assert_eq!(evaluated.len(), 0); // No instances added yet
    }
}
