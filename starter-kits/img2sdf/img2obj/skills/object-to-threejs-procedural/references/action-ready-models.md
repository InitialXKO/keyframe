# Action-Ready Procedural Models

Assess this reference for every object, even when the user does not mention interaction. Set `interactionContract.status` to `not-required` with a concrete reason when no motion is justified. Set it to `required` only for user-requested motion, observed joints/mechanisms, or a strong object-class prior above the activation threshold. Do not invent sockets, colliders, physics, destruction, or hidden mechanisms.

## Design Goal

The form phase should preserve independently moving parts and stable pivots without forcing an interaction pass. When interaction is required, runtime behavior targets exact component and motion-affordance ids instead of rewriting the reconstruction.

## Motion Affordance Contract

Every active affordance declares `id`, `componentId`, `behavior`, numeric `pivot`, numeric `axis`, `limits` or `rate`, `source`, normalized `confidence`, `evidenceRefs`, and `enabledByDefault`. Automatically activate only observed or strong domain-prior motion at or above `activationThreshold`; a user request may activate explicitly. Lower-confidence motion remains a bounded assumption and must not animate by default.

Typical strong priors include a helicopter main/tail rotor, fan blades, wheels, and clock hands. Doors, hatches, retractable landing gear, deformation, detachment, physics, and destruction require direct evidence or explicit user intent.

Use `patterns/procedural-motion.md` for pivot selection, implementation choice,
and transformed-state review once motion is active.

## Hierarchy Pattern

Use this structure:

- `root`: whole-object motion, visibility, global scale, runtime metadata.
- `component pivot Group`: stable transform node for each macro/meso component.
- `visual mesh`: child of the component pivot; holds geometry and material.
- `socket Object3D`: child of the relevant pivot; marks attachment, effect, grip, or joint positions.
- collider metadata/proxy: simplified runtime shape, not necessarily a visible mesh.
- destruction group metadata: semantic grouping for detach/break logic.

## Collider Rules

- Use primitive proxies first: box, sphere, capsule, cylinder.
- Use compound proxies for complex silhouettes.
- Avoid visual mesh colliders unless the user explicitly asks for high-precision collision.
- Mark triggers separately from solid colliders.
- Store collider intent even when no physics engine is installed.

## Destruction Rules

- Break along existing seams, joints, material boundaries, weak points, or branch roots.
- Use detachable component groups for large fragments.
- Use procedural small fragments only where they improve readability.
- Attach impact, spark, dust, liquid, or debris effect sockets when destruction is expected.
- Preserve material continuity on exposed fracture faces where possible.

## Acceptance Criteria

An active interaction pass succeeds when:

- Every active affordance targets an exact component ID and stable pivot node.
- Movable parts are not merged into unrelated geometry.
- Numeric pivot, axis, limits/rate, and provenance match the approved contract.
- A single 2x2 motion-state sheet exposes rest and key transformed states.
- No tested state creates implausible intersection, detachment, imbalance, or visual regression.
- Sockets, colliders, or destruction groups exist only when explicitly required.
- `root.userData.sculptRuntime` exposes maps that later code can target.
