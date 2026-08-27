import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, BlendMode, TransformBuilder, Canvas2DRenderer, createRenderer } from "../dist/index.js";
import { spring, interpolate, interpolateColors, Sequence, Series, createRemotionAdapter, setRemotionFrameContext, useCurrentFrame } from "../dist/remotion/index.js";
import { OPFSStorage } from "../dist/opfs_storage.js";
import { StorageAdapter } from "../dist/storage_adapter.js";

test("JS Evaluator: Evaluates clip keyframes accurately without WASM instance (Issue #2 reproduction)", async () => {
  const engine = new Engine(); // No wasmInstance
  const clip = new Clip("test")
    .duration(2000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(0).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translateX(500).build()));
  engine.addClip(clip);
  engine.addInstances([new Instance("test", "i1")]);
  await engine.prepare({ storage: { enabled: false } }).catch(() => {});

  const e = engine.getEvaluatedInstances(1000, true)[0];
  // Expected tx = 250 (linear interpolation halfway through 2000ms duration)
  assert.equal(e.transformMatrix[12], 250);
  assert.equal(e.transformMatrix[13], 0);
  assert.equal(e.opacity, 1.0);
  assert.equal(e.visible, true);
});

test("JS Evaluator: Supports Additive BlendMode, delay, time remapping, and initial transform", async () => {
  const engine = new Engine();
  const clip = new Clip("clip1")
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(0).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

  const inst = new Instance("clip1", "inst1")
    .delay(200)
    .timeRemappingSpeed(2.0)
    .blendMode(BlendMode.Additive)
    .initialTransform(new TransformBuilder().translateX(50).build());

  engine.addClip(clip);
  engine.addInstances([inst]);
  await engine.prepare({ storage: { enabled: false } }).catch(() => {});

  // Before delay (at t=100ms)
  const evalBeforeDelay = engine.getEvaluatedInstances(100, true)[0];
  assert.equal(evalBeforeDelay.visible, false);
  assert.equal(evalBeforeDelay.opacity, 0.0);

  // At globalTime = 400ms:
  // elapsed = (400 - 200) * 2.0 = 400ms localTime
  // clip linear interpolation: tx = 40
  // Additive blend with initial tx=50: final tx = 50 + 40 = 90
  const evalActive = engine.getEvaluatedInstances(400, true)[0];
  assert.equal(evalActive.visible, true);
  assert.equal(evalActive.transformMatrix[12], 90);
});

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

  // WASM Acceleration test for interpolate with extrapolation options
  const mockWasm = {
    interpolate_extrapolate(v, input, output, left, right) {
      assert.equal(v, 150);
      assert.equal(left, "clamp");
      assert.equal(right, "clamp");
      return 100;
    }
  };

  globalThis.wasmInstance = mockWasm;
  const wasmRes = interpolate(150, [0, 100], [0, 100], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  assert.equal(wasmRes, 100);
  delete globalThis.wasmInstance;
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

  const memory = new WebAssembly.Memory({ initial: 1 });
  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
    memory,
  };
  const engine = new Engine(mockWasm);
  const clip = new Clip("c1").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);
  await engine.prepare();

  renderer.render(engine, 500);
  renderer.destroy();
});

test("Engine DevTools messaging integration", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
    memory,
  };
  const engine = new Engine(mockWasm);
  const clip = new Clip("c1").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);
  await engine.prepare();

  let postedMessage = null;
  globalThis.window = {
    postMessage: (msg) => {
      postedMessage = msg;
    },
  };

  engine.enableDevTools();
  assert.equal(engine.isDevToolsEnabled(), true);

  engine.getEvaluatedInstances(250);
  assert.ok(postedMessage !== null);
  assert.equal(postedMessage.source, "keyframe-engine-devtools");
  assert.equal(postedMessage.type, "FRAME_EVALUATED");
  assert.equal(postedMessage.payload.globalTime, 250);
  assert.equal(postedMessage.payload.instances.length, 1);
});

