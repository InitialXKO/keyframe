# Face And Hand Region Contract

Use this strict extension of `pre-spec-assessment.md` only for a visible anatomical face or hand. Masks, screens, carvings, and other identity-critical features use the general contract. This adds no build pass and claims neither medical anatomy nor automatic rigging.

During assessment, establish visibility, confidence, occlusion, evidence needs, constraints, and bounded unknowns. At the start of Form, complete the geometry-bound assembly, landmark mappings, feature target, and applicable `surfaceTopologyPlan` before detailed region geometry. Blockout includes visible identity-defining macro masses without speculating about detailed topology.

## Declare The Region

Set `preSpecAssessment.specializedRegions.status` to:

- `declared` when at least one face or hand is visible and its full contract is complete at the start of Form;
- `none` only after inspection, with a concrete reason in `notes`;
- `unassessed` only through Blockout while Form-owned mappings are unavailable; record the pending contract in notes or a bounded risk.

Each declared region needs:

- a unique `id`, `kind`, `name`, `representation`, `visibility`, `confidence`, and `occlusionHandling`;
- one `assemblyRef` containing its `componentRefs`;
- source `evidenceRefs` and dedicated close-up `reviewViewIds`;
- visible landmarks mapped to geometry parts inside the assembly, with explicit proportion plus expression, pose, or contact constraints;
- one independent critical, `mustPass` `featureTargetId`.

If a region is partial or occluded, record the unknowns. Use `request-input` or `omit-hidden-detail` when the hidden structure cannot be bounded honestly. Do not invent hidden fingers or facial forms.

## Face Contract

A clear face must cover at least these landmark roles:

- `face-contour`: forehead/head mass, cheeks, jaw, or muzzle silhouette;
- `eye-system`: eye shape, spacing, vertical placement, pupils/gaze, and eyelid exposure;
- `nose-muzzle`: nose bridge or muzzle mass and its relation to the eyes and mouth;
- `mouth-expression`: mouth corners, lip/opening shape, teeth/tongue when visible, and expression.

Add `brow-expression`, `jaw-cheeks`, and `ears` when they carry identity. Give each landmark concrete criteria and executable geometry; several may share one continuous host. Preserve observed proportion, expression, and asymmetry. Material or decals cannot repair wrong silhouette, gaze, or mouth opening.

## Hand Contract

Choose the articulation mode from the reference:

- `explicit-digits`: exactly one thumb chain and at least one finger chain, each with `segmentCount` from 1 to 4, component refs, and pose criteria;
- `grouped-digits`: stylized paws, mittens, or grouped glove forms still need named wrist, palm, digit mass, and outer-contour landmarks;
- `silhouette-only`: allowed only for a partial or strongly obscured hand;
- `hidden`: allowed only for an occluded hand with an explicit hidden-detail policy.

Do not force five human fingers onto a stylized paw, and do not collapse a clearly articulated hand into a mitten. Follow the visible representation.

Static landmarks and digit chains may share one continuous host. When Interaction requires articulation, every chain segment maps to a unique geometry part and needs a non-static `actionProfile.animationRole`, `actionProfile.transformChannels.rotate: true`, a supported `actionProfile.pivot.mode`, a finite three-number `actionProfile.pivot.localPosition`, and a non-zero finite `actionProfile.pivot.axis`.

When a hand touches an object, add `interaction.type`, a geometry-part `targetComponentRef`, geometry-part `contactComponentRefs` inside the hand region, and observable criteria. Bind both sides of the contact to the region's critical feature target.

## Critical Review

Every visible region remains an independent critical, `mustPass` feature target with dedicated source/render evidence bound through its exact `reviewViewIds`. Its minimum score cannot be lower than the configured critical threshold.

A missing crop, unbound review, hidden critical region, or sub-threshold score blocks `continue`; the full-object score cannot average the failure away.

## Execution Routing

- Use `procedural-patterns.md` for registered geometry and topology realization.
- Use `patterns/organic-skin-eyes.md` for continuous organic form, separate anatomical boundaries, skin/eye lookdev, and face review.
- Use `patterns/procedural-motion.md` only when an anatomical joint or digit chain requires runtime articulation.
- Use `attachment-joint-correctness.md` for grip and surface-contact mechanics.
- Use `browser-screenshot-feedback.md` for close-up capture, comparison, and critical feature scoring.

Load only the matched execution references; this file remains the schema and quality authority for every visible face or hand.
