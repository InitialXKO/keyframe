import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from "../dist/index.js";
import { threeAdapter, AdapterContext } from "../dist/adapters/index.js";
import { webgpuAdapter, GPUDeviceLostError } from "../dist/adapters/index.js";
import { domAdapter, DOMAdapter } from "../dist/dom_binder.js";
import { controller, AnimationPlayer } from "../dist/controller.js";
import { HierarchyResolver } from "../dist/math/hierarchy.js";

// Helper to mock Three.js Object3D and Matrix4
function createMockThreeObject(initialPos = { x: 0, y: 0, z: 0 }) {
  const position = { ...initialPos };
  const quaternion = { x: 0, y: 0, z: 0, w: 1 };
  const scale = { x: 1, y: 1, z: 1 };

  const matrixElements = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);

  const matrix = {
    elements: matrixElements,
    copy(m) {
      if (m.elements) {
        this.elements.set(m.elements);
      } else if (m instanceof Float32Array || Array.isArray(m)) {
        this.elements.set(m);
      }
    },
    fromArray(arr) {
      this.elements.set(arr);
    },
    decompose(pos, quat, sca) {
      pos.x = this.elements[12];
      pos.y = this.elements[13];
      pos.z = this.elements[14];

      const sx = Math.hypot(this.elements[0], this.elements[1], this.elements[2]);
      const sy = Math.hypot(this.elements[4], this.elements[5], this.elements[6]);
      const sz = Math.hypot(this.elements[8], this.elements[9], this.elements[10]);
      sca.x = sx || 1;
      sca.y = sy || 1;
      sca.z = sz || 1;

      quat.x = 0;
      quat.y = 0;
      quat.z = 0;
      quat.w = 1.0;
    },
    determinant() {
      return 1.0;
    }
  };

  return {
    matrixAutoUpdate: true,
    matrix,
    position,
    quaternion,
    scale,
    updateMatrixCalled: false,
    updateMatrix() {
      this.updateMatrixCalled = true;
    }
  };
}

test("ThreeAdapter: Token-based dual scene parallel isolation", async () => {
  const memoryA = new WebAssembly.Memory({ initial: 1 });
  const mockWasmA = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
    memory: memoryA,
  };
  const memoryB = new WebAssembly.Memory({ initial: 1 });
  const mockWasmB = {
    add_clip_json: () => {},
    add_instance_json: () => {},
    evaluate_frame: () => 1,
    get_instance_buffer_ptr: () => 0,
    get_instance_buffer_byte_length: () => 80,
    prepare: () => {},
    memory: memoryB,
  };

  const engineA = new Engine(mockWasmA);
  const clipA = new Clip("cA").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(100).build())
  );
  engineA.addClip(clipA).addInstances([new Instance("cA", "instA")]);
  await engineA.prepare();

  const engineB = new Engine(mockWasmB);
  const clipB = new Clip("cB").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(500).build())
  );
  engineB.addClip(clipB).addInstances([new Instance("cB", "instB")]);
  await engineB.prepare();

  const sceneA = {};
  const sceneB = {};

  const ctxA = threeAdapter.registerScene(sceneA, engineA);
  const ctxB = threeAdapter.registerScene(sceneB, engineB);

  const objA = createMockThreeObject();
  const objB = createMockThreeObject();

  ctxA.registerObject(objA);
  ctxB.registerObject(objB);

  assert.equal(objA.matrixAutoUpdate, false);
  assert.equal(objB.matrixAutoUpdate, false);

  threeAdapter.applyToScene(ctxA, 0);
  threeAdapter.applyToScene(ctxB, 0);

  const evalA = engineA.getEvaluatedInstances(0);
  const evalB = engineB.getEvaluatedInstances(0);

  assert.ok(evalA.length > 0 && evalB.length > 0);

  assert.equal(objA.matrix.elements[12], evalA[0].transformMatrix[12]);
  assert.equal(objB.matrix.elements[12], evalB[0].transformMatrix[12]);

  threeAdapter.applyToScene(ctxA, 1000);
  const evalA1000 = engineA.getEvaluatedInstances(1000);
  assert.equal(objA.matrix.elements[12], evalA1000[0].transformMatrix[12]);
  assert.equal(objB.matrix.elements[12], evalB[0].transformMatrix[12]);

  assert.notEqual(ctxA, ctxB);
});