test("StorageAdapter bakeStreamToOPFS chunked streaming bake", async () => {
  const adapter = new StorageAdapter();
  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
  };
  const engine = new Engine(mockWasm);
  const clip = new Clip("c1").duration(2000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1")]);
  await engine.prepare();

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

test("Engine WASM Memory binding, auto-resolution, and error handling", async () => {
  delete (globalThis).wasmMemory;

  // Mock WASM instance without memory initially
  const fakeWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
  };

  const engine = new Engine(fakeWasm);
  await engine.prepare();

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

  // 5. Fallback JS evaluation when skipEvaluate is set to true
  const jsEngine = new Engine();
  jsEngine.addInstances([new Instance("c1", "inst1")]);
  await jsEngine.prepare({ storage: { enabled: false } }).catch(() => {});
  const jsList = jsEngine.getEvaluatedInstances(0, true);
  assert.equal(jsList.length, 1);
});

test("Engine.prepare() compatibility validation and unprepared guardrail", async () => {
  // Unprepared engine should throw Error("Engine not prepared") on getEvaluatedInstances
  const engine = new Engine();
  assert.throws(() => {
    engine.getEvaluatedInstances(0);
  }, /Engine not prepared/);

  // Validation 1: mass !== 1.0 throws error
  const massEngine = new Engine();
  const badMassClip = new Clip("bad_mass")
    .duration(1000)
    .addKeyframe(new Keyframe(0).springConfig({ mass: 2.0 }));
  massEngine.addClip(badMassClip);

  await assert.rejects(async () => {
    await massEngine.prepare();
  }, (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /Clip "bad_mass" keyframe at t=0 uses spring mass=2\.0/);
    assert.match(err.message, /Use @keyframe\/physics for real-time interactive springs/);
    return true;
  });

  // Validation 2: extrapolate option throws error
  const extrapolateEngine = new Engine();
  const badExtrapolateClip = new Clip("bad_extrapolate")
    .duration(1000)
    .addKeyframe(new Keyframe(0).interpolateConfig({ extrapolate: "extend" }));
  extrapolateEngine.addClip(badExtrapolateClip);

  await assert.rejects(async () => {
    await extrapolateEngine.prepare();
  }, (err) => {
    assert.match(err.message, /Clip "bad_extrapolate" keyframe at t=0 uses extrapolate, but WASM core does not support extrapolate\. To fix, choose one: → Remove extrapolate and clamp input manually → Use @keyframe\/bake to pre-bake this clip/);
    return true;
  });

  // Validation 3: WASM loading failure throws explicit error (Fail Fast)
  const WASMErrorEngine = new Engine();
  let stages = [];
  await assert.rejects(async () => {
    await WASMErrorEngine.prepare({
      wasmUrl: "invalid-url-force-error",
      storage: { enabled: false },
      onProgress: (stage) => stages.push(stage),
    });
  }, (err) => {
    assert.match(err.message, /Failed to load WASM engine module from "invalid-url-force-error"/);
    return true;
  });

  assert.ok(stages.includes("validation"));
  assert.ok(stages.includes("wasm_loading"));
});

test("Engine zero-copy ABI: evaluateFrame() returns raw WASM memory view and getEvaluatedInstances() uses zero-copy subarray view", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 2,
    get_instance_buffer_ptr: () => 64,
    get_instance_buffer_byte_length: () => 160,
    prepare: () => {},
    memory,
  };

  const engine = new Engine(mockWasm);
  engine.addInstances([new Instance("c1", "inst1"), new Instance("c1", "inst2")]);
  await engine.prepare();

  // 1. Test evaluateFrame returns raw memory view without copying
  const evalFrame = engine.evaluateFrame(500);
  assert.equal(evalFrame.count, 2);
  assert.equal(evalFrame.ptr, 64);
  assert.equal(evalFrame.byteOffset, 64);
  assert.equal(evalFrame.byteLength, 160);
  assert.equal(evalFrame.floatsPerInstance, 20);
  assert.equal(evalFrame.view.buffer, memory.buffer);
  assert.equal(evalFrame.view.byteOffset, 64);
  assert.equal(evalFrame.view.length, 40);

  // 2. Test getEvaluatedInstances uses subarray view over memory buffer (zero copy)
  const instances = engine.getEvaluatedInstances(500, true);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].transformMatrix.buffer, memory.buffer);
  assert.equal(instances[0].transformMatrix.byteOffset, 64);
  assert.equal(instances[0].transformMatrix.length, 16);

  assert.equal(instances[1].transformMatrix.buffer, memory.buffer);
  assert.equal(instances[1].transformMatrix.byteOffset, 64 + 20 * 4);
  assert.equal(instances[1].transformMatrix.length, 16);
});

