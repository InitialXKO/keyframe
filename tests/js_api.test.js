import test from "node:test";
import assert from "node:assert/strict";

import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from "../dist/builder/index.js";
import { spring, interpolate, interpolateColors, Sequence, Series, setRemotionFrameContext, useCurrentFrame } from "../dist/remotion/index.js";
import { OPFSStorage } from "../dist/opfs_storage.js";
import { StorageAdapter } from "../dist/storage_adapter.js";

test("Builder API constructs valid Clip and Instance IR with Infinity iterations", () => {
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
    .delay(100);

  engine.addClip(clip);
  engine.addInstances([inst]);

  const ir = engine.exportIR();
  assert.equal(ir.clips.length, 1);
  assert.equal(ir.clips[0].id, "test_clip");
  assert.equal(ir.clips[0].keyframes.length, 2);
  assert.equal(ir.instances.length, 1);
  assert.equal(ir.instances[0].id, "inst_1");
  assert.equal(ir.instances[0].delay, 100);
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

test("Remotion Sequence & Series context propagation", () => {
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
});

test("OPFS Storage & StorageAdapter bake bytes persistence", async () => {
  const adapter = new StorageAdapter();
  const bakeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await adapter.saveBakeData("bake_1.bin", bakeBytes);
  const loadedBytes = await adapter.loadBakeData("bake_1.bin");

  assert.deepEqual(loadedBytes, bakeBytes);
});
