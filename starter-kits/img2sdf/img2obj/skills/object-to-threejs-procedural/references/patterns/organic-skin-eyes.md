# Organic Skin and Eye Patterns

Load this reference only for exposed skin, flesh, eyes, mouths, noses/muzzles,
ears, or other identity-sensitive organic surfaces. For visible faces or hands,
also load `../anatomical-regions.md`.

## Form routing

- preserve continuous skin/flesh transitions on a sculpted host when the
  reference shows no real seam;
- separate eyeballs, corneal/wet layers, teeth, tongue, mouth cavity, claws,
  horns, and accessories when their boundary is visible;
- keep fleshy muzzle/nose, eyelids, brows, lips, folds, and
  surface-continuous cheek fur as host-bound relief rather than floating clumps;
- concentrate geometry where silhouette, eyelids, lips, nostrils, joints, or
  expression require it rather than applying uniform density;
- use `SkinnedMesh`/bone-ready topology only when Interaction actually requires
  deformation; static anatomy still needs semantic regions but not an invented
  rig.

Use stable component and feature IDs, bounded landmark evidence, and the current
`componentTree`, `detailPlan`, `localFeatures`, `surfaceTopologyPlan`, and
specialized-region contracts. Do not claim quad topology, skin weights, or
hidden anatomy unless they are implemented and verified.

Validate neutral form before relying on skin, fur, cloth, nail, eye, or
accessory materials.

## Lookdev routing

- skin/flesh: non-metallic, reference-driven roughness, subtle independent
  normal/roughness breakup, and local variation by region;
- wet lips/nose: use a local smoother or coated override rather than making all
  skin glossy;
- eye: keep iris/sclera geometry and the wet/corneal response logically
  separated when visible;
- SSS-like effects: prefer restrained material/lighting cues unless a real
  thickness/SSS implementation is available and tested.

`thickness` alone is not generic subsurface scattering, especially when no
transmissive or node-material path consumes it. Do not use iridescence on eyes
unless the reference visibly supports a thin-film color shift.

## Review

Review close-up and full assembly together. Reject incorrect gaze, eye spacing,
mouth opening, facial contour, disconnected organic masses, plastic-looking
skin, uniform wetness, or materials used to conceal wrong anatomy.
