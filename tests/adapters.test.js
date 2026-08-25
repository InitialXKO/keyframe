import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from "../dist/index.js";
import { threeAdapter, AdapterContext } from "../dist/adapters/index.js";
import { webgpuAdapter, GPUDeviceLostError } from "../dist/adapters/index.js";

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

test("ThreeAdapter: Token-based dual scene parallel isolation", () => {
  const engineA = new Engine();
  const clipA = new Clip("cA").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(100).build())
  );
  engineA.addClip(clipA).addInstances([new Instance("cA", "instA")]);

  const engineB = new Engine();
  const clipB = new Clip("cB").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(500).build())
  );
  engineB.addClip(clipB).addInstances([new Instance("cB", "instB")]);

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

  // Assert objA received engineA's evaluated matrix
  assert.equal(objA.matrix.elements[12], evalA[0].transformMatrix[12]);
  // Assert objB received engineB's evaluated matrix
  assert.equal(objB.matrix.elements[12], evalB[0].transformMatrix[12]);

  // Modifying scene A context at time 1000 does not affect scene B
  threeAdapter.applyToScene(ctxA, 1000);
  const evalA1000 = engineA.getEvaluatedInstances(1000);
  assert.equal(objA.matrix.elements[12], evalA1000[0].transformMatrix[12]);
  assert.equal(objB.matrix.elements[12], evalB[0].transformMatrix[12]);

  assert.notEqual(ctxA, ctxB);
});

test("ThreeAdapter: Lifecycle unregisterScene restoreControl true vs false", () => {
  const engine = new Engine();
  const scene = {};
  const ctx = threeAdapter.registerScene(scene, engine);

  const obj1 = createMockThreeObject();
  const obj2 = createMockThreeObject();

  ctx.registerObject(obj1);
  ctx.registerObject(obj2);

  assert.equal(obj1.matrixAutoUpdate, false);
  assert.equal(obj2.matrixAutoUpdate, false);

  ctx.unregisterObject(obj1, true);
  assert.equal(obj1.matrixAutoUpdate, true);
  assert.equal(obj1.updateMatrixCalled, true);
  assert.equal(ctx.registeredObjects.has(obj1), false);

  threeAdapter.unregisterScene(ctx, true);
  assert.equal(obj2.matrixAutoUpdate, true);
  assert.equal(obj2.updateMatrixCalled, true);
  assert.equal(ctx.registeredObjects.size, 0);

  const ctx2 = threeAdapter.registerScene(scene, engine);
  const obj3 = createMockThreeObject();
  ctx2.registerObject(obj3);
  assert.equal(obj3.matrixAutoUpdate, false);

  threeAdapter.unregisterScene(ctx2, false);
  assert.equal(ctx2.registeredObjects.size, 0);
  assert.equal(obj3.matrixAutoUpdate, false);
});

test("ThreeAdapter: fastDirty precision semantics (true vs false)", () => {
  const engine = new Engine();
  const clip = new Clip("c1").duration(1000).addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(200).build())
  );
  engine.addClip(clip).addInstances([new Instance("c1", "inst1")]);

  const scene = {};
  const ctx = threeAdapter.registerScene(scene, engine);
  const obj = createMockThreeObject({ x: 999, y: 999, z: 999 });
  ctx.registerObject(obj);

  threeAdapter.applyToScene(ctx, 0, { fastDirty: true });
  assert.equal(obj.position.x, 999);

  threeAdapter.applyToScene(ctx, 0, { fastDirty: false });
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
