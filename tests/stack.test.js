import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Engine,
  Clip,
  Instance,
  AnimationStack,
  BlendMode,
  PropertyTrackRegistry,
  Validator,
  TransformBuilder,
  Easing,
} from '../dist/index.js';

test('Issue #49: BlendMode.Inherit and inherit_from IR building and validation', () => {
  const clip1 = new Clip('c1').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(10, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(50, 0, 0).build(),
    opacity: 0.8,
    easing: Easing.Linear,
  });

  const clip2 = new Clip('c2').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(0, 20, 0).build(),
    opacity: 0.5,
    easing: Easing.Linear,
  });

  const inst1 = new Instance('c1', 'i1').delay(0);
  const inst2 = new Instance('c2', 'i2').delay(1000).inheritFrom('i1', ['transform', 'opacity']);

  const ir1 = inst1.build();
  const ir2 = inst2.build();

  assert.equal(ir2.blend_mode, BlendMode.Inherit);
  assert.equal(ir2.inherit_from?.source_instance_id, 'i1');
  assert.deepEqual(ir2.inherit_from?.property_tracks, ['transform', 'opacity']);

  const valRes = Validator.validateReferences([inst1, inst2], [clip1, clip2]);
  assert.equal(valRes.ok, true);

  const invalidInst = new Instance('c2', 'i3').inheritFrom('non_existent_id');
  const valErr = Validator.validateReferences([inst1, invalidInst], [clip1, clip2]);
  assert.equal(valErr.ok, false);
  assert.match(valErr.error || '', /non_existent_id/);
});

test('Issue #49: PropertyTrackRegistry custom track registration and interpolation', () => {
  PropertyTrackRegistry.register('color_rgba', (a, b, factor) => {
    return [
      a[0] + (b[0] - a[0]) * factor,
      a[1] + (b[1] - a[1]) * factor,
      a[2] + (b[2] - a[2]) * factor,
      a[3] + (b[3] - a[3]) * factor,
    ];
  });

  const interpolated = PropertyTrackRegistry.interpolate(
    'color_rgba',
    [1, 0, 0, 1],
    [0, 1, 0, 0.5],
    0.5
  );

  assert.deepEqual(interpolated, [0.5, 0.5, 0, 0.75]);
});

test('Issue #49: AnimationStack static expansion (Path A) value seam resolution', () => {
  const clipA = new Clip('move_right').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(100, 0, 0).build(),
    opacity: 0.8,
    easing: Easing.Linear,
  });

  const clipB = new Clip('move_up').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(0, 50, 0).build(),
    opacity: 0.5,
    easing: Easing.Linear,
  });

  const stack = new AnimationStack('stack1')
    .add(clipA)
    .add(clipB);

  const ir = stack.expand();

  assert.equal(ir.clips.length, 2);
  assert.equal(ir.instances.length, 2);

  // First clip end translation x = 100, opacity = 0.8
  // Second expanded clip keyframe at t=0 should start at x = 100, opacity = 0.8 * 1 = 0.8
  const expandedClipB = ir.clips[1];
  assert.equal(expandedClipB.keyframes[0].transform.translation[0], 100);
  assert.equal(expandedClipB.keyframes[0].opacity, 0.8);

  // Second expanded clip keyframe at t=1000 should end at x = 100, y = 50, opacity = 0.8 * 0.5 = 0.4
  assert.equal(expandedClipB.keyframes[1].transform.translation[0], 100);
  assert.equal(expandedClipB.keyframes[1].transform.translation[1], 50);
  assert.equal(expandedClipB.keyframes[1].opacity, 0.4);

  // Verify idempotency of expand()
  const irIdempotent = stack.expand();
  assert.equal(irIdempotent.clips.length, 2);
});

test('Issue #51: Validator topological ordering and property_tracks validation', () => {
  const clip = new Clip('c1').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  });

  const inst1 = new Instance('c1', 'i1').delay(0);
  const inst2 = new Instance('c1', 'i2').delay(1000).inheritFrom('i1', ['invalid_track_name']);

  // Invalid property track name
  const valTrackRes = Validator.validateReferences([inst1, inst2], [clip]);
  assert.equal(valTrackRes.ok, false);
  assert.match(valTrackRes.error || '', /invalid_track_name/);

  // Reversed topological order
  const inst2ValidTracks = new Instance('c1', 'i2').delay(1000).inheritFrom('i1', ['transform']);
  const valTopoRes = Validator.validateReferences([inst2ValidTracks, inst1], [clip]);
  assert.equal(valTopoRes.ok, false);
  assert.match(valTopoRes.error || '', /topological order/);
});

test('Issue #51: property_tracks selective inheritance evaluation', async () => {
  const clip1 = new Clip('c1').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(100, 0, 0).build(),
    opacity: 0.5,
    easing: Easing.Linear,
  });

  const clip2 = new Clip('c2').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(10, 0, 0).build(),
    opacity: 0.8,
    easing: Easing.Linear,
  });

  const inst1 = new Instance('c1', 'inst_1').delay(0);
  const inst2OpOnly = new Instance('c2', 'inst_2').delay(0).inheritFrom('inst_1', ['opacity']);

  const engine = new Engine();
  engine.addClip(clip1);
  engine.addClip(clip2);
  engine.addInstances([inst1, inst2OpOnly]);
  engine.prepared = true;

  const res = engine.getEvaluatedInstances(0);
  // inst_2 inherits opacity (0.5 * 1.0 * 0.8 = 0.4) but NOT transform (remains local tx = 10)
  assert.ok(Math.abs(res[1].transformMatrix[12] - 10) < 1e-3, `Expected tx=10, got ${res[1].transformMatrix[12]}`);
  assert.ok(Math.abs(res[1].opacity - 0.4) < 1e-3, `Expected opacity=0.4, got ${res[1].opacity}`);
});

