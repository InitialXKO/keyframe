# Pre-Spec Assessment And Quality Contract

Use this reference while filling the integrated `preSpecAssessment` created by `sculpt init`. It is part of the same `ObjectSculptSpec`, not a separate required file.

## Reference preparation evidence

Apply the parent `SKILL.md` preparation policy; record only the assessment evidence here. Judge subject/background separation independently from whether source detail and quality are practical to reconstruct. In `referencePreparation`, state the observed basis for `subjectBackgroundSeparation`. For a generated target, ensure `outputImage` equals `sourceImage`, `outputBackground=solid-white`, `whiteBackgroundValidated` and `subjectContrastValidated` are true, and `modificationPolicy.mode` distinguishes `cleanup-only` from `bounded-simplification`.

Name every intentional simplification in `modificationPolicy.declaredChanges`; keep identity, primary silhouette/proportions, major component layout, signature features, dominant material/color zones, pose, and viewpoint in `protectedTraits`. `sourceImage` remains the sole reconstruction and acceptance reference. `unassessed` preparation, failed background or contrast validation, or undeclared simplification blocks strict quality. Do not use fixed domain profiles; assess observed traits, complexity, and target fidelity.

## Soft Object Classification

Fill every `preSpecAssessment.objectClass` axis. The values below are broad, composable anchors rather than closed enums; use only observed or bounded-inferred descriptors, and use a precise custom value when none fits.

- `primaryType`: a concise noun phrase for what the object is, separate from style, structure, or material
- `representationKind`: solid mesh, surface shell or height field, curve or strand network, point cloud or particle field, sprite or billboard, voxel grid, implicit surface, or volume field; list every applicable kind for a hybrid
- `formLanguage`: organic, geometric, hard-surface, manufactured, mechanical, architectural, botanical, anatomical or creature-like, character-like, sculptural, amorphous, crystalline or faceted, draped or folded, terrain or landform, ornamental, typographic, or symbolic
- `structureKind`: single body, compound or nested assembly, modular assembly, repeated array, branching network, lattice or graph, segmented chain, layered shell, enclosure with internals, articulated hierarchy, deformable continuum, or distributed system
- `motionPotential`: static, whole-object transform, rigid-body, constrained or articulated, skeletal, bend or twist, cloth or soft-body, morphing, detachable or reconfigurable, destructible, particle or fluid flow, volumetric evolution, effect-emitter, or procedural growth or assembly
- `materialFamilies`: metal, mineral/stone/concrete, ceramic/glass, polymer/plastic/rubber, wood/paper, textile/leather, biological tissue, plant matter, hair/fur/fiber, soil/sand, liquid/gel, ice/wax, coating/paint, emissive/energy, volumetric medium, or composite/mixed
- `notes`: optional cross-axis ambiguity or evidence limitation; move actionable uncertainty into structured `assumptions[]` or `risks[]`

`motionPotential` is a pre-spec hypothesis, not authorization to require Interaction or invent hidden mechanisms. Representation kinds classify visible construction without promising unsupported simulation. Material families identify only a broad substance or rendering-medium class; record rigidity, finish, microrelief, and PBR behavior under `material-lighting-realism.md`.

## Visual Style Classification

Assess all nine `preSpecAssessment.visualStyle.axes` before Blockout: realism,
form, proportion, detail, shading, surface, edge, palette, and medium emulation.
The axes are authoritative and composable; `derivation.family` and familiar
labels such as Low Poly, Cel-Shading, Hand-Painted 3D, or Voxel Art are
system-derived summaries. Synchronization also derives `overallStyleProfile`
to combine them into one label, source-grounded signature traits, and
phase-specific reconstruction guidance. Use `other` only with a custom label
and operational definition; use `unassessed` while evidence is incomplete.

Every assessed axis needs confidence, exact `viewEvidence[].id` references, and
observed cues. Style describes treatment, not object type, construction
complexity, concrete PBR values, or camera/presentation. It never overrides
`sourceImage`. Read `visual-style-classification.md` for the complete controlled
vocabulary, derivation rules, and phase projection contract.

## Identity-Critical Region Screening

