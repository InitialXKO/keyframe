use crate::types::GpuInstanceData;

#[cfg(test)]
mod tests {
    use crate::types::GpuInstanceData;
    use std::mem::{align_of, size_of};

    #[test]
    fn test_gpu_instance_layout_assertions() {
        assert_eq!(size_of::<GpuInstanceData>(), 80, "GpuInstanceData size must be exactly 80 bytes");
        assert_eq!(align_of::<GpuInstanceData>(), 16, "GpuInstanceData alignment must be 16 bytes");

        let inst = GpuInstanceData {
            transform_matrix: [0.0; 16],
            opacity: 1.0,
            visible: 1,
            clip_index: 0,
            _padding: 0,
        };
        let base_ptr = &inst as *const _ as usize;
        let opacity_ptr = &inst.opacity as *const _ as usize;
        let visible_ptr = &inst.visible as *const _ as usize;
        let clip_index_ptr = &inst.clip_index as *const _ as usize;
        let padding_ptr = &inst._padding as *const _ as usize;

        assert_eq!(opacity_ptr - base_ptr, 64, "transform_matrix offset must be 64 bytes");
        assert_eq!(visible_ptr - base_ptr, 68, "visible offset must be 68 bytes");
        assert_eq!(clip_index_ptr - base_ptr, 72, "clip_index offset must be 72 bytes");
        assert_eq!(padding_ptr - base_ptr, 76, "_padding offset must be 76 bytes");
    }
}

pub fn verify_cpu_gpu_matrices(
    cpu_output: &[GpuInstanceData],
    gpu_output: &[GpuInstanceData],
    tolerance: f32,
) -> Result<f32, String> {
    if cpu_output.len() != gpu_output.len() {
        return Err(format!(
            "Length mismatch: CPU has {}, GPU has {}",
            cpu_output.len(),
            gpu_output.len()
        ));
    }

    let mut max_diff: f32 = 0.0;
    for (i, (c, g)) in cpu_output.iter().zip(gpu_output.iter()).enumerate() {
        for m in 0..16 {
            let diff = (c.transform_matrix[m] - g.transform_matrix[m]).abs();
            if diff > max_diff {
                max_diff = diff;
            }
            if diff > tolerance {
                return Err(format!(
                    "Matrix difference exceeding tolerance at instance {} element {}: cpu={}, gpu={}, diff={}",
                    i, m, c.transform_matrix[m], g.transform_matrix[m], diff
                ));
            }
        }
        let opacity_diff = (c.opacity - g.opacity).abs();
        if opacity_diff > tolerance {
            return Err(format!(
                "Opacity difference exceeding tolerance at instance {}: cpu={}, gpu={}, diff={}",
                i, c.opacity, g.opacity, opacity_diff
            ));
        }
    }

    Ok(max_diff)
}
