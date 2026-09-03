# Hard-Surface and Machinery Patterns

Load this reference only for rigid manufactured components: housings, panels,
frames, fasteners, shafts, rotors, engines, tools, vehicles, or machinery.

## Form routing

- start from the observed mass and panel silhouette, not a generic low-poly box;
- model bevels/chamfers as geometry where edge highlights define the form;
- use CSG only for an actual visible cutout that cannot be represented more
  cleanly with authored topology;
- separate moving, independently shaped, differently attached, or differently
  materialed parts into stable component IDs;
- use named embedded features for grooves, seams, vents, recesses, and panel
  breaks that remain continuous with one host;
- declare fasteners or repeated apertures in `repetitionSystems` only when their
  spacing and host relationship are observable.

Map the result into `componentTree`, `surfaceTopologyPlan`,
`detailDecompositionContract`, `repetitionSystems`, and exact
`attachment.contactType`, `embedDepth|overlap`, and `gapTolerance` values (or
the equivalent repetition attachment relationship). Fixed bevel sizes, radial
segments, polygon counts, and draw-call targets are not universal defaults.

## Lookdev routing

- bare brushed metal: metallic response plus directionally aligned anisotropy;
- painted or coated metal: the visible paint is normally dielectric
  (`metalness` near zero) with optional clearcoat; expose metallic response only
  where bare substrate is visible;
- rust/oxide: normally dielectric and rough; blend it through observed masks or
  executable `rust`, `oxide`, or `patina` local overrides instead of assigning
  a generic partly metallic rust material;
- rubber/plastic: non-metallic with reference-driven roughness and microrelief;
- glass/display covers: route additionally to `transmissive-surfaces.md`.

Use `materialProfile`, `baseColor`, layered `roughness`, `metalness`,
`anisotropy`, `anisotropyRotation`, `clearcoat`, `clearcoatRoughness`,
`normal`, `wear`, `dirt`, and `localOverrides`. Environment lighting is strongly
recommended for reflective materials but cannot compensate for wrong geometry.
Use `../material-lighting-realism.md` for the shared environment helper and
texture-projection contract.
Use anisotropy only when the active generator/material profile actually consumes
it; otherwise encode the observed brushing through directional roughness/normal
fields rather than inventing an unsupported shader path.

## Interaction routing

For rotors, hinges, sliders, wheels, levers, or telescoping parts, route to
`procedural-motion.md`. Each moving part remains a separate semantic component
with a numeric pivot and axis.

## Visual vetoes

Reject razor-sharp manufactured edges that should catch highlights, floating or
interpenetrating attachments, arbitrary greebles, wrong panel scale, metal that
reads as gray plastic, coating that makes the substrate incorrectly metallic,
or repeated details used to distract from a poor primary form.