test("ThreeAdapter: Lifecycle unregisterScene abandoned false vs true", () => {
  const engine = new Engine();
  const scene = {};
  const ctx = threeAdapter.registerScene(scene, engine);

  const obj1 = createMockThreeObject();
  const obj2 = createMockThreeObject();

  ctx.registerObject(obj1);
  ctx.registerObject(obj2);

  assert.equal(obj1.matrixAutoUpdate, false);
  assert.equal(obj2.matrixAutoUpdate, false);

  ctx.unregisterObject(obj1, { abandoned: false });
  assert.equal(obj1.matrixAutoUpdate, true);
  assert.equal(obj1.updateMatrixCalled, true);
  assert.equal(ctx.registeredObjects.has(obj1), false);

  threeAdapter.unregisterScene(ctx, { abandoned: false });
  assert.equal(obj2.matrixAutoUpdate, true);
  assert.equal(obj2.updateMatrixCalled, true);
  assert.equal(ctx.registeredObjects.size, 0);

  const ctx2 = threeAdapter.registerScene(scene, engine);
  const obj3 = createMockThreeObject();
  ctx2.registerObject(obj3);
  assert.equal(obj3.matrixAutoUpdate, false);

  threeAdapter.unregisterScene(ctx2, { abandoned: true });
  assert.equal(ctx2.registeredObjects.size, 0);
  assert.equal(obj3.matrixAutoUpdate, false);
});

test("ThreeAdapter: rasterized precision semantics (true vs false)", async () => {
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
  const clip = new Clip("c1").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(200).build())
  );
  engine.addClip(clip).addInstances([new Instance("c1", "inst1")]);
  await engine.prepare();

  const scene = {};
  const ctx = threeAdapter.registerScene(scene, engine);
  const obj = createMockThreeObject({ x: 999, y: 999, z: 999 });
  ctx.registerObject(obj);

  threeAdapter.applyToScene(ctx, 0, { rasterized: true });
  assert.equal(obj.position.x, 999);

  threeAdapter.applyToScene(ctx, 0, { rasterized: false });
  assert.notEqual(obj.position.x, 999);
});

test("ThreeAdapter: Matrix robustness (quaternion norm & determinant)", () => {
  const obj = createMockThreeObject();
  obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);

  const q = obj.quaternion;
  const quatNorm = Math.hypot(q.x, q.y, q.z, q.w);
  assert.ok(quatNorm >= 0.9999 && quatNorm <= 1.0001, `Quaternion norm ${quatNorm} not in range`);

  const det = obj.matrix.determinant();
  assert.ok(det > 0.0001, `Matrix determinant ${det} must be > 0.0001`);
});

test("WebGPUAdapter: Boundary probes (alignment, overflow, device lost)", () => {
  const mockDevice = {
    limits: { minStorageBufferOffsetAlignment: 256 },
    isLost: false,
    queue: {
      writeBuffer() {}
    }
  };

  const mockBuffer = {
    size: 256
  };

  assert.throws(
    () => {
      webgpuAdapter.writeToBuffer(mockDevice, mockBuffer, 0, 1);
    },
    (err) => {
      return err instanceof TypeError && err.message.includes("minStorageBufferOffsetAlignment");
    }
  );

  assert.throws(
    () => {
      webgpuAdapter.writeToBuffer(mockDevice, mockBuffer, 0, 256);
    },
    (err) => {
      return err instanceof RangeError && err.message.includes("Buffer overflow");
    }
  );

  const lostDevice = {
    limits: { minStorageBufferOffsetAlignment: 256 },
    isLost: true
  };

  assert.throws(
    () => {
      webgpuAdapter.writeToBuffer(lostDevice, mockBuffer, 0, 0);
    },
    (err) => {
      return err instanceof GPUDeviceLostError && err.name === "GPUDeviceLostError";
    }
  );
});

