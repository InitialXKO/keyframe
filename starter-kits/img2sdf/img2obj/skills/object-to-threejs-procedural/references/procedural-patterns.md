# Procedural Three.js Object Patterns

Use this reference only when implementing a model. It maps observed form to
executable geometry; it does not expand the generator's capability registry.

## Contents

- Capability boundary and geometry choices
- Representation coverage
- Important composite cases
- Semantic naming and kernel descriptors
- Surface topology and detail decomposition
- Verification cues

## Capability Boundary

Before authoring, classify each route:

- `registered`: the exact primitive has a validator and TypeScript emitter in
  `GEOMETRY_REGISTRY`.
- `composed`: the form can be built honestly from registered primitives,
  assemblies, repetition systems, and supported modifiers.
- `capability-gap`: the target needs a representation or behavior that has no
  registered implementation.

Never disguise a gap as a primitive, card, material, or prose-only plan.
Registered geometry proves bounded static emission only; route motion to
Interaction and surface response to Lookdev.

## Geometry Choices

Choose per semantic component, not once for the whole object. Use assemblies
for compound targets and describe each repeated system once. All names in the
second column are registered primitive IDs.

| Construction | Registered primitive | Best use | Boundary |
| --- | --- | --- | --- |
| primitive solids | `box`, `sphere`, `ellipsoid`, `cylinder`, `cone`, `capsule`, `torus` | machinery, furniture, fruit, joints, stones, pipes, limbs, handles, rings, tires | compose non-primitive forms; rounded edge treatment emits directly only for `box` |
| fixed plane | `plane-card` | thin leaves, feathers, labels, decals, cloth strips | not a camera-facing sprite or true shell |
| profile solid | `extrude` | plates, blades, keys, logos, planar cutouts | supports 2D holes/bevels, not arbitrary 3D CSG |
| axial profile | `lathe` | bottles, bowls, vases, lamps, wheels | rotational form only |
| circular sweep | `tube` | cables, hoses, roots, straps, veins | circular cross-section |
| profiled sweep | `curve-sweep` | rails, seals, ribbons, gutters, non-circular cables | explicit 2D profile/path; self-intersection remains a risk |
| sectional body | `section-loft` | torsos, heads, hulls, trunks, tapered shells | ordered elliptical sections, not arbitrary patches |
| fitted layer | `conforming-shell` | static clothing, armor skins, bark, covers | requires an undeformed `section-loft` host |
| branching graph | `branch-network` | trees, roots, antlers, horns, coral | branch tubes/junctions overlap rather than fuse |
| controlled sheet | `deformable-surface` | bounded terrain, static drapes, flags, membranes, fabric panels | no arbitrary closed solid or live simulation |
| guided fibers | `fiber-system` | bounded hair/fur accents, bristles, feathers, grass | ribbon cards, not dense grooming |
| implicit blend | `implicit-surface` | foam, wax, blobs, stylized liquid, soft subtraction | bounded field, not a general boolean engine |
| semantic field sculpt | `sculpted-surface` | welded anatomy, creature masses, rocks, trunks, relief/recess | one closed connected manifold surface |
| repeated geometry | `instanced-cluster` | bolts, tiles, leaves, scales, pebbles, coarse voxels | one instancable source within registry limits |
| host-bound scatter | `surface-scatter` | deterministic leaves, scales, spikes, tufts | currently requires a `section-loft` host |
| volume approximation | `volume-field` | cloud, smoke, mist, dust, fire, aura | crossed cards, not true volumetrics |

Use `geometryDescriptor.deformationStack` for bounded
`bend|taper|bulge|twist|noise`, except on a loft host linked to a shell or
surface scatter.

Keep paths, profiles, and contours component-local; never expand one bounded
repetition system into thousands of component records.

## Representation Coverage

This matrix makes the soft object classification comprehensive without
pretending that every representation is executable.

| `representationKind` | Registered or composed route | Use `capability-gap` when |
| --- | --- | --- |
| solid mesh | primitive solids, `extrude`, `lathe`, sweeps, lofts, implicit surfaces, or assemblies | exact imported mesh recovery, manufacturing topology, production retopology, or unrestricted CSG is required |
| surface shell or height field | `conforming-shell` and `deformable-surface`; use the bounded landform compiler or compose sculpted, lofted, or extruded masses | true hydraulic erosion, caves/overhangs, GIS-scale terrain, chunking, collision LOD, or streaming is required |
| curve or strand network | `tube`, `curve-sweep`, `branch-network`, `fiber-system` | dense groom curves, cyclic graph topology, automatic attachment, or dynamic strand simulation is required |
| point cloud or particle field | `instanced-cluster` for visible discrete particles; `volume-field` for a static cloudy approximation | raw point-cloud ingestion, point rendering, dynamic particles, flocking, or fluid flow is required |
| sprite or billboard | `plane-card` for a fixed card | camera-facing sprites, axial billboards, impostor atlases, or view-dependent replacement are required |
| voxel grid | a bounded coarse set of instanced `box` cells | dense voxel storage, voxel meshing, editable destruction, sparse-octree streaming, or more than registry limits is required |
| implicit surface | `implicit-surface` or `sculpted-surface`; use assemblies for intentionally separate parts | unrestricted booleans, guaranteed production CSG/manifold semantics, identity-critical sealed internals, or high-resolution production meshing is required |
| volume field | `volume-field` crossed-card approximation | true density sampling, raymarching, dynamic volumetric evolution, scattering, or simulation is required |
| hybrid | an `assembly` whose children independently choose any registered route above | one unsupported subsystem is identity-critical; the supported children do not erase that gap |

