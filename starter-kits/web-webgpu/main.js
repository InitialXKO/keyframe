import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from '../../dist/index.js';
import { webgpuAdapter } from '../../dist/adapters/webgpu_adapter.js';

async function initWebGPU() {
  const status = document.getElementById('status');
  if (!navigator.gpu) {
    status.innerText = "WebGPU not supported on this browser/environment.";
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    status.innerText = "Failed to request WebGPU adapter.";
    return;
  }

  const device = await adapter.requestDevice();
  const canvas = document.getElementById('canvas');
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Build Engine IR
  const engine = new Engine();
  const clip = new Clip('box_spin')
    .duration(2000)
    .easing(Easing.Linear)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateZ(0).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().rotateZ(360).build()));

  engine.addClip(clip);

  const instances = [];
  for (let i = 0; i < 50; i++) {
    instances.push(new Instance('box_spin', `box_${i}`).delay(i * 40));
  }
  engine.addInstances(instances);
  await engine.prepare();

  // Create GPU Storage Buffer for 80-byte per instance data
  const bufferSize = instances.length * 80;
  const storageBuffer = device.createBuffer({
    size: Math.max(256, bufferSize),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });

  const shaderModule = device.createShaderModule({
    code: `
      struct InstanceData {
        transform_matrix: mat4x4<f32>,
        opacity: f32,
        visible: u32,
        clip_index: u32,
        padding: u32,
      };

      @group(0) @binding(0) var<storage, read> instances: array<InstanceData>;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      };

      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 3>(
          vec2<f32>(0.0, 0.1),
          vec2<f32>(-0.1, -0.1),
          vec2<f32>(0.1, -0.1)
        );
        let inst = instances[instanceIndex];
        let local_pos = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        let world_pos = inst.transform_matrix * local_pos;

        var out: VertexOutput;
        out.position = world_pos;
        out.color = vec4<f32>(1.0, 0.5, 0.2, inst.opacity);
        return out;
      }

      @fragment
      fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
        return in.color;
      }
    `
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shaderModule, entryPoint: 'vs_main' },
    fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: storageBuffer } }]
  });

  status.innerText = "WebGPU Storage Buffer Pipeline Running!";

  let startTime = performance.now();
  function render() {
    const time = performance.now() - startTime;

    // Direct write matrices via getInstanceBufferPtr() or webgpuAdapter
    webgpuAdapter.writeToBuffer(device, storageBuffer, time, 0, { engine });

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3, instances.length, 0, 0);
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

initWebGPU();
