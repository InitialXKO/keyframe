# Vegetation Component Patterns

Load this reference only when the observed object contains trunks, branches,
stems, leaves, grass blades, or another botanical component. It is advisory
knowledge for the current schema, not a new category or JSON wrapper.

## Form routing

Choose per component:

- trunk or woody branch: tapered sweep/cylinder chain with explicit parent,
  attachment, taper, curvature, and branching evidence;
- soft stem: a bendable sweep with enough longitudinal control points for the
  observed curvature;
- broad leaf: a thin authored surface when its contour matters, or a masked card
  when the reference supports that approximation;
- grass or dense small leaves: one authored blade/leaf plus a declared
  `repetitionSystems` layout when repetition is genuinely visible;
- dense canopy: several bounded foliage masses before any leaf-level repetition.

Map decisions into existing fields such as `componentTree[].primitive`,
`dimensions`, `transform`, `attachment`, `geometryDescriptor`, `detailPlan`,
`localFeatures`, `surfaceTopologyPlan`, and `repetitionSystems`. Use stable
construction names such as `trunk-primary-taper`, `branch-upper-left`, or
`leaf-cluster-crown`; never use one anonymous `plant` mesh for a complex plant.

Do not copy fixed segment or instance counts from examples. Select only the
geometry density needed for the visible silhouette, curvature, and motion.
Instancing is an implementation option, not visual-quality evidence.

When a whole static tree needs an automatic first Form construction, route to
`procedural-tree-generation.md`. Keep using this file for per-component choices
and for any plant whose hierarchy has already been authored.

## Lookdev routing

- bark: high roughness with independent meso relief and fine normal breakup;
- leaf: non-metallic, two-sided only when both faces are visible, with separate
  front/back response when the reference requires it;
- stem: non-metallic and usually smoother than bark;
- cutout cards: prefer a tested cutoff/alpha-hash strategy over broad
  transparency when edge sorting becomes visible.

Map these to the current material contract: `materialProfile`, `baseColor`,
layered `roughness`, `metalness`, `normal`, `bump`, `displacement`,
`ambientOcclusion`, `textureProjection`, and `localOverrides`. Treat
transmission/thickness as a bounded optical choice, not generic fake SSS.

## Interaction routing

When the reference or object class strongly implies sway, route implementation
and shader safety to `procedural-motion.md`, then:

- target exact stem/branch/leaf component IDs;
- preserve the rooted base and weight displacement toward tips;
- declare wind axis/direction, rate, amplitude range, and neutral/extreme states
  in `interactionContract.motionAffordances`;
- use object/bone transforms for small assemblies and a verified shader/TSL
  implementation only for genuinely dense repeated vegetation.

## Visual vetoes

Reject when roots float, branches attach implausibly, repetition looks stamped,
leaf cards expose rectangular silhouettes, sway detaches joints, or material
effects hide an incorrect plant silhouette.
