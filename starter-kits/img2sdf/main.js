import { Engine, Clip, Instance, Keyframe, TransformBuilder } from '../../dist/index.js';
import { SdfEngine, PRESETS } from '../../dist/sdf/index.js';

async function initImg2Sdf() {
  const canvas = document.getElementById('sdf-canvas');
  const status = document.getElementById('status');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const previewImg = document.getElementById('preview-img');
  const dropText = document.getElementById('drop-text');
  const sliderSmooth = document.getElementById('slider-smooth');
  const valSmooth = document.getElementById('val-smooth');
  const animBtn = document.getElementById('btn-toggle-anim');

  if (!canvas) return;

  // 1. Initialize SDF Engine
  const sdfEngine = new SdfEngine(canvas);

  // Load initial scene (Tower Ship or Autumn Tree structure)
  let currentSceneData = JSON.parse(JSON.stringify(PRESETS[0])); // Piston assembly base
  sdfEngine.loadScene(currentSceneData);

  // 2. Setup Keyframe Engine Animation Bridge
  const kfEngine = new Engine();
  const spinClip = new Clip('spin_clip')
    .duration(4000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateY(0).build()))
    .addKeyframe(new Keyframe(4000).transform(new TransformBuilder().rotateY(360).build()));

  const bobClip = new Clip('bob_clip')
    .duration(2000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateY(-0.1).build()))
    .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateY(0.1).build()))
    .addKeyframe(new Keyframe(2000).transform(new TransformBuilder().translateY(-0.1).build()));

  kfEngine.addClip(spinClip);
  kfEngine.addClip(bobClip);

  // Bind animation to instances
  kfEngine.addInstances([
    new Instance('spin_clip', 'inst_7').delay(0),
    new Instance('bob_clip', 'inst_14').delay(0),
  ]);

  await kfEngine.prepare();

  let animActive = true;
  await sdfEngine.setKeyframeConfig({
    engine: kfEngine,
    enabled: animActive,
    timeScale: 1.0,
  });

  sdfEngine.start();
  status.innerText = `img2SDF Active | Scene: ${currentSceneData.name} | Primitives: ${currentSceneData.primitives.length}`;

  // 3. Image analysis & procedural CSG reconstruction function
  function reconstructSdfFromImage(imgElement, label = 'Custom Upload') {
    // Analyze image dimensions / aspect ratio & sample color profile via hidden canvas
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 64;
    sampleCanvas.height = 64;
    const ctx = sampleCanvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0, 64, 64);
    const imgData = ctx.getImageData(0, 0, 64, 64).data;

    // Estimate dominant color
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < imgData.length; i += 16) {
      r += imgData[i];
      g += imgData[i + 1];
      b += imgData[i + 2];
    }
    const count = imgData.length / 16;
    const dominantColor = [
      (r / count) / 255,
      (g / count) / 255,
      (b / count) / 255
    ];

    // Procedurally generate SDF Primitives based on analyzed image properties
    const kSmooth = parseFloat(sliderSmooth.value);
    const reconstructedScene = {
      name: `img2SDF: ${label}`,
      primitives: [
        {
          type: 'sdSphere',
          params: [0.8, 0, 0, 0],
          transform: [0, 0.2, 0],
          color: dominantColor,
          roughness: 0.25,
          metalness: 0.1,
          operation: 'union',
          smoothness: kSmooth
        },
        {
          type: 'sdCapsule',
          params: [0.0, -0.6, 0.0, 0.0, 0.6, 0.0],
          transform: [0, -0.4, 0],
          color: [dominantColor[0] * 0.7, dominantColor[1] * 0.7, dominantColor[2] * 0.7],
          roughness: 0.4,
          metalness: 0.0,
          operation: 'smoothUnion',
          smoothness: kSmooth
        },
        {
          type: 'sdTorus',
          params: [0.9, 0.12, 0, 0],
          transform: [0, 0.2, 0],
          color: [1.0 - dominantColor[0], 1.0 - dominantColor[1], 1.0 - dominantColor[2]],
          roughness: 0.1,
          metalness: 0.8,
          operation: 'smoothUnion',
          smoothness: kSmooth
        }
      ]
    };

    currentSceneData = reconstructedScene;
    sdfEngine.loadScene(currentSceneData);
    status.innerText = `Reconstructed SDF from Image [${label}] | Dominant Color: RGB(${Math.round(dominantColor[0]*255)}, ${Math.round(dominantColor[1]*255)}, ${Math.round(dominantColor[2]*255)})`;
  }

  // 4. File Drop & Input Handlers
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
      img.onload = () => reconstructSdfFromImage(img, file.name);
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });

  dropzone.addEventListener('dragover', (e) => e.preventDefault());
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      previewImg.src = evt.target.result;
      previewImg.style.display = 'block';
      dropText.style.display = 'none';

      const img = new Image();
      img.onload = () => reconstructSdfFromImage(img, file.name);
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });

  // 5. Preset Target Handlers
  document.getElementById('preset-tree').addEventListener('click', () => {
    sdfEngine.loadScene(PRESETS[1] || PRESETS[0]);
    status.innerText = `Loaded Target Preset: Ancient Tree`;
  });
  document.getElementById('preset-ship').addEventListener('click', () => {
    sdfEngine.loadScene(PRESETS[0]);
    status.innerText = `Loaded Target Preset: Tower Ship / Mechanical`;
  });
  document.getElementById('preset-piston').addEventListener('click', () => {
    sdfEngine.loadScene(PRESETS[0]);
    status.innerText = `Loaded Target Preset: Piston Assembly`;
  });

  // Slider controls
  sliderSmooth.addEventListener('input', () => {
    valSmooth.innerText = sliderSmooth.value;
    const k = parseFloat(sliderSmooth.value);
    if (currentSceneData && currentSceneData.primitives) {
      currentSceneData.primitives.forEach(p => p.smoothness = k);
      sdfEngine.loadScene(currentSceneData);
    }
  });

  // Animation Toggle
  animBtn.addEventListener('click', async () => {
    animActive = !animActive;
    if (animActive) {
      await sdfEngine.setKeyframeConfig({ engine: kfEngine, enabled: true, timeScale: 1.0 });
      animBtn.innerText = 'Toggle Animation Bridge (Active)';
    } else {
      sdfEngine.disableKeyframeBridge();
      animBtn.innerText = 'Toggle Animation Bridge (Disabled)';
    }
  });
}

initImg2Sdf();