test("WebGPUAdapter: Compute & Read extensions (createComputeResources, dispatchCompute, readFromBuffer, readInstance)", async () => {
  let createdShaderCode = "";
  let dispatchedWorkgroups = 0;

  const mockDevice = {
    limits: { minStorageBufferOffsetAlignment: 256 },
    isLost: false,
    createShaderModule(desc) {
      createdShaderCode = desc.code;
      return { id: "shader-1" };
    },
    createBindGroupLayout(desc) {
      return { id: "bgl-1" };
    },
    createPipelineLayout(desc) {
      return { id: "pl-1" };
    },
    createComputePipeline(desc) {
      return { id: "pipeline-1" };
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return {
            setPipeline() {},
            setBindGroup() {},
            dispatchWorkgroups(count) {
              dispatchedWorkgroups = count;
            },
            end() {}
          };
        },
        copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {},
        finish() {
          return {};
        }
      };
    },
    queue: {
      submit(cmds) {}
    },
    createBuffer(desc) {
      return {
        size: desc.size,
        async mapAsync() {},
        getMappedRange(off, sz) {
          const buf = new ArrayBuffer(sz);
          const view = new Uint8Array(buf);
          view.fill(42);
          return buf;
        },
        unmap() {},
        destroy() {}
      };
    }
  };

  // 1. Test createComputeResources
  const res = webgpuAdapter.createComputeResources(mockDevice);
  assert.ok(res.pipeline);
  assert.ok(createdShaderCode.includes("struct InstanceInput"));
  assert.ok(createdShaderCode.includes("fn main("));

  // 2. Test dispatchCompute
  const mockBuffer = { size: 1024 };
  webgpuAdapter.dispatchCompute(mockDevice, mockBuffer, 100, 0, {
    pipeline: res.pipeline,
    instanceCount: 10
  });
  assert.equal(dispatchedWorkgroups, 1);

  // 3. Test boundary checks on dispatchCompute
  assert.throws(
    () => {
      webgpuAdapter.dispatchCompute(mockDevice, mockBuffer, 100, 1, { pipeline: res.pipeline });
    },
    (err) => err instanceof TypeError && err.message.includes("minStorageBufferOffsetAlignment")
  );

  assert.throws(
    () => {
      webgpuAdapter.dispatchCompute(mockDevice, mockBuffer, 100, 0, {
        pipeline: res.pipeline,
        instanceCount: 100
      });
    },
    (err) => err instanceof RangeError && err.message.includes("Buffer overflow")
  );

  // 4. Test readFromBuffer & readInstance
  const readData = await webgpuAdapter.readFromBuffer(mockDevice, mockBuffer, { offset: 0, size: 80 });
  assert.equal(readData.byteLength, 80);
  assert.equal(new Uint8Array(readData)[0], 42);

  const instData = await webgpuAdapter.readInstance(mockDevice, mockBuffer, { instanceIndex: 0 });
  assert.equal(instData.byteLength, 80);
  assert.equal(new Uint8Array(instData)[0], 42);

  // 5. Test boundary check on readFromBuffer
  await assert.rejects(
    async () => {
      await webgpuAdapter.readFromBuffer(mockDevice, mockBuffer, { offset: 1000, size: 100 });
    },
    (err) => err instanceof RangeError && err.message.includes("Buffer overflow")
  );
});

test("DOMAdapter: batchApply matrix3d formatting & performance guardrail warning", () => {
  const elements = [];
  for (let i = 0; i < 205; i++) {
    elements.push({
      style: { transform: "" },
      __transformMatrix: new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        10 + i, 20, 0, 1
      ])
    });
  }

  let warnCalled = false;
  let warnMsg = "";
  const originalWarn = console.warn;
  console.warn = (msg) => {
    warnCalled = true;
    warnMsg = msg;
  };

  domAdapter.batchApply(elements, 0, { transformPrefix: "translate3d(0,0,0)" });
  console.warn = originalWarn;

  assert.ok(warnCalled, "Expected console.warn for >200 elements limit");
  assert.ok(warnMsg.includes("205 elements (>200 limit)"));
  assert.ok(elements[0].style.transform.includes("matrix3d("));
  assert.ok(elements[0].style.transform.includes("translate3d(0,0,0)"));
  assert.ok(elements[0].style.transform.includes("10, 20, 0, 1)"));
});