test("Engine zero-copy ABI: JS fallback mode packs instances in contiguous buffer view", async () => {
  const engine = new Engine();
  const clip = new Clip("c1").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("c1", "inst1"), new Instance("c1", "inst2")]);
  engine.prepared = true;

  const evalFrame = engine.evaluateFrame(100);
  assert.equal(evalFrame.count, 2);
  assert.equal(evalFrame.view.length, 40);

  const instances = engine.getEvaluatedInstances(100, true);
  assert.equal(instances.length, 2);
  // Verify transformMatrix shares the exact same ArrayBuffer with evalFrame.view
  assert.equal(instances[0].transformMatrix.buffer, evalFrame.view.buffer);
  assert.equal(instances[1].transformMatrix.buffer, evalFrame.view.buffer);
  assert.equal(instances[0].transformMatrix.byteOffset, evalFrame.view.byteOffset);
  assert.equal(instances[1].transformMatrix.byteOffset, evalFrame.view.byteOffset + 20 * 4);
});

test("bakeChunk binary format, Engine.decodeBakedChunk and StorageAdapter loadBakeData(key, { decode: true })", async () => {
  const engine = new Engine();
  const clip = new Clip("c1")
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(10).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(110).build()));

  const inst1 = new Instance("c1", "inst1");
  engine.addClip(clip);
  engine.addInstances([inst1]);
  engine.prepared = true;

  // Bake frames from 0ms to 1000ms at 10 fps (101ms intervals / ~11 frames)
  const bakedBytes = engine.bakeChunk(0, 1000, 10);
  assert.ok(bakedBytes instanceof Uint8Array);
  assert.ok(bakedBytes.byteLength > 0);
  assert.equal(bakedBytes.byteLength % 80, 0);

  // Test static method Engine.decodeBakedChunk
  const decoded = Engine.decodeBakedChunk(bakedBytes);
  assert.ok(Array.isArray(decoded));
  assert.equal(decoded.length, Math.floor(bakedBytes.byteLength / 80));

  // Verify first decoded instance fields (visible, clipIndex, opacity, matrix)
  assert.equal(decoded[0].visible, true);
  assert.equal(decoded[0].opacity, 1.0);
  assert.equal(decoded[0].clipIndex, 0);
  assert.equal(decoded[0].transformMatrix[12], 10); // translateX = 10 at t=0

  // Test StorageAdapter.loadBakeData with decode options
  const storage = new StorageAdapter();
  await storage.saveBakeData("test_bake.bin", bakedBytes);

  // 1. Raw bytes mode (default / decode: false)
  const rawData = await storage.loadBakeData("test_bake.bin");
  assert.deepEqual(rawData, bakedBytes);

  // 2. Decoded mode with boolean flag `true`
  const decodedInstancesBool = await storage.loadBakeData("test_bake.bin", true);
  assert.equal(decodedInstancesBool.length, decoded.length);
  assert.equal(decodedInstancesBool[0].visible, true);
  assert.equal(decodedInstancesBool[0].transformMatrix[12], 10);

  // 3. Decoded mode with options object `{ decode: true }`
  const decodedInstancesObj = await storage.loadBakeData("test_bake.bin", { decode: true });
  assert.equal(decodedInstancesObj.length, decoded.length);
  assert.equal(decodedInstancesObj[0].visible, true);
  assert.equal(decodedInstancesObj[0].transformMatrix[12], 10);
});
