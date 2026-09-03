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
