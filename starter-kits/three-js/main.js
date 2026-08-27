import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder } from '../../dist/index.js';
import { threeAdapter } from '../../dist/adapters/three_adapter.js';

// Mock Three.js Mesh / Object3D if Three.js is not loaded in browser window
class MockThreeObject {
  constructor() {
    this.matrixAutoUpdate = true;
    this.matrix = {
      fromArray: (arr) => { this.matrix.elements = new Float32Array(arr); },
      copy: (m) => { this.matrix.elements = new Float32Array(m.elements || m); },
      decompose: (pos, quat, scale) => {
        pos.x = this.matrix.elements[12];
        pos.y = this.matrix.elements[13];
        pos.z = this.matrix.elements[14];
      },
      elements: new Float32Array(16)
    };
    this.position = { x: 0, y: 0, z: 0 };
    this.quaternion = { x: 0, y: 0, z: 0, w: 1 };
    this.scale = { x: 1, y: 1, z: 1 };
  }
  updateMatrix() {}
}

async function initThreeDemo() {
  const status = document.getElementById('status');
  const rasterBtn = document.getElementById('toggleRasterized');
  const abandonBtn = document.getElementById('toggleAbandoned');

  const engine = new Engine();
  const clip = new Clip('spin_mesh')
    .duration(3000)
    .easing(Easing.Linear)
    .iterations(Infinity)
    .addKeyframe(new Keyframe(0).transform(new TransformBuilder().rotateY(0).build()))
    .addKeyframe(new Keyframe(3000).transform(new TransformBuilder().rotateY(360).build()));

  engine.addClip(clip);

  const mockScene = { isScene: true };
  const mockMesh = new MockThreeObject();

  engine.addInstances([new Instance('spin_mesh', 'mesh_1')]);
  await engine.prepare({ wasmUrl: '../../pkg/keyframe_engine_bg.wasm' });

  // 1. Register scene to obtain Token Credential (AdapterContext)
  let isRasterized = false;
  let isAbandoned = false;

  const ctx = threeAdapter.registerScene(mockScene, engine, { defaultRasterized: isRasterized });
  ctx.registerObject(mockMesh);

  rasterBtn.addEventListener('click', () => {
    isRasterized = !isRasterized;
    rasterBtn.innerText = `Toggle Rasterized Mode (Current: ${isRasterized ? 'On (3x Fast)' : 'Off (Decomposed)'})`;
  });

  abandonBtn.addEventListener('click', () => {
    isAbandoned = true;
    threeAdapter.unregisterScene(ctx, { abandoned: true });
    status.innerText = "Scene un-registered with abandoned: true (Permanently frozen matrix, no decompose).";
  });

  let startTime = performance.now();
  function animate() {
    if (!isAbandoned) {
      const time = performance.now() - startTime;
      threeAdapter.applyToScene(ctx, time, { rasterized: isRasterized });
      status.innerText = `Position: (${mockMesh.position.x.toFixed(2)}, ${mockMesh.position.y.toFixed(2)}, ${mockMesh.position.z.toFixed(2)}) | AutoUpdate: ${mockMesh.matrixAutoUpdate}`;
    }
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

initThreeDemo();