Route `structureKind` without redefining its pre-assessment taxonomy: use one
host for `single body` or `deformable continuum`; assemblies for
`compound or nested assembly`, `modular assembly`, `enclosure with internals`,
or `articulated hierarchy`; instances/scatter/fibers/volume for `repeated array`
or `distributed system`; `branch-network` only for a rooted acyclic
`branching network`; sweeps/instances for `lattice or graph` and
`segmented chain`; conforming or explicit nested parts for `layered shell`.

## Important Composite Cases

- **Terrain/environment:** use `procedural-landform-generation.md` for an
  automatic first bounded terrain/boulder/cliff Form, or compose sculpted,
  lofted, and extruded masses directly. Split vegetation, props, water, and
  atmosphere. True terrain systems remain a capability gap.
- **Vegetation:** combine branches/sweeps or a fused sculpted mass with
  scatter, instances, cards, or fibers for foliage.
- **Characters:** use a lofted or sculpted host plus real separate boundaries,
  shells, and fibers. Use `anatomical-regions.md` only for anatomical faces and
  hands; masks, screens, and carvings are generic identity-critical features.
- **Openings/internals:** use `extrude.holes`, `conforming-shell.openings`,
  surrounding geometry, bounded implicit subtraction, or explicit child
  assemblies. Never fake visible depth with a dark patch; robust editable CSG
  remains a gap.

## Semantic Component Naming

Every component `id` and `name` must identify the observed construction part or assembly it represents. Use semantic kebab-case IDs shaped like `<system>-<structural-part>[-<side|index|function>]`, for example `fuselage-cockpit-shell`, `main-rotor-blade-01`, `left-landing-gear-strut`, or `rocket-pod-tube-bank`. The one parentless global root may keep the conventional id `root`.

Reject names made only from implementation words, generic nouns, position qualifiers, or indices: `part-01`, `mesh-a`, `component-2`, `main-body`, `object`, and `group` do not explain what must be constructed. Side or index suffixes are valid only after a structural noun. Do not encode primitive, color, or material as a substitute for identity: `black-cylinder-3` is weaker than `tail-rotor-drive-shaft`; geometry and appearance belong in their dedicated fields.

Names must follow the reference and topology plan. A precise-sounding invented name is still invalid when the evidence does not support that construction. Use a bounded assumption or risk when the exact hidden structure is unknown.

Declare the special representation explicitly and keep it within validator caps. These patterns do not provide simulation, dense strand grooming, automatic fur attachment, exact lace topology, caustics, or raymarched volumetrics.

For a fitted shell or surface scatter, the referenced `section-loft` is the final rest surface: make the linked component its child, keep the linked transform identity, and encode the host shape directly in `sections`. The validator rejects post-loft host modifiers because they would detach clothing, leaves, scales, or fur from the rendered body. Use shell `folds` for fitted surface variation.

## Registered Kernel Descriptors

Use validator-owned schemas:

- `section-loft`: `representation: elliptical-sections`, ordered
  `sections[{position,radii,twist}]`, `radialSegments`, `segmentsPerSpan`, and
  cap flags.
- `conforming-shell`: `representation: loft-shell`, `bodyRef`, positive
  `thickness`, non-negative `clearance`,
  `coverage{vRange,angleStart,angleLength}`, plus optional `openings` and
  directional `folds`.
- `branch-network`: `representation: branch-graph`,
  `nodes[{id,position,radius}]`, one rooted connected acyclic graph with
  single-parent `edges[{from,to,controlPoints}]`, segment counts, and `capEnds`.
  It overlaps branch tubes/junctions rather than fusing.
- `deformable-surface`: bounded `grid`, rectangular `controlGrid`, segment
  counts, and directional folds.
- `fiber-system`: guided `ribbon-cards` with strand/sample counts, root/tip
  widths, spread/clump/curl, card planes, and seeded variation.
- `implicit-surface`: `representation: metaballs`, closed `bounds`, bounded
  `resolution`, positive `isoLevel`, UV projection, and additive/subtractive
  sphere, ellipsoid, or capsule sources.
- `sculpted-surface`: `representation: field-sculpt`, closed `bounds`, bounded
  `resolution`, positive `isoLevel`, `connectivity: single-surface`, primitive
  sources, and `inflate`, `pinch`, `ridge`, or `crease` modifiers with
  resolvable radii/falloff.