Screen every target—not only characters—for local regions or semantic systems whose failure would make the object unrecognizable even when its whole-object silhouette or average review score looks acceptable. Rank observed candidates in `visualIdentitySpec.salienceGraph` by identity impact at the target display size, not by geometric complexity. Replace generic starter `featureReviewTargets` with the decision-critical object-specific systems; require dedicated `reviewViewIds` only when full-object evidence cannot judge one reliably. Route matched components through `capabilityPlan`, and record a `capability-gap` instead of inventing unsupported handling.

Examples include a vehicle grille or lamp cluster, a machine tool head or control panel, an enclosure opening or visible internal mechanism, a product lens or logo, a branching hub, and a character face or hand. These examples are not a closed taxonomy: use the observed source to decide what carries identity.

### Face And Hand Exception

Faces and hands are one stricter exception, not the only regions screened. Each visible face or hand remains an independent critical target because proportion, gaze, expression, digit, or contact errors cannot be averaged away by the rest of the object. During assessment, identify visibility, confidence, occlusion, evidence needs, constraints, dedicated crop needs, and bounded unknowns. Set `preSpecAssessment.specializedRegions.status=none` as soon as absence is established, with a reason. When a visible region needs Form-owned component mappings, keep it `unassessed` only through Blockout, record the pending contract in its notes or a bounded risk, then complete one `declared` contract per region at the start of Form.

The Form contract completes geometry-bound assembly and landmark mappings plus the relevant `surfaceTopologyPlan` before generating Form geometry or visual modules; do not pre-author detailed topology during Blockout. Landmark names do not require separate meshes, and multiple landmarks may share one continuous host when the evidence supports it. Never infer hidden digits or facial forms as facts. See `anatomical-regions.md` for the supported landmark, articulation, contact, and evidence contract.

## Complexity Scoring

`preSpecAssessment.complexity` is a stateful contract. A newly initialized spec starts as `status: unassessed` with `tier: unassessed` and all score values `null`. `--complexity` provides an `initialTierHint` for temporary scaffolding; Blockout generation is blocked until assessment is complete (`status: assessed`). Complexity scores measure construction difficulty. Top-level `globalSpec.scores.*` measure suitability evidence strength instead; higher is generally stronger evidence except for `occlusion_risk`, and none of these values is a fidelity review score.

When `status: assessed`, all 8 core axes and 2 modifier axes must be scored as ordinal integers `0–3`:

### Core Complexity Axes (0 → 3)

| Axis | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `silhouetteComplexity` | primitive or convex outline | a few controlled cuts or negative spaces | several concavities and secondary contours | dense, branched, organic, or heavily interrupted contour |
| `formTopologyComplexity` | flat or primitive surface | simple continuous curvature or bevels | several curvature transitions or junctions | continuous sculpting or topology is identity-critical |
| `componentCount` | 1 construction unit | 2–5 units | 6–17 units | 18+ units |
| `hierarchyDepth` | 1 structural level | 2 levels | 3 levels | 4+ levels |
| `repetitionDensity` | none | one small regular pattern | multiple patterns or meaningful variation | multi-tier procedural distribution defines the form |
| `materialLayerCount` | one uniform material | 2–3 materials | 4–6 materials or masked zones | nested layered PBR response defines identity |
| `localDetailDensity` | smooth or intentionally plain | sparse discrete features | several meso/micro feature groups | dense multi-tier detail covers most surfaces |
| `representationComplexity` | standard solid mesh | compound meshes or simple curves | one specialized instancing, shell, fiber, implicit, or volume subsystem | multiple interacting specialized systems |

### Modifier Axes (0 → 3)
Modifiers retain the `0–3` ordinal scale but do not add to the base complexity tier:

| Modifier | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `occlusionRisk` | all identity-critical structure is visible | minor hidden geometry is safely inferable | several important parts or contacts are ambiguous | core or internal structure is substantially hidden |
| `actionReadinessNeed` | static object | whole-object transforms or one simple affordance | several joints, sockets, colliders, or simulation constraints | deep articulation, destruction, or interacting simulation systems |

If `occlusionRisk > 0`, the 2x2 turnaround cannot be skipped; if it is `3`, suitability cannot be `pass`. `actionReadinessNeed=2` sets minimum required depth to `moderate`; `3` sets it to `complex` and requires `needsActionReadyHierarchy=true`.

