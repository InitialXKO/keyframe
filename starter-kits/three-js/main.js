// ============================================================================
// Keyframe Engine Starter Kit - Three.js Integration
//
// Loading Three.js / Three.js 加载方式:
// 1. NPM / Bundler:
//    Run `npm install three` and use:
//    `import * as THREE from 'three';`
//
// 2. Browser ESM / CDN:
//    Use importmap in index.html or import directly from CDN:
//    `import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';`
// ============================================================================

import * as THREE from 'three';
import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from '../../dist/index.js';
import { threeAdapter } from '../../dist/adapters/three_adapter.js';

async function initThreeDemo() {
  const status = document.getElementById('status');
  const rasterBtn = document.getElementById('toggleRasterized');
  const abandonBtn = document.getElementById('toggleAbandoned');
  const container = document.getElementById('container');

  // 1. Create real Three.js Scene, Camera, Renderer, and Mesh
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(800, 600);
  container.appendChild(renderer.domElement);

  // Add lighting to scene
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 5, 5);
  scene.add(dirLight);

  // Create 3D Mesh
  const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const material = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    roughness: 0.3,
    metalness: 0.2
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // 2. Initialize Keyframe Engine animation clip & instances
  const engine = new Engine();
  const clip = new Clip('spin_mesh')
    .duration(3000)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateY(0).rotateX(0).build()))
    .addKeyframe(new Keyframe(3000).transform(new TransformBuilder().rotateY(360).rotateX(360).build()));

  engine.addClip(clip);
  engine.addInstances([new Instance('spin_mesh', 'mesh_1')]);

  // Prepare engine (tries local WASM module first, falls back gracefully to JS evaluator if WASM file is unavailable)
  try {
    await engine.prepare({ wasmUrl: '../../pkg/keyframe_engine_bg.wasm' });
  } catch (err) {
    console.warn("WASM engine module unavailable, initializing JS fallback evaluator:", err.message);
    await engine.prepare({ storage: { enabled: false } }).catch(() => {
      engine.prepared = true;
    });
  }

  // 3. Register scene and mesh with ThreeAdapter (Token Context)
  let isRasterized = false;
  let isAbandoned = false;

  const ctx = threeAdapter.registerScene(scene, engine, { defaultRasterized: isRasterized });
  ctx.registerObject(mesh);

  // Interactive controls
  rasterBtn.addEventListener('click', () => {
    isRasterized = !isRasterized;
    rasterBtn.innerText = `Toggle Rasterized Mode (Current: ${isRasterized ? 'On (3x Fast Matrix Direct)' : 'Off (Decomposed Position/Rotation)'})`;
  });

  abandonBtn.addEventListener('click', () => {
    isAbandoned = true;
    threeAdapter.unregisterScene(ctx, { abandoned: true });
    status.innerText = "Scene un-registered with abandoned: true (Permanently frozen matrix, no decompose).";
  });

  // 4. Render loop: Sync matrix via threeAdapter and render scene
  let startTime = performance.now();
  function animate() {
    requestAnimationFrame(animate);

    if (!isAbandoned) {
      const time = performance.now() - startTime;
      threeAdapter.applyToScene(ctx, time, { rasterized: isRasterized });
      status.innerText = `Position: (${mesh.position.x.toFixed(2)}, ${mesh.position.y.toFixed(2)}, ${mesh.position.z.toFixed(2)}) | Rotation Y: ${mesh.rotation.y.toFixed(2)} rad | AutoUpdate: ${mesh.matrixAutoUpdate}`;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
}

initThreeDemo();
