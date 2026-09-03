# Hair, Fur, and Fiber Patterns

Load this reference only when visible strands, fur, hair cards, bristles,
feathers, fibers, or fuzzy edge breakup materially affect identity.

## Form routing

Choose the cheapest representation that preserves the observed result:

- groom mass: primary volume first, then flow-defining clumps;
- cards/strips: visible directional locks or tufts;
- shells: short dense fur only when layered silhouettes and sorting are proven;
- instanced fibers/bristles: repeated short elements with an observable host and
  distribution;
- geometry strands: only identity-critical isolated strands.

Declare host, root/contact relationship, direction/flow, length range, density
variation, clump hierarchy, silhouette role, and occlusion risk through existing
components/features/repetition fields. Do not replace a missing skull/body form
with floating hair or fur.

## Lookdev routing

Use `materialProfile: "fiber"` for the current generator path when appropriate.
Drive anisotropy direction from the observed fiber flow, use independent
roughness/normal fields, and choose alpha hash/cutout or transparency only after
checking edge quality and sorting. `sheen` may support a soft fiber response but
is not a substitute for direction and silhouette.

Avoid universal shell counts, card counts, opacity ramps, and fur lengths.
These depend on scale, camera distance, object identity, and the reference.

## Interaction routing

Only add secondary motion when it is visible or strongly implied. Preserve
roots, weight motion toward tips, and test neutral plus extreme states. Dense
shader motion requires compile/runtime evidence; rigid cards or clumps may use
component/bone transforms.

## Visual vetoes

Reject transparent halos, sorting bands, detached roots, evenly stamped cards,
fur shells that visibly resemble nested plastic layers, incorrect flow,
over-bright sheen, or fiber detail that damages the underlying silhouette.
