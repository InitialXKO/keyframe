# Browser Screenshot Feedback

Use this reference when a procedural Three.js reconstruction has a browser-renderable preview.

## Capture Rule

Each visual build pass should produce at least one rendered screenshot from a named review viewpoint. Use the Codex in-app Browser screenshot tool first. Do not install or download Playwright/Chromium just for this skill; use Playwright or another browser automation path only when the user explicitly allows it or the project already depends on it. If the in-app Browser is unavailable, ask for a screenshot path or use browser tooling that is already present in the target project.

Start every review attempt from a clean diagnostic baseline: clear the Browser console when supported, or record a timestamp/checkpoint and reload the target safely before reproducing once. Judge only messages emitted after that baseline. Keep older messages as history, never as evidence for the current build, and record whether the baseline was `console-cleared`, `reload-checkpoint`, or `unavailable` in the review notes.

Create a side-by-side review image after capture:

```bash
python3 <plugin-root>/scripts/sculpt.py compare \
  --reference reference.png \
  --render render.png \
  --render-receipt render-receipt.json \
  --out comparison.png \
  --manifest-out evidence.json \
  --json
```

For a v4 module, also pass `--sculpt-manifest object-sculpt.json --module-id <module-id>` so the evidence contains the required render receipt for the exact module and implementation snapshot.

For viewing-contract v2, the render receipt is mandatory for strict review. It
must match the exact `viewingContract.renderPipeline` hash, prove at least one
frame was rendered through the controller, and record the resolved AA mode and
pass chain. Device pixel ratio alone never counts as anti-aliasing evidence.

The script aligns and packages evidence, verifies real image inputs, and hashes the exact artifacts. It must not calculate the acceptance score. A genuinely fresh Codex vision reviewer—not the builder with a renamed ID—must inspect `comparison.png`, and the verdict must bind its exact hash and both context IDs.

## Blind Visual Scout

After deterministic preflight, run a second fresh image-only reviewer concurrently with the primary independent reviewer. Give the scout only `sourceImage`, current render, previous render when one exists, their exact side-by-side comparison, the active phase ID, and its compact visual rubric. Do not give it any spec, phase packet, semantic IDs, numeric parameters, prior scores, builder explanation, or primary-reviewer output.

The scout must inspect every visible component or region in two ordered passes:

1. Re-scan all earlier-phase visual quality for remaining defects and clear improvement opportunities. A passed phase is a baseline, not a frozen result.
2. Review the active phase's visual goals.

Then return one v4 blind-scout artifact containing only `approve|reject` plus at most seven observations. Each observation uses only `visualRegion`, `severity`, `category`, `phaseScope`, `direction`, and `viewIds`; it contains no score, semantic ID, parameter path, or numeric fix.

Keep the guidance visual and directional: for example, “main upper mass is too narrow; widen and rebalance it against the body.” The scout must not score, name spec IDs, invent numeric corrections, or evaluate feature-target contracts. A current/protected major or critical observation requires `reject`. The builder translates its report into exact IDs and parameters, while the primary reviewer supplies the composite score, required feature reviews, and corrections. The CLI validates packet/output fields but cannot detect hidden context leaked by an external orchestrator; treat such a run as `UNVERIFIED`.

Immediately after each capture/evaluate/review checkpoint, embed the current render output and this exact `comparison.png` in a user-facing commentary update. Also report the current module/pass, accepted gates versus total gates, review result or blocker, and a recalculated remaining-time range. Do this for rejected challengers as well as accepted candidates, before starting the next step. A path printed by the CLI or an image shown only to the independent reviewer does not satisfy this requirement. For two to four views, present the single 2x2 contact sheet; retain the full-resolution originals for reviewer inspection.

When `--diagnostics-dir` is used, inspect the silhouette overlay and manifest metrics to correct camera/framing before geometry. Red is reference-only, cyan is render-only, and white is overlap. Missing/empty masks and gross silhouette/framing/detail mismatch are hard vetoes; good diagnostics still cannot unlock a pass.

The layout uses contain/no-crop fitting. For multi-view passes, use `--pairs-json` and `--manifest-out`; `--layout auto` packs two to four views into one 2x2 contact sheet and one immutable manifest. Each cell keeps the original reference/render paths, hashes, dimensions, provenance, and its `comparisonRegion`; the contact-sheet preview never replaces the high-resolution originals. Use the legacy `--layout rows` only when more than four views are genuinely decision-critical. For lookdev, keep the original `grazing` or detail capture high resolution even though its preview occupies one 2x2 cell.

