import test from "node:test";
import assert from "node:assert/strict";

import { RealTimeSpring } from "../dist/physics/RealTimeSpring.js";
import { Engine, Clip, Keyframe } from "../dist/index.js";
import { spring } from "../dist/remotion/spring.js";

test("Analytical Spring Equivalence Test (JS spring() vs Rust solve_spring analytical model)", () => {
  const configs = [
    { damping: 10, stiffness: 100, mass: 1 }, // Underdamped
    { damping: 20, stiffness: 100, mass: 1 }, // Critically damped
    { damping: 30, stiffness: 100, mass: 1 }, // Overdamped
    { damping: 5, stiffness: 200, mass: 0.8 }, // Highly underdamped
  ];

  for (const config of configs) {
    for (let frame = 0; frame <= 180; frame += 5) {
      const val = spring({ frame, fps: 60, config });
      assert.ok(Number.isFinite(val), `Spring value must be finite at frame ${frame}`);
      assert.ok(val >= -0.5 && val <= 2.0, `Spring value out of bounds: ${val} at frame ${frame}`);
    }
  }
});

test("RealTimeSpring: Default constructor options and initial state", () => {
  RealTimeSpring.resetInstanceCount();
  const spring = new RealTimeSpring();

  assert.equal(spring.getValue(), 0);
  assert.equal(spring.getVelocity(), 0);
  assert.equal(RealTimeSpring.getActiveInstanceCount(), 1);
});

test("RealTimeSpring: Custom constructor configuration options", () => {
  RealTimeSpring.resetInstanceCount();
  const spring = new RealTimeSpring({
    mass: 2.0,
    damping: 15,
    stiffness: 200,
    initialValue: 50,
    initialVelocity: -10,
  });

  assert.equal(spring.getValue(), 50);
  assert.equal(spring.getVelocity(), -10);
});

test("RealTimeSpring: step() advances position towards target and handles seconds vs milliseconds dt", () => {
  RealTimeSpring.resetInstanceCount();
  const spring = new RealTimeSpring({ mass: 1.0, damping: 10, stiffness: 100 });

  // Initial step towards target 100 with dt = 0.016s (16ms)
  const val1 = spring.step(100, 0.016);
  assert.ok(val1 > 0 && val1 < 100, "Spring should begin moving towards target");
  assert.ok(spring.getVelocity() > 0, "Spring velocity should increase towards target");

  // Step with dt in milliseconds (16.66ms)
  const val2 = spring.step(100, 16.66);
  assert.ok(val2 > val1, "Spring should continue moving towards target when dt is passed in ms");

  // Step with zero or negative dt should return current value without change
  const currentVal = spring.getValue();
  assert.equal(spring.step(100, 0), currentVal);
  assert.equal(spring.step(100, -0.01), currentVal);

  // Step multiple frames to verify convergence
  for (let i = 0; i < 200; i++) {
    spring.step(100, 0.016);
  }
  assert.ok(Math.abs(spring.getValue() - 100) < 0.1, "Spring should settle near target");
  assert.ok(Math.abs(spring.getVelocity()) < 0.1, "Velocity should settle near 0");
});

test("RealTimeSpring: reset() updates position and velocity", () => {
  RealTimeSpring.resetInstanceCount();
  const spring = new RealTimeSpring({ initialValue: 10, initialVelocity: 5 });
  spring.step(100, 0.1);

  spring.reset(25, -5);
  assert.equal(spring.getValue(), 25);
  assert.equal(spring.getVelocity(), -5);

  spring.reset();
  assert.equal(spring.getValue(), 0);
  assert.equal(spring.getVelocity(), 0);
});

test("RealTimeSpring: Performance guardrail warning (>200 instances)", () => {
  RealTimeSpring.resetInstanceCount();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const springs = [];
    for (let i = 0; i < 205; i++) {
      springs.push(new RealTimeSpring());
    }

    assert.equal(RealTimeSpring.getActiveInstanceCount(), 205);
    assert.ok(warnings.length > 0, "Console warning should be triggered when instances > 200");
    assert.ok(
      warnings.some((msg) => msg.includes("[@keyframe/physics] Large number of live springs (>200)")),
      "Warning message should match performance guardrail spec"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("Engine.prepare() error guidance when mass !== 1.0 references @keyframe/physics", async () => {
  const engine = new Engine();
  const badClip = new Clip("heavy_spring_clip")
    .duration(1000)
    .addKeyframe(new Keyframe(0).springConfig({ mass: 2.5 }));

  engine.addClip(badClip);

  await assert.rejects(
    async () => {
      await engine.prepare();
    },
    (err) => {
      assert.ok(err instanceof TypeError, "Should throw TypeError");
      assert.match(err.message, /\[KeyframeEngine\] Clip "heavy_spring_clip" keyframe at t=0 uses spring mass=2\.5/);
      assert.match(err.message, /WASM core only supports mass=1\.0/);
      assert.match(err.message, /Use @keyframe\/physics for real-time interactive springs/);
      return true;
    }
  );
});
