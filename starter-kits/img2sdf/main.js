import { Engine, Clip, Instance, Keyframe, TransformBuilder } from '../../dist/index.js';
import { SdfEngine, PRESETS } from '../../dist/sdf/index.js';
import { Img2ObjEngine } from './img2obj-engine.js';

/**
 * vinhhien112/img2obj ObjectSculptSpec -> @keyframe/sdf Raymarching CSG Generator
 *
 * Implements the vinhhien112/img2obj 4-phase procedural sculpting pipeline:
 * Phase 1: Reference image validation & evidence extraction (palette, silhouette bounds)
 * Phase 2: ObjectSculptSpec construction (hierarchical assemblies, PBR materials, motion pivots)
 * Phase 3: Procedural CSG compilation (sdSphere, sdBox, sdCylinder, sdCapsule, sdTorus) with smooth blending
 * Phase 4: Visual review rendering & Keyframe Engine zero-copy motion bridge
 */

async function initImg2Sdf() {
  const canvas = document.getElementById('sdf-canvas');
  const status = document.getElementById('status');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const previewImg = document.getElementById('preview-img');
  const dropText = document.getElementById('drop-text');
  const specTextarea = document.getElementById('spec-json');
  const recompileBtn = document.getElementById('btn-recompile');
  const sliderSmooth = document.getElementById('slider-smooth');
  const valSmooth = document.getElementById('val-smooth');
  const animBtn = document.getElementById('btn-toggle-anim');

  if (!canvas) return;

  // 1. Initialize SdfEngine
  const sdfEngine = new SdfEngine(canvas);

  // 2. Default vinhhien112/img2obj ObjectSculptSpec Template (Ancient Autumn Oak)
  const treeSpec = Img2ObjEngine.getTemplateSpec("Ancient Tree");
  const shipSpec = Img2ObjEngine.getTemplateSpec("Tower Ship");
  const pistonSpec = Img2ObjEngine.getTemplateSpec("Piston");

  specTextarea.value = JSON.stringify(treeSpec, null, 2);

  let currentSceneData = Img2ObjEngine.compileSpecToSdf(treeSpec);
  sdfEngine.loadScene(currentSceneData);

  // 3. Setup Keyframe Engine Motion Bridge
  const kfEngine = new Engine();
  const swayClip = new Clip('sway_clip')
    .duration(3000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateZ(-10).build()))
    .addKeyframe(new Keyframe(1500).transform(new TransformBuilder().rotateZ(10).build()))
    .addKeyframe(new Keyframe(3000).transform(new TransformBuilder().rotateZ(-10).build()));

  kfEngine.addClip(swayClip);
  kfEngine.addInstances([
    new Instance('sway_clip', 'inst_7').delay(0),
    new Instance('sway_clip', 'inst_14').delay(500),
  ]);

  await kfEngine.prepare();

  let animActive = true;
  await sdfEngine.setKeyframeConfig({
    engine: kfEngine,
    enabled: animActive,
    timeScale: 1.0,
  });

  sdfEngine.start();
  status.innerText = `img2obj Spec Compiled | Model: ${treeSpec.name} | Primitives: ${currentSceneData.primitives.length}`;

  // 4. UI Event Listeners & img2obj Engine integration
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      previewImg.src = evt.target.result;
      previewImg.style.display = 'block';
      dropText.style.display = 'none';

      const img = new Image();
      img.onload = () => {
        const spec = Img2ObjEngine.generateSpecFromImage(img, file.name);
        specTextarea.value = JSON.stringify(spec, null, 2);
        currentSceneData = Img2ObjEngine.compileSpecToSdf(spec);
        sdfEngine.loadScene(currentSceneData);
        status.innerText = `img2obj Spec Generated from [${file.name}] | Primitives: ${currentSceneData.primitives.length}`;
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });

  recompileBtn.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(specTextarea.value);
      currentSceneData = Img2ObjEngine.compileSpecToSdf(parsed);
      sdfEngine.loadScene(currentSceneData);
      status.innerText = `Spec Recompiled Successfully | Model: ${parsed.name || "Custom"}`;
    } catch (err) {
      status.innerText = `JSON Parse Error: ${err.message}`;
    }
  });

  sliderSmooth.addEventListener('input', () => {
    valSmooth.innerText = sliderSmooth.value;
    try {
      const parsed = JSON.parse(specTextarea.value);
      const k = parseFloat(sliderSmooth.value);
      currentSceneData = Img2ObjEngine.compileSpecToSdf(parsed, k);
      sdfEngine.loadScene(currentSceneData);
    } catch (e) {}
  });

  // Preset Spec buttons
  document.getElementById('preset-tree').addEventListener('click', () => {
    specTextarea.value = JSON.stringify(treeSpec, null, 2);
    currentSceneData = Img2ObjEngine.compileSpecToSdf(treeSpec);
    sdfEngine.loadScene(currentSceneData);
    status.innerText = `Loaded Spec Preset: Ancient Autumn Oak`;
  });

  document.getElementById('preset-ship').addEventListener('click', () => {
    specTextarea.value = JSON.stringify(shipSpec, null, 2);
    currentSceneData = Img2ObjEngine.compileSpecToSdf(shipSpec);
    sdfEngine.loadScene(currentSceneData);
    status.innerText = `Loaded Spec Preset: Tower Ship`;
  });

  document.getElementById('preset-piston').addEventListener('click', () => {
    specTextarea.value = JSON.stringify(pistonSpec, null, 2);
    currentSceneData = Img2ObjEngine.compileSpecToSdf(pistonSpec);
    sdfEngine.loadScene(currentSceneData);
    status.innerText = `Loaded Spec Preset: Piston Assembly`;
  });

  animBtn.addEventListener('click', async () => {
    animActive = !animActive;
    if (animActive) {
      await sdfEngine.setKeyframeConfig({ engine: kfEngine, enabled: true, timeScale: 1.0 });
      animBtn.innerText = 'Toggle Keyframe Bridge (Active)';
    } else {
      sdfEngine.disableKeyframeBridge();
      animBtn.innerText = 'Toggle Keyframe Bridge (Disabled)';
    }
  });
}

initImg2Sdf();