Hidden-form planning defaults to one ImageGen 2x2 planning sheet (`three-quarter | side` over `back | front`). For a complex/ultra assembly with separable or internal parts, the first tile may instead be `exploded`; the side, back, and front tiles remain assembled. Do not replace the sheet with sequential generations: the shared sheet keeps identity, scale, and styling more consistent across views. It may be skipped only when the object is assessed as both simple and strongly symmetric; uncertainty means generate it.

Every new evidence view records `referenceProvenance`. Direct user/source references use `origin: observed`; a contract-approved white-background primary reference uses `origin: prepared-reference`; both use `allowedUse: acceptance`. Registered ImageGen 2x2 planning tiles use `origin: synthetic-hypothesis` and `allowedUse: planning-veto`; they may veto cross-view silhouette, depth, or assembly failures but their inferred material appearance and hidden parts are not truth. Planning-sheet cells never approve.

Use the same contact sheet to score critical semantic systems up to the configured policy cap. A normal feature is a subsystem such as a hull, cabin system, roof system, limb assembly, control panel, or sail-and-rigging system; it is not an individual mesh. Declared face and hand regions are the exception: each stays independent and requires its configured close-up view in that same contact sheet. Score up to three uncertain important features only when adaptive escalation is useful.

The starter spec contains generic review targets only as placeholders. Replace them with object-specific systems discovered during pre-spec assessment; otherwise strict quality validation should not pass a moderate or complex object.

## Compare By Layer

Review screenshot evidence in this order:

1. Silhouette and proportions: bounding shape, width/height/depth cues, taper, symmetry, negative space.
2. Component structure: parent/child placement, joints, contact points, repeated systems, floating or detached parts.
3. Form detail: bevels, chamfers, curvature, bends, dents, seams, raised ridges, holes, deformation scale.
4. Surface response: albedo zones, roughness variation, metalness, clearcoat, transmission, normal/bump/displacement, ambient occlusion.
5. Local features: scratches, chips, dirt accumulation, moss, stains, color patches, edge wear, contact wear.
6. Lighting/camera: exposure, shadow softness, contact shadows, color temperature, rim light, reflection readability.
7. Completeness and coherence: whether remaining omissions or simplifications visibly damage identity, structure, or material credibility.

Action selection and root-cause rules live only in `self-correction-loop.md`. This file owns capture, evidence packaging, and visual scoring order.

## AI Vision Scorecard

Score each applicable layer from `0` to `1`, then assign one overall score based on the pass goal:

- `silhouetteProportion`: outer contour, mass distribution, negative space, camera-normalized proportions.
- `componentStructure`: hierarchy, placement, attachment, repeated systems, floating or disconnected parts.
- `formDetail`: taper, bend, bevel, deformation, secondary forms, local geometry.
- `materialSurface`: albedo, roughness, reflectance, normal/displacement, AO, local wear, tactile frequency.
- `lightingCamera`: camera match, exposure, key/fill/rim balance, shadow/contact response, background.

Do not hide a critical failed layer inside a high average. If a layer is essential to the current pass and remains visibly wrong, choose `refine-spec` or `refine-code` even when the arithmetic mean is above threshold; use one `refine-batch` when the complete fix spans both.

## Feature Tiers

- `critical`: identity-defining, user-prioritized, visually salient, or high-risk subsystem. It must be visible and pass independently; face/hand targets must also bind their dedicated `viewIds`.
- `important`: useful secondary subsystem. Review only suspicious items; the reviewed average must meet the configured threshold.
- `detail`: micro detail. Record mismatch notes and defer to refinement unless the user promotes it.

Repeated parts should be one target when they form one recognizable system. For example, review three cabins as `cabin-system`, not three separate cabin targets.

## Evidence Format

Record each item in `evidence.views` with:

- `viewId`: the required view name.
- `referenceImage`: source image, crop, or marked-up reference path.
- `renderScreenshot`: browser-rendered screenshot path.
- `comparisonImage`: side-by-side evidence image reviewed by AI vision.

Record review-level fields separately:

- `aiVisionScore`: overall score from `0` to `1`.
- `layerScores`: per-layer scores from the scorecard.
- `aiVisionNotes`: concrete matched features, mismatches, root causes, and next correction.
- `featureReviews`: feature ID, score, visibility in the contact sheet, focused notes, and `viewIds` for targets that require dedicated evidence.

Never use screenshots as decoration only. They are the ground truth for the self-correction loop.

After the system gate passes, show the same exact evidence to the user for the final phase decision. AI acceptance alone is not phase completion.
