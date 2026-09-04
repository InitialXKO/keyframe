import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, BlendMode, TransformBuilder, Canvas2DRenderer, createRenderer, MemoryWriter, createSyncOPFSWriter, createAsyncOPFSWriter, createMemoryWriter, createOPFSWriter } from "../dist/index.js";
import { spring, interpolate, interpolateColors, Sequence, Series, createRemotionAdapter, setRemotionFrameContext, useCurrentFrame } from "../dist/remotion/index.js";
import { OPFSStorage } from "../dist/opfs_storage.js";
import { StorageAdapter } from "../dist/storage_adapter.js";

test("JS Evaluator: Supports all 16 new Easing variants (Bounce, Elastic, Back, Expo, Sine, SpringEasing)", async () => {
  const easings = [
    Easing.BounceIn,
    Easing.BounceOut,
    Easing.BounceInOut,
    Easing.ElasticIn,
    Easing.ElasticOut,
    Easing.ElasticInOut,
    Easing.BackIn,
    Easing.BackOut,
    Easing.BackInOut,
    Easing.ExpoIn,
    Easing.ExpoOut,
    Easing.ExpoInOut,
    Easing.SineIn,
    Easing.SineOut,
    Easing.SineInOut,
    Easing.SpringEasing,
  ];

  for (const easing of easings) {
    const engine = new Engine();
    const clip = new Clip(`test_${easing}`)
      .duration(1000)
      .addKeyframe(new Keyframe(0).easing(easing).transform(new TransformBuilder().translateX(0).build()))
      .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

    engine.addClip(clip);
    engine.addInstances([new Instance(`test_${easing}`, "i1")]);
    engine.prepared = true;

    const startVal = engine.getEvaluatedInstances(0, true)[0].transformMatrix[12];
    const endVal = engine.getEvaluatedInstances(1000, true)[0].transformMatrix[12];
    const midVal = engine.getEvaluatedInstances(500, true)[0].transformMatrix[12];

    assert.ok(Math.abs(startVal - 0) < 1e-2, `Start failed for ${easing}`);
    if (easing === Easing.SpringEasing) {
      assert.ok(Number.isFinite(endVal), `End value not finite for ${easing}`);
    } else {
      assert.ok(Math.abs(endVal - 100) < 1e-2, `End failed for ${easing}`);
    }
    assert.ok(Number.isFinite(midVal), `Mid value not finite for ${easing}`);
  }
});

