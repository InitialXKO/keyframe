import { Engine, Clip, Instance, Keyframe, TransformBuilder } from '../../dist/index.js';
import { SdfEngine, PRESETS } from '../../dist/sdf/index.js';

async function initSdfStarterKit() {
  const status = document.getElementById('status');
  const canvas = document.getElementById('sdf-canvas');
  if (!canvas) return;

  // 1. Initialize SDF Raymarching Engine with Preset 0 (Piston Assembly)
  let presetIndex = 0;
  const sdfEngine = new SdfEngine(canvas);
  sdfEngine.loadScene(PRESETS[presetIndex]);

  // 2. Build Keyframe Engine Animation IR
  const kfEngine = new Engine();

  // Create rotation animation clip for crank disc & flywheel
  const spinClip = new Clip('crank_spin')
    .duration(4000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateZ(0).build()))
    .addKeyframe(new Keyframe(4000).transform(new TransformBuilder().rotateZ(360).build()));

  // Create reciprocating translation clip for piston
  const pistonClip = new Clip('piston_bounce')
    .duration(2000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateY(-0.1).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateY(0.15).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translateY(-0.1).build()));

  kfEngine.addClip(spinClip);
  kfEngine.addClip(pistonClip);

  // Bind animation clips to SDF primitive instance indices
  const instances = [
    new Instance('crank_spin', 'inst_7').delay(0),   // Crank Disc
    new Instance('piston_bounce', 'inst_14').delay(0) // Piston
  ];
  kfEngine.addInstances(instances);

  await kfEngine.prepare();

  // 3. Connect Keyframe Engine to SDF Engine via Keyframe Bridge
  let bridgeActive = true;
  await sdfEngine.setKeyframeConfig({
    engine: kfEngine,
    enabled: bridgeActive,
    timeScale: 1.0,
  });

  status.innerText = `SDF Raymarching Running | Preset: ${PRESETS[presetIndex].name} | Keyframe Bridge: Active`;

  // 4. Start Render Loop
  sdfEngine.start();

  // 5. Setup UI Event Listeners
  const toggleBtn = document.getElementById('toggleBridge');
  toggleBtn.addEventListener('click', async () => {
    bridgeActive = !bridgeActive;
    if (bridgeActive) {
      await sdfEngine.setKeyframeConfig({
        engine: kfEngine,
        enabled: true,
        timeScale: 1.0,
      });
      toggleBtn.innerText = 'Toggle Keyframe Bridge (Active)';
      status.innerText = `SDF Raymarching | Preset: ${PRESETS[presetIndex].name} | Keyframe Bridge: Active`;
    } else {
      sdfEngine.disableKeyframeBridge();
      toggleBtn.innerText = 'Toggle Keyframe Bridge (Disabled - Kinematics Fallback)';
      status.innerText = `SDF Raymarching | Preset: ${PRESETS[presetIndex].name} | Keyframe Bridge: Fallback (Kinematics)`;
    }
  });

  const switchBtn = document.getElementById('switchPreset');
  switchBtn.addEventListener('click', async () => {
    presetIndex = (presetIndex + 1) % PRESETS.length;
    sdfEngine.loadScene(PRESETS[presetIndex]);
    if (bridgeActive) {
      await sdfEngine.setKeyframeConfig({
        engine: kfEngine,
        enabled: true,
        timeScale: 1.0,
      });
    }
    status.innerText = `SDF Raymarching | Preset: ${PRESETS[presetIndex].name} | Keyframe Bridge: ${bridgeActive ? 'Active' : 'Fallback'}`;
  });
}

initSdfStarterKit();