- `surface-scatter`: `representation: loft-surface`, `surfaceRef`, registered
  `basePrimitive`/`baseParameters`, count/seed, host ranges/masks,
  scale/spin/offset, and alignment.
- `instanced-cluster`: one registered base plus an `explicit`, `grid`,
  `radial`, `along-path`, or deterministic `scatter` layout.
- `volume-field`: `representation: crossed-cards`, bounded sources,
  particle/card counts, card size, and seed.
- `geometryDescriptor.deformationStack`: ordered
  `{type,axis,amount,start,end,power}`; bend adds direction and noise adds
  frequency/seed.

Respect validator budgets; consolidate overlapping field terms instead of
raising term count and resolution together. `sculpted-surface` rejects
disconnected, open, non-manifold, enclosed-void, and sub-grid feature results.

## Surface Topology Decision

Complete the applicable `surfaceTopologyPlan` at Form before detailed geometry
or visual modules:

- `continuous-sculpt`: uninterrupted soft/organic/rock/tree mass or
  deformable sheet; one connected host.
- `assembled-solid`: real seam, accessory, socket, plate, tooth, eye, lens, or articulated part.
- `conforming-shell`: a separate fitted layer that follows a host surface.
- `surface-relief`: a silhouette ridge, cheek tuft, scar, fold, or raised form embedded in the host—not a floating mesh.
- `fiber-strand`: real hair, whisker, grass, or thread bound to a host.
- `material-only`: color/roughness/normal detail too small to change silhouette.

`representationKind` classifies the medium; `surfaceTopologyPlan` classifies
how an important visible surface or feature relates to its host. Point,
particle, voxel, instance, and volume systems remain in the object-class,
component, and repetition contracts unless they also require one of the
surface relationships above. Do not invent a new topology strategy to replace
an unsupported representation.

One semantic module may contain several strategies, and several landmark regions may reference the same host component. Do not use component count as a proxy for descriptive completeness.

## Detail Decomposition Contract

Every geometry-bearing component owns a `detailPlan`. This is a visual inventory, not a mesh-count quota. A continuous shell may stay one component while its windows, frames, panel breaks, recesses, fasteners, vents, and color-only markings remain independently named and reviewable.

- `simple + atomic`: allowed only with a concrete `atomicityReason` and no children/features.
- `children`: every observed sub-part is a real direct child and `childComponentIds` exactly matches the hierarchy.
- `features`: the host remains continuous, but every important sub-detail maps to executable local feature, topology, repetition, material, or numeric geometry data.
- `hybrid`: combines real child parts with host-bound features.
- `compound` or `complex`: `atomic` is invalid.

Each feature records exact host-local position, rotation, and 3D size, plus evidence, confidence, material references, and acceptance criteria. Its realization target must already exist and be supported. Host geometry records such as sculpt sources, ridges, creases, and deformations use `geometry-feature`; a `topology-group` realization also needs an exact geometry `implementationId`, because topology metadata alone does not build detail. A prose-only detail, unknown id, material pretending to change geometry, or missing complex decomposition is a validation error. Reviewer correction plans may target these records as `detail-feature` IDs.

Faces and hands use named assemblies and registered geometry rather than a
generic one-click primitive. Route their landmark, articulation, contact, and
evidence requirements through `anatomical-regions.md`; this file owns only the
chosen geometry realization.

Material contracts, surface-frequency bands, PBR extraction, and lookdev acceptance live only in `material-lighting-realism.md`.

## Local Feature Types

Use `component.localFeatures` for details that matter to recognizability:

- raised ridge
- recessed groove
- seam line
- screw or rivet
- chip or dent
- scratch cluster
- stain or dirt patch
- decal or label area
- hole or socket
- bevel highlight
- fabric stitch
- leaf vein or serrated edge

Each emitted local feature should also have a corresponding `detailPlan.features[]` record with numeric host-local placement/size, geometry effect, evidence, confidence, acceptance criteria, and `realization.mode: local-feature` pointing to its exact id.

The generator can directly emit raised path details (`seam`, `seam-line`, `raised-ridge`, `fabric-stitch`), point details (`button`, `rivet`, `screw`), and planar `decal` details. Recessed grooves, holes, dents, and silhouette-changing features still need explicit components, extrude holes, implicit subtraction, or displacement-capable topology.

## Verification Cues

A procedural object is usually failing when:

- silhouette reads wrong even before material
- an unsupported representation was silently replaced by a primitive, card, or material
- a whole environment was treated as one undifferentiated object or terrain mass
- a visible opening or internal structure was faked with a dark flat patch
- every edge is perfectly sharp or perfectly smooth
- material has one flat color and no roughness variation
- lighting hides the form instead of explaining it
- repeated details are too evenly spaced
- close-up details add triangles but not recognizability