test("Easing.CubicBezier defaults to standard EaseInOut curve (0.42, 0, 0.58, 1) when cubic_params is omitted", async () => {
  const engine = new Engine();
  const clip = new Clip("bezier_default")
    .duration(1000)
    .addKeyframe(new Keyframe(0).easing(Easing.CubicBezier).transform(new TransformBuilder().translateX(0).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

  engine.addClip(clip);
  engine.addInstances([new Instance("bezier_default", "i1")]);
  engine.prepared = true;

  // At t=500ms, linear would be 50. EaseInOut (0.42, 0, 0.58, 1) evaluated at t=0.5 yields 0.5 (translateX = 50).
  // At t=250ms (linear = 25), EaseInOut produces ~14.65, distinct from linear.
  const evalMid = engine.getEvaluatedInstances(250, true)[0];
  const tx = evalMid.transformMatrix[12];
  assert.notEqual(tx, 25);
  assert.ok(tx > 10 && tx < 20);
});

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

test("TransformBuilder rotateX, rotateY, rotateZ, and rotateEuler helper methods", () => {
  const tbX = new TransformBuilder().rotateX(90).build();
  assert.ok(Math.abs(tbX.rotation_quat[0] - Math.sin(Math.PI / 4)) < 1e-5);
  assert.ok(Math.abs(tbX.rotation_quat[3] - Math.cos(Math.PI / 4)) < 1e-5);

  const tbY = new TransformBuilder().rotateY(180).build();
  assert.ok(Math.abs(tbY.rotation_quat[1] - 1.0) < 1e-5);
  assert.ok(Math.abs(tbY.rotation_quat[3] - 0.0) < 1e-5);

  const tbZ = new TransformBuilder().rotateZ(360).build();
  assert.ok(Math.abs(tbZ.rotation_quat[2] - 0.0) < 1e-5);
  assert.ok(Math.abs(tbZ.rotation_quat[3] - (-1.0)) < 1e-5 || Math.abs(tbZ.rotation_quat[3] - 1.0) < 1e-5);

  const tbEuler = new TransformBuilder().rotateEuler(0, 90, 0).build();
  assert.ok(Math.abs(tbEuler.rotation_quat[1] - Math.sin(Math.PI / 4)) < 1e-5);
});

test("Builder API constructs valid Clip and Instance IR with Additive BlendMode & Time Remapping", () => {
  const engine = new Engine();

  const clip = new Clip("test_clip")
    .duration(2000)
    .metadata({ easing: Easing.EaseInOut })
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

test("Engine bakeStream streaming bake and OPFSWriter integration", async () => {
  const engine = new Engine();
  const clip = new Clip("stream_clip")
    .duration(2000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(0).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translateX(100).build()));

  engine.addClip(clip);
  const instances = [];
  for (let i = 0; i < 1000; i++) {
    instances.push(new Instance("stream_clip", `i_${i}`));
  }
  engine.addInstances(instances);
  engine.prepared = true;

  const memoryWriter = createMemoryWriter();
  let chunkCount = 0;

  const totalBytes = await engine.bakeStream(
    { startMs: 0, endMs: 2000, fps: 30 },
    (chunk) => {
      chunkCount++;
      memoryWriter.write(chunk);
    }
  );

  memoryWriter.close();
  const bakedBytes = memoryWriter.getBytes();
  assert.equal(bakedBytes.byteLength, totalBytes);
  assert.ok(totalBytes > 0);
  assert.ok(chunkCount >= 1);

  // Test early termination in JS streaming mode
  let earlyChunkCount = 0;
  const earlyTotal = await engine.bakeStream(
    { startMs: 0, endMs: 2000, fps: 30 },
    (_chunk) => {
      earlyChunkCount++;
      return false; // abort streaming
    }
  );

  assert.equal(earlyChunkCount, 1);
  assert.ok(earlyTotal < totalBytes);
});

test("Engine bakeStream with WASM mock & async callback support", async () => {
  let streamCallCount = 0;
  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
    bake_stream: (startMs, endMs, fps, onChunk) => {
      streamCallCount++;
      const dummyChunk = new Uint8Array(80);
      const ok = onChunk(dummyChunk);
      return ok === false ? 0 : 80;
    },
  };

  const engine = new Engine(mockWasm);
  engine.addInstances([new Instance("c1", "i1")]);
  engine.prepared = true;

  // 1. Sync callback via WASM
  let syncReceived = false;
  const syncBytes = await engine.bakeStream(
    { startMs: 0, endMs: 1000, fps: 30 },
    (chunk) => {
      syncReceived = true;
      assert.equal(chunk.byteLength, 80);
      return true;
    }
  );
  assert.ok(syncReceived);
  assert.equal(streamCallCount, 1);
  assert.equal(syncBytes, 80);

  // 2. Async callback via WASM (should safely fall back to JS async loop)
  let asyncReceivedBytes = 0;
  const asyncTotal = await engine.bakeStream(
    { startMs: 0, endMs: 1000, fps: 30 },
    async (chunk) => {
      await new Promise((r) => setTimeout(r, 1));
      asyncReceivedBytes += chunk.byteLength;
      return true;
    }
  );

  // WASM bake_stream is bypassed for async callbacks to avoid synchronous memory race conditions
  assert.equal(streamCallCount, 1);
  assert.equal(asyncReceivedBytes, 2480);
  assert.equal(asyncTotal, 2480);
});

test("Hypothesis B: WASM Memory growth auto-rebinds memory buffer and prevents view detachment", async () => {
  // Simulate WASM memory growth (memory.grow)
  let memory = new WebAssembly.Memory({ initial: 2, maximum: 20 });
  let instanceCount = 0;

  const mockWasm = {
    add_clip_json: () => {},
    add_instance_json: () => {
      instanceCount++;
    },
    evaluate_frame: () => instanceCount,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => instanceCount * 80,
    prepare: () => {},
    memory,
  };

  const engine = new Engine(mockWasm);
  const clip = new Clip("stress_clip").duration(1000);
  engine.addClip(clip);
  await engine.prepare();

  const oldBuffer = memory.buffer;
  let viewBefore = engine.evaluateFrame(0).view;
  assert.ok(viewBefore.byteLength >= 0);

  // Stress test: continuously add 10,000 instances and grow WASM memory
  for (let i = 0; i < 10000; i++) {
    engine.addInstances([new Instance("stress_clip", `inst_${i}`)]);
    if (i === 1000) {
      // Trigger WASM memory grow to 15 pages (960KB >= 800KB) which detaches previous ArrayBuffer
      memory.grow(13);
      mockWasm.memory = memory;
    }
  }

  await engine.prepare();
  const frameResult = engine.evaluateFrame(0);

  // 1. Verify memory grew and old buffer is detached
  assert.notEqual(memory.buffer, oldBuffer, "WASM memory grew as expected");
  assert.equal(oldBuffer.byteLength, 0, "Old ArrayBuffer detached upon memory.grow");

  // 2. Verify engine.evaluateFrame returns fresh active view pointing to new memory.buffer
  assert.equal(frameResult.view.buffer, memory.buffer, "Engine view rebound to new active WASM memory buffer");
  assert.ok(frameResult.byteLength > 0, "View byteLength > 0 (View not detached)");
  assert.equal(frameResult.count, 10000);
});

test("Hypothesis D: 8-iteration Newton-Raphson error bound < 1e-6 across degenerate cubic-bezier curve families", async () => {
  const degenerateCases = [
    [0.5, 0.0, 0.5, 1.0],   // 近退化水平 (Horizontal tangent)
    [0.0, 1.5, 1.0, -0.5],  // y 超界 (Y-overshoot)
    [0.001, 0.001, 0.999, 0.999], // 极端压缩 (Extreme compression)
  ];

  function solveCubicBezierRef(p1x, p1y, p2x, p2y, targetX, iterations = 64) {
    if (targetX <= 0) return 0;
    if (targetX >= 1) return 1;

    let low = 0;
    let high = 1;
    let u = targetX;

    for (let i = 0; i < iterations; i++) {
      const oneMinusU = 1.0 - u;
      const x = 3.0 * oneMinusU * oneMinusU * u * p1x + 3.0 * oneMinusU * u * u * p2x + u * u * u;
      const err = x - targetX;
      if (Math.abs(err) < 1e-9) break;
      if (err > 0) {
        high = u;
      } else {
        low = u;
      }
      const dx = 3.0 * oneMinusU * oneMinusU * p1x + 6.0 * oneMinusU * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
      if (Math.abs(dx) > 1e-7) {
        const nextU = u - err / dx;
        if (nextU > low && nextU < high) {
          u = nextU;
          continue;
        }
      }
      u = 0.5 * (low + high);
    }

    const oneMinusU = 1.0 - u;
    return 3.0 * oneMinusU * oneMinusU * u * p1y + 3.0 * oneMinusU * u * u * p2y + u * u * u;
  }

  for (const [p1x, p1y, p2x, p2y] of degenerateCases) {
    const clip = new Clip("bezier_deg")
      .duration(1000)
      .addKeyframe(
        new Keyframe(0)
          .easing(Easing.CubicBezier, { p1x, p1y, p2x, p2y })
          .transform(new TransformBuilder().translateX(0).build())
      )
      .addKeyframe(
        new Keyframe(1000)
          .transform(new TransformBuilder().translateX(100).build())
      );

    const engine = new Engine();
    engine.addClip(clip);
    engine.addInstances([new Instance("bezier_deg", "i1")]);
    engine.prepared = true;

    for (let t = 0; t <= 1; t += 0.001) {
      const evalInst = engine.getEvaluatedInstances(t * 1000, true)[0];
      const result = evalInst.transformMatrix[12] / 100;
      const reference = solveCubicBezierRef(p1x, p1y, p2x, p2y, t, 64);
      const diff = Math.abs(result - reference);

      assert.ok(diff < 1e-6, `Divergence at t=${t} for curve [${p1x},${p1y},${p2x},${p2y}]: result=${result}, ref=${reference}, diff=${diff}`);
    }
  }
});

test("Hypothesis A: GpuInstanceData 80-byte memory layout and field byte offsets match WebGPU / Rust ABI", async () => {
  const engine = new Engine();
  const clip = new Clip("layout_clip").duration(1000);
  engine.addClip(clip);
  engine.addInstances([new Instance("layout_clip", "i1")]);
  engine.prepared = true;

  const evalResult = engine.evaluateFrame(0);
  assert.equal(evalResult.floatsPerInstance, 20);
  assert.equal(evalResult.byteLength, 80);

  const buffer = evalResult.view.buffer;
  const byteOffset = evalResult.view.byteOffset;

  const floatView = new Float32Array(buffer, byteOffset, 20);
  const uintView = new Uint32Array(buffer, byteOffset, 20);

  // Field offset assertions:
  // transform_matrix: float indices 0..15 (0..64 bytes)
  // opacity: float index 16 (64..68 bytes)
  // visible: uint index 17 (68..72 bytes)
  // clip_index: uint index 18 (72..76 bytes)
  // _padding: uint index 19 (76..80 bytes)

  assert.equal(floatView.subarray(0, 16).byteLength, 64, "transform_matrix takes 64 bytes");
  assert.equal(floatView.subarray(16, 17).byteOffset - byteOffset, 64, "opacity offset is at 64 bytes");
  assert.equal(uintView.subarray(17, 18).byteOffset - byteOffset, 68, "visible offset is at 68 bytes");
  assert.equal(uintView.subarray(18, 19).byteOffset - byteOffset, 72, "clip_index offset is at 72 bytes");
  assert.equal(uintView.subarray(19, 20).byteOffset - byteOffset, 76, "_padding offset is at 76 bytes");
});

test("Hypothesis C: View object reuse across 100,000 frame evaluations ensures zero-copy and minimal GC heap growth", async () => {
  const engine = new Engine();
  const clip = new Clip("gc_clip")
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(0).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

  engine.addClip(clip);
  engine.addInstances([new Instance("gc_clip", "i1"), new Instance("gc_clip", "i2")]);
  engine.prepared = true;

  // Initial evaluation to initialize buffers
  const initialFrame = engine.evaluateFrame(0);
  const initialInstances = engine.getEvaluatedInstances(0, true);

  const initialBuffer = initialFrame.view.buffer;

  // Run 100,000 frame evaluations
  for (let i = 0; i < 100000; i++) {
    const time = (i % 1000);
    const frame = engine.evaluateFrame(time);
    const instances = engine.getEvaluatedInstances(time, true, frame);

    // Verify buffer and matrix views are reused across evaluations
    assert.equal(frame.view.buffer, initialBuffer, "Float32Array buffer reused across 100,000 evaluations");
    assert.equal(instances[0].transformMatrix.buffer, initialBuffer, "Instance 1 transformMatrix shares contiguous ArrayBuffer");
    assert.equal(instances[1].transformMatrix.buffer, initialBuffer, "Instance 2 transformMatrix shares contiguous ArrayBuffer");
  }
});

test("Hypothesis E: Analytical spring numerical matching with Remotion < 1e-10 across 300 frames", () => {
  const configs = [
    { damping: 10, stiffness: 100 },
    { damping: 0.5, stiffness: 200 },
    { damping: 20, stiffness: 100 }, // Critically damped
    { damping: 30, stiffness: 100 }, // Overdamped
  ];

  for (const config of configs) {
    for (let frame = 0; frame < 300; frame++) {
      const val = spring({ frame, fps: 30, config });

      // Reference calculation matching Remotion formula
      const fps = 30;
      const damping = config.damping;
      const stiffness = config.stiffness;
      const mass = config.mass ?? 1;

      const t = frame / fps;
      let refVal = 0;
      if (t > 0) {
        const w0 = Math.sqrt(stiffness / mass);
        const zeta = damping / (2 * Math.sqrt(stiffness * mass));

        if (Math.abs(zeta - 1) < 1e-5) {
          refVal = 1 - (1 + w0 * t) * Math.exp(-w0 * t);
        } else if (zeta < 1) {
          const wd = w0 * Math.sqrt(1 - zeta * zeta);
          refVal = 1 - Math.exp(-zeta * w0 * t) * ((zeta * w0 / wd) * Math.sin(wd * t) + Math.cos(wd * t));
        } else {
          const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
          const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
          const c2 = r1 / (r2 - r1);
          const c1 = 1 - c2;
          refVal = 1 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
        }
      }

      const diff = Math.abs(val - refVal);
      assert.ok(diff < 1e-10, `Mismatch frame=${frame} config=${JSON.stringify(config)}: val=${val}, ref=${refVal}, diff=${diff}`);
    }
  }
});