test('Issue #51: Spring keyframe consistency matrix (Path A vs Path B)', async () => {
  const springCfg = { damping: 12, stiffness: 150, mass: 1 };
  const clipSpring = new Clip('c_spring').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(100, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
    springConfig: springCfg,
  });

  const clip2 = new Clip('c_second').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(50, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  });

  const stackA = new AnimationStack('stack_spring_a').add(clipSpring).add(clip2, { dynamic: false });
  const stackB = new AnimationStack('stack_spring_b').add(clipSpring).add(clip2, { dynamic: true });

  const engineA = new Engine();
  engineA.addStack(stackA);
  engineA.prepared = true;

  const engineB = new Engine();
  engineB.addStack(stackB);
  engineB.prepared = true;

  // Compare second segment end at t = 2000
  const instA = engineA.getEvaluatedInstances(2000)[1];
  const instB = engineB.getEvaluatedInstances(2000)[1];

  const diff = Math.abs(instA.transformMatrix[12] - instB.transformMatrix[12]);
  assert.ok(diff < 1e-3, `Spring end state mismatch between Path A (${instA.transformMatrix[12]}) and Path B (${instB.transformMatrix[12]}), diff=${diff}`);
});

test('Issue #49: AnimationStack dynamic expansion (Path B) and Runtime Inheritance evaluation', async () => {
  const clipA = new Clip('c_a').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(100, 0, 0).build(),
    opacity: 0.8,
    easing: Easing.Linear,
  });

  const clipB = new Clip('c_b').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(0, 50, 0).build(),
    opacity: 0.5,
    easing: Easing.Linear,
  });

  const stack = new AnimationStack('stack_dyn')
    .add(clipA)
    .add(clipB, { dynamic: true });

  const engine = new Engine();
  engine.addStack(stack);
  await engine.prepare({ storage: { enabled: false } }).catch(() => {});
  engine.prepared = true;

  // Evaluate at global time = 1500ms (50% through clipB, inheriting clipA's end position x=100)
  const instances = engine.getEvaluatedInstances(1500);
  assert.equal(instances.length, 2);

  const instB = instances[1];
  const mat = instB.transformMatrix;

  // Column-major matrix: index 12 is translation.x, index 13 is translation.y
  assert.ok(Math.abs(mat[12] - 100) < 1e-3, `Expected translation.x ~ 100, got ${mat[12]}`);
  assert.ok(Math.abs(mat[13] - 25) < 1e-3, `Expected translation.y ~ 25, got ${mat[13]}`);
  assert.ok(Math.abs(instB.opacity - 0.6) < 1e-3, `Expected opacity ~ 0.6, got ${instB.opacity}`);
});

test('Issue #49: Consistency Matrix — Expander (Path A) vs Runtime Inheritance (Path B) error bounds', async () => {
  const clip1 = new Clip('c_linear1').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(10, 20, 0).scale(1, 1, 1).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(60, 40, 0).scale(2, 2, 1).build(),
    opacity: 0.8,
    easing: Easing.Linear,
  });

  const clip2 = new Clip('c_linear2').duration(1000).addKeyframe({
    time: 0,
    transform: new TransformBuilder().translate(0, 0, 0).scale(1, 1, 1).build(),
    opacity: 1,
    easing: Easing.Linear,
  }).addKeyframe({
    time: 1000,
    transform: new TransformBuilder().translate(30, -10, 0).scale(0.5, 0.5, 1).build(),
    opacity: 0.5,
    easing: Easing.Linear,
  });

  // Engine A: Static expansion (Path A)
  const stackStatic = new AnimationStack('s_static')
    .add(clip1)
    .add(clip2, { dynamic: false });

  const engineA = new Engine();
  engineA.addStack(stackStatic);
  await engineA.prepare({ storage: { enabled: false } }).catch(() => {});
  engineA.prepared = true;

  // Engine B: Runtime inheritance (Path B)
  const stackDynamic = new AnimationStack('s_dynamic')
    .add(clip1)
    .add(clip2, { dynamic: true });

  const engineB = new Engine();
  engineB.addStack(stackDynamic);
  await engineB.prepare({ storage: { enabled: false } }).catch(() => {});
  engineB.prepared = true;

  // Evaluate both across multiple key time points in second segment (1000ms..2000ms)
  const sampleTimes = [1000, 1250, 1500, 1750, 2000];

  for (const t of sampleTimes) {
    const instA = engineA.getEvaluatedInstances(t)[1];
    const instB = engineB.getEvaluatedInstances(t)[1];

    const matA = instA.transformMatrix;
    const matB = instB.transformMatrix;

    for (let k = 0; k < 16; k++) {
      const diff = Math.abs(matA[k] - matB[k]);
      assert.ok(
        diff < 1e-4,
        `Matrix element [${k}] mismatch at t=${t}: Path A = ${matA[k]}, Path B = ${matB[k]}, diff = ${diff}`
      );
    }

    const opacityDiff = Math.abs(instA.opacity - instB.opacity);
    assert.ok(
      opacityDiff < 1 / 255,
      `Opacity mismatch at t=${t}: Path A = ${instA.opacity}, Path B = ${instB.opacity}, diff = ${opacityDiff}`
    );
  }
});
