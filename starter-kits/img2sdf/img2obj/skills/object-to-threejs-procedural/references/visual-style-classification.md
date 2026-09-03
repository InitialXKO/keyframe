# Visual Style Classification

Use this reference when assessing `preSpecAssessment.visualStyle`. Classify what
is visible in `sourceImage`; do not choose a fashionable label first and force
the object to match it. The nine axes are the authoritative contract. Familiar
style names are derived summaries, never a substitute for the axes.

## Contents

- Contract and evidence rules
- Controlled axes
- Influences, derived labels, and overall synthesis
- Phase execution
- Ownership boundaries

## Contract and evidence rules

`visualStyle` is a sibling of `objectClass` and `complexity`:

```json
{
  "status": "assessed",
  "axes": {
    "realism": {
      "primary": "stylized",
      "modifiers": ["semi-realistic"],
      "custom": [],
      "confidence": 0.9,
      "evidenceRefs": ["full-object"],
      "cues": ["Simplified masses retain plausible material response."]
    }
  },
  "influences": [],
  "derivation": {
    "family": "hybrid",
    "archetypeLabels": [],
    "customLabel": ""
  },
  "overallStyleProfile": {
    "label": "Hybrid: Semi-Realistic",
    "signatureTraits": ["Simplified masses retain plausible material response."],
    "phaseDirectives": {
      "blockout": ["Keep the combined Blockout style coherent with sourceImage."],
      "form": ["Keep the combined Form style coherent with sourceImage."],
      "lookdev": ["Keep the combined Lookdev style coherent with sourceImage."],
      "interaction": ["Protect the combined style in every runtime state."]
    }
  },
  "notes": ""
}
```

Every assessed axis requires one registered `primary`, zero to two distinct
registered `modifiers`, confidence `0..1`, exact `viewEvidence[].id` references,
and concise observed cues. A modifier may not duplicate the primary. Use
`unassessed`, not `other`, while evidence is incomplete.

Use `other` only when the registry genuinely lacks the observed treatment. Add
exactly one matching `custom` entry with `role`, a stable short `label`, and an
operational `definition`. A custom definition must describe what must be built
or reviewed, not merely say that the style is unique.

`none` is a real assessed value for edge treatment or medium emulation. It is
exclusive and cannot have modifiers. Synchronization owns `derivation` and
`overallStyleProfile`; authors edit axes and influences, then let the pipeline
recompute both summaries.

## Controlled axes

### `realism`

Controls how literally visible form, material, and imperfection should behave.

| ID | Operational meaning |
| --- | --- |
| `hyper-realistic` | Preserve camera-plausible form plus unusually dense source-supported microvariation. |
| `photorealistic` | Target a result plausibly mistaken for a photograph under matching capture conditions. |
| `naturalistic` | Preserve physically credible form and material without requiring photographic indistinguishability. |
| `idealized-realistic` | Keep physical plausibility while cleaning or idealizing source-supported form. |
| `semi-realistic` | Combine realistic structure/material cues with visible simplification or exaggeration. |
| `stylized` | Intentionally transform form, proportion, detail, or response while preserving identity. |
| `abstract-representational` | Reduce or transform the object strongly while keeping it recognizable. |
| `nonrepresentational` | Organize form without requiring recognition as a real-world object. |
| `other` | Use one defined custom realism treatment. |

### `formTreatment`

Controls the geometry language of silhouettes, masses, and transitions.

| ID | Operational meaning |
| --- | --- |
| `literal` | Follow the observed continuous form and construction directly. |
| `simplified-rounded` | Merge secondary transitions into clean rounded masses. |
| `simplified-geometric` | Reduce masses to clear geometric volumes and planes. |
| `faceted` | Preserve intentional planar facets and visible angular transitions. |
| `voxelized` | Quantize visible volume to a regular cubic grid. |
| `inflated` | Use swollen, soft, balloon-like volumes and transitions. |
| `hand-sculpted` | Preserve deliberate manual sculpt asymmetry and tool-shaped transitions. |
| `flattened-relief` | Compress depth into layered or bas-relief construction. |
| `deconstructed` | Separate a recognizable whole into intentionally exposed constituent parts. |
| `fragmented` | Build the form from discontinuous shards or pieces. |
| `surreal-distorted` | Apply intentional impossible bends, merges, or spatial distortions. |
| `amorphous` | Use continuously changing masses without stable geometric part boundaries. |
| `other` | Use one defined custom form treatment. |

### `proportionTreatment`

Controls relationships between the sizes and lengths of parts.