test("DOMAdapter: batchApply with engine option triggers single getEvaluatedInstances call", () => {
  let getEvaluatedInstancesCallCount = 0;

  const mockEngine = {
    getEvaluatedInstances(t) {
      getEvaluatedInstancesCallCount++;
      return [
        {
          id: "inst1",
          transformMatrix: new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            50, 60, 0, 1
          ]),
          opacity: 1,
          visible: true
        }
      ];
    }
  };

  const elem = { style: { transform: "", opacity: "", pointerEvents: "" } };
  domAdapter.batchApply([elem], 500, { engine: mockEngine });

  assert.equal(getEvaluatedInstancesCallCount, 1, "getEvaluatedInstances should be called exactly once");
  assert.ok(elem.style.transform.includes("50, 60, 0, 1)"));
});

test("DOMAdapter: batchApply opacity clamping, visibility toggling (0.001 layer preservation), and pointer-events", () => {
  const mockEngine = {
    getEvaluatedInstances(t) {
      if (t === 0) {
        return [
          {
            transformMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            opacity: 0,
            visible: false
          }
        ];
      } else {
        return [
          {
            transformMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            opacity: 0.5,
            visible: true
          }
        ];
      }
    }
  };

  const elem = { style: { transform: "", opacity: "", pointerEvents: "" } };

  // 1. Hidden state: visible = false -> opacity set to 0.001 (preserves GPU layer, no display toggle, pointerEvents = "none")
  domAdapter.batchApply([elem], 0, { engine: mockEngine });
  assert.equal(elem.style.opacity, "0.001");
  assert.equal(elem.style.pointerEvents, "none");
  assert.equal(elem.style.display, undefined);

  // 2. Visible state: visible = true, opacity = 0.5 -> opacity set to 0.5, pointerEvents = ""
  domAdapter.batchApply([elem], 500, { engine: mockEngine });
  assert.equal(elem.style.opacity, "0.5");
  assert.equal(elem.style.pointerEvents, "");
  assert.equal(elem.style.display, undefined);
});

test("Controller: Playback state management & frame events", () => {
  const engine = new Engine();
  const player = controller.createPlayer(engine, { fps: 60, timeScale: 1.0 });

  assert.equal(player.getIsPlaying(), false);
  assert.equal(player.getCurrentTime(), 0);

  let frameTriggered = false;
  player.on("frame", (t) => {
    frameTriggered = true;
  });

  player.seek(500);
  assert.equal(player.getCurrentTime(), 500);
  assert.equal(frameTriggered, true);

  player.play();
  assert.equal(player.getIsPlaying(), true);

  player.pause();
  assert.equal(player.getIsPlaying(), false);
});

test("HierarchyResolver: Topological sorting, Kahn cycle detection & matrix cascading", () => {
  const resolver = new HierarchyResolver();

  const mat0 = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    10, 0, 0, 1
  ]);
  const mat1 = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    5, 0, 0, 1
  ]);

  const parentMap = new Map([
    [1, 0]
  ]);

  const worldMats = resolver.resolve([mat0, mat1], parentMap);
  assert.equal(worldMats.length, 2);
  assert.equal(worldMats[0][12], 10);
  assert.equal(worldMats[1][12], 15);

  const cycleMap = new Map([
    [0, 1],
    [1, 0]
  ]);

  assert.throws(
    () => {
      resolver.resolve([mat0, mat1], cycleMap);
    },
    (err) => {
      return err instanceof Error && err.message.includes("Cycle detected in hierarchy:");
    }
  );
});
