import { RealTimeSpring } from '../../dist/physics/RealTimeSpring.js';
import { Engine, Clip, Instance, Keyframe, TransformBuilder } from '../../dist/index.js';
import { domAdapter } from '../../dist/dom_binder.js';

async function initLivePhysicsDemo() {
  const container = document.getElementById('container');
  const statsEl = document.getElementById('stats');

  // Initialize Keyframe Engine
  const engine = new Engine();
  const clip = new Clip('physics_clip')
    .duration(1000)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translate(0, 0, 0).build()));

  engine.addClip(clip);

  // Set up 3 parallel spring instances with distinct physics parameters (mass, damping, stiffness)
  const configs = [
    { id: 'box1', label: 'Light', mass: 0.8, damping: 8, stiffness: 180, class: 'box-primary' },
    { id: 'box2', label: 'Medium', mass: 1.5, damping: 12, stiffness: 120, class: 'box-secondary' },
    { id: 'box3', label: 'Heavy', mass: 3.0, damping: 15, stiffness: 80, class: 'box-tertiary' },
  ];

  const elements = [];
  const springsX = [];
  const springsY = [];

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const el = document.createElement('div');
    el.className = `box ${cfg.class}`;
    el.innerText = cfg.label;
    container.appendChild(el);
    elements.push(el);

    engine.addInstances([new Instance('physics_clip', cfg.id)]);

    springsX.push(new RealTimeSpring({ mass: cfg.mass, damping: cfg.damping, stiffness: cfg.stiffness }));
    springsY.push(new RealTimeSpring({ mass: cfg.mass, damping: cfg.damping, stiffness: cfg.stiffness }));
  }

  await engine.prepare({ wasmUrl: 'https://cdn.jsdelivr.net/npm/@keyframe/core/pkg/keyframe_engine_bg.wasm' });

  let targetX = 0;
  let targetY = 0;

  // Track mouse movements relative to container center
  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    targetX = e.clientX - rect.left - 400;
    targetY = e.clientY - rect.top - 240;
  });

  let lastTime = performance.now();

  function animate(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1); // in seconds
    lastTime = now;

    const evaluatedInstances = engine.getEvaluatedInstances(now);

    for (let i = 0; i < configs.length; i++) {
      const currentX = springsX[i].step(targetX, dt);
      const currentY = springsY[i].step(targetY, dt);

      const vx = springsX[i].getVelocity();
      const vy = springsY[i].getVelocity();
      const speed = Math.hypot(vx, vy);

      // Kinetic energy mapping: modulate opacity based on velocity
      const dynamicOpacity = Math.min(1.0, Math.max(0.2, 0.3 + speed / 600));

      const instance = evaluatedInstances[i];
      if (instance && instance.transformMatrix) {
        // Overlay real-time spring displacements on base transform matrix
        const mat = instance.transformMatrix;
        mat[12] = currentX;
        mat[13] = currentY;

        elements[i].style.opacity = dynamicOpacity.toFixed(2);
      }
    }

    domAdapter.batchApply(elements, now, { engine });

    if (statsEl && springsX[0]) {
      statsEl.innerText = `Light Spring | Value: ${springsX[0].getValue().toFixed(1)}px | Velocity: ${springsX[0].getVelocity().toFixed(1)}px/s`;
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

initLivePhysicsDemo();