### Tier Derivation Rules
Base tier is calculated deterministically from core axis scores based on count of high-complexity axes (`high`: score ≥ 2) and extreme-complexity axes (`extreme`: score = 3):
- `ultra`: `extreme ≥ 3` OR (`extreme ≥ 2` AND `high ≥ 5`) OR `high ≥ 7`
- `complex`: `extreme ≥ 1` OR `high ≥ 3`
- `moderate`: `high ≥ 1` OR `core score sum ≥ 4`
- `simple`: all remaining cases

`tier` always equals `baseTier`. `specDepthDecision.requiredDepth` may be higher if promoted by `actionReadinessNeed`.

## Bounded Uncertainty

`preSpecAssessment.unknownsToResolveBeforeImplementation` is a temporary planning queue, not an implementation input. Before building geometry, resolve every entry or move it into exactly one structured record:

- `assumptions[]`: `id`, `statement`, `scope`, `bounds`, `impactIfWrong`, and a concrete `falsifyingCheck`.
- `risks[]`: `id`, `statement`, `scope`, `impact`, and `mitigation`; add `evidenceRefs` when available.

Do not leave uncertainty as a plain sentence. An assumption must state where it applies and what would prove it wrong. A known risk must state its impact and the mitigation used while evidence is missing. `--strict-quality` blocks unresolved unknowns and unbounded legacy strings.

## Quality Contract

Treat `qualityContract` as the Blockout-owned acceptance floor between assessment and implementation, not as a second description of quality. Keep only:

- `minimumSpecDepth.macroComponents`, `mesoComponents`, `microFeatureGroups`, `materials`, and `repetitionSystems`
- non-empty `requiredReviewViewIds` that resolve to exact `viewEvidence[].id` values

The derived complexity depth supplies non-lowerable floors; assessment may raise them but synchronization never lowers an explicit stronger requirement. `repetitionSystems` must be at least `1` when `needsRepetitionSystems=true`. `materials` counts material definitions—do not call this value material layers. Describe masked zones, stacked responses, and local overrides in the material/component contracts that implement them.

Use `featureReviewTargets` as the sole source for object-specific visible obligations. Every critical or `mustPass` target for the active pass needs non-empty `componentRefs`, `evidenceRefs`, and source-specific `criteria`; replace each untouched starter criterion before Blockout approval. Use dedicated `reviewViewIds` only when full-object evidence cannot judge the target reliably.

The fixed definition of done is operational: all active-pass depth floors are met, every required review-view ID exists, every applicable critical or `mustPass` feature target passes, and no blocking phase validation remains. Pass rubrics and `qualityTargets` own visual deltas and failure rules; do not duplicate them inside `qualityContract`.

Resolve `viewHypothesisPolicy` independently as required by `SKILL.md`: record `layoutId` and `layoutMode`, keep `allowedUse=planning-veto` and `acceptanceAuthority=false`, and when skipped require `skipAssessment.objectIsSimple=true`, bilateral/radial/axial symmetry, confidence `>=0.8`, `evidenceRefs`, and a reason.

## Strict Quality Gate

Validate the current pass before generation:

```bash
python3 <plugin-root>/scripts/sculpt.py validate spec.json --for-pass <current-pass> --strict-quality
```

If strict validation fails:

- refine `preSpecAssessment` if complexity was underestimated
- raise `qualityContract` floors or add exact review-view evidence when the assessment requires more proof
- replace generic `featureReviewTargets` and add missing components, materials, repetition systems, evidence refs, or local features
- do not lower a derived floor; represent an explicitly accepted simplification in the source/reference preparation contract

The gate should block code generation when the spec could describe many different objects instead of the provided reference.

## Suitability Decision

Use `pass` when one target occupies enough of the frame, its silhouette and major materials are readable, and hidden geometry can be bounded honestly.

Use `conditional` when the macro form is clear but one view, partial occlusion, organic simplification, static cloth/fiber/glass/liquid/volume approximations, or missing close-ups limit fidelity. Record the limitation and the evidence needed to remove it.

Use `reject` when the target is ambiguous, badly cropped/blurred/hidden, an identity-critical region cannot be bounded, or the request requires exact mesh extraction, manufacturing dimensions, strand grooming, physical simulation, exact caustics, or dynamic volumetrics that this procedural workflow does not provide.

Request front/side/back views, higher resolution, neutral framing, or material/face/hand close-ups only when that evidence can change the decision. For complex targets, require macro/meso/micro structure, every distinct material layer, local overrides, confidence, and source evidence; otherwise keep suitability `conditional` and list the missing proof.
