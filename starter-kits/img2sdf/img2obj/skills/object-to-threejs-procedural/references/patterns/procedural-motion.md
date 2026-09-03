# Procedural Motion Patterns

Load this reference only in Interaction, or earlier as planning-veto evidence,
when an observed component or high-confidence object-class prior implies
rotation, hinge motion, sliding, telescoping, sway, or secondary deformation.

## Routing

- rotor, wheel, fan, dial: continuous or bounded rotation around an exact pivot;
- door, lever, jaw, flap: hinge with an observed axis and limits;
- piston, drawer, slider: translation along a constrained axis;
- plant, hair, fur, fabric: rooted weighted deformation only when visible or
  strongly implied;
- character/animal joint: articulated part or skeleton only when the required
  geometry and weights actually exist.

Every active motion maps to `interactionContract.motionAffordances` with exact
component ID, behavior, pivot, normalized axis, rate or limits, source,
confidence, evidence refs, and tested neutral/extreme states. Keep the moving
component semantic and independently addressable.

### Pivot selection

- use a center pivot only when the part rotates around its center of mass;
- use a base pivot for a rooted upright part such as a tree, sign, bottle, pole,
  or leg;
- use a hinge pivot for a lid, door, handle, flap, jaw, lever, or wing;
- use a branch/root pivot for an organic appendage that bends from one end;
- use a custom pivot only when evidence supports a mechanical joint or socket.

### Articulated digits

Do not split a static hand merely to satisfy landmark semantics. When
Interaction requires articulated digits, map each `digitChains[].componentRefs`
entry to one unique geometry part and keep its count equal to `segmentCount`.
Give every segment a non-static `actionProfile.animationRole`, enabled rotation,
and a finite joint-local pivot and non-zero axis. Preserve the observed joint
arc, taper, curl, and grip clearance across rest, mid, and extreme states.

## Implementation choice

Prefer:

1. object/component transform for rigid single-part motion;
2. hierarchy/bone deformation for articulated assemblies;
3. instance attributes for many repeated rigid elements;
4. verified TSL/node or renderer-compatible shader deformation only for dense
   continuous/repeated motion that cannot be represented efficiently otherwise.

Raw `onBeforeCompile` snippets are not JSON data and are not copied blindly.
They require the installed Three.js version, renderer, shader chunks,
`customProgramCacheKey`, uniform lifecycle, compile result, and runtime receipt
to be verified. Vertex deformation must happen before projection.

## Review

Test rest, representative mid, and extreme states. Reject incorrect pivots,
detached children, penetration, broken clearances, motion that changes component
identity, unrooted sway, or animation polish used to excuse a poor static form.