| ID | Operational meaning |
| --- | --- |
| `literal` | Match observed source-relative proportions. |
| `idealized` | Regularize proportions toward a clean intended norm visible in the source. |
| `heroic` | Enlarge strength, stature, or power-bearing regions. |
| `exaggerated` | Amplify selected source relationships beyond literal measurement. |
| `chibi` | Use a large head or identity mass with compact body/secondary parts. |
| `super-deformed` | Compress and exaggerate the whole proportion system beyond ordinary chibi. |
| `caricatured` | Exaggerate the most identity-bearing proportions selectively. |
| `elongated` | Extend dominant axes or limbs relative to width/volume. |
| `compact` | Compress lengths and gaps into a dense proportion system. |
| `toy-like` | Use manufactured collectible/toy proportions and part thickness. |
| `other` | Use one defined custom proportion treatment. |

### `detailTreatment`

Controls which visible details survive and how strongly they read.

| ID | Operational meaning |
| --- | --- |
| `literal-complete` | Reproduce every source-visible detail that survives at target scale. |
| `selective` | Keep identity-bearing details and intentionally omit subordinate noise. |
| `simplified` | Merge detail groups into fewer clean features. |
| `iconic` | Keep only minimal symbols or features needed for recognition. |
| `ornamental` | Give decorative motifs deliberate structural prominence. |
| `amplified` | Enlarge or deepen important details beyond literal size. |
| `handcrafted-irregular` | Preserve meaningful handmade variation rather than regularizing it. |
| `procedural-patterned` | Organize detail through explicit repeatable systems and controlled variation. |
| `other` | Use one defined custom detail treatment. |

### `shadingTreatment`

Controls how light and shader response describe the form.

| ID | Operational meaning |
| --- | --- |
| `physically-based` | Use energy-consistent PBR material and lighting behavior. |
| `physically-plausible-stylized` | Keep plausible response while deliberately simplifying or shaping it. |
| `smooth-lit` | Favor continuous interpolated illumination and soft value transitions. |
| `flat-lit` | Preserve discrete face-level lighting changes. |
| `unlit` | Make authored color independent of scene lighting. |
| `toon-ramp` | Quantize lighting through a controlled tonal ramp. |
| `cel-banded` | Use hard-edged discrete light/shadow bands. |
| `painterly` | Shape light response as authored strokes or broad painted masses. |
| `matcap-like` | Use view-dependent captured/studio response as the dominant form cue. |
| `emissive-dominant` | Let self-illumination dominate visible response. |
| `other` | Use one defined custom shading treatment. |

### `surfaceTreatment`

Controls visible marks, texture organization, and finish variation.

| ID | Operational meaning |
| --- | --- |
| `literal-material` | Reproduce the observed substance-specific surface response. |
| `clean-uniform` | Keep the surface intentionally even and low-variation. |
| `hand-painted` | Author color/value variation as painted 3D texture rather than literal material sampling. |
| `painterly-brushwork` | Preserve visible directional brush marks and stroke grouping. |
| `graphic-flat-fill` | Use clean bounded color regions with little internal texture. |
| `photographic-projection` | Project source-derived photographic appearance where evidence supports it. |
| `procedural-pattern` | Generate marks through repeatable parameterized fields. |
| `pixelated` | Quantize surface marks to visible pixels or texels. |
| `stippled` | Build tone from discrete dots. |
| `hatched` | Build tone from directional line groups. |
| `mosaic-tiled` | Build the surface from discrete tile-like units and seams. |
| `distressed` | Preserve source-supported wear, grime, chips, or abrasion as a dominant cue. |
| `handcrafted-imprint` | Preserve fingerprints, tool marks, seams, or handmade surface imprints. |
| `other` | Use one defined custom surface treatment. |

### `edgeTreatment`

Controls explicit rendered lines; it does not replace geometric bevels or seams.

| ID | Operational meaning |
| --- | --- |
| `none` | Add no explicit style line. |
| `silhouette-outline` | Draw only the visible outer contour. |
| `silhouette-and-crease` | Draw the outer contour plus selected structural creases. |
| `inked` | Use deliberate variable graphic ink lines. |
| `sketched` | Use loose, imperfect, repeated drawing lines. |
| `brush-line` | Use pressure-like painterly line width and texture. |
| `technical-line` | Use clean controlled drafting-style linework. |
| `hidden-line` | Show selected occluded construction lines intentionally. |
| `other` | Use one defined custom edge treatment. |

### `paletteTreatment`

Controls color relationships, not material physics.

| ID | Operational meaning |
| --- | --- |
| `source-natural` | Match observed source-relative hues, values, and saturation. |
| `graded-natural` | Apply a coherent grade while retaining natural source relationships. |
| `limited` | Use a deliberately small palette. |
| `monochrome` | Organize the object around one hue family or grayscale. |
| `duotone` | Organize the object around two dominant color families. |
| `pastel` | Use light, softened, low-intensity colors. |
| `muted` | Reduce saturation and contrast deliberately. |
| `high-saturation` | Preserve strongly saturated color as a defining cue. |
| `high-contrast` | Use large value or chroma separation between regions. |
| `color-blocked` | Divide the object into clean, discrete color regions. |
| `neon-emissive` | Use intense luminous color relationships. |
| `other` | Use one defined custom palette treatment. |

