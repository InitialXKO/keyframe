import * as THREE from 'three';
import {
  SCULPT_REVIEW_RENDER_CONTRACT,
  SCULPT_REVIEW_RENDER_CONTRACT_SHA256,
  createSculptReviewPipeline,
} from './aa.generated';

async function run(): Promise<void> {
  const expectedSmaaContractSha256 =
    'e4fd51bdba0462ff5462cdfebaa663e92e1005c889d111742988ab85fcee2737';
  const expectedFxaaContractSha256 =
    'e891f02e58b1af1267973c485a0da51b9d9c0b49fca174ded6c13106c7e55db3';
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 10);
  camera.position.z = 3;
  scene.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x6688aa }),
    ),
  );
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2));

  const smaa = await createSculptReviewPipeline({
    renderer,
    scene,
    camera,
    contract: {
      ...SCULPT_REVIEW_RENDER_CONTRACT,
      antiAliasing: {
        ...SCULPT_REVIEW_RENDER_CONTRACT.antiAliasing,
        mode: 'smaa',
      },
    },
  });
  smaa.resize(320, 240, 1);
  smaa.render();
  const smaaReceipt = smaa.receipt();
  smaa.dispose();

  const fxaa = await createSculptReviewPipeline({
    renderer,
    scene,
    camera,
    contract: {
      ...SCULPT_REVIEW_RENDER_CONTRACT,
      antiAliasing: {
        ...SCULPT_REVIEW_RENDER_CONTRACT.antiAliasing,
        mode: 'fxaa',
      },
    },
  });
  fxaa.resize(320, 240, 1);
  fxaa.render();
  const fxaaReceipt = fxaa.receipt();
  fxaa.dispose();

  const raceContract = {
    ...SCULPT_REVIEW_RENDER_CONTRACT,
    antiAliasing: {
      ...SCULPT_REVIEW_RENDER_CONTRACT.antiAliasing,
      mode: 'smaa' as const,
    },
  };
  const raceResults = await Promise.allSettled([
    createSculptReviewPipeline({ renderer, scene, camera, contract: raceContract }),
    createSculptReviewPipeline({ renderer, scene, camera, contract: raceContract }),
  ]);
  const raceWinners = raceResults.filter(
    (result): result is PromiseFulfilledResult<Awaited<
      ReturnType<typeof createSculptReviewPipeline>
    >> => result.status === 'fulfilled',
  );
  if (raceWinners.length !== 1) {
    throw new Error(`expected one concurrent pipeline winner, received ${raceWinners.length}`);
  }
  raceWinners[0].value.dispose();
  renderer.dispose();

  const nativeRenderer = new THREE.WebGLRenderer({ antialias: true });
  const native = await createSculptReviewPipeline({
    renderer: nativeRenderer,
    scene,
    camera,
    contract: {
      ...SCULPT_REVIEW_RENDER_CONTRACT,
      antiAliasing: {
        ...SCULPT_REVIEW_RENDER_CONTRACT.antiAliasing,
        mode: 'auto',
      },
    },
  });
  native.resize(320, 240, 1);
  native.render();
  const nativeReceipt = native.receipt();
  native.dispose();
  nativeRenderer.dispose();

  if (
    smaaReceipt.contractSha256 === SCULPT_REVIEW_RENDER_CONTRACT_SHA256
    || fxaaReceipt.contractSha256 === SCULPT_REVIEW_RENDER_CONTRACT_SHA256
  ) {
    throw new Error('custom contracts must not reuse the generated default contract hash');
  }
  if (
    smaaReceipt.contractSha256 !== expectedSmaaContractSha256
    || fxaaReceipt.contractSha256 !== expectedFxaaContractSha256
  ) {
    throw new Error('runtime contract hashes must match Python canonical evidence hashes');
  }

  document.body.dataset.status = 'pass';
  document.body.textContent = JSON.stringify({
    smaaReceipt,
    fxaaReceipt,
    nativeReceipt,
    concurrentPipelineOutcomes: raceResults.map((result) => result.status),
  });
}

run().catch((error: unknown) => {
  document.body.dataset.status = 'fail';
  document.body.textContent =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
});
