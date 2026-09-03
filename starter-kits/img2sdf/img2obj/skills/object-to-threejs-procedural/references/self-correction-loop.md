# Self-Correction Loop Reference

Use this reference when a model construction pass has just finished.

All reviewer quality values—`overallScore`, every `layerScores.*`, and feature scores—are normalized numbers from `0` to `1`; decimals such as `0.82` are correct. Never write ordinal `0–3` assessment ratings in a review verdict.

## Review Order

1. Capture or collect a rendered screenshot for the current browser view.
2. Select critical semantic systems up to the spec policy cap and only the suspicious important systems. Keep every visible face and hand as an independent critical target.
3. Create one no-crop contact sheet and hash-bound manifest containing every required observed view plus registered synthetic diagnostic views with `sculpt compare`, including declared face/hand close-ups.
4. Run `module preflight` for a module or `review --preflight-only` for an assembled pass. A pass writes a hash-bound receipt. Module evidence first proves that reference and render share the exact `module-local` module/component scope and that the reference is an isolated crop/mask rather than the full-object source. `evidence-scope-mismatch` and other evidence/hash/provenance/batch failures return directly to the builder without scoring or consuming quality budget. If an otherwise-valid refinement fails a deterministic pixel-quality veto and a champion exists, preserve the challenger, restore the champion transactionally, record `rejected-preflight-regression`, and do not create a reviewer.
5. If preflight passes, start two fresh contexts concurrently:
   - a blind visual scout that receives only `sourceImage`, current render, previous render when one exists, exact side-by-side comparison, active `phaseId`, and compact phase rubric—never spec, phase packet, quality contract, feature targets, IDs, parameters, scores, builder defense, pre-generation image, or primary verdict;
   - the primary Codex vision reviewer that receives the raw images, exact contact-sheet hash, and contracts, but no builder score, defense, or proposed verdict.
6. The scout scans every visible component/region and returns `approve|reject` plus ranked directional observations without scores, IDs, feature-target judgments, or numeric fixes. The main agent maps the scout's visual regions to exact spec IDs and actionable values. The primary reviewer independently inspects every current required/diagnostic view and every applicable critical or `mustPass` feature target once, reports all actionable issues, and decides whether each correction belongs to spec or executable code. Do not deliberately defer a known issue to another review attempt.

Run the primary reviewer as a separate sub-agent. Only after both reviewers return, the main agent records every scout observation 1:1 in `blindScoutMapping`: `mapped` with exact `{targetType,target}` entries, `unmapped` with a reason for non-blocking observations, or `deferred` for future-phase observations. It cannot drop, merge, or rewrite scout severity/verdict; an unmapped current/protected `critical|major` observation blocks the gate.
7. The reviewer chooses exactly one action:
   - `continue`
   - `refine-spec`
   - `refine-code`
   - `refine-batch` when the complete correction set changes both spec and code
   - `strategy-reset` after three consecutive non-improving challengers prove the representation itself is wrong
   - `request-input`
   - `stop`
8. Before any refine or strategy reset is applied, require one `impactAssessment` with canonical `activePhase`, exact target IDs, exact allowed parameter paths, protected component IDs, structural invariants, expected effect, possible side effects, risk, rollback checkpoint, and `verdict: safe-to-apply`. It also requires a non-empty `downstreamImpact` array; every entry names a `phase` strictly later than `activePhase`, the `prediction`, the `currentMitigation`, and the `futureVerification` that can falsify or confirm it. This is planning evidence, not permission to author future-phase fields. Refinement sets `strategyChange: false`; strategy reset sets it to `true`. If the batch is broad, overlaps a protected component, cannot state what must remain unchanged, or leaves a material downstream risk unmitigated, narrow or reject it without touching the champion.
9. The main agent assembles the review envelope without changing either reviewer output, adds `blindScoutMapping`, and submits it to `module review` or assembled `review --verdict-json`. Recording consumes the receipt; every later review attempt starts with one fresh deterministic preflight. Manual score/model/notes fields cannot approve or refine an evidence-backed visual pass.
10. If the system gate does not pass, show the rejected challenger and continue the existing correction/rollback policy without asking the user to approve it.
11. If the system gate passes, show the user the candidate render/output and exact side-by-side or Interaction runtime evidence, clearly label it `system passed — awaiting user approval`, and ask for one explicit decision:
    - `approved`: bind approval to the exact pass/review/spec/artifact and unlock the next phase;
    - `changes-requested`: record every item as `visualRegion`, `problem`, and `expectedDirection`, keep the phase open, map the feedback to exact IDs/parameters, and rerun preflight plus both AI reviewers before asking again.

For visual passes, `continue` requires every pass-declared view, verified image hashes/dimensions, a primary reviewer bound to the comparison hash with composite shape-similarity score `>=0.70`, passing reviews for every applicable critical or `mustPass` feature target, and a separate blind-scout record bound to the same hash with decision `approve`. No pixel-overlap score participates. Module evidence still carries a render receipt for the exact module/implementation snapshot.

