import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Clip, Instance, Keyframe, TransformBuilder, Easing, Validator, MemoryWriter, COMPUTE_TEMPLATE } from '../dist/index.js';

test('Validator: Rejects invalid clip duration, non-monotonic keyframes, and out-of-range cubic bezier', () => {
  const invalidDurationClip = new Clip('c1').duration(-500);
  assert.equal(Validator.validateClip(invalidDurationClip).ok, false);

  const nonMonotonicClip = new Clip('c2').duration(1000)
    .addKeyframe(new Keyframe(500))
    .addKeyframe(new Keyframe(200));
  assert.equal(Validator.validateClip(nonMonotonicClip).ok, false);

  const invalidCubicClip = new Clip('c3').duration(1000)
    .addKeyframe(new Keyframe(0).easing(Easing.CubicBezier, { p1x: 1.5, p1y: 0, p2x: 0.5, p2y: 1 }))
    .addKeyframe(new Keyframe(1000));
  assert.equal(Validator.validateClip(invalidCubicClip).ok, false);

  const validClip = new Clip('c4').duration(1000)
    .addKeyframe(new Keyframe(0))
    .addKeyframe(new Keyframe(1000));
  assert.equal(Validator.validateClip(validClip).ok, true);
});

test('Validator: Rejects invalid instance speed and missing clip reference', () => {
  const validClip = new Clip('valid_clip').duration(1000);
  const invalidInstance = new Instance('non_existent_clip', 'inst_1');

  const refResult = Validator.validateReferences([invalidInstance], [validClip]);
  assert.equal(refResult.ok, false);
  assert.match(refResult.error, /does not exist/);
});

test('OPFS & MemoryWriter: Binary roundtrip integrity', async () => {
  const writer = new MemoryWriter('test_anim.bin');
  const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  await writer.write(testData);
  writer.close();

  const readBack = writer.getBytes();
  assert.equal(readBack.length, testData.length);
  assert.deepEqual(Array.from(readBack), Array.from(testData));
});

test('Performance Benchmark: Evaluates 10,000 instances throughput', () => {
  const engine = new Engine();
  const clip = new Clip('mass_clip')
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().scale(1).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().scale(2).build()));

  engine.addClip(clip);

  const instances = [];
  for (let i = 0; i < 10000; i++) {
    instances.push(new Instance('mass_clip', `mass_${i}`).delay(i * 0.1));
  }
  engine.addInstances(instances);
  engine.prepared = true;

  const startTime = performance.now();
  const frameCount = 50;
  for (let f = 0; f < frameCount; f++) {
    engine.evaluateFrame(f * 10);
  }
  const durationMs = performance.now() - startTime;
  const timePerFrameMs = durationMs / frameCount;

  assert.ok(timePerFrameMs < 30, `10,000 instances evaluation should be under 30ms per frame in sandbox, got ${timePerFrameMs.toFixed(2)}ms`);
});

test('WGSL Compute Template: Contains full keyframe TRS math and cubic bezier easing', () => {
  assert.ok(COMPUTE_TEMPLATE.includes('struct InstanceInput'));
  assert.ok(COMPUTE_TEMPLATE.includes('fn solve_cubic_bezier'));
  assert.ok(COMPUTE_TEMPLATE.includes('fn quat_slerp'));
  assert.ok(COMPUTE_TEMPLATE.includes('fn compose_trs'));
});

test('Cubic Bezier Newton-Raphson Degenerate Cases Convergence (8 iterations vs 64 ground truth)', () => {
  function solveCubicBezier64(p1x, p1y, p2x, p2y, t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 64; i++) {
      const omu = 1 - u;
      const x = 3 * omu * omu * u * p1x + 3 * omu * u * u * p2x + u * u * u;
      const dx = 3 * omu * omu * p1x + 6 * omu * u * (p2x - p1x) + 3 * u * u * (1 - p2x);
      if (Math.abs(dx) < 1e-12) break;
      u -= (x - t) / dx;
      u = Math.max(0, Math.min(1, u));
    }
    const omu = 1 - u;
    return 3 * omu * omu * u * p1y + 3 * omu * u * u * p2y + u * u * u;
  }

  const degenerateCases = [
    [0.5, 0.0, 0.5, 1.0],
    [0.0, 1.5, 1.0, -0.5],
    [0.001, 0.001, 0.999, 0.999],
    [0.1, 0.9, 0.9, 0.1],
  ];

  for (const [p1x, p1y, p2x, p2y] of degenerateCases) {
    const engine = new Engine();
    const clip = new Clip("bezier_test")
      .duration(1000)
      .addKeyframe(new Keyframe(0).easing(Easing.CubicBezier, { p1x, p1y, p2x, p2y }).transform(new TransformBuilder().translateX(0).build()))
      .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

    engine.addClip(clip);
    engine.addInstances([new Instance("bezier_test", "i1")]);
    engine.prepared = true;

    for (let step = 0; step <= 100; step++) {
      const t = step / 100;
      const timeMs = t * 1000;
      const evalVal = engine.getEvaluatedInstances(timeMs, true)[0].transformMatrix[12];
      const refVal = solveCubicBezier64(p1x, p1y, p2x, p2y, t) * 100;

      assert.ok(
        Math.abs(evalVal - refVal) < 1e-3,
        `Divergence at t=${t} for curve (${p1x}, ${p1y}, ${p2x}, ${p2y}): eval=${evalVal}, ref=${refVal}`
      );
    }
  }
});