### `mediumEmulation`

Controls the physical or 2D medium whose artifacts the 3D asset intentionally
imitates. `none` means no medium imitation beyond ordinary 3D construction.

| ID | Operational meaning |
| --- | --- |
| `none` | Do not imitate a separate craft or 2D medium. |
| `clay` | Preserve modeled clay mass, softness, and tool/finger evidence. |
| `plasticine` | Use colorful pliable modeling-compound cues and seams. |
| `paper-craft` | Use folded, layered, cut, or tabbed paper construction cues. |
| `painted-miniature` | Emulate a physically painted small-scale model. |
| `wood-carving` | Preserve carved planes, grain-aware cuts, and tool marks. |
| `ceramic-figurine` | Emulate formed and glazed ceramic object response. |
| `stop-motion-handmade` | Preserve frame-ready handmade puppet/prop construction cues. |
| `oil-paint` | Emulate opaque layered pigment and impasto-like marks. |
| `watercolor` | Emulate translucent washes, pooling, and paper-like variation. |
| `ink` | Emulate black or colored ink marks and fills. |
| `pencil` | Emulate graphite/colored-pencil grain and strokes. |
| `pixel-art` | Emulate deliberately authored pixel clusters; this is not voxel geometry. |
| `mosaic` | Emulate assembled tesserae, grout, and tile variation. |
| `other` | Use one defined custom medium treatment. |

## Influences and derived labels

Use `influences[]` only for a named cultural, genre, period, franchise-neutral,
or artistic influence that cannot be inferred safely from axis values alone.
Each influence needs a stable `id`, display `label`, affected axis IDs,
confidence, and evidence. An influence scopes interpretation; it never overrides
the observed axes or grants permission to copy protected character/IP designs.

The system derives broad `family` as `realistic`, `stylized`, `abstract`,
`hybrid`, or `other`. It also recognizes composable summaries such as
Hyper-Realistic, Photorealistic, Standard Realistic, Semi-Realistic, Abstract
3D, Surrealism 3D, Low Poly, High Poly Stylized, Toon Shading, Cel-Shading,
Anime Stylized, Chibi Cute, Hand-Painted 3D, Claymation Art, Plasticine Style,
Voxel Art, Gritty Realism, Dark Fantasy Realism, and Flat Design 3D.

These labels are conveniences. For example, Low Poly requires faceted form plus
simplified/iconic detail; Cel-Shading is specifically `cel-banded`; Voxel Art
requires voxelized form; Anime requires a declared influence. A label can coexist
with others because one object may be Low Poly, Hand-Painted, and limited-palette
at the same time.

HD-2D is a scene/camera/compositing presentation style, not an intrinsic object
style. Record it in the viewing or presentation contract rather than forcing it
into `visualStyle`.

`overallStyleProfile` combines the assessed axes and declared influences into
one readable object-level style. `label` summarizes the family and matching
archetypes, `signatureTraits` preserves the source-observed cues behind every
axis, and `phaseDirectives` turns only the axes owned by each phase into build
and review guidance. Treat it as synchronized output, not a second authored
style source. Any mismatch is stale pipeline state; run `sculpt sync`.

## Phase execution

- Blockout consumes `realism`, `formTreatment`, and `proportionTreatment`.
- Form also consumes `detailTreatment`.
- Lookdev consumes all nine axes.
- Interaction protects the complete established style while testing runtime states.

The phase context exposes only the cumulative relevant axes and matching
`styleDirectives` generated for `overallStyleProfile.phaseDirectives`. A
Lookdev-only change must not invalidate Blockout/Form review hashes. The blind
scout receives that guidance inside `phaseRubric.styleChecks`, not the raw style
schema.

Style is Blockout-owned because it must be assessed before geometry starts.
Later phases may repair it through cumulative prior-phase edit authority when
new evidence falsifies an earlier classification. Synchronize after an edit so
derived labels and phase hashes stay current:

```bash
python3 <plugin-root>/scripts/sculpt.py sync object-sculpt.json
```

Keep `notes` non-executable; put every build/review instruction in an axis,
custom definition, or scoped influence so it enters the correct phase projection.

## Ownership boundaries

- `objectClass` says what the object and representation are.
- `visualStyle` says how visible form and appearance are intentionally treated.
- `complexity` says how difficult the reconstruction is.
- component/topology contracts say how geometry is built.
- materials own concrete PBR values and maps.
- viewing/presentation owns camera, post-processing, and scene-level hybrids.
- `qualityContract` owns measurable completion floors.

Style never authorizes deviation from `sourceImage`. If a declared treatment
cannot be implemented by registered geometry/material capabilities, record a
`capability-gap`; do not silently approximate it or add prose-only behavior.
