# Fabric and Cloth Patterns

Load this reference only for cloth, garments, flags, upholstery, straps,
curtains, or another flexible woven surface.

## Form routing

Separate three scales:

- macro: drape, hanging direction, inflation, folds, contact and silhouette;
- meso: seams, hems, panels, quilting, gathered regions, major wrinkles;
- micro: weave/fiber response that should normally remain in material maps.

Use geometry or displacement only for folds that alter silhouette or cast
meaningful shadows. A displacement path needs sufficient, evenly distributed
topology, valid UV/projection, and a scale bounded to the component. Never
hardcode a universal grid resolution.

Declare attachment/contact points and preserve tension direction. Garments,
straps, buttons, zippers, rigid trim, and body hosts need separate IDs when
their construction, material, attachment, or motion differs.

## Lookdev routing

Use `materialProfile: "cloth"` when appropriate. Map observed response to
`baseColor`, layered `roughness`, `sheen`, `sheenColor`, `sheenRoughness`,
`normal`, `bump`, `displacement`, `ambientOcclusion`, and local overrides.

- matte woven fabric: broad rough response with restrained sheen;
- satin/silk-like fabric: smoother directional highlights, but not generic
  mirror clearcoat;
- thick fabric: stronger meso normal/occlusion and rounded folds;
- thin fabric: thinner silhouettes and possible bounded translucency only when
  visible in the source.

Do not reuse albedo as roughness, height, normal, or AO.

## Interaction routing

Use skeletal/component deformation for bounded authored states or simulation
only when required and feasible. Test attachment stability, penetration,
clearance, and rest pose. Do not introduce cloth simulation merely because the
material is fabric.

## Visual vetoes

Reject folds unrelated to gravity/contact, cloth that floats away from its
anchors, displacement tearing or faceting, metallic-looking fabric, uniform
procedural wrinkles, or micro-weave detail used to mask an incorrect drape.
