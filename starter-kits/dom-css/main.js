import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from '../../dist/index.js';
import { domAdapter } from '../../dist/dom_binder.js';

async function initDOMDemo() {
  const container = document.getElementById('container');
  const status = document.getElementById('status');
  const largeBatchBtn = document.getElementById('triggerLargeBatch');

  const engine = new Engine();
  const clip = new Clip('bounce')
    .duration(2000)
    .easing(Easing.EaseInOut)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translate(0, 0, 0).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translate(300, 200, 0).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translate(0, 0, 0).build()));

  engine.addClip(clip);

  let elementCount = 50;
  let elements = [];

  async function setupElements(count) {
    container.innerHTML = '';
    elements = [];
    engine.instances = [];

    const instList = [];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'anim-box';
      container.appendChild(el);
      elements.push(el);

      instList.push(new Instance('bounce', `box_${i}`).delay(i * 20));
    }
    engine.addInstances(instList);
    await engine.prepare({ wasmUrl: '../../pkg/keyframe_engine_bg.wasm' });

    status.innerText = `Active Elements: ${count}`;
  }

  await setupElements(elementCount);

  largeBatchBtn.addEventListener('click', async () => {
    elementCount = 250;
    await setupElements(elementCount);
    console.log("Triggered >200 elements batchApply to test performance guardrail warning.");
  });

  let startTime = performance.now();
  function render() {
    const time = performance.now() - startTime;
    domAdapter.batchApply(elements, time, { engine });
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

initDOMDemo();
