import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Clip, Instance, Keyframe, TransformBuilder } from '../dist/index.js';
import {
  PRESETS,
  validateScene,
  packStatic,
  packPoses,
  evalSceneMap,
  initKeyframeBridge,
  solvePoses,
  isKeyframeBridgeActive,
  disposeKeyframeBridge,
  solveKinematics,
} from '../dist/sdf/index.js';

test('SDF: PRESETS pass schema validation', () => {
  for (const preset of PRESETS) {
    const res = validateScene(preset);
    assert.equal(res.ok, true, `Preset "${preset.name}" failed validation: ${res.ok ? '' : res.error}`);
  }
});

test('SDF: packStatic & packPoses correctly produce binary float buffers', () => {
  const scene = PRESETS[0];
  const packed = packStatic(scene);
  assert.equal(packed.P0.length, 64);
  assert.equal(packed.P2.length, 64);
  assert.equal(packed.B0.length, 64);
  assert.equal(packed.B1.length, 64);

  const P1 = new Float32Array(64);
  const P3 = new Float32Array(64);
  packPoses(scene, P1, P3);
  assert.equal(P1.length, 64);
  assert.equal(P3.length, 64);
});

test('SDF: evalSceneMap CPU evaluator computes valid distance', () => {
  const scene = PRESETS[0];
  const st = packStatic(scene);
  const P1 = new Float32Array(64);
  const P3 = new Float32Array(64);
  packPoses(scene, P1, P3);

  const hit = evalSceneMap([0, 0, 0], scene.prims.length, st.P0, P1, st.P2, P3, st.B0, st.B1);
  assert.equal(typeof hit.d, 'number');
  assert.equal(Number.isFinite(hit.d), true);
});

test('SDF: Keyframe Bridge integrates with Engine and updates primitive poses', async () => {
  const scene = JSON.parse(JSON.stringify(PRESETS[0]));
  const kfEngine = new Engine();

  const clip = new Clip('crank_rot')
    .duration(2000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translate(10, 20, 30).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translate(50, 60, 70).build()));

  kfEngine.addClip(clip);
  kfEngine.addInstances([new Instance('crank_rot', 'inst_0').delay(0)]);
  kfEngine.prepared = true;

  const initSuccess = await initKeyframeBridge(scene, {
    engine: kfEngine,
    enabled: true,
  });

  assert.equal(initSuccess, true);
  assert.equal(isKeyframeBridgeActive(), true);

  // Evaluate frame at 1000ms (midpoint)
  solvePoses(scene, 1.0, () => solveKinematics(scene, 1.0));

  // Prim 0 position should be updated from Keyframe Engine translation (30, 40, 50)
  const prim0 = scene.prims[0];
  assert.ok(prim0._wp, 'Prim 0 should have _wp computed');
  assert.equal(Math.round(prim0._wp[0]), 30);
  assert.equal(Math.round(prim0._wp[1]), 40);
  assert.equal(Math.round(prim0._wp[2]), 50);

  // Cleanup
  disposeKeyframeBridge();
  assert.equal(isKeyframeBridgeActive(), false);
});

test('SDF: Keyframe Bridge auto-detects instance ID mapping for primitives (inst_7 & inst_14)', async () => {
  const scene = JSON.parse(JSON.stringify(PRESETS[0]));
  const kfEngine = new Engine();

  const crankClip = new Clip('crank_clip')
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translate(1, 2, 3).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translate(5, 6, 7).build()));

  const pistonClip = new Clip('piston_clip')
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translate(10, 20, 30).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translate(50, 60, 70).build()));

  kfEngine.addClip(crankClip);
  kfEngine.addClip(pistonClip);

  // Add instances with inst_7 and inst_14 IDs
  kfEngine.addInstances([
    new Instance('crank_clip', 'inst_7'),
    new Instance('piston_clip', 'inst_14'),
  ]);
  kfEngine.prepared = true;

  const initSuccess = await initKeyframeBridge(scene, {
    engine: kfEngine,
    enabled: true,
  });

  assert.equal(initSuccess, true);

  solvePoses(scene, 0.5, () => solveKinematics(scene, 0.5));

  // Primitive 7 (Crank Disc) should be updated with crankClip at midpoint (3, 4, 5)
  const prim7 = scene.prims[7];
  assert.ok(prim7._wp);
  assert.equal(Math.round(prim7._wp[0]), 3);
  assert.equal(Math.round(prim7._wp[1]), 4);
  assert.equal(Math.round(prim7._wp[2]), 5);

  // Primitive 14 (Piston) should be updated with pistonClip at midpoint (30, 40, 50)
  const prim14 = scene.prims[14];
  assert.ok(prim14._wp);
  assert.equal(Math.round(prim14._wp[0]), 30);
  assert.equal(Math.round(prim14._wp[1]), 40);
  assert.equal(Math.round(prim14._wp[2]), 50);

  // Primitive 0 (Base) should keep its default kinematics pose (not overwritten)
  const prim0 = scene.prims[0];
  assert.notEqual(Math.round(prim0._wp[0]), 3);

  disposeKeyframeBridge();
});

test('SDF: Keyframe Bridge fallback to solveKinematics when disabled', () => {
  const scene = JSON.parse(JSON.stringify(PRESETS[0]));
  disposeKeyframeBridge();

  solvePoses(scene, 1.0, () => solveKinematics(scene, 1.0));

  // Prim 0 should still have _wp calculated by solveKinematics
  assert.ok(scene.prims[0]._wp);
});
