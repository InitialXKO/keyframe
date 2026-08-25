import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, BlendMode, TransformBuilder, Canvas2DRenderer, createRenderer } from "../dist/index.js";
import { spring, interpolate, interpolateColors, Sequence, Series, createRemotionAdapter, setRemotionFrameContext, useCurrentFrame } from "../dist/remotion/index.js";
import { OPFSStorage } from "../dist/opfs_storage.js";
import { StorageAdapter } from "../dist/storage_adapter.js";

test("Builder API constructs valid Clip and Instance IR with Additive BlendMode & Time Remapping", () => {
  const engine = new Engine();

  const clip = new Clip("test_clip")
    .duration(2000)
    .easing(Easing.EaseInOut)
    .iterations(Infinity)
    .addKeyframe(
      new Keyframe(0)
        .transform(new TransformBuilder().translateX(0).scale(1).build())
        .opacity(1)
    )
    .addKeyframe(
      new Keyframe(2000)
        .transform(new TransformBuilder().translateX(500).scale(2).build())
        .opacity(0)
    );

  const inst = new Instance("test_clip", "inst_1")
    .opacity(0.8)
    .delay(100)
    .timeRemappingSpeed(1.5)
    .blendMode(BlendMode.Additive);

  engine.addClip(clip);
  engine.addInstances([inst]);

  const ir = engine.exportIR();
  assert.equal(ir.clips.length, 1);
  assert.equal(ir.clips[0].id, "test_clip");
  assert.equal(ir.clips[0].keyframes.length, 2);
  assert.equal(ir.instances.length, 1);
  assert.equal(ir.instances[0].id, "inst_1");
  assert.equal(ir.instances[0].time_remapping_speed, 1.5);
  assert.equal(ir.instances[0].blend_mode, BlendMode.Additive);
});

test("Remotion spring, interpolate & interpolateColors math", () => {
  const valStart = spring({ frame: 0, fps: 30 });
  const valMid = spring({ frame: 15, fps: 30 });
  assert.equal(valStart, 0);
  assert.ok(valMid > 0 && valMid <= 1.5);

  const interp = interpolate(50, [0, 100], [0, 500], { extrapolateLeft: "clamp" });
  assert.equal(interp, 250);

  const colorHex = interpolateColors(50, [0, 100], ["#ff0000", "#00ff00"]);
  assert.ok(colorHex.includes("rgba(128, 128, 0"));
});

test("Remotion Sequence & Series context propagation & createRemotionAdapter", () => {
  setRemotionFrameContext(30);
  assert.equal(useCurrentFrame(), 30);

  let evaluatedValue = 0;
  Sequence({
    from: 10,
    durationInFrames: 50,
    children: () => {
      evaluatedValue = useCurrentFrame(); // Should be 30 - 10 = 20
    },
  });

  assert.equal(evaluatedValue, 20);

  const engine = new Engine();
  const adapter = createRemotionAdapter(engine);
  const ir = adapter.compileToIR();
  assert.ok(ir.clips !== undefined);
});

test("OPFS Storage & StorageAdapter bake bytes persistence", async () => {
  const adapter = new StorageAdapter();
  const bakeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await adapter.saveBakeData("bake_1.bin", bakeBytes);
  const loadedBytes = await adapter.loadBakeData("bake_1.bin");

  assert.deepEqual(loadedBytes, bakeBytes);
});

test("Canvas2DRenderer & AutoRenderer createRenderer fallback", async () => {
  const canvas = {
    width: 800,
    height: 600,
    getContext: (type) => {
      if (type === "2d") {
        return {
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          transform: () => {},
          beginPath: () => {},
          rect: () => {},
          fill: () => {},
          stroke: () => {},
          globalAlpha: 1,
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
        };
      }
      return null;
    },
  };

  const renderer = await createRenderer(canvas, "canvas2d");
  assert.equal(renderer.getBackendType(), "canvas2d");

  const engine = new Engine();
  const clip = new Clip("c1").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);

  renderer.render(engine, 500);
  renderer.destroy();
});

test("Engine DevTools messaging integration", () => {
  const engine = new Engine();
  const clip = new Clip("c1").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);

  let postedMessage = null;
  globalThis.window = {
    postMessage: (msg) => {
      postedMessage = msg;
    },
  };

  engine.enableDevTools();
  assert.equal(engine.isDevToolsEnabled(), true);

  engine.evaluateFrame(250);
  assert.ok(postedMessage !== null);
  assert.equal(postedMessage.source, "keyframe-engine-devtools");
  assert.equal(postedMessage.type, "FRAME_EVALUATED");
  assert.equal(postedMessage.payload.globalTime, 250);
  assert.equal(postedMessage.payload.instances.length, 1);
});

test("StorageAdapter bakeStreamToOPFS chunked streaming bake", async () => {
  const adapter = new StorageAdapter();
  const engine = new Engine();
  const clip = new Clip("c1").duration(2000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);

  let progressReported = [];
  await adapter.bakeStreamToOPFS(engine, "stream_test.bin", {
    startMs: 0,
    endMs: 2000,
    fps: 30,
    chunkSizeMs: 1000,
    onProgress: (p) => progressReported.push(p),
  });

  const streamBytes = await adapter.loadBakeData("stream_test.bin");
  assert.ok(streamBytes.byteLength >= 0);
  assert.ok(progressReported.length > 0);
  assert.equal(progressReported[progressReported.length - 1], 100);
});

test("Engine WASM Memory binding, auto-resolution, and error handling", () => {
  delete (globalThis).wasmMemory;

  // Mock WASM instance without memory initially
  const fakeWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
  };

  const engine = new Engine(fakeWasm);

  // 1. Should throw ReferenceError when WASM instance exists but memory is unaccessible
  assert.throws(() => {
    engine.getEvaluatedInstances(0);
  }, ReferenceError);

  // 2. Auto-resolution via __wasm.memory
  const mockMemory = new WebAssembly.Memory({ initial: 1 });
  fakeWasm.__wasm = { memory: mockMemory };
  // getEvaluatedInstances should auto-bind memory now and not throw ReferenceError
  const list = engine.getEvaluatedInstances(0);
  assert.equal(list.length, 1);

  // 3. Explicit binding via engine.bindWasmMemory()
  const mockMemory2 = new WebAssembly.Memory({ initial: 1 });
  engine.bindWasmMemory(mockMemory2);
  assert.equal(fakeWasm.memory, mockMemory2);

  // 4. Static binding via Engine.bindWasmMemory()
  delete fakeWasm.memory;
  delete (globalThis).wasmMemory;
  Engine.bindWasmMemory(mockMemory);
  assert.equal((globalThis).wasmMemory, mockMemory);
  const list2 = engine.getEvaluatedInstances(0);
  assert.equal(list2.length, 1);

  // Clean up global state
  delete (globalThis).wasmMemory;

  // 5. Fallback JS evaluation when no WASM instance is provided
  const jsEngine = new Engine();
  jsEngine.addInstances([new Instance("c1", "inst1")]);
  const jsList = jsEngine.getEvaluatedInstances(0);
  assert.equal(jsList.length, 1);
});
