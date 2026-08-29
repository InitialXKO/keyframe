import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder, VERTEX_TEMPLATE } from '../../dist/index.js';
import { webgpuAdapter } from '../../dist/adapters/webgpu_adapter.js';
import { controller } from '../../dist/controller.js';

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
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateZ(0).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().rotateZ(360).build()));

  engine.addClip(clip);

  const instances = [];
  for (let i = 0; i < 50; i++) {
    instances.push(new Instance('box_spin', `box_${i}`).delay(i * 40));
  }
  engine.addInstances(instances);
  await engine.prepare({ wasmUrl: '../../pkg/keyframe_engine_bg.wasm' });

  // Create GPU Storage Buffer for 80-byte per instance data
  const bufferSize = instances.length * 80;
  const storageBuffer = device.createBuffer({
    size: Math.max(256, bufferSize),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });

  const shaderModule = device.createShaderModule({
    code: VERTEX_TEMPLATE
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

  const player = controller.createPlayer(engine, {
    fps: 60,
    duration: 2000
  });
  player.loop(true);

  player.on('frame', (timeMs) => {
    // Direct write matrices via getInstanceBufferPtr() or webgpuAdapter
    webgpuAdapter.writeToBuffer(device, storageBuffer, timeMs, 0, { engine });

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
  });

  player.play();
}

initWebGPU();