The blind scout is phase-scoped and cumulative. Every record names the active `phaseId`; every observation uses a canonical category plus `phaseScope: current|protected|deferred`. The scout must scan every mandatory rubric check, including excessive macro deviation, visible assembly and attachment alignment, reference-relative balance, signature-detail plausibility, and reference-relative material/surface fidelity. It scans earlier-phase quality before the active phase, then reports only the seven highest-impact directions. A major/critical issue in the active phase or an earlier phase may produce `reject`; earlier phases are not frozen, and non-blocking improvement directions are also useful. The legacy token `protected` means “prior quality scope subject to regression veto,” not “do not improve.” Only future-phase issues are deferred. For example, a material defect seen during Blockout is `deferred`, while a broken or still-improvable Blockout silhouette or attachment found during Lookdev is `protected` and may reject or guide a repair. Simplicity, wear, asymmetry, or detail density is defective only when it visibly conflicts with `sourceImage`.

Correction authority is cumulative too. The active phase must review and may improve fields/components owned by itself or any earlier phase, so a Lookdev render may trigger a geometry/Form correction and Interaction may repair Form or Lookdev. Do not reopen a separate administrative phase or silently mutate an accepted artifact. Treat the repair as a challenger in the active phase: declare the earlier owned paths in the impact assessment, preserve unrelated structure, compare source/current/previous renders, let any current/prior regression veto promotion, rollback on failure, and request user approval again for the resulting active-phase artifact. Future-phase edits remain forbidden.

`continue` means the system gate passed; it does not mean the phase is complete. The next phase stays locked until an explicit user approval record matches that exact system-reviewed artifact. Never manufacture or infer the user's response.

## Independent verdict contract

The main agent assembles one JSON review envelope per attempt. `contextId` values must identify different builder and reviewer contexts; a model name alone is not independence.

The CLI rejects identical context IDs, invalid scout mappings, and builder-side score overrides, but cannot cryptographically prove who produced a JSON file or inspect hidden context passed by an external orchestrator. Real independence and scout blindness are therefore orchestration rules: actually spawn fresh contexts, pass the scout only its allowlisted packet, and preserve both reviewer outputs when assembling the envelope. Treat the ID and packet checks as accidental-leak guards, not trusted attestation; a known context leak makes the review `UNVERIFIED`.

```json
{
  "artifactType": "threejs-sculpt-module-review",
  "version": 1,
  "reviewId": "face-r2",
  "action": "continue",
  "builder": {"contextId": "builder-task-id"},
  "reviewer": {"contextId": "fresh-reviewer-id", "role": "independent-reviewer", "model": "vision-model"},
  "comparisonSha256": "<exact evidence comparison hash>",
  "blindScout": {
    "artifactType": "threejs-sculpt-blind-scout",
    "version": 2,
    "phaseId": "form",
    "decision": "approve",
    "comparisonSha256": "<exact evidence comparison hash>",
    "reviewedAt": "<ISO-8601 timestamp>",
    "reviewer": {
      "role": "blind-visual-scout",
      "contextId": "fresh-blind-scout-id",
      "model": "vision-model"
    },
    "observations": []
  },
  "blindScoutMapping": {
    "artifactType": "threejs-sculpt-blind-scout-mapping",
    "version": 1,
    "mapper": {"role": "main-agent", "contextId": "builder-task-id"},
    "items": []
  },
  "overallScore": 0.88,
  "layerScores": {"silhouetteProportion": 0.9, "componentStructure": 0.88, "formDetail": 0.86},
  "sanityChecks": {
    "assemblyCorrectness": {"status": "pass", "summary": "No visible part is misplaced, reversed, floating, or implausibly intersecting.", "componentIds": ["fuselage-shell"], "viewIds": ["reference"]},
    "proportionBalance": {"status": "pass", "summary": "Major mass and appendage ratios remain balanced against the reference.", "componentIds": ["fuselage-shell"], "viewIds": ["reference"]},
    "shapeSilhouette": {"status": "pass", "summary": "The defining contour and local form are coherent in the reviewed views.", "componentIds": ["fuselage-shell"], "viewIds": ["reference"]},
    "signatureDetail": {"status": "pass", "summary": "Identity-critical visible details are present and proportionate.", "componentIds": ["fuselage-shell"], "viewIds": ["reference"]}
  },
  "featureReviews": [{"id": "face-identity", "score": 0.9, "visible": true, "viewIds": ["face-closeup"]}],
  "issues": [],
  "corrections": [],
  "resolvedIssueIds": [],
  "resolvedRootCauseKeys": [],
  "summary": "Concrete comparison result."
}
```

For an assembled pass, use the same body with `artifactType: "threejs-sculpt-pass-review"` and add the current `passId` and `specHash`. The CLI rejects a stale pass/spec/comparison binding. Do not also pass manual AI scores, model names, notes, layer scores, or feature reviews; the verdict is the sole reviewer authority.

