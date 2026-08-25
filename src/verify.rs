use crate::types::GpuInstanceData;

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
