import { Engine, Clip, Instance, Keyframe, Easing } from '../../dist/index.js';
import { controller } from '../../dist/controller.js';
import { Remotion } from '../../dist/index.js';

async function initRemotionExport() {
  const status = document.getElementById('status');
  const canvas = document.getElementById('exportCanvas');
  const ctx = canvas.getContext('2d');

  const engine = new Engine();
  const clip = new Clip('hero_banner')
    .duration(5000)
    .easing(Easing.EaseInOut)
    .addKeyframe(new Keyframe(0).transform({ translation: [0, 0, 0], scale: [1, 1, 1], rotation_quat: [0, 0, 0, 1], origin: [0, 0, 0] }))
    .addKeyframe(new Keyframe(5000).transform({ translation: [300, 180, 0], scale: [1.5, 1.5, 1], rotation_quat: [0, 0, 0.38, 0.92], origin: [0, 0, 0] }));

  engine.addClip(clip);
  engine.addInstance(new Instance('hero_banner', 'banner_1'));
  await engine.prepare();

  // Create AudioContext for Audio Clock Master Adaptive Convergence
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioContextClass ? new AudioContextClass() : null;

  const player = controller.createPlayer(engine, {
    fps: 30,
    timeScale: 1.0,
    audioContext: audioCtx,
    duration: 5000
  });

  player.on('frame', (timeMs) => {
    status.innerText = `Exporting / Rendering Frame at time: ${Math.round(timeMs)} ms`;

    // Render frame
    if (ctx) {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const evaluated = engine.getEvaluatedInstances(timeMs);
      if (evaluated && evaluated[0]) {
        const mat = evaluated[0].transformMatrix;
        ctx.fillStyle = '#58a6ff';
        ctx.fillRect(mat[12] || 50, mat[13] || 50, 80, 80);
      }
    }
  });

  player.on('ended', () => {
    status.innerText = "Video Export Pipeline Simulation Completed!";
  });

  player.play();
}

initRemotionExport();