For `refine-spec`, `refine-code`, or `refine-batch`, every open issue must name an existing semantic target with `targetType` (`component|material|repetition|feature|topology-group|motion-affordance|global`) and exact `target` id. It also needs a stable `id`, semantic `rootCauseKey`, `failureClass` (`topology|geometry|proportion|attachment|material|surface|lighting|evidence|performance|other`), severity, reason, falsifiable `evidenceCheck`, and `observedMismatch{parameterPath,actual,expected,unit,tolerance,viewIds}`. A critical or major visual issue also names its `sanityCategory`. Never use `model`, `whatever`, or a visual nickname when a declared id exists.

Every correction must reference that issue and repeat the exact `targetType`/`target`, then declare `parameterPath`, `operation` (`set|scale|translate|rotate|replace`), `beforeValue`, action `value`, final `expectedValue`, `unit`, concrete `change`, and quantified `expectedDelta{metric,from,to,tolerance,unit,viewIds}`. A spec path is relative to the selected target and must exist; a code path starts with `implementation.` and names the affected implementation symbol. `refine-batch` additionally requires `scope: spec|code` and must cover both scopes. If the reviewer cannot bound the value or range from evidence, use `request-input` instead of inventing a number.

The CLI returns one atomic version-2 `pendingCorrectionBatch`. Apply every listed correction in one builder work phase, with no intermediate render, preflight, or reviewer call. For spec corrections, `readyToRender` remains false until each declared path equals its `expectedValue`; a hash change elsewhere does not count. Then render all required views once and review once. Changing issue/root-cause labels does not close a defect: the gate also derives canonical lineage from failure class, exact target id, and correction paths.

Example:

```json
{
  "id": "rotor-span-too-short",
  "rootCauseKey": "main-rotor-span-ratio",
  "failureClass": "proportion",
  "severity": "major",
  "status": "open",
  "targetType": "component",
  "target": "main-rotor-blade-01",
  "reason": "The reviewed side view shows insufficient rotor span.",
  "observedMismatch": {
    "parameterPath": "dimensions.length",
    "actual": 1.8,
    "expected": 2.25,
    "unit": "relative",
    "tolerance": 0.05,
    "viewIds": ["side"]
  },
  "evidenceCheck": "Measure rotor span against fuselage length in the side view."
}
```

```json
{
  "issueId": "rotor-span-too-short",
  "scope": "spec",
  "targetType": "component",
  "target": "main-rotor-blade-01",
  "parameterPath": "dimensions.length",
  "operation": "set",
  "beforeValue": 1.8,
  "value": 2.25,
  "expectedValue": 2.25,
  "unit": "relative",
  "change": "Set the declared blade length to the measured target.",
  "expectedDelta": {
    "metric": "rotorSpanToFuselageLength",
    "from": 0.72,
    "to": 0.90,
    "tolerance": 0.03,
    "unit": "ratio",
    "viewIds": ["side"]
  }
}
```

Treat every valid attempt as a challenger to the best checkpoint in the active strategy. Promotion requires composite AI similarity `>=0.70`, passing primary-reviewer feature gates, and blind-scout `approve`; explicit user approval closes the configured human gate. The blind scout compares source/current/previous images to decide visual regression. Pixel-overlap diagnostics never participate.

A failed challenger is recorded in append-only audit and restored transactionally to the best compatible champion. Three consecutive visual non-improvements exhaust the current strategy; keep the champion and make one materially different, falsifiable representation change before another render. Schema/hash/evidence failures do not consume that visual quality budget. The cheap preflight still rejects stale artifacts, imperceptible changes, mismatched receipts, and incomplete correction batches before paying for AI review.

Legacy v3 specs retain their owned/protected-layer scoring ladder for compatibility. Do not copy that legacy policy into a v4 phase packet or reviewer prompt.

## Root Cause Guide

Use `refine-spec` when:

- a component is missing or invented incorrectly
- the primitive family is wrong
- proportions or coordinate frame are wrong
- material layer is under-specified
- local features are missing from the spec
- evidence refs are absent or contradict the image
- user expectation cannot be represented by current build passes

Use `refine-code` when:

- the spec is clear but generated geometry is wrong
- material parameters were not implemented
- local masks/noise/wear are missing in code
- hierarchy/pivots do not match the spec
- browser render has obvious artifacts
- performance can be improved without changing the spec

Use `request-input` when:

- the image hides essential geometry
- material cannot be inferred from the provided view
- exact branding/text/ornament is required
- the requested fidelity is incompatible with a single image

Use `stop` when:

- target fidelity is reached
- user accepted current approximation
- remaining issues require new references, manual modeling, or non-procedural assets

## Fidelity Estimate

Use a practical 0-1 scale:

- `0.2`: only rough primitive placeholder
- `0.4`: silhouette recognizable, structure incomplete
- `0.6`: macro and meso forms mostly correct, material/detail weak
- `0.75`: object reads correctly, local details approximate
- `0.85`: strong procedural match for real-time use
- `0.95`: near-reference, usually requires multiple views or manual art

Do not claim `0.9+` from a single ambiguous image unless the object is simple and symmetrical.
