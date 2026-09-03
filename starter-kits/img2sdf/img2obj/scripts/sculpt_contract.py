#!/usr/bin/env python3
"""Canonical workflow, evidence, and pass-state rules for procedural sculpting."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import struct
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from visual_feature_gate import (
    feature_gate_failures,
    feature_review_policy,
    feature_targets_for_pass,
)
from sculpt_perception import perceptual_review_failures
from sculpt_style import (
    sync_visual_style,
    visual_style_directives,
    visual_style_projection,
)


DEFAULT_PASS_ORDER = ["blockout", "form", "lookdev"]
VISUAL_PASS_IDS = {
    "blockout",
    "structure",
    "form",
    "lookdev",
    "structural-pass",
    "form-refinement",
    "material-pass",
    "surface-pass",
    "lighting-pass",
}
RUNTIME_PASS_IDS = {"interaction", "interaction-pass"}
METRICS_PASS_IDS = {"optimization", "optimization-pass"}
REFINEMENT_ACTIONS = frozenset({"refine-spec", "refine-code", "refine-batch"})
STRATEGY_RESET_ACTION = "strategy-reset"
CORRECTION_SCOPES = frozenset({"spec", "code"})
CORRECTION_TARGET_TYPES = frozenset(
    {
        "component",
        "material",
        "repetition",
        "feature",
        "detail-feature",
        "topology-group",
        "motion-affordance",
        "global",
    }
)
CORRECTION_OPERATIONS = frozenset({"set", "scale", "translate", "rotate", "replace"})
GLOBAL_CORRECTION_TARGETS = frozenset(
    {
        "spec",
        "silhouette",
        "coordinate-frame",
        "camera",
        "lighting",
        "render-pipeline",
        "evidence",
        "performance",
        "assembly",
    }
)
MAX_REFINEMENT_ATTEMPTS = 6
MAX_CONSECUTIVE_NON_IMPROVEMENTS = 3
MIN_REFINEMENT_SCORE_DELTA = 0.02
MAX_REFINEMENT_REGRESSION = 0.0
MAX_STRATEGY_RESETS = 1
# Version 4 keeps the phase loop and rollback machinery while using two visual
# system signals: one composite AI score and an independent blind scout.
# Human approval remains the final phase gate.
SIMPLIFIED_PHASE_EXECUTION_VERSION = 4
SIMPLIFIED_AI_OVERALL_FLOOR = 0.70
MAX_BLIND_SCOUT_OBSERVATIONS = 7
BLIND_SCOUT_ARTIFACT_VERSION = 2
BLIND_SCOUT_MAPPING_ARTIFACT_TYPE = "threejs-sculpt-blind-scout-mapping"
BLIND_SCOUT_MAPPING_VERSION = 1
BLIND_SCOUT_PHASE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "blockout": (
        "silhouette",
        "framing",
        "proportion",
        "major-part",
        "assembly",
    ),
    "form": (
        "silhouette",
        "proportion",
        "major-part",
        "assembly",
        "shape",
        "attachment",
        "balance",
        "signature-detail",
    ),
    "lookdev": (
        "color",
        "material",
        "surface",
        "lighting",
        "grounding",
    ),
    "interaction": (
        "motion",
        "clearance",
        "runtime-state",
        "assembly",
    ),
}
BLIND_SCOUT_PHASE_ORDER = ("blockout", "form", "lookdev", "interaction")
BLIND_SCOUT_PHASE_FOCUS = {
    "blockout": (
        "First scan all visible prior-quality dimensions for remaining defects or "
        "improvement opportunities, then judge the complete silhouette, framing, "
        "macro proportions, and presence/placement/assembly of identity-defining parts."
    ),
    "form": (
        "First re-scan Blockout quality for remaining or improvable silhouette, "
        "proportion, and major-part issues; then judge structure, local shape, "
        "attachments, balance, and signature identity detail. A passed prior phase "
        "is a baseline, not a frozen result."
    ),
    "lookdev": (
        "First re-scan Blockout and Form quality for remaining or improvable "
        "silhouette, proportion, structure, attachment, balance, and shape issues; "
        "then judge color zones, material class, gloss/roughness, surface response, "
        "lighting, and grounding. A passed prior phase is a baseline, not a frozen result."
    ),
    "interaction": (
        "First re-scan all earlier visual quality for remaining or improvable "
        "silhouette, structure, shape, and lookdev issues; then judge visible motion "
        "states, pivot plausibility, clearance, detachment, intersection, and "
        "runtime-state coherence. Earlier passes remain editable when improvement is "
        "visibly justified."
    ),
}
BLIND_SCOUT_CATEGORY_CHECKS = {
    "silhouette": (
        "Compare the complete visible outline, dominant curves, negative spaces, and "
        "identity-bearing profile against the active reference."
    ),
    "framing": (
        "Check camera-relative scale, crop, orientation, and placement without treating "
        "a framing mismatch as a geometry correction."
    ),
    "proportion": (
        "Compare macro and local width, height, depth cues, thickness, spacing, and "
        "relative scale between visible parts."
    ),
    "major-part": (
        "Check the visible count, presence, placement, orientation, and relative size "
        "of every identity-defining major part."
    ),
    "assembly": (
        "Inspect visible construction relationships for detached, floating, intersecting, "
        "misaligned, off-center, or implausibly supported parts."
    ),
    "shape": (
        "Compare local contours, curvature, taper, thickness, transitions, and volume "
        "against the visible reference evidence."
    ),
    "attachment": (
        "Inspect every visible joint, socket, seam, contact, overlap, and intended gap "
        "for alignment, continuity, penetration, detachment, or implausible connection."
    ),
    "balance": (
        "Compare the reference's intended symmetry or asymmetry, visual weight, support, "
        "stance, and part distribution; do not penalize asymmetry present in the reference."
    ),
    "signature-detail": (
        "Check identity-critical visible details for missing, invented, malformed, "
        "misplaced, misoriented, duplicated, or visually implausible construction."
    ),
    "color": (
        "Compare dominant color zones, boundaries, relative values, saturation, and "
        "identity-critical accents against the active reference."
    ),
    "material": (
        "Compare material class, metalness, roughness or gloss, reflectance, transmission, "
        "and layered response; reject simplification only when it is visibly poorer than "
        "or inconsistent with the reference."
    ),
    "surface": (
        "Compare visible relief, wear, grain, scratches, patina, softness, and response "
        "variation at the target display scale without demanding invisible microdetail."
    ),
    "lighting": (
        "Check whether highlights, shading, reflections, and contrast reveal the same "
        "forms and material response rather than hiding defects."
    ),
    "grounding": (
        "Check contact shadows, support points, floor contact, and depth cues for floating "
        "or implausible placement."
    ),
    "motion": (
        "Compare visible motion direction, pivot behavior, deformation, and state changes "
        "with the observed or approved motion evidence."
    ),
    "clearance": (
        "Inspect moving states for collision, penetration, detachment, implausible gaps, "
        "or insufficient travel clearance."
    ),
    "runtime-state": (
        "Check that every reviewed runtime state remains visually coherent and preserves "
        "the accepted object identity, assembly, materials, and rendering."
    ),
}
BLIND_SCOUT_SEVERITY_POLICY = {
    "critical": (
        "The visible result loses object identity, omits or invents a defining system, "
        "or shows a broken or impossible assembly that invalidates the object."
    ),
    "major": (
        "A clear reference mismatch or construction/material defect is readily visible "
        "at the target display scale and materially harms fidelity or plausibility."
    ),
    "minor": (
        "A localized visible mismatch remains, but it does not materially change identity, "
        "assembly plausibility, material class, or the dominant read."
    ),
}
BLIND_SCOUT_COVERAGE_RULE = (
    "Inspect every mandatory check before deciding. Report only the seven highest-impact "
    "visible directions, but reject whenever any current or prior-phase critical or major "
    "defect exists; an empty observation list asserts that the complete mandatory scan "
    "found no reportable issue."
)
BLIND_SCOUT_REFERENCE_COMPARISON_RULE = (
    "Use the active reconstruction target for visible fidelity. When an ImageGen-prepared "
    "target is present, also use the original image only as an identity and macro-form "
    "guardrail. Judge simplification, asymmetry, detail, and material complexity relative "
    "to the reference evidence rather than generic realism preferences."
)
DETERMINISTIC_QUALITY_METRICS = (
    "centroidDelta",
    "aspectRatioDelta",
    "detailEnergyRatio",
    "edgeDensityRatio",
    "foregroundHistogramIntersection",
    "foregroundMeanColorDelta",
    "highlightCoverageRatio",
    "highlightEnergyRatio",
)
MATERIAL_OWNER_ROLE_TOKENS = (
    "material",
    "surface",
    "lookdev",
    "fabric",
    "fiber",
    "fur",
    "hair",
    "cloth",
    "costume",
    "knit",
    "glass",
    "liquid",
)


def blind_scout_phase_id(pass_id: str) -> str:
    """Map legacy pass aliases to the four user-facing phase scopes."""

    normalized = str(pass_id or "").strip().lower()
    if normalized in {"blockout", "structure", "structural-pass"}:
        return "blockout"
    if normalized in {"form", "form-refinement"}:
        return "form"
    if normalized in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
        return "lookdev"
    if normalized in {"interaction", "interaction-pass"}:
        return "interaction"
    return normalized


def blind_scout_phase_categories(pass_id: str) -> tuple[str, ...]:
    return BLIND_SCOUT_PHASE_CATEGORIES.get(blind_scout_phase_id(pass_id), ())


def blind_scout_phase_scope(pass_id: str, category: str) -> str:
    phase_id = blind_scout_phase_id(pass_id)
    if category in BLIND_SCOUT_PHASE_CATEGORIES.get(phase_id, ()):
        return "current"
    try:
        phase_index = BLIND_SCOUT_PHASE_ORDER.index(phase_id)
    except ValueError:
        return "deferred"
    protected_categories = {
        item
        for prior_phase in BLIND_SCOUT_PHASE_ORDER[:phase_index]
        for item in BLIND_SCOUT_PHASE_CATEGORIES[prior_phase]
    }
    return "protected" if category in protected_categories else "deferred"


def blind_scout_phase_rubrics() -> dict[str, dict[str, Any]]:
    all_categories = sorted(
        {
            category
            for categories in BLIND_SCOUT_PHASE_CATEGORIES.values()
            for category in categories
        }
    )
    rubrics: dict[str, dict[str, Any]] = {}
    for phase_index, phase_id in enumerate(BLIND_SCOUT_PHASE_ORDER):
        categories = BLIND_SCOUT_PHASE_CATEGORIES[phase_id]
        prior_categories = sorted(
            {
                category
                for prior_phase in BLIND_SCOUT_PHASE_ORDER[:phase_index]
                for category in BLIND_SCOUT_PHASE_CATEGORIES[prior_phase]
            }
        )
        protected_categories = [
            category for category in prior_categories if category not in categories
        ]
        mandatory_categories = list(
            dict.fromkeys([*protected_categories, *categories])
        )
        rubrics[phase_id] = {
            "focus": BLIND_SCOUT_PHASE_FOCUS[phase_id],
            "currentPhaseCategories": list(categories),
            "priorPhaseCategories": prior_categories,
            # Backward-compatible machine key. "Protected" means protected from
            # regression, not frozen against improvement.
            "protectedPhaseCategories": protected_categories,
            "reviewOrder": ["prior-phase-quality-sweep", "current-phase-review"],
            "priorPhaseReviewRequired": True,
            "priorPhaseImprovementAllowed": True,
            "mandatoryChecks": [
                {
                    "category": category,
                    "phaseScope": blind_scout_phase_scope(phase_id, category),
                    "inspection": BLIND_SCOUT_CATEGORY_CHECKS[category],
                }
                for category in mandatory_categories
            ],
            "coverageRule": BLIND_SCOUT_COVERAGE_RULE,
            "severityPolicy": copy.deepcopy(BLIND_SCOUT_SEVERITY_POLICY),
            "referenceComparisonRule": BLIND_SCOUT_REFERENCE_COMPARISON_RULE,
            "deferredCategories": [
                category
                for category in all_categories
                if category not in categories and category not in prior_categories
            ],
        }
    return rubrics


def blind_scout_execution_contract() -> dict[str, Any]:
    """Return the phase-scoped prompt/output contract for the visual-only scout."""

    return {
        "required": True,
        "role": "blind-visual-scout",
        "independence": "fresh-context-distinct-from-builder-and-primary-reviewer",
        "execution": "parallel-with-primary-reviewer",
        "inputAllowlist": [
            "sourceImage",
            "currentRender",
            "previousRender",
            "sideBySideComparison",
            "phaseId",
            "phaseRubric",
        ],
        "inputDenylist": [
            "spec",
            "phasePacket",
            "componentIds",
            "parameters",
            "scores",
            "builderDefense",
            "primaryVerdict",
        ],
        "inputRule": (
            "Pass only sourceImage, currentRender, previousRender when available, "
            "sideBySideComparison, phaseId, and phaseRubric. Never pass the spec, "
            "phase packet, quality contract, feature targets, or pre-generation image."
        ),
        "approvalRule": (
            "Decide only from the permitted pixels and phase rubric. The primary "
            "independent reviewer—not the scout—evaluates exact IDs, feature targets, "
            "scores, and contract compliance."
        ),
        "phaseRubrics": blind_scout_phase_rubrics(),
        "scanRule": (
            "Run a mandatory two-pass scan using every phaseRubric.mandatoryChecks item: "
            "(1) inspect every visible component or region for remaining defects and "
            "clear improvement opportunities in all earlier phases, then (2) inspect "
            "the active phase. Explicitly test visible assembly and attachment alignment, "
            "reference-relative balance, signature-detail plausibility, material/surface "
            "fidelity, and excessive macro deviation whenever their phase scope is current "
            "or protected. Earlier-phase quality is cumulative and improvable, not frozen. "
            "Compare currentRender with previousRender to determine whether a refinement "
            "improves or regresses; previousRender is required when a prior checkpoint exists."
        ),
        "outOfScopeRule": (
            "A major or critical issue in the active phase or any earlier phase may "
            "cause reject. Earlier-phase issues may also be reported as improvement "
            "directions even when they are not yet blocking. Only future-phase issues "
            "are deferred."
        ),
        "output": {
            "artifactVersion": BLIND_SCOUT_ARTIFACT_VERSION,
            "advisoryOnly": False,
            "gateAuthority": True,
            "scoresForbidden": True,
            "verdictForbidden": False,
            "numericFixesForbidden": True,
            "decisionValues": ["approve", "reject"],
            "maxObservations": MAX_BLIND_SCOUT_OBSERVATIONS,
            "rejectRule": (
                "reject requires at least one current or earlier-phase critical or major observation; "
                "a small numeric score drop alone is not a rejection reason"
            ),
            "approveRule": (
                "approve may contain deferred observations and non-blocking earlier-phase "
                "improvement directions, but no current or earlier-phase critical or "
                "major observation"
            ),
            "priorPhaseReviewRequired": True,
            "priorPhaseImprovementAllowed": True,
            "priorPhaseIsNotFrozen": True,
            "componentScanFields": [
                "visualRegion",
                "severity",
                "category",
                "phaseScope",
                "direction",
                "viewIds",
            ],
            "priorityDirectionFields": [
                "visualRegion",
                "category",
                "phaseScope",
                "severity",
                "direction",
                "viewIds",
            ],
            "forbiddenFields": [
                "componentId",
                "componentIds",
                "parameterPath",
                "score",
                "numericFix",
                "beforeValue",
                "expectedValue",
            ],
            "mainAgentMapping": {
                "required": True,
                "artifactType": BLIND_SCOUT_MAPPING_ARTIFACT_TYPE,
                "version": BLIND_SCOUT_MAPPING_VERSION,
                "storageField": "blindScoutMapping",
                "mapperRole": "main-agent",
                "oneItemPerObservation": True,
                "statuses": ["mapped", "unmapped", "deferred"],
                "targetFields": ["targetType", "target"],
                "blockingScopes": ["current", "protected"],
                "blockingUnmappedSeverities": ["critical", "major"],
                "preserveScoutVerdictAndSeverity": True,
            },
        },
    }

def human_approval_contract(approval_mode: str) -> dict[str, Any]:
    """Return the exact post-system human gate for the configured approval mode."""

    final_only = approval_mode == "final-only"
    return {
        "required": True,
        "scope": "final-active-phase" if final_only else "every-active-phase",
        "order": (
            "after-final-system-pass"
            if final_only
            else "after-system-pass-before-next-phase"
        ),
        "systemPassPrerequisite": True,
        "approvalDecisions": ["approved", "changes-requested"],
        "bindingFields": [
            "passId",
            "reviewKey",
            "specHash",
            "reviewedArtifactSha256",
        ],
        "changesRequestedFields": [
            "visualRegion",
            "problem",
            "expectedDirection",
        ],
        "rules": [
            "Never ask the user to approve before deterministic preflight, the composite AI review, and blind scout approve pass.",
            "Show the current output and exact comparison or runtime evidence when requesting approval.",
            "Only explicit user approval completes the configured human gate.",
            "If the user requests changes, record where the problem is, what is wrong, and the expected direction; refine and rerun the composite AI review and blind scout before asking again.",
            "The builder must never infer, fabricate, or self-record user approval.",
        ],
    }


def review_governance_contract() -> dict[str, Any]:
    """Return the independent-review authority required for every v4 workflow."""

    return {
        "independentContextRequired": True,
        "reviewerRole": "independent-reviewer",
        "verdictArtifactRequired": True,
        "builderMayNotOverrideVerdict": True,
    }


def primary_feature_review_policy(quality_profile: str) -> dict[str, Any]:
    """Keep source-specific feature acceptance with the primary reviewer."""

    reference_fidelity = quality_profile == "reference-fidelity"
    return {
        "enabled": True,
        "reviewUnit": "multi-view-contact-sheet",
        "maxCriticalFeaturesPerPass": 8,
        "maxImportantFeaturesPerPass": 3,
        "criticalDefaultThreshold": 0.85 if reference_fidelity else 0.8,
        "importantAverageThreshold": 0.78 if reference_fidelity else 0.65,
        "adaptiveEscalation": True,
        "singleImagePairOnly": False,
        "selectionRule": (
            "Review a few identity-defining semantic systems, not every mesh; "
            "visible face and hand regions remain independent critical targets."
        ),
    }

DERIVED_SPEC_FIELDS = {
    "reviewHistory",
    "userPhaseApprovals",
    "visualEvidence",
    "sculptPipeline",
    "pbrExtractionHistory",
}

# Compatibility-only hints accepted while migrating pre-3.2 specs. They no
# longer select the quality pipeline or activate performance gates.
REALTIME_USES = {"browser-prop", "game-prop", "playable", "destructible"}
INTERACTIVE_USES = {"animated", "playable", "destructible"}
CURRENT_SCHEMA_VERSION = "3.2"
LEGACY_SCHEMA_VERSION = "2.0"
COMPONENT_TYPES = frozenset({"part", "assembly"})
VISUAL_EVIDENCE_ARTIFACT_TYPE = "threejs-sculpt-visual-evidence"
VISUAL_EVIDENCE_MANIFEST_VERSION = 1
VISUAL_EVIDENCE_GENERATOR = "threejs-object-sculptor/compare"

_SCHEMA_VERSION_PATTERN = re.compile(
    r"^(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)"
    r"(?:\.(?P<patch>0|[1-9][0-9]*))?$"
)


def user_eta_policy() -> dict[str, Any]:
    """Describe the ETA update that the executing agent owes the user.

    The CLI can count quality gates, but it cannot honestly predict browser,
    reviewer, ImageGen, or refinement latency.  Keep the estimate agent-owned
    and require a range whose basis is visible instead of fabricating a timer.
    """

    return {
        "required": True,
        "format": "range",
        "allowedUnits": ["minutes", "hours"],
        "singleExactTimeForbidden": True,
        "recalculateAfterEveryStep": True,
        "requiredBasis": [
            "observed duration of completed cycles when available",
            "remaining quality gates",
            "remaining refinement budget",
            "known browser, reviewer, ImageGen, or user-input waits",
        ],
        "blockedRule": (
            "Only report ETA as unknown when an external blocker makes a range dishonest; "
            "name the blocker and state when progress will be checked again."
        ),
    }


def user_progress_contract(
    scope: str,
    completed: int,
    total: int,
    current_step: str,
    remaining_steps: Iterable[str],
) -> dict[str, Any]:
    """Return a stable gate count plus the required user-update policy."""

    safe_total = max(0, int(total))
    safe_completed = min(max(0, int(completed)), safe_total)
    percent = (
        100.0
        if safe_total == 0 and current_step == "complete"
        else 0.0
        if safe_total == 0
        else round(100.0 * safe_completed / safe_total, 1)
    )
    return {
        "reportRequired": True,
        "scope": scope,
        "completedGates": safe_completed,
        "totalGates": safe_total,
        "gatePercentComplete": percent,
        "percentMeaning": "accepted quality gates, not elapsed wall-clock time",
        "currentStep": current_step,
        "remainingGates": list(dict.fromkeys(str(item) for item in remaining_steps if str(item))),
        "nextAction": {
            "required": True,
            "instruction": (
                "State one concrete next action, its target module/pass, and the condition that will finish it."
            ),
        },
        "nextUpdate": "after this step and before starting the next workflow step",
        "eta": user_eta_policy(),
    }


def visual_checkpoint_presentation(
    evidence: Mapping[str, Any],
    *,
    checkpoint: str,
    artifact_state: str = "candidate",
    progress: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Expose exact visual artifacts that must be embedded in the user update."""

    views = evidence.get("views")
    view_items = [item for item in views if isinstance(item, Mapping)] if isinstance(views, list) else []
    render_outputs = list(
        dict.fromkeys(
            str(item.get("renderScreenshot"))
            for item in view_items
            if isinstance(item.get("renderScreenshot"), str)
            and str(item.get("renderScreenshot")).strip()
        )
    )
    reference_images = list(
        dict.fromkeys(
            str(item.get("referenceImage"))
            for item in view_items
            if isinstance(item.get("referenceImage"), str)
            and str(item.get("referenceImage")).strip()
        )
    )
    comparison = evidence.get("comparisonImage")
    return {
        "displayRequired": True,
        "displayBeforeNextStep": True,
        "checkpoint": checkpoint,
        "artifactState": artifact_state,
        "renderOutputs": render_outputs,
        "referenceImages": reference_images,
        "sideBySideComparison": comparison if isinstance(comparison, str) else "",
        "displayOrder": [
            "render output",
            "reference/render side-by-side comparison",
            "review result",
            "current progress",
            "remaining-time range",
        ],
        "markdownRule": (
            "Embed the absolute local render and comparison paths as visible Markdown images; "
            "a plain path or reviewer-only attachment does not satisfy the user update."
        ),
        "progress": dict(progress) if isinstance(progress, Mapping) else {},
        "eta": user_eta_policy(),
    }


def is_pending_quality_attempt(record: Mapping[str, Any]) -> bool:
    """Return whether a scored attempt still belongs to the active retry cycle."""

    action = record.get("action")
    return action in REFINEMENT_ACTIONS or (
        action == "continue" and record.get("accepted") is False
    )


def deterministic_quality_gate_failures(failures: Iterable[Any]) -> list[str]:
    """Select deterministic pixel-quality vetoes from broader preflight failures.

    Evidence integrity, provenance, stale hashes, missing views, and incomplete
    correction batches are deliberately excluded. Those failures cannot prove
    that a refinement made the rendered object worse and therefore must not spend
    the quality retry budget or trigger a checkpoint rollback.
    """

    selected: list[str] = []
    for value in failures:
        if not isinstance(value, str):
            continue
        is_metric_failure = any(metric in value for metric in DETERMINISTIC_QUALITY_METRICS)
        is_threshold_failure = (
            " veto threshold " in value
            or " must be >= " in value
            or " must be <= " in value
        )
        if is_metric_failure and is_threshold_failure:
            selected.append(value)
    return list(dict.fromkeys(selected))


def refinement_budget(records: Any) -> dict[str, Any]:
    """Bound review work while allowing useful refinements to keep progressing.

    Legacy records did not store a candidate disposition. They still consume the
    total attempt budget, but do not fabricate a non-improvement streak.
    """

    used = 0
    consecutive_non_improvements = 0
    strategy_resets = 0
    if isinstance(records, list):
        strategy_resets = sum(
            1
            for record in records
            if isinstance(record, Mapping) and record.get("action") == STRATEGY_RESET_ACTION
        )
        cycle: list[Mapping[str, Any]] = []
        for record in reversed(records):
            if not isinstance(record, Mapping):
                continue
            action = record.get("action")
            if is_pending_quality_attempt(record):
                cycle.append(record)
                continue
            if action == STRATEGY_RESET_ACTION:
                break
            if action == "stop":
                if str(record.get("candidateDisposition") or "").startswith("rejected-"):
                    cycle.append(record)
                break
            if action == "continue" and record.get("accepted", True) is True:
                break
        for record in reversed(cycle):
            used += 1
            disposition = record.get("candidateDisposition")
            if disposition in {
                "rejected-regression",
                "rejected-preflight-regression",
                "rejected-no-improvement",
                "rejected-invalid-lineage",
                "rejected-incomplete",
            }:
                consecutive_non_improvements += 1
            elif disposition in {"seed", "promoted", "gate-pass"}:
                consecutive_non_improvements = 0
    remaining = max(0, MAX_REFINEMENT_ATTEMPTS - used)
    remaining_non_improvements = max(
        0,
        MAX_CONSECUTIVE_NON_IMPROVEMENTS - consecutive_non_improvements,
    )
    exhausted = remaining == 0 or remaining_non_improvements == 0
    return {
        # Keep the old names as compatibility aliases for callers and caches.
        "maximumBatches": MAX_REFINEMENT_ATTEMPTS,
        "usedBatches": used,
        "remainingBatches": remaining,
        "maximumAttempts": MAX_REFINEMENT_ATTEMPTS,
        "usedAttempts": used,
        "remainingAttempts": remaining,
        "maximumConsecutiveNonImprovements": MAX_CONSECUTIVE_NON_IMPROVEMENTS,
        "consecutiveNonImprovements": consecutive_non_improvements,
        "remainingNonImprovements": remaining_non_improvements,
        "exhausted": exhausted,
        "exhaustedReason": (
            "three-consecutive-non-improvements"
            if remaining_non_improvements == 0
            else "total-attempt-limit"
            if remaining == 0
            else ""
        ),
        "maximumStrategyResets": MAX_STRATEGY_RESETS,
        "usedStrategyResets": strategy_resets,
        "remainingStrategyResets": max(0, MAX_STRATEGY_RESETS - strategy_resets),
    }


_CORRECTION_PATH_SEGMENT = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9_-]*)(?:\[(?P<index>0|[1-9][0-9]*)\])?$")


def review_target_catalog(spec: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Index every semantic correction target by its declared type and exact id."""

    catalog: dict[str, dict[str, Any]] = {
        target_type: {} for target_type in CORRECTION_TARGET_TYPES
    }
    collections = {
        "component": spec.get("componentTree", []),
        "material": spec.get("materials", []),
        "repetition": spec.get("repetitionSystems", []),
        "feature": spec.get("featureReviewTargets", []),
    }
    for target_type, items in collections.items():
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, Mapping) and isinstance(item.get("id"), str) and item["id"]:
                catalog[target_type][str(item["id"])] = item
    for component in spec.get("componentTree", []):
        if not isinstance(component, Mapping):
            continue
        plan = component.get("detailPlan")
        features = plan.get("features", []) if isinstance(plan, Mapping) else []
        if not isinstance(features, list):
            continue
        for item in features:
            if isinstance(item, Mapping) and isinstance(item.get("id"), str) and item["id"]:
                catalog["detail-feature"][str(item["id"])] = item
    topology = spec.get("surfaceTopologyPlan")
    groups = topology.get("groups", []) if isinstance(topology, Mapping) else []
    if isinstance(groups, list):
        for item in groups:
            if isinstance(item, Mapping) and isinstance(item.get("id"), str) and item["id"]:
                catalog["topology-group"][str(item["id"])] = item
    interaction = spec.get("interactionContract")
    affordances = (
        interaction.get("motionAffordances", [])
        if isinstance(interaction, Mapping)
        else []
    )
    if isinstance(affordances, list):
        for item in affordances:
            if isinstance(item, Mapping) and isinstance(item.get("id"), str) and item["id"]:
                catalog["motion-affordance"][str(item["id"])] = item
    globals_by_id: dict[str, Any] = {
        "spec": spec,
        "silhouette": spec.get("silhouette", {}),
        "coordinate-frame": spec.get("coordinateFrame", {}),
        "camera": spec.get("lookDevTargets", {}),
        "lighting": {
            "lightingFromPhoto": spec.get("lightingFromPhoto", []),
            "lookDevTargets": spec.get("lookDevTargets", {}),
        },
        "render-pipeline": (
            spec.get("viewingContract", {}).get("renderPipeline", {})
            if isinstance(spec.get("viewingContract"), Mapping)
            else {}
        ),
        "evidence": {"viewEvidence": spec.get("viewEvidence", [])},
        "performance": spec.get("performanceAudit", spec.get("performanceBudget", {})),
        "interaction": spec.get("interactionContract", {}),
        "assembly": spec,
    }
    catalog["global"].update(globals_by_id)
    return catalog


def resolve_correction_parameter(
    catalog: Mapping[str, Mapping[str, Any]],
    target_type: Any,
    target_id: Any,
    parameter_path: Any,
) -> tuple[bool, Any]:
    """Resolve a spec-relative correction path without executing selectors or code."""

    if not isinstance(target_type, str) or not isinstance(target_id, str):
        return False, None
    if not isinstance(parameter_path, str) or not parameter_path.strip():
        return False, None
    target_group = catalog.get(target_type)
    if not isinstance(target_group, Mapping) or target_id not in target_group:
        return False, None
    current: Any = target_group[target_id]
    for raw_segment in parameter_path.split("."):
        match = _CORRECTION_PATH_SEGMENT.fullmatch(raw_segment)
        if match is None or not isinstance(current, Mapping):
            return False, None
        key = match.group("key")
        if key not in current:
            return False, None
        current = current[key]
        index_text = match.group("index")
        if index_text is not None:
            index = int(index_text)
            if not isinstance(current, list) or index >= len(current):
                return False, None
            current = current[index]
    return True, current


def correction_batch_from_verdict(verdict: Any) -> dict[str, Any]:
    """Normalize one refine verdict into the atomic batch the builder must apply."""

    if not isinstance(verdict, Mapping) or verdict.get("action") not in REFINEMENT_ACTIONS:
        return {}
    action = str(verdict["action"])
    default_scope = "spec" if action == "refine-spec" else "code" if action == "refine-code" else ""
    issues = [
        {
            "id": str(issue.get("id")),
            "rootCauseKey": str(issue.get("rootCauseKey")),
            "severity": str(issue.get("severity")),
            "failureClass": str(issue.get("failureClass")),
            "targetType": str(issue.get("targetType")),
            "target": str(issue.get("target")),
            "reason": str(issue.get("reason")),
            "observedMismatch": copy.deepcopy(issue.get("observedMismatch")),
            "evidenceCheck": str(issue.get("evidenceCheck")),
        }
        for issue in verdict.get("issues", [])
        if isinstance(issue, Mapping)
        and issue.get("status") == "open"
        and isinstance(issue.get("id"), str)
        and issue.get("id")
    ]
    issue_ids = {issue["id"] for issue in issues}
    corrections: list[dict[str, Any]] = []
    scopes: set[str] = set()
    for index, correction in enumerate(verdict.get("corrections", [])):
        if not isinstance(correction, Mapping) or correction.get("issueId") not in issue_ids:
            continue
        scope = correction.get("scope", default_scope)
        normalized_scope = str(scope) if scope in CORRECTION_SCOPES else default_scope
        if normalized_scope:
            scopes.add(normalized_scope)
        corrections.append(
            {
                "sequence": index + 1,
                "issueId": str(correction.get("issueId")),
                "packId": str(correction.get("packId") or ""),
                "operatorId": str(correction.get("operatorId") or ""),
                "scope": normalized_scope,
                "targetType": str(correction.get("targetType")),
                "target": str(correction.get("target")),
                "parameterPath": str(correction.get("parameterPath")),
                "operation": str(correction.get("operation")),
                "beforeValue": copy.deepcopy(correction.get("beforeValue")),
                "value": copy.deepcopy(correction.get("value")),
                "expectedValue": copy.deepcopy(correction.get("expectedValue")),
                "unit": str(correction.get("unit")),
                "change": str(correction.get("change")),
                "expectedDelta": copy.deepcopy(correction.get("expectedDelta")),
                "expectedVisualEffect": str(
                    correction.get("expectedVisualEffect")
                    or correction.get("change")
                    or ""
                ),
                "falsifyingView": str(
                    correction.get("falsifyingView")
                    or (
                        correction.get("expectedDelta", {}).get("viewIds", [""])[0]
                        if isinstance(correction.get("expectedDelta"), Mapping)
                        and isinstance(correction.get("expectedDelta", {}).get("viewIds"), list)
                        and correction.get("expectedDelta", {}).get("viewIds")
                        else ""
                    )
                ),
            }
        )
    return {
        "artifactType": "threejs-sculpt-correction-batch",
        "version": 2,
        "batchId": str(verdict.get("reviewId") or "refinement"),
        "action": action,
        "atomic": True,
        "issues": issues,
        "issueIds": [issue["id"] for issue in issues],
        "rootCauseKeys": sorted({issue["rootCauseKey"] for issue in issues}),
        "scopes": sorted(scopes),
        "corrections": corrections,
        "correctionCount": len(corrections),
        "impactAssessment": copy.deepcopy(verdict.get("impactAssessment")),
        "executionPolicy": "apply-all-corrections-before-render",
        "reviewPolicy": "one-render-and-one-review-after-the-complete-batch",
    }


def correction_batch_from_plan(
    action: Any,
    batch_id: Any,
    plan: Any,
    impact_assessment: Any = None,
) -> dict[str, Any]:
    """Keep the legacy manual correction plan on the same atomic execution contract."""

    if action not in REFINEMENT_ACTIONS or not isinstance(plan, list) or not plan:
        return {}
    scope = "spec" if action == "refine-spec" else "code"
    issues: list[dict[str, Any]] = []
    corrections: list[dict[str, Any]] = []
    for index, item in enumerate(plan):
        if not isinstance(item, Mapping):
            continue
        issue_id = f"{batch_id or 'manual-refinement'}-{index + 1}"
        reason = str(item.get("reason") or "Apply the declared correction.")
        issues.append(
            {
                "id": issue_id,
                "rootCauseKey": issue_id,
                "failureClass": "other",
                "severity": "major",
                "targetType": str(item.get("targetType")),
                "target": str(item.get("target")),
                "reason": reason,
                "observedMismatch": {
                    "parameterPath": str(item.get("parameterPath")),
                    "actual": copy.deepcopy(item.get("beforeValue")),
                    "expected": copy.deepcopy(item.get("expectedValue")),
                    "unit": str(item.get("unit")),
                    "tolerance": copy.deepcopy(
                        item.get("expectedDelta", {}).get("tolerance")
                        if isinstance(item.get("expectedDelta"), Mapping)
                        else None
                    ),
                    "viewIds": copy.deepcopy(
                        item.get("expectedDelta", {}).get("viewIds", [])
                        if isinstance(item.get("expectedDelta"), Mapping)
                        else []
                    ),
                },
                "evidenceCheck": reason,
            }
        )
        corrections.append(
            {
                "sequence": index + 1,
                "issueId": issue_id,
                "scope": scope,
                "targetType": str(item.get("targetType")),
                "target": str(item.get("target")),
                "parameterPath": str(item.get("parameterPath")),
                "operation": str(item.get("operation")),
                "beforeValue": copy.deepcopy(item.get("beforeValue")),
                "value": copy.deepcopy(item.get("value")),
                "expectedValue": copy.deepcopy(item.get("expectedValue")),
                "unit": str(item.get("unit")),
                "change": reason,
                "expectedDelta": copy.deepcopy(item.get("expectedDelta")),
            }
        )
    if not corrections:
        return {}
    return {
        "artifactType": "threejs-sculpt-correction-batch",
        "version": 2,
        "batchId": str(batch_id or "manual-refinement"),
        "action": str(action),
        "atomic": True,
        "issues": issues,
        "issueIds": [issue["id"] for issue in issues],
        "scopes": [scope],
        "corrections": corrections,
        "correctionCount": len(corrections),
        "impactAssessment": copy.deepcopy(impact_assessment),
        "executionPolicy": "apply-all-corrections-before-render",
        "reviewPolicy": "one-render-and-one-review-after-the-complete-batch",
    }


def parse_schema_version(value: Any) -> tuple[int, int, int]:
    """Parse a numeric schema version without float or lexical comparison errors."""
    if not isinstance(value, str):
        raise ValueError("schemaVersion must be a string in major.minor format")
    match = _SCHEMA_VERSION_PATTERN.fullmatch(value.strip())
    if match is None:
        raise ValueError(
            f"invalid schemaVersion {value!r}; expected major.minor or major.minor.patch"
        )
    return (
        int(match.group("major")),
        int(match.group("minor")),
        int(match.group("patch") or 0),
    )


def schema_version_at_least(
    spec_or_version: Mapping[str, Any] | str,
    minimum: str,
) -> bool:
    """Compare schema versions numerically, defaulting a missing spec field to v2.0."""
    if isinstance(spec_or_version, Mapping):
        value = spec_or_version.get("schemaVersion", LEGACY_SCHEMA_VERSION)
    else:
        value = spec_or_version
    return parse_schema_version(value) >= parse_schema_version(minimum)


def component_type(component: Mapping[str, Any]) -> str:
    """Return the additive component kind; legacy components are geometry parts."""
    value = component.get("componentType", "part")
    return value if isinstance(value, str) else str(value)


def detail_feature_count(spec: Mapping[str, Any]) -> int:
    """Count explicitly inventoried details, falling back for legacy specs."""

    plans_seen = False
    count = 0
    legacy_count = 0
    for component in spec.get("componentTree", []):
        if not isinstance(component, Mapping) or component_type(component) == "assembly":
            continue
        local_features = component.get("localFeatures")
        if isinstance(local_features, list):
            legacy_count += len(local_features)
        plan = component.get("detailPlan")
        if not isinstance(plan, Mapping):
            continue
        plans_seen = True
        features = plan.get("features")
        if isinstance(features, list):
            count += len(features)
    return count if plans_seen else legacy_count


def parse_json(text: str, label: str = "JSON") -> Any:
    try:
        return json.loads(
            text,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"{label} contains non-finite number {value}")
            ),
        )
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid {label}: {exc}") from exc


def load_spec_file(path: Path) -> dict[str, Any]:
    payload = parse_json(path.read_text(encoding="utf-8"), "spec JSON")
    if not isinstance(payload, dict):
        raise ValueError("spec must be a JSON object")
    if payload.get("schemaVersion") == "4.0":
        # Lazy import avoids coupling the stable schema 3.1 engine to the
        # optional compositional manifest layer during module import.
        from sculpt_modules import resolve_manifest

        return resolve_manifest(path, payload, allow_missing=True)
    return payload


def write_spec_atomic(path: Path, spec: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(spec, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def file_sha256(path: Path) -> str:
    """Return a full content digest without loading large evidence files at once."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_dimensions(path: Path) -> tuple[int, int]:
    """Read PNG/JPEG dimensions and reject files that merely have an image extension."""
    with path.open("rb") as handle:
        header = handle.read(32)
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            if len(header) < 24 or header[12:16] != b"IHDR":
                raise ValueError("invalid PNG header")
            width, height = struct.unpack(">II", header[16:24])
            if width <= 0 or height <= 0:
                raise ValueError("invalid PNG dimensions")
            return width, height
        if not header.startswith(b"\xff\xd8"):
            raise ValueError("evidence must be a real PNG or JPEG image")
        handle.seek(2)
        while True:
            marker_prefix = handle.read(1)
            if not marker_prefix:
                break
            if marker_prefix != b"\xff":
                continue
            marker = handle.read(1)
            while marker == b"\xff":
                marker = handle.read(1)
            if not marker or marker in {b"\xd8", b"\xd9"}:
                continue
            length_bytes = handle.read(2)
            if len(length_bytes) != 2:
                break
            segment_length = struct.unpack(">H", length_bytes)[0]
            if segment_length < 2:
                break
            marker_value = marker[0]
            if marker_value in {
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            }:
                payload = handle.read(segment_length - 2)
                if len(payload) < 5:
                    break
                height, width = struct.unpack(">HH", payload[1:5])
                if width <= 0 or height <= 0:
                    break
                return width, height
            handle.seek(segment_length - 2, os.SEEK_CUR)
    raise ValueError("invalid or unsupported JPEG image")


def visual_evidence_manifest_sha256(manifest: Mapping[str, Any]) -> str:
    """Digest the immutable evidence manifest, excluding compatibility aliases."""
    payload = {
        key: value
        for key, value in manifest.items()
        if key not in {"manifestSha256", "evidenceSet", "type"}
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _stored_dimensions(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, dict):
        return None
    width = value.get("width")
    height = value.get("height")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or not isinstance(height, int)
        or isinstance(height, bool)
        or width <= 0
        or height <= 0
    ):
        return None
    return width, height


def visual_evidence_integrity_failures(evidence: Any) -> list[str]:
    """Validate evidence provenance, content hashes, image identity, and dimensions."""
    if not isinstance(evidence, dict):
        return ["visual evidence must be a comparison manifest object"]
    failures: list[str] = []
    if evidence.get("artifactType") != VISUAL_EVIDENCE_ARTIFACT_TYPE:
        failures.append("visual evidence must come from the compare command")
    if evidence.get("manifestVersion") != VISUAL_EVIDENCE_MANIFEST_VERSION:
        failures.append(
            f"visual evidence manifestVersion must be {VISUAL_EVIDENCE_MANIFEST_VERSION}"
        )
    if evidence.get("generator") != VISUAL_EVIDENCE_GENERATOR:
        failures.append("visual evidence generator provenance is missing or invalid")
    stored_manifest_hash = evidence.get("manifestSha256")
    try:
        computed_manifest_hash = visual_evidence_manifest_sha256(evidence)
    except (TypeError, ValueError):
        computed_manifest_hash = ""
    if (
        not isinstance(stored_manifest_hash, str)
        or len(stored_manifest_hash) != 64
        or stored_manifest_hash != computed_manifest_hash
    ):
        failures.append("visual evidence manifest hash is missing or does not match its contents")

    views = evidence.get("views")
    if not isinstance(views, list) or not views:
        failures.append("visual evidence manifest needs at least one view")
        return failures

    top_comparison = evidence.get("comparisonImage")
    top_hash = evidence.get("comparisonSha256")
    top_dimensions = _stored_dimensions(evidence.get("comparisonDimensions"))
    if not isinstance(top_comparison, str) or not top_comparison.strip():
        failures.append("visual evidence manifest comparisonImage is required")
    if not isinstance(top_hash, str) or len(top_hash) != 64:
        failures.append("visual evidence manifest comparisonSha256 is required")
    if top_dimensions is None:
        failures.append("visual evidence manifest comparisonDimensions are required")

    seen_view_ids: set[str] = set()
    inspected_files: dict[str, tuple[str, tuple[int, int]] | str] = {}
    for index, view in enumerate(views):
        label = f"visual evidence view {index}"
        if not isinstance(view, dict):
            failures.append(f"{label} must be an object")
            continue
        view_id = view.get("viewId")
        if not isinstance(view_id, str) or not view_id.strip():
            failures.append(f"{label} needs viewId")
        elif view_id in seen_view_ids:
            failures.append(f"duplicate visual evidence viewId {view_id!r}")
        else:
            seen_view_ids.add(view_id)
        provenance = view.get("referenceProvenance")
        if provenance is not None:
            if not isinstance(provenance, dict):
                failures.append(f"{label} referenceProvenance must be an object")
            else:
                origin = provenance.get("origin")
                allowed_use = provenance.get("allowedUse")
                if origin not in {"observed", "prepared-reference", "synthetic-hypothesis"}:
                    failures.append(f"{label} referenceProvenance.origin is invalid")
                if allowed_use not in {"acceptance", "planning-veto"}:
                    failures.append(f"{label} referenceProvenance.allowedUse is invalid")
                if origin == "synthetic-hypothesis" and allowed_use != "planning-veto":
                    failures.append(
                        f"{label} synthetic-hypothesis references may only use planning-veto"
                    )
        identities: dict[str, tuple[str, str, tuple[int, int] | None]] = {}
        for prefix, path_field in (
            ("reference", "referenceImage"),
            ("render", "renderScreenshot"),
            ("comparison", "comparisonImage"),
        ):
            path_value = view.get(path_field)
            digest_value = view.get(f"{prefix}Sha256")
            dimensions_value = _stored_dimensions(view.get(f"{prefix}Dimensions"))
            if not isinstance(path_value, str) or not path_value.strip():
                failures.append(f"{label} missing {path_field}")
                continue
            if "://" in path_value or path_value.startswith(("data:", "blob:")):
                failures.append(f"{label} {path_field} must be a local immutable file")
                continue
            if not isinstance(digest_value, str) or len(digest_value) != 64:
                failures.append(f"{label} missing {prefix}Sha256")
                continue
            if dimensions_value is None:
                failures.append(f"{label} missing {prefix}Dimensions")
                continue
            path = Path(path_value).expanduser()
            if not path.is_file():
                failures.append(f"{label} {path_field} does not exist: {path_value}")
                continue
            cache_key = str(path.resolve())
            inspected = inspected_files.get(cache_key)
            if inspected is None:
                try:
                    inspected = (file_sha256(path), image_dimensions(path))
                except (OSError, ValueError) as exc:
                    inspected = str(exc)
                inspected_files[cache_key] = inspected
            if isinstance(inspected, str):
                failures.append(
                    f"{label} {path_field} is not valid image evidence: {inspected}"
                )
                continue
            actual_digest, actual_dimensions = inspected
            if actual_digest != digest_value:
                failures.append(f"{label} {path_field} content changed after comparison")
            if actual_dimensions != dimensions_value:
                failures.append(f"{label} {path_field} dimensions changed after comparison")
            identities[prefix] = (path_value, digest_value, dimensions_value)
        reference_identity = identities.get("reference")
        render_identity = identities.get("render")
        comparison_identity = identities.get("comparison")
        if (
            reference_identity is not None
            and render_identity is not None
            and reference_identity[1] == render_identity[1]
        ):
            failures.append(f"{label} reference and render cannot be the same image content")
        if comparison_identity is not None:
            if comparison_identity[0] != top_comparison or comparison_identity[1] != top_hash:
                failures.append(f"{label} comparison identity does not match the manifest")
            if top_dimensions is not None and comparison_identity[2] != top_dimensions:
                failures.append(f"{label} comparison dimensions do not match the manifest")
    return list(dict.fromkeys(failures))


def visual_evidence_authority_failures(
    evidence: Any,
    required_view_ids: Iterable[str] | None = None,
) -> list[str]:
    """Reject synthetic hypotheses as acceptance truth while preserving legacy evidence."""
    if not isinstance(evidence, dict):
        return ["visual evidence must be a comparison manifest object"]
    failures: list[str] = []
    required = {str(item) for item in required_view_ids} if required_view_ids is not None else None
    views = evidence.get("views")
    if not isinstance(views, list):
        return ["visual evidence manifest needs views"]
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            continue
        view_id = str(view.get("viewId") or "primary")
        if required is not None and view_id not in required:
            continue
        provenance = view.get("referenceProvenance")
        if provenance is None:
            continue  # schema-v1 compatibility; new compare output always records it
        if not isinstance(provenance, dict):
            failures.append(f"visual evidence view {index} has invalid reference provenance")
            continue
        if provenance.get("origin") not in {"observed", "prepared-reference"}:
            failures.append(
                f"visual evidence view {index} uses a synthetic hypothesis, not acceptance reference truth"
            )
        if provenance.get("allowedUse") != "acceptance":
            failures.append(
                f"visual evidence view {index} is limited to planning/veto and cannot approve a gate"
            )
    return list(dict.fromkeys(failures))


def is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


CORE_COMPLEXITY_AXES = (
    "silhouetteComplexity",
    "formTopologyComplexity",
    "componentCount",
    "hierarchyDepth",
    "repetitionDensity",
    "materialLayerCount",
    "localDetailDensity",
    "representationComplexity",
)

MODIFIER_COMPLEXITY_AXES = (
    "occlusionRisk",
    "actionReadinessNeed",
)

TIER_RANKS = {"simple": 1, "moderate": 2, "complex": 3, "ultra": 4}
RANK_TO_TIER = {1: "simple", 2: "moderate", 3: "complex", 4: "ultra"}


def is_stateful_complexity_contract(complexity: Mapping[str, Any]) -> bool:
    """Return whether a complexity payload uses the current stateful shape."""
    if not isinstance(complexity, Mapping):
        return False
    scores = complexity.get("scores")
    return (
        "status" in complexity
        or "modifiers" in complexity
        or (
            isinstance(scores, Mapping)
            and "formTopologyComplexity" in scores
        )
    )


def derive_complexity_tier(complexity: Mapping[str, Any]) -> dict[str, Any]:
    """Derive tier, requiredDepth, and overrides from current or legacy complexity."""
    if not isinstance(complexity, Mapping):
        return {
            "status": "unassessed",
            "baseTier": "unassessed",
            "tier": "unassessed",
            "requiredDepth": "moderate",
            "activeOverrides": [],
            "highCount": 0,
            "extremeCount": 0,
            "scoreSum": 0,
        }

    status = complexity.get("status")
    scores = complexity.get("scores") if isinstance(complexity.get("scores"), Mapping) else {}
    modifiers = complexity.get("modifiers") if isinstance(complexity.get("modifiers"), Mapping) else {}

    is_stateful = is_stateful_complexity_contract(complexity)

    if not is_stateful:
        tier = str(complexity.get("tier") or "moderate")
        tier = tier if tier in TIER_RANKS else "moderate"
        return {
            "status": "assessed",
            "baseTier": tier,
            "tier": tier,
            "requiredDepth": tier,
            "activeOverrides": ["legacy flat complexity tier"],
            "highCount": 0,
            "extremeCount": 0,
            "scoreSum": 0,
        }

    if status == "unassessed":
        hint = str(complexity.get("initialTierHint") or complexity.get("tier") or "moderate")
        req_depth = hint if hint in TIER_RANKS else "moderate"
        return {
            "status": "unassessed",
            "baseTier": "unassessed",
            "tier": "unassessed",
            "requiredDepth": req_depth,
            "activeOverrides": [],
            "highCount": 0,
            "extremeCount": 0,
            "scoreSum": 0,
        }

    core_values: list[int] = []
    for axis in CORE_COMPLEXITY_AXES:
        val = scores.get(axis)
        if not isinstance(val, int) or isinstance(val, bool) or val < 0 or val > 3:
            hint = str(complexity.get("initialTierHint") or complexity.get("tier") or "moderate")
            req_depth = hint if hint in TIER_RANKS else "moderate"
            return {
                "status": "unassessed",
                "baseTier": "unassessed",
                "tier": "unassessed",
                "requiredDepth": req_depth,
                "activeOverrides": [],
                "highCount": 0,
                "extremeCount": 0,
                "scoreSum": 0,
            }
        core_values.append(val)

    high = sum(1 for v in core_values if v >= 2)
    extreme = sum(1 for v in core_values if v == 3)
    score_sum = sum(core_values)

    if extreme >= 3 or (extreme >= 2 and high >= 5) or high >= 7:
        base_tier = "ultra"
    elif extreme >= 1 or high >= 3:
        base_tier = "complex"
    elif high >= 1 or score_sum >= 4:
        base_tier = "moderate"
    else:
        base_tier = "simple"

    active_overrides: list[str] = []
    occ_risk = modifiers.get("occlusionRisk")
    action_need = modifiers.get("actionReadinessNeed")

    action_min_depth = "simple"
    if isinstance(action_need, int) and not isinstance(action_need, bool):
        if action_need == 2:
            action_min_depth = "moderate"
            if TIER_RANKS[base_tier] < TIER_RANKS["moderate"]:
                active_overrides.append("actionReadinessNeed=2 promoted requiredDepth to moderate")
        elif action_need == 3:
            action_min_depth = "complex"
            if TIER_RANKS[base_tier] < TIER_RANKS["complex"]:
                active_overrides.append("actionReadinessNeed=3 promoted requiredDepth to complex")
            active_overrides.append("actionReadinessNeed=3 requires action-ready hierarchy")

    if isinstance(occ_risk, int) and not isinstance(occ_risk, bool):
        if occ_risk > 0:
            active_overrides.append(f"occlusionRisk={occ_risk} forbids 2x2 turnaround view skip")
        if occ_risk == 3:
            active_overrides.append("occlusionRisk=3 forbids pass suitability score")

    required_rank = max(TIER_RANKS[base_tier], TIER_RANKS[action_min_depth])
    required_depth = RANK_TO_TIER[required_rank]

    return {
        "status": "assessed",
        "baseTier": base_tier,
        "tier": base_tier,
        "requiredDepth": required_depth,
        "activeOverrides": active_overrides,
        "highCount": high,
        "extremeCount": extreme,
        "scoreSum": score_sum,
    }


def complexity_minimums(complexity: str) -> dict[str, int]:
    presets = {
        "simple": {
            "components": 1,
            "materials": 1,
            "macroLayers": 1,
            "mesoLayers": 0,
            "microLayers": 0,
            "depthLevels": 1,
        },
        "moderate": {
            "components": 5,
            "materials": 2,
            "macroLayers": 1,
            "mesoLayers": 2,
            "microLayers": 1,
            "depthLevels": 2,
        },
        "complex": {
            "components": 10,
            "materials": 3,
            "macroLayers": 1,
            "mesoLayers": 3,
            "microLayers": 2,
            "depthLevels": 3,
        },
        "ultra": {
            "components": 18,
            "materials": 4,
            "macroLayers": 1,
            "mesoLayers": 5,
            "microLayers": 3,
            "depthLevels": 4,
        },
    }
    return copy.deepcopy(presets.get(complexity, presets["moderate"]))


def adaptive_hypothesis_views(
    complexity: str,
    quality_profile: str,
    first_view: str = "three-quarter",
) -> list[str]:
    """Return the smallest cross-view set that can expose front-only geometry."""
    if first_view not in {"three-quarter", "exploded"}:
        raise ValueError("first hypothesis view must be three-quarter or exploded")
    views = ["side"]
    if quality_profile == "reference-fidelity" or complexity in {"moderate", "complex", "ultra"}:
        views.insert(0, first_view)
    if complexity in {"complex", "ultra"}:
        views.append("back")
    return views


def _visual_pass(
    pass_id: str,
    label: str,
    objective: str,
    acceptance: list[str],
    required_layers: dict[str, float],
    required_views: list[str] | None = None,
    diagnostic_views: list[str] | None = None,
    *,
    owned_layers: list[str] | None = None,
    visual_baseline_pass_id: str | None = None,
    preserve_layers: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": pass_id,
        "label": label,
        "objective": objective,
        "componentRefs": ["root"],
        "acceptance": acceptance,
        "evidenceType": "visual",
        "requiredViews": required_views or ["primary"],
        "diagnosticViews": diagnostic_views or [],
        "requiredLayerScores": required_layers,
        "ownedLayers": owned_layers or list(required_layers),
        "minimumRefinementDelta": MIN_REFINEMENT_SCORE_DELTA,
        "maximumVisualRegression": MAX_REFINEMENT_REGRESSION,
    }
    if visual_baseline_pass_id:
        payload["visualBaselinePassId"] = visual_baseline_pass_id
        payload["preserveLayers"] = preserve_layers or []
    return payload


def build_pass_plan(
    complexity: str = "moderate",
    intended_use: str | None = None,
    quality_profile: str = "balanced",
    *,
    interaction_required: bool | None = None,
    hypothesis_first_view: str = "three-quarter",
) -> list[dict[str, Any]]:
    """Return the quality-first pipeline.

    ``intended_use`` remains only as a migration hint. New specs decide whether
    to append interaction from their explicit interaction contract. Performance
    is a separate optional audit and never a modeling pass.
    """
    reference_fidelity = quality_profile == "reference-fidelity"
    diagnostic_views = adaptive_hypothesis_views(
        complexity,
        quality_profile,
        hypothesis_first_view,
    )
    strict = 0.84 if reference_fidelity else 0.72
    blockout_layers = {
        "silhouette": 0.85 if reference_fidelity else 0.72,
        "assemblyCorrectness": strict,
        "proportionBalance": strict,
        "shapeSilhouette": strict,
    }
    form_layers = (
        {
            "silhouette": 0.86,
            "structure": 0.84,
            "formDetail": 0.82,
            "assemblyCorrectness": 0.86,
            "proportionBalance": 0.85,
            "shapeSilhouette": 0.85,
            "signatureDetail": 0.80,
        }
        if reference_fidelity
        else {
            "silhouette": 0.76,
            "structure": 0.74,
            "formDetail": 0.72,
            "assemblyCorrectness": 0.76,
            "proportionBalance": 0.74,
            "shapeSilhouette": 0.74,
            "signatureDetail": 0.68,
        }
    )
    lookdev_layers = (
        {
            "material": 0.85,
            "lighting": 0.80,
            "materialPlausibility": 0.84,
            "surfaceQuality": 0.82,
        }
        if reference_fidelity
        else {
            "material": 0.72,
            "lighting": 0.68,
            "materialPlausibility": 0.72,
            "surfaceQuality": 0.68,
        }
    )

    def sanity(categories: list[str]) -> dict[str, Any]:
        return {
            "obviousErrorVeto": True,
            "requiredCategories": categories,
            "reviewRule": (
                "Inspect every required category once, list all visible actionable issues in one "
                "verdict, and reject any critical or major wrong placement, imbalance, wrong form, "
                "implausible material, or identity-detail defect regardless of average score."
            ),
        }

    passes = [
        _visual_pass(
            "blockout",
            "Khối chính",
            "Match overall silhouette, framing, mass, and proportions before detail.",
            [
                "Reference and render preserve the same overall silhouette.",
                "Primary masses and framing are correct before detail work.",
            ],
            blockout_layers,
            # Synthetic views guide construction only; observed evidence still
            # owns Blockout acceptance.
            diagnostic_views=[],
            owned_layers=list(blockout_layers),
        )
    ]
    passes[0]["visualSanity"] = sanity(
        ["assemblyCorrectness", "proportionBalance", "shapeSilhouette"]
    )
    passes.append(
        _visual_pass(
            "form",
            "Hoàn thiện hình",
            "Resolve structure, attachments, proportions, shape, and visible identity details.",
            [
                "Macro and required meso forms match the reference.",
                "All major child parts attach to the correct parent, position, orientation, and scale.",
                "No obvious imbalance, floating joint, accidental intersection, or implausible form remains.",
                "Signature details required to identify the object are present and proportionate.",
            ],
            form_layers,
            diagnostic_views=diagnostic_views,
            owned_layers=list(form_layers),
            visual_baseline_pass_id="blockout",
            preserve_layers=list(blockout_layers),
        )
    )
    passes[-1]["visualSanity"] = sanity(
        ["assemblyCorrectness", "proportionBalance", "shapeSilhouette", "signatureDetail"]
    )
    lookdev_views = ["reference"]
    if quality_profile == "reference-fidelity":
        lookdev_views = ["neutral", "grazing", "reference"]
    passes.append(
        _visual_pass(
            "lookdev",
            "Vật liệu và ánh sáng",
            "Validate color, material response, surface detail, lighting, and contact shadows together.",
            [
                "Materials preserve the reference palette and roughness response.",
                "Lighting reveals form without baking the source lighting into albedo.",
                "Contact shadows and surface detail remain believable at the target view.",
            ],
            lookdev_layers,
            lookdev_views,
            [],
            owned_layers=list(lookdev_layers),
            visual_baseline_pass_id="form",
            preserve_layers=list(form_layers),
        )
    )
    passes[-1]["visualSanity"] = sanity(
        ["materialPlausibility", "surfaceQuality"]
    )
    if interaction_required is None:
        interaction_required = intended_use in INTERACTIVE_USES
    if interaction_required:
        passes.append(
            {
                "id": "interaction",
                "label": "Tương tác",
                "objective": "Validate only evidence-backed or user-requested motion affordances.",
                "componentRefs": ["root"],
                "acceptance": [
                    "Every active motion targets an exact component id with numeric pivot, axis, and limits/rate.",
                    "No component intersects, detaches, or moves implausibly across its tested key states.",
                    "The model remains stable before, during, and after interaction.",
                ],
                "evidenceType": "runtime",
                "requiredRuntimeChecks": [
                    "loads",
                    "transforms",
                    "interaction",
                    "motion-clearance",
                    "visual-no-regression",
                ],
            }
        )
    return passes


def interaction_required(spec: Mapping[str, Any]) -> bool:
    """Return whether the Interaction phase must remain on the active plan.

    An unassessed object keeps the phase visible so the LLM cannot silently
    finish after Lookdev without applying object-class motion knowledge. Once
    it records a justified ``not-required`` decision, sync removes the phase;
    a required contract keeps the runtime gate active.
    """

    contract = spec.get("interactionContract")
    if isinstance(contract, Mapping):
        return contract.get("status") != "not-required"
    readiness = spec.get("actionReadiness")
    return isinstance(readiness, Mapping) and readiness.get("enabled") is True


def _hypothesis_first_view(spec: Mapping[str, Any]) -> str:
    policy = spec.get("viewHypothesisPolicy")
    if isinstance(policy, Mapping) and policy.get("layoutId") == (
        "assembly-exploded-2x2-v1"
    ):
        return "exploded"
    return "three-quarter"


def pass_order(spec: dict[str, Any]) -> list[str]:
    ids = [
        str(item["id"])
        for item in spec.get("buildPasses", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip()
    ]
    if schema_version_at_least(spec, CURRENT_SCHEMA_VERSION):
        expected = [
            item["id"]
            for item in build_pass_plan(
                _spec_complexity(spec),
                None,
                str(spec.get("qualityProfile") or "balanced"),
                interaction_required=interaction_required(spec),
                hypothesis_first_view=_hypothesis_first_view(spec),
            )
        ]
        retired = {"structure", "structural-pass", "optimization", "optimization-pass"}
        return [
            *expected,
            *(item for item in ids if item not in expected and item not in retired),
        ]
    return ids or DEFAULT_PASS_ORDER.copy()


def pass_config(spec: dict[str, Any], pass_id: str) -> dict[str, Any]:
    for item in spec.get("buildPasses", []):
        if isinstance(item, dict) and item.get("id") == pass_id:
            return item
    return {}


def _spec_complexity(spec: Mapping[str, Any]) -> str:
    assessment = spec.get("preSpecAssessment")
    complexity = assessment.get("complexity") if isinstance(assessment, dict) else None
    if isinstance(complexity, dict):
        derivation = derive_complexity_tier(complexity)
        req = derivation.get("requiredDepth")
        if req in TIER_RANKS:
            return str(req)
        tier = complexity.get("tier")
        if tier in TIER_RANKS:
            return str(tier)
        hint = complexity.get("initialTierHint")
        if hint in TIER_RANKS:
            return str(hint)
    decision = assessment.get("specDepthDecision") if isinstance(assessment, dict) else None
    if isinstance(decision, dict):
        req = decision.get("requiredDepth")
        if req in TIER_RANKS:
            return str(req)
    return "moderate"


def effective_pass_config(spec: dict[str, Any], pass_id: str) -> dict[str, Any]:
    """Merge custom pass data with non-lowerable profile minimums."""
    configured = copy.deepcopy(pass_config(spec, pass_id))
    canonical = next(
        (
            item
            for item in build_pass_plan(
                _spec_complexity(spec),
                None,
                str(spec.get("qualityProfile") or "balanced"),
                interaction_required=interaction_required(spec),
                hypothesis_first_view=_hypothesis_first_view(spec),
            )
            if item.get("id") == pass_id
        ),
        {},
    )
    if not canonical:
        return configured
    merged = copy.deepcopy(configured)
    for key, value in canonical.items():
        merged.setdefault(key, copy.deepcopy(value))
    for key in (
        "requiredViews",
        "diagnosticViews",
        "requiredMetrics",
        "requiredArtifacts",
        "requiredRuntimeChecks",
        "ownedLayers",
        "preserveLayers",
    ):
        minimum = canonical.get(key)
        selected = configured.get(key)
        if isinstance(minimum, list):
            values = [item for item in selected if isinstance(item, str)] if isinstance(selected, list) else []
            merged[key] = list(dict.fromkeys([*minimum, *values]))
    if pass_id in {"structure", "form", "structural-pass", "form-refinement"}:
        policy = spec.get("viewHypothesisPolicy")
        if isinstance(policy, Mapping):
            decision = policy.get("decision")
            hypotheses_active = policy.get("enabled") is True and decision not in {
                "not-needed",
                "not-applicable",
            }
            if not hypotheses_active:
                merged["diagnosticViews"] = []
    minimum_layers = canonical.get("requiredLayerScores")
    selected_layers = configured.get("requiredLayerScores")
    if isinstance(minimum_layers, dict):
        merged_layers = dict(selected_layers) if isinstance(selected_layers, dict) else {}
        for layer, floor in minimum_layers.items():
            selected = merged_layers.get(layer)
            if is_number(floor) and (not is_number(selected) or float(selected) < float(floor)):
                merged_layers[layer] = floor
        merged["requiredLayerScores"] = merged_layers
    if canonical.get("requiredPostOptimizationVisualReview") is True:
        merged["requiredPostOptimizationVisualReview"] = True
    if isinstance(canonical.get("visualBaselinePassId"), str):
        merged["visualBaselinePassId"] = canonical["visualBaselinePassId"]
    configured_tolerance = configured.get("maximumVisualRegression")
    canonical_tolerance = canonical.get("maximumVisualRegression")
    if is_number(canonical_tolerance):
        merged["maximumVisualRegression"] = (
            min(float(configured_tolerance), float(canonical_tolerance))
            if is_number(configured_tolerance) and float(configured_tolerance) >= 0
            else canonical_tolerance
        )
    configured_delta = configured.get("minimumRefinementDelta")
    canonical_delta = canonical.get("minimumRefinementDelta")
    if is_number(canonical_delta):
        merged["minimumRefinementDelta"] = (
            max(float(configured_delta), float(canonical_delta))
            if is_number(configured_delta)
            else canonical_delta
        )
    configured_overall = configured.get("minimumOverallScore")
    canonical_overall = canonical.get("minimumOverallScore")
    if is_number(canonical_overall):
        merged["minimumOverallScore"] = (
            max(float(configured_overall), float(canonical_overall))
            if is_number(configured_overall)
            else canonical_overall
        )
    # New specs use a lightweight visual gate.  Keep the legacy profile
    # targets in the source spec as aspirational guidance, but do not let them
    # silently recreate the old four-layer hard gate at execution time.
    if simplified_visual_gate_enabled(spec, pass_id):
        merged["minimumOverallScore"] = SIMPLIFIED_AI_OVERALL_FLOOR
        merged["requiredLayerScores"] = {}
        merged["ownedLayers"] = []
        # Later phases may change form/materials; their protection comes from
        # the comparison artifact, scout, and human approval rather than
        # mandatory duplicate layer scores.
        merged["preserveLayers"] = []
        merged["maximumVisualRegression"] = 0.10 if pass_id != "blockout" else 0.0
        # A two-decimal composite improvement is enough to move the champion
        # in the lightweight loop; requiring the legacy 0.02 delta made
        # ordinary 0.80 -> 0.82 refinements fail on floating-point boundaries.
        merged["minimumRefinementDelta"] = 0.01
        sanity = merged.get("visualSanity")
        if isinstance(sanity, dict):
            sanity = copy.deepcopy(sanity)
            sanity["requiredCategories"] = []
            merged["visualSanity"] = sanity
        merged["qualityGateMode"] = "ai-scout-human"
    return merged


def evidence_type(spec: dict[str, Any], pass_id: str) -> str:
    configured = pass_config(spec, pass_id).get("evidenceType")
    if configured in {"visual", "runtime", "metrics"}:
        return str(configured)
    if pass_id in RUNTIME_PASS_IDS:
        return "runtime"
    if pass_id in METRICS_PASS_IDS:
        return "metrics"
    return "visual"


def phase_execution_version(spec: Mapping[str, Any]) -> int:
    contract = spec.get("phaseExecutionContract")
    version = contract.get("version") if isinstance(contract, Mapping) else None
    return int(version) if isinstance(version, int) and not isinstance(version, bool) else 0


def simplified_visual_gate_enabled(
    spec: Mapping[str, Any],
    pass_id: str | None = None,
) -> bool:
    """Return whether the v4 lightweight visual gate applies to a pass."""

    if phase_execution_version(spec) < SIMPLIFIED_PHASE_EXECUTION_VERSION:
        return False
    if pass_id is None:
        return True
    configured = pass_config(dict(spec), pass_id)
    configured_kind = configured.get("evidenceType")
    if configured_kind in {"runtime", "metrics"}:
        return False
    return pass_id not in RUNTIME_PASS_IDS and pass_id not in METRICS_PASS_IDS


def visual_gate_threshold(spec: Mapping[str, Any], pass_id: str) -> float:
    """Return the executable AI threshold, distinct from aspirational fidelity."""

    if simplified_visual_gate_enabled(spec, pass_id):
        return SIMPLIFIED_AI_OVERALL_FLOOR
    configured = pass_config(dict(spec), pass_id)
    minimum = configured.get("minimumOverallScore")
    if is_number(minimum):
        return float(minimum)
    return visual_acceptance_threshold(dict(spec))


def spec_content_hash(spec: dict[str, Any]) -> str:
    stable = {key: value for key, value in spec.items() if key not in DERIVED_SPEC_FIELDS}
    encoded = json.dumps(stable, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def generation_spec_projection(spec: Mapping[str, Any], pass_id: str) -> dict[str, Any]:
    """Return exactly the phase-owned inputs consumed by generated TypeScript.

    The generator uses this projection as well as hashing it. This keeps a
    Lookdev or Interaction edit from changing Blockout source/receipts while
    preserving the guarantee that every hashed input can affect generated code.
    """

    canonical = (
        "form" if pass_id in {"structure", "structural-pass", "form-refinement"}
        else "lookdev" if pass_id in {"material-pass", "surface-pass", "lighting-pass"}
        else "interaction" if pass_id in RUNTIME_PASS_IDS
        else pass_id
    )
    ids = pass_order(dict(spec))
    selected_index = ids.index(pass_id) if pass_id in ids else 0
    selected_ids = set(ids[: selected_index + 1])
    build_passes = [
        {
            key: copy.deepcopy(item.get(key))
            for key in ("id", "componentRefs")
            if key in item
        }
        for item in spec.get("buildPasses", [])
        if isinstance(item, Mapping) and item.get("id") in selected_ids
    ]
    explicit_refs = {
        str(component_id)
        for item in build_passes
        for component_id in (
            item.get("componentRefs", [])
            if isinstance(item.get("componentRefs"), list)
            else []
        )
        if str(component_id).strip()
    }
    all_components = [
        item for item in spec.get("componentTree", []) if isinstance(item, Mapping)
    ]
    component_by_id = {
        str(item.get("id")): item
        for item in all_components
        if isinstance(item.get("id"), str) and str(item.get("id")).strip()
    }
    allowed_levels = {
        "blockout": {"macro"},
        "form": {"macro", "meso", "micro"},
        "lookdev": {"macro", "meso", "micro"},
        "interaction": {"macro", "meso", "micro"},
    }.get(canonical, {"macro", "meso", "micro"})
    included_ids: set[str] = set()

    def include_with_parent(item: Mapping[str, Any]) -> None:
        component_id = str(item.get("id") or "")
        if not component_id or component_id in included_ids:
            return
        parent_id = item.get("parent")
        if parent_id is not None and str(parent_id) in component_by_id:
            include_with_parent(component_by_id[str(parent_id)])
        included_ids.add(component_id)

    for item in all_components:
        component_id = str(item.get("id") or "")
        level = str(item.get("level") or "macro")
        tier = str(item.get("fidelityTier") or "")
        if component_id in explicit_refs or level in allowed_levels or tier == pass_id:
            include_with_parent(item)
    if not included_ids and all_components:
        include_with_parent(all_components[0])

    geometry_fields = {
        "id",
        "name",
        "componentType",
        "parent",
        "level",
        "fidelityTier",
        "primitive",
        "dimensions",
        "transform",
        "attachment",
        "geometryDescriptor",
        "blockoutProxy",
    }
    components: list[dict[str, Any]] = []
    for item in all_components:
        if str(item.get("id") or "") not in included_ids:
            continue
        fields = set(geometry_fields)
        if canonical in {"form", "lookdev", "interaction"}:
            fields.add("localFeatures")
        if canonical in {"lookdev", "interaction"}:
            fields.update({"material", "surfaceDetail"})
        if canonical == "interaction":
            fields.add("actionProfile")
        projected = {
            key: copy.deepcopy(value)
            for key, value in item.items()
            if key in fields
        }
        if canonical in {"blockout", "form"}:
            projected["material"] = "__phase-neutral__"
            features = projected.get("localFeatures")
            if isinstance(features, list):
                projected["localFeatures"] = [
                    {key: copy.deepcopy(value) for key, value in feature.items() if key != "material"}
                    for feature in features
                    if isinstance(feature, Mapping)
                ]
        components.append(projected)

    neutral_material = {
        "id": "__phase-neutral__",
        "baseColor": "#8A8F98",
        "roughness": 0.82,
        "metalness": 0.0,
    }
    result: dict[str, Any] = {
        "targetName": spec.get("targetName"),
        "qualityProfile": spec.get("qualityProfile"),
        "buildPasses": build_passes,
        "componentTree": components,
        "materials": (
            [neutral_material]
            if canonical in {"blockout", "form"}
            else copy.deepcopy(spec.get("materials", []))
        ),
        "repetitionSystems": (
            []
            if canonical == "blockout"
            else copy.deepcopy(spec.get("repetitionSystems", []))
        ),
        "lookDevTargets": (
            copy.deepcopy(spec.get("lookDevTargets", {}))
            if canonical in {"lookdev", "interaction"}
            else {}
        ),
        "lightingFromPhoto": (
            copy.deepcopy(spec.get("lightingFromPhoto", []))
            if canonical in {"lookdev", "interaction"}
            else []
        ),
    }
    assessment = spec.get("preSpecAssessment")
    if canonical in {"form", "lookdev", "interaction"} and isinstance(
        assessment, Mapping
    ):
        result["preSpecAssessment"] = {
            "specializedRegions": copy.deepcopy(
                assessment.get("specializedRegions", {})
            ),
            **(
                {
                    "visualStyle": {
                        "status": assessment["visualStyle"].get("status"),
                        "axes": {
                            "shadingTreatment": {
                                "primary": (
                                    assessment["visualStyle"]["axes"].get("shadingTreatment", {})
                                ).get("primary")
                            }
                        },
                    }
                }
                if canonical in {"lookdev", "interaction"}
                and isinstance(assessment.get("visualStyle"), Mapping)
                and isinstance(assessment["visualStyle"].get("axes"), Mapping)
                and isinstance(
                    assessment["visualStyle"]["axes"].get("shadingTreatment"), Mapping
                )
                else {}
            ),
        }
    return result


def generation_validation_hash(spec: dict[str, Any], pass_id: str) -> str:
    """Bind validation/generation to the exact phase-owned generation inputs."""

    encoded = json.dumps(
        {
            "contract": "threejs-sculpt-generation-validation-v2",
            "passId": pass_id,
            "spec": generation_spec_projection(spec, pass_id),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sculpt_representation_signature(spec: dict[str, Any]) -> str:
    """Hash modeling strategy classes, excluding ordinary numeric/detail tuning."""

    def structural_descriptor(value: Any) -> Any:
        if isinstance(value, Mapping):
            structural_keys = {
                "id", "type", "kind", "mode", "primitive", "strategy", "operation",
                "method", "algorithm", "componentRef", "componentRefs", "hostComponentRef",
                "parentId", "requiredTopology", "topology", "closed",
                "decompositionMode", "observedComplexity", "featureClass", "geometryEffect",
                "targetId", "implementationId", "parameterPath", "hostComponentId",
            }
            return {
                str(key): structural_descriptor(item)
                for key, item in value.items()
                if key in structural_keys
            }
        if isinstance(value, list):
            return [structural_descriptor(item) for item in value]
        if isinstance(value, (str, bool)):
            return value
        return None

    components = []
    for component in spec.get("componentTree", []):
        if not isinstance(component, Mapping):
            continue
        components.append(
            {
                key: component.get(key)
                for key in (
                    "id",
                    "componentType",
                    "parent",
                    "primitive",
                )
                if key in component
            } | {
                key: structural_descriptor(component.get(key))
                for key in (
                    "geometryDescriptor", "modifiers", "attachment", "localFeatures", "detailPlan"
                )
                if key in component
            }
        )
    topology_groups = []
    topology_plan = spec.get("surfaceTopologyPlan", {})
    if isinstance(topology_plan, Mapping):
        topology_groups = [
            structural_descriptor(group)
            for group in topology_plan.get("groups", [])
            if isinstance(group, Mapping)
        ]
    encoded = json.dumps(
        {
            "contract": "threejs-sculpt-representation-v1",
            "surfaceTopologyPlan": topology_groups,
            "detailDecompositionContract": structural_descriptor(
                spec.get("detailDecompositionContract", {})
            ),
            "componentTree": components,
            "repetitionSystems": structural_descriptor(spec.get("repetitionSystems", [])),
            "specializedRegions": structural_descriptor(spec.get("specializedRegions", {})),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def phase_quality_targets(spec: Mapping[str, Any], pass_id: str) -> dict[str, Any]:
    """Project global quality targets to the fields that one phase can improve."""

    targets = spec.get("qualityTargets")
    if not isinstance(targets, Mapping):
        return {}
    canonical = (
        "form" if pass_id in {"structure", "structural-pass", "form-refinement"}
        else "lookdev" if pass_id in {"material-pass", "surface-pass", "lighting-pass"}
        else "interaction" if pass_id in RUNTIME_PASS_IDS
        else pass_id
    )
    lookdev_tokens = (
        "material",
        "lighting",
        "color",
        "roughness",
        "gloss",
        "wear",
        "highlight",
        "surface response",
    )
    blockout_tokens = (
        "silhouette",
        "proportion",
        "structure",
        "mass",
        "framing",
    )

    def strings(field: str) -> list[str]:
        value = targets.get(field)
        return [str(item) for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []

    must_match = strings("mustMatch")
    nice_to_have = strings("niceToHave")
    if canonical == "blockout":
        must_match = [
            item for item in must_match if any(token in item.lower() for token in blockout_tokens)
        ]
        nice_to_have = []
    elif canonical == "form":
        must_match = [
            item for item in must_match if not any(token in item.lower() for token in lookdev_tokens)
        ]
        nice_to_have = [
            item for item in nice_to_have if not any(token in item.lower() for token in lookdev_tokens)
        ]

    diagnostic_fields = {
        "blockout": {
            "maximumCentroidDelta",
            "maximumAspectRatioDelta",
            "acceptanceAuthority",
            "guardrailMode",
        },
        "form": {
            "maximumCentroidDelta",
            "maximumAspectRatioDelta",
            "minimumDetailEnergyRatio",
            "minimumEdgeDensityRatio",
            "acceptanceAuthority",
            "guardrailMode",
        },
    }.get(canonical)
    diagnostics = targets.get("diagnosticTargets")
    diagnostics = diagnostics if isinstance(diagnostics, Mapping) else {}
    if diagnostic_fields is not None:
        diagnostics = {
            key: copy.deepcopy(value)
            for key, value in diagnostics.items()
            if key in diagnostic_fields
        }
    else:
        diagnostics = copy.deepcopy(dict(diagnostics))

    projection: dict[str, Any] = {}
    if "targetFidelity" in targets:
        projection["targetFidelity"] = copy.deepcopy(targets.get("targetFidelity"))
    if must_match:
        projection["mustMatch"] = must_match
    if nice_to_have and canonical in {"form", "lookdev"}:
        projection["niceToHave"] = nice_to_have
    if canonical == "lookdev" and isinstance(targets.get("reviewViewpoints"), list):
        projection["reviewViewpoints"] = copy.deepcopy(targets.get("reviewViewpoints"))
    if diagnostics:
        projection["diagnosticTargets"] = diagnostics
    return projection


def review_spec_hash(spec: dict[str, Any], pass_id: str) -> str:
    """Hash only the spec content that can affect a given pass or an earlier one."""
    ids = pass_order(spec)
    index = ids.index(pass_id) if pass_id in ids else 0
    configs = [pass_config(spec, item) for item in ids[: index + 1]]
    kind = evidence_type(spec, pass_id)
    base_fields = (
        "targetName",
        "targetId",
        "schemaVersion",
        "intendedUse",
        "legacyIntent",
        "qualityProfile",
        "sourceImage",
        "referencePreparation",
        "suitability",
        "coordinateFrame",
        "silhouette",
        "viewEvidence",
        "reviewGovernance",
        "phaseExecutionContract",
    )
    payload: dict[str, Any] = {key: spec.get(key) for key in base_fields}
    quality_contract = spec.get("qualityContract")
    if isinstance(quality_contract, Mapping):
        minimum_depth = quality_contract.get("minimumSpecDepth")
        minimum_depth = minimum_depth if isinstance(minimum_depth, Mapping) else {}
        depth_fields = (
            ("macroComponents",)
            if pass_id == "blockout"
            else ("macroComponents", "mesoComponents", "microFeatureGroups", "repetitionSystems")
            if pass_id in {"structure", "form", "structural-pass", "form-refinement"}
            else ("materials",)
            if pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}
            else ()
        )
        payload["qualityContract"] = {
            "minimumSpecDepth": {
                key: copy.deepcopy(minimum_depth.get(key))
                for key in depth_fields
                if key in minimum_depth
            },
            "requiredReviewViewIds": copy.deepcopy(
                quality_contract.get("requiredReviewViewIds", [])
            ),
            "unsupportedFields": {
                key: copy.deepcopy(value)
                for key, value in quality_contract.items()
                if key not in {"minimumSpecDepth", "requiredReviewViewIds"}
            },
            "unsupportedMinimumSpecDepthFields": {
                key: copy.deepcopy(value)
                for key, value in minimum_depth.items()
                if key
                not in {
                    "macroComponents",
                    "mesoComponents",
                    "microFeatureGroups",
                    "materials",
                    "repetitionSystems",
                }
            },
        }
    assessment = spec.get("preSpecAssessment")
    if isinstance(assessment, Mapping):
        object_class = assessment.get("objectClass")
        object_class = object_class if isinstance(object_class, Mapping) else {}
        complexity = assessment.get("complexity")
        complexity = complexity if isinstance(complexity, Mapping) else {}
        decision_map = assessment.get("specDepthDecision") if isinstance(assessment.get("specDepthDecision"), Mapping) else {}
        complexity_hash_payload = {
            "tier": complexity.get("tier"),
            "modifiers": copy.deepcopy(complexity.get("modifiers")) if isinstance(complexity.get("modifiers"), Mapping) else {},
            "requiredDepth": decision_map.get("requiredDepth"),
        }
        if pass_id == "blockout":
            payload["preSpecAssessment"] = {
                "objectClass": {
                    key: object_class.get(key)
                    for key in (
                        "primaryType",
                        "representationKind",
                        "formLanguage",
                        "structureKind",
                    )
                    if key in object_class
                },
                "complexity": complexity_hash_payload,
            }
        elif pass_id in {"structure", "form", "structural-pass", "form-refinement"}:
            payload["preSpecAssessment"] = {
                "objectClass": {
                    key: object_class.get(key)
                    for key in (
                        "primaryType",
                        "representationKind",
                        "formLanguage",
                        "structureKind",
                    )
                    if key in object_class
                },
                "complexity": complexity_hash_payload,
                "specDepthDecision": copy.deepcopy(
                    assessment.get("specDepthDecision", {})
                ),
                "specializedRegions": copy.deepcopy(
                    assessment.get("specializedRegions", {})
                ),
            }
        elif pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
            payload["preSpecAssessment"] = {
                "materialFamilies": copy.deepcopy(object_class.get("materialFamilies", []))
            }
        elif pass_id in RUNTIME_PASS_IDS:
            payload["preSpecAssessment"] = {
                "motionPotential": copy.deepcopy(object_class.get("motionPotential", []))
            }
        style_projection = visual_style_projection(
            assessment.get("visualStyle"),
            pass_id,
        )
        if style_projection:
            pre_spec_payload = payload.setdefault("preSpecAssessment", {})
            if isinstance(pre_spec_payload, dict):
                pre_spec_payload["visualStyle"] = style_projection
    targets = spec.get("qualityTargets") if isinstance(spec.get("qualityTargets"), dict) else {}
    payload["qualityTargets"] = phase_quality_targets(spec, pass_id)
    payload["buildPasses"] = configs
    payload["visualAcceptance"] = (
        spec.get("selfCorrectLoop", {}).get("visualAcceptance", {})
        if isinstance(spec.get("selfCorrectLoop"), dict)
        else {}
    )
    target_pass_id = (
        "form"
        if pass_id in {"structure", "structural-pass", "form-refinement"}
        else "lookdev"
        if pass_id in {"material-pass", "surface-pass", "lighting-pass"}
        else "interaction"
        if pass_id in RUNTIME_PASS_IDS
        else pass_id
    )
    payload["featureReviewTargets"] = [
        target
        for target in spec.get("featureReviewTargets", [])
        if isinstance(target, dict)
        and isinstance(target.get("passIds"), list)
        and target_pass_id in target["passIds"]
    ]

    components = [item for item in spec.get("componentTree", []) if isinstance(item, dict)]
    composite_contract = schema_version_at_least(spec, CURRENT_SCHEMA_VERSION)
    blockout_fields = {
        "id",
        "name",
        "componentType",
        "level",
        "role",
        "importance",
        "confidence",
        "primitive",
        "geometryDescriptor",
        "parent",
        "dimensions",
        "transform",
        "evidenceRefs",
    }
    form_fields = blockout_fields | {
        "attachment", "deformations", "joints", "seams", "localFeatures", "details",
        "fidelityTier",
    }
    lookdev_fields = form_fields | {"material", "materialLayers", "surfaceDetail"}

    def hash_component(item: dict[str, Any], fields: set[str]) -> dict[str, Any]:
        projected = {key: value for key, value in item.items() if key in fields}
        if composite_contract:
            # In v3.1 omission and an explicit `part` have the same additive meaning.
            projected["componentType"] = component_type(item)
        return projected

    if pass_id == "blockout":
        payload["viewHypothesisPolicy"] = spec.get("viewHypothesisPolicy", {})
        payload["componentTree"] = [
            hash_component(item, blockout_fields)
            for item in components
            if item.get("level", "macro") == "macro"
        ]
    elif pass_id in {"structure", "form", "structural-pass", "form-refinement"}:
        payload["surfaceTopologyPlan"] = spec.get("surfaceTopologyPlan", {})
        payload["detailDecompositionContract"] = spec.get(
            "detailDecompositionContract", {}
        )
        payload["viewHypothesisPolicy"] = spec.get("viewHypothesisPolicy", {})
        payload["componentTree"] = [
            hash_component(item, form_fields)
            for item in components
        ]
        payload["repetitionSystems"] = spec.get("repetitionSystems", [])
    elif pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
        payload["componentTree"] = [
            hash_component(item, lookdev_fields)
            for item in components
        ]
        payload["repetitionSystems"] = spec.get("repetitionSystems", [])
    else:
        payload["componentTree"] = components
        payload["repetitionSystems"] = spec.get("repetitionSystems", [])

    post_optimization_visual = effective_pass_config(spec, pass_id).get(
        "requiredPostOptimizationVisualReview"
    ) is True
    if (
        kind == "visual"
        and pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}
    ) or post_optimization_visual:
        payload["qualityTargets"]["reviewViewpoints"] = targets.get("reviewViewpoints", [])
        payload["materials"] = spec.get("materials", [])
        payload["lookDevTargets"] = spec.get("lookDevTargets", {})
        payload["lightingFromPhoto"] = spec.get("lightingFromPhoto", [])
    if kind == "runtime":
        payload["interactionContract"] = spec.get("interactionContract", {})
        payload["actionReadiness"] = spec.get("actionReadiness", {})
    if kind == "metrics":
        payload["performanceAudit"] = spec.get("performanceAudit", {})
        payload["performanceBudget"] = spec.get("performanceBudget", {})
        payload["lodPlan"] = spec.get("lodPlan", [])
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def visual_acceptance_threshold(spec: dict[str, Any]) -> float:
    candidates = [0.7]
    targets = spec.get("qualityTargets")
    if isinstance(targets, dict) and is_number(targets.get("targetFidelity")):
        candidates.append(float(targets["targetFidelity"]))
    loop = spec.get("selfCorrectLoop")
    if isinstance(loop, dict):
        config = loop.get("visualAcceptance")
        if isinstance(config, dict):
            for field in ("threshold", "minimumAiVisionScore"):
                if is_number(config.get(field)):
                    candidates.append(float(config[field]))
    return max(candidates)


def review_visual_views(entry: dict[str, Any]) -> list[dict[str, Any]]:
    evidence = entry.get("evidence")
    if isinstance(evidence, dict) and evidence.get("type") == "visual":
        views = evidence.get("views")
        if isinstance(views, list):
            return [item for item in views if isinstance(item, dict)]
    legacy = entry.get("visualEvidence")
    if isinstance(legacy, dict):
        return [
            {
                "viewId": legacy.get("cameraView") or "primary",
                "referenceImage": legacy.get("referenceImage")
                or legacy.get("referenceScreenshot")
                or "",
                "renderScreenshot": legacy.get("renderScreenshot") or "",
                "comparisonImage": legacy.get("comparisonImage") or "",
                "notes": legacy.get("notes") or "",
            }
        ]
    return []


_LAYER_SCORE_ALIASES = {
    "silhouette": ("silhouette", "silhouetteProportion", "macro", "shape"),
    "structure": ("structure", "componentStructure", "meso", "form", "proportion"),
    "formDetail": ("formDetail", "form-detail", "detail", "localForm"),
    "material": ("material", "materialSurface", "surface", "lookdev"),
    "lighting": ("lighting", "lightingCamera", "light", "shadow"),
}


def _canonical_score_layer(layer: str) -> str:
    for canonical, aliases in _LAYER_SCORE_ALIASES.items():
        if layer in aliases:
            return canonical
    return layer


def _score_for_layer(layer_scores: Any, layer: str) -> float | None:
    if not isinstance(layer_scores, dict):
        return None
    for key in _LAYER_SCORE_ALIASES.get(layer, (layer,)):
        value = layer_scores.get(key)
        if is_number(value):
            return float(value)
    return None


def _valid_quality_score(value: Any) -> bool:
    return is_number(value) and 0 <= float(value) <= 1


def _view_diagnostic_quality(view: Mapping[str, Any]) -> dict[str, float]:
    """Normalize one acceptance view so every deterministic quality signal is comparable."""

    diagnostics = view.get("fitDiagnostics")
    if not isinstance(diagnostics, Mapping):
        return {}
    result: dict[str, float] = {}
    direct_metrics: dict[str, Any] = {}
    inverse_metrics = {
        "centroidAlignment": diagnostics.get("centroidDelta"),
        "aspectAlignment": diagnostics.get("aspectRatioDelta"),
        "contourAlignment": diagnostics.get("normalizedContourDistance"),
    }
    appearance = diagnostics.get("appearance")
    if isinstance(appearance, Mapping):
        direct_metrics.update(
            {
                "detailEnergyRatio": appearance.get("detailEnergyRatio"),
                "edgeDensityRatio": appearance.get("edgeDensityRatio"),
                "histogramIntersection": appearance.get(
                    "foregroundHistogramIntersection"
                ),
                "highlightCoverageRatio": appearance.get(
                    "highlightCoverageRatio"
                ),
                "highlightEnergyRatio": appearance.get("highlightEnergyRatio"),
            }
        )
        inverse_metrics["meanColorAlignment"] = appearance.get(
            "foregroundMeanColorDelta"
        )
    for metric, value in direct_metrics.items():
        if _valid_quality_score(value):
            result[metric] = float(value)
    for metric, value in inverse_metrics.items():
        if _valid_quality_score(value):
            result[metric] = max(0.0, 1.0 - float(value))
    return result


def _acceptance_diagnostic_view(view: Mapping[str, Any]) -> bool:
    provenance = view.get("referenceProvenance")
    return not isinstance(provenance, Mapping) or (
        provenance.get("origin") in {"observed", "prepared-reference"}
        and provenance.get("allowedUse") == "acceptance"
    )


def _canonical_regression_view_id(view: Mapping[str, Any]) -> str:
    view_id = str(view.get("viewId") or "primary").strip().lower()
    # Form calls the observed source view `primary`; Lookdev calls the same
    # camera/reference pair `reference`. Treating them as different let a later
    # phase omit the only comparable baseline view.
    return "source-reference" if view_id in {"primary", "reference"} else view_id


def diagnostic_quality_vector(evidence: Any) -> dict[str, float]:
    """Normalize deterministic observed-view geometry diagnostics for rollback.

    Diagnostics remain veto-only: they can reject a regression but can never
    approve a gate. The weakest observed acceptance view is retained so a 2x2
    sheet cannot average away one visibly damaged angle.
    """

    if not isinstance(evidence, Mapping):
        return {}
    buckets: dict[str, list[float]] = {}
    per_view: dict[str, float] = {}
    views = evidence.get("views")
    if not isinstance(views, list):
        return {}
    for view in views:
        if not isinstance(view, Mapping):
            continue
        if not _acceptance_diagnostic_view(view):
            continue
        view_id = str(view.get("viewId") or "primary")
        for metric, quality in _view_diagnostic_quality(view).items():
            buckets.setdefault(metric, []).append(quality)
            per_view[f"{view_id}.{metric}"] = quality
    # Keep aggregate keys for compatibility and dashboards, but rollback uses
    # the per-view keys too so improvement in one angle cannot hide damage in
    # another angle.
    return {
        **{
            key: min(values)
            for key, values in buckets.items()
            if values
        },
        **per_view,
    }


def quality_candidate_disposition(
    baseline: Mapping[str, Any] | None,
    candidate: Mapping[str, Any],
    *,
    owned_layers: Iterable[str],
    protected_layers: Iterable[str] = (),
    required_layers: Mapping[str, Any] | None = None,
    minimum_delta: float = MIN_REFINEMENT_SCORE_DELTA,
    maximum_regression: float = MAX_REFINEMENT_REGRESSION,
    diagnostic_metrics: Iterable[str] | None = None,
    blind_scout_decision: str | None = None,
) -> dict[str, Any]:
    """Classify a reviewed challenger without allowing score averaging to hide damage."""

    owned = list(dict.fromkeys(str(item) for item in owned_layers if str(item)))
    required_comparison_layers = list(
        dict.fromkeys([*owned, *(str(item) for item in protected_layers if str(item))])
    )
    after_scores = candidate.get("layerScores")
    missing_layers = [
        layer
        for layer in required_comparison_layers
        if not _valid_quality_score(_score_for_layer(after_scores, layer))
    ]
    if not _valid_quality_score(candidate.get("overallScore")):
        missing_layers.insert(0, "overallScore")
    if missing_layers:
        return {
            "disposition": "rejected-incomplete",
            "meaningfulImprovement": False,
            "improvedLayers": [],
            "regressedLayers": [],
            "missingLayers": list(dict.fromkeys(missing_layers)),
            "minimumDelta": minimum_delta,
            "maximumRegression": maximum_regression,
        }

    # Old sidecars may contain a champion created before complete layer scoring
    # was mandatory. Treat that invalid baseline as absent so one valid candidate
    # repairs the state instead of becoming permanently unable to improve it.
    if baseline is not None:
        baseline_scores = baseline.get("layerScores")
        baseline_incomplete = not _valid_quality_score(baseline.get("overallScore")) or any(
            not _valid_quality_score(_score_for_layer(baseline_scores, layer))
            for layer in required_comparison_layers
        )
        if baseline_incomplete:
            baseline = None
    if baseline is None:
        return {
            "disposition": "seed",
            "meaningfulImprovement": True,
            "improvedLayers": owned,
            "regressedLayers": [],
            "missingLayers": [],
            "minimumDelta": minimum_delta,
            "maximumRegression": maximum_regression,
        }

    before_scores = baseline.get("layerScores")
    baseline_scored_layers = [
        _canonical_score_layer(str(layer))
        for layer, value in before_scores.items()
        if isinstance(before_scores, Mapping) and _valid_quality_score(value)
    ] if isinstance(before_scores, Mapping) else []
    # When a phase intentionally owns no numeric layers (v4 lightweight gate),
    # do not resurrect historical layer names and turn them into hidden
    # requirements.  Legacy phases retain the old comparison behavior.
    compared_layers = list(
        dict.fromkeys(
            [
                *required_comparison_layers,
                *(
                    baseline_scored_layers
                    if required_comparison_layers
                    else []
                ),
            ]
        )
    )
    regressions: list[str] = []
    improved: list[str] = []
    crossed: list[str] = []
    thresholds = required_layers if isinstance(required_layers, Mapping) else {}
    before_overall = baseline.get("overallScore")
    after_overall = candidate.get("overallScore")
    if is_number(before_overall) and (
        not is_number(after_overall)
        or float(after_overall) < float(before_overall) - maximum_regression
    ):
        regressions.append("overallScore")
    before_diagnostics = baseline.get("diagnosticScores")
    after_diagnostics = candidate.get("diagnosticScores")
    allowed_diagnostics = (
        {str(metric) for metric in diagnostic_metrics}
        if diagnostic_metrics is not None
        else None
    )
    if isinstance(before_diagnostics, Mapping):
        for metric, before in before_diagnostics.items():
            if allowed_diagnostics is not None and str(metric) not in allowed_diagnostics:
                continue
            if not _valid_quality_score(before):
                continue
            after = (
                after_diagnostics.get(metric)
                if isinstance(after_diagnostics, Mapping)
                else None
            )
            if (
                not _valid_quality_score(after)
                or float(after) < float(before) - maximum_regression
            ):
                regressions.append(f"diagnostic.{metric}")
    for layer in compared_layers:
        before = _score_for_layer(before_scores, layer)
        after = _score_for_layer(after_scores, layer)
        if before is not None and (after is None or after < before - maximum_regression):
            regressions.append(layer)
    for layer in owned:
        before = _score_for_layer(before_scores, layer)
        after = _score_for_layer(after_scores, layer)
        if before is not None and after is not None and after >= before + minimum_delta:
            improved.append(layer)
        threshold = thresholds.get(layer)
        if (
            before is not None
            and after is not None
            and is_number(threshold)
            and before < float(threshold) <= after
        ):
            crossed.append(layer)
    if not owned:
        # A lightweight phase still needs a useful champion signal.  Compare
        # the composite score and deterministic diagnostics directly instead of
        # inventing layer scores.
        if (
            is_number(before_overall)
            and is_number(after_overall)
            and float(after_overall) >= float(before_overall) + minimum_delta
        ):
            improved.append("overallScore")
        if isinstance(before_diagnostics, Mapping):
            for metric, before in before_diagnostics.items():
                if allowed_diagnostics is not None and str(metric) not in allowed_diagnostics:
                    continue
                after = (
                    after_diagnostics.get(metric)
                    if isinstance(after_diagnostics, Mapping)
                    else None
                )
                if (
                    _valid_quality_score(before)
                    and _valid_quality_score(after)
                    and float(after) >= float(before) + minimum_delta
                ):
                    improved.append(f"diagnostic.{metric}")
    meaningful = bool(improved or crossed)
    scout_approved_regression = bool(regressions) and blind_scout_decision == "approve"
    disposition = (
        "gate-pass"
        if scout_approved_regression
        else "rejected-regression"
        if regressions
        else "promoted"
        if meaningful
        else "rejected-no-improvement"
    )
    return {
        "disposition": disposition,
        "meaningfulImprovement": meaningful and not regressions,
        "improvedLayers": sorted(set([*improved, *crossed])),
        "regressedLayers": sorted(set(regressions)),
        "missingLayers": [],
        "minimumDelta": minimum_delta,
        "maximumRegression": maximum_regression,
        "blindScoutDecision": blind_scout_decision,
        "regressionAcceptedByBlindScout": scout_approved_regression,
    }


def _diagnostic_targets(spec: dict[str, Any], pass_id: str | None = None) -> dict[str, float]:
    reference_fidelity = spec.get("qualityProfile") == "reference-fidelity"
    floors = {
        "maximumCentroidDelta": 0.02 if reference_fidelity else 0.05,
        "maximumAspectRatioDelta": 0.03 if reference_fidelity else 0.08,
        "minimumDetailEnergyRatio": 0.75 if reference_fidelity else 0.65,
        "minimumEdgeDensityRatio": 0.35 if reference_fidelity else 0.20,
        "minimumHistogramIntersection": 0.35 if reference_fidelity else 0.25,
        "maximumMeanColorDelta": 0.40 if reference_fidelity else 0.55,
        "minimumHighlightCoverageRatio": 0.10 if reference_fidelity else 0.05,
        "minimumHighlightEnergyRatio": 0.10 if reference_fidelity else 0.05,
    }
    targets = spec.get("qualityTargets")
    configured = targets.get("diagnosticTargets") if isinstance(targets, dict) else None
    if not isinstance(configured, dict):
        return floors
    result = dict(floors)
    for field in (
        "minimumDetailEnergyRatio",
        "minimumEdgeDensityRatio",
        "minimumHistogramIntersection",
        "minimumHighlightCoverageRatio",
        "minimumHighlightEnergyRatio",
    ):
        value = configured.get(field)
        if is_number(value):
            result[field] = max(result[field], float(value))
    for field in (
        "maximumCentroidDelta",
        "maximumAspectRatioDelta",
        "maximumMeanColorDelta",
    ):
        value = configured.get(field)
        if is_number(value):
            result[field] = min(result[field], float(value))
    return result


def _diagnostic_guardrail_failures(
    spec: dict[str, Any],
    views: list[dict[str, Any]],
    required_view_ids: list[str],
    pass_id: str,
) -> list[str]:
    failures: list[str] = []
    targets = _diagnostic_targets(spec, pass_id)
    by_id = {str(view.get("viewId") or "primary"): view for view in views}
    if len(required_view_ids) == 1 and len(views) == 1 and required_view_ids[0] not in by_id:
        by_id[required_view_ids[0]] = views[0]
    for view_id in required_view_ids:
        view = by_id.get(view_id)
        if not isinstance(view, dict):
            continue
        diagnostics = view.get("fitDiagnostics")
        if not isinstance(diagnostics, dict):
            failures.append(f"visual view {view_id!r} needs reproducible fitDiagnostics")
            continue
        centroid = diagnostics.get("centroidDelta")
        aspect = diagnostics.get("aspectRatioDelta")
        appearance = diagnostics.get("appearance")
        detail_ratio = appearance.get("detailEnergyRatio") if isinstance(appearance, dict) else None
        provenance = view.get("referenceProvenance")
        synthetic_hypothesis = (
            isinstance(provenance, dict)
            and provenance.get("origin") == "synthetic-hypothesis"
        )
        simplified = simplified_visual_gate_enabled(spec, pass_id)
        maximum_centroid = max(targets["maximumCentroidDelta"], 0.18) if synthetic_hypothesis else targets["maximumCentroidDelta"]
        maximum_aspect = max(targets["maximumAspectRatioDelta"], 0.30) if synthetic_hypothesis else targets["maximumAspectRatioDelta"]
        if (
            not simplified
            and (not is_number(centroid) or float(centroid) > maximum_centroid)
        ):
            failures.append(
                f"visual view {view_id!r} centroidDelta must be <= "
                f"{maximum_centroid}"
            )
        if (
            not simplified
            and (not is_number(aspect) or float(aspect) > maximum_aspect)
        ):
            failures.append(
                f"visual view {view_id!r} aspectRatioDelta must be <= "
                f"{maximum_aspect}"
            )
        detail_relevant = (
            not simplified
            and not synthetic_hypothesis
            and pass_id in {
            "lookdev",
            "material-pass",
            "surface-pass",
            "lighting-pass",
            "optimization",
            "optimization-pass",
            }
        )
        if detail_relevant and (
            not is_number(detail_ratio)
            or float(detail_ratio) < targets["minimumDetailEnergyRatio"]
        ):
            failures.append(
                f"visual view {view_id!r} detailEnergyRatio must be >= "
                f"{targets['minimumDetailEnergyRatio']}"
            )
        if detail_relevant:
            appearance_checks = (
                ("edgeDensityRatio", "minimumEdgeDensityRatio", lambda value, limit: value >= limit, ">="),
                (
                    "foregroundHistogramIntersection",
                    "minimumHistogramIntersection",
                    lambda value, limit: value >= limit,
                    ">=",
                ),
                ("foregroundMeanColorDelta", "maximumMeanColorDelta", lambda value, limit: value <= limit, "<="),
                (
                    "highlightCoverageRatio",
                    "minimumHighlightCoverageRatio",
                    lambda value, limit: value >= limit,
                    ">=",
                ),
                (
                    "highlightEnergyRatio",
                    "minimumHighlightEnergyRatio",
                    lambda value, limit: value >= limit,
                    ">=",
                ),
            )
            for field, target_field, predicate, relation in appearance_checks:
                value = appearance.get(field) if isinstance(appearance, dict) else None
                limit = targets[target_field]
                if not is_number(value) or not predicate(float(value), limit):
                    failures.append(
                        f"visual view {view_id!r} {field} must be {relation} {limit}"
                    )
    return failures


def visual_preflight_failures(
    spec: dict[str, Any],
    evidence: Any,
    pass_id: str,
    spec_path: Path | None = None,
) -> list[str]:
    """Run deterministic evidence vetoes before spending a reviewer-agent call."""
    failures: list[str] = []
    if not isinstance(evidence, dict):
        return ["visual evidence must be a comparison manifest object"]
    views_value = evidence.get("views")
    views = [item for item in views_value if isinstance(item, dict)] if isinstance(views_value, list) else []
    config = effective_pass_config(spec, pass_id)
    required_views = config.get("requiredViews", ["primary"])
    if not isinstance(required_views, list) or not required_views:
        required_views = ["primary"]
    required_view_ids = [str(item) for item in required_views]
    diagnostic_views = config.get("diagnosticViews", [])
    diagnostic_view_ids = (
        [str(item) for item in diagnostic_views if isinstance(item, str) and item]
        if isinstance(diagnostic_views, list)
        else []
    )
    reviewed_view_ids = list(dict.fromkeys([*required_view_ids, *diagnostic_view_ids]))
    by_id = {str(view.get("viewId") or "primary"): view for view in views}
    if len(required_view_ids) == 1 and len(views) == 1 and required_view_ids[0] not in by_id:
        by_id[required_view_ids[0]] = views[0]
    for view_id in reviewed_view_ids:
        view = by_id.get(view_id)
        if not view:
            kind = "required" if view_id in required_view_ids else "diagnostic"
            failures.append(f"missing {kind} visual view {view_id!r}")
            continue
        for field in ("referenceImage", "renderScreenshot", "comparisonImage"):
            if not isinstance(view.get(field), str) or not str(view[field]).strip():
                failures.append(f"visual view {view_id!r} missing {field}")

    failures.extend(visual_evidence_integrity_failures(evidence))
    failures.extend(visual_evidence_authority_failures(evidence, required_view_ids))
    source_image = spec.get("sourceImage")
    if isinstance(source_image, str) and source_image.strip() and "://" not in source_image:
        source_path = Path(source_image).expanduser()
        if spec_path is not None and not source_path.is_absolute():
            source_path = spec_path.expanduser().resolve().parent / source_path
        if source_path.is_file():
            source_hash = file_sha256(source_path)
            for view_id in required_view_ids:
                view = by_id.get(view_id)
                if isinstance(view, dict) and view.get("referenceSha256") != source_hash:
                    failures.append(
                        f"visual view {view_id!r} is not bound to spec.sourceImage"
                    )
    if diagnostic_view_ids:
        from sculpt_view_hypotheses import hypothesis_evidence_failures

        failures.extend(
            hypothesis_evidence_failures(
                spec_path,
                spec,
                evidence,
                diagnostic_view_ids,
            )
        )
    failures.extend(_diagnostic_guardrail_failures(spec, views, reviewed_view_ids, pass_id))
    return list(dict.fromkeys(failures))


def _visual_review_failures(
    spec: dict[str, Any],
    entry: dict[str, Any],
    pass_id: str,
    config: dict[str, Any],
    spec_path: Path | None = None,
) -> list[str]:
    evidence = entry.get("evidence")
    failures = visual_preflight_failures(spec, evidence, pass_id, spec_path)
    configured_overall = config.get("minimumOverallScore")
    required_threshold = (
        visual_gate_threshold(spec, pass_id)
        if simplified_visual_gate_enabled(spec, pass_id)
        else (
            float(configured_overall)
            if is_number(configured_overall)
            else visual_acceptance_threshold(spec)
        )
    )
    recorded_threshold = entry.get("visualAcceptanceThreshold")
    if not is_number(recorded_threshold) or float(recorded_threshold) < required_threshold:
        failures.append(
            f"visualAcceptanceThreshold cannot be below the spec threshold {required_threshold}"
        )
    score = entry.get("aiVisionScore")
    if not is_number(score) or float(score) < required_threshold:
        failures.append(f"aiVisionScore must meet visual threshold {required_threshold}")
    required_layers = config.get("requiredLayerScores", {})
    if isinstance(required_layers, dict):
        for layer, minimum in required_layers.items():
            layer_score = _score_for_layer(entry.get("layerScores"), str(layer))
            if not is_number(minimum) or layer_score is None or layer_score < float(minimum):
                failures.append(f"layer score {layer!r} must be >= {minimum}")

    reviewer = entry.get("reviewerEvidence")
    comparison_hash = evidence.get("comparisonSha256") if isinstance(evidence, dict) else None
    if not isinstance(reviewer, dict):
        failures.append("reviewerEvidence is required for an accepted visual review")
    else:
        if reviewer.get("type") != "ai-vision":
            failures.append("reviewerEvidence.type must be 'ai-vision'")
        if not isinstance(reviewer.get("model"), str) or not reviewer["model"].strip():
            failures.append("reviewerEvidence.model is required")
        if reviewer.get("reviewedArtifactSha256") != comparison_hash:
            failures.append("reviewerEvidence is not bound to the compared image hash")
        if not isinstance(reviewer.get("reviewedAt"), str) or not reviewer["reviewedAt"].strip():
            failures.append("reviewerEvidence.reviewedAt is required")
        governance = spec.get("reviewGovernance")
        independent_required = (
            isinstance(governance, dict)
            and governance.get("independentContextRequired") is True
        )
        if independent_required:
            builder_context = reviewer.get("builderContextId")
            reviewer_context = reviewer.get("reviewerContextId")
            if not isinstance(builder_context, str) or not builder_context.strip():
                failures.append("reviewerEvidence.builderContextId is required")
            if not isinstance(reviewer_context, str) or not reviewer_context.strip():
                failures.append("reviewerEvidence.reviewerContextId is required")
            if (
                isinstance(builder_context, str)
                and isinstance(reviewer_context, str)
                and builder_context.strip() == reviewer_context.strip()
            ):
                failures.append("builder and reviewer contextId must differ")
            if reviewer.get("role") != "independent-reviewer":
                failures.append("reviewerEvidence.role must be 'independent-reviewer'")
            verdict_path_value = reviewer.get("reviewVerdict")
            verdict_hash = reviewer.get("reviewVerdictSha256")
            if not isinstance(verdict_path_value, str) or not verdict_path_value.strip():
                failures.append("reviewerEvidence.reviewVerdict is required")
            elif spec_path is not None or Path(verdict_path_value).expanduser().is_absolute():
                verdict_path = Path(verdict_path_value).expanduser()
                if not verdict_path.is_absolute():
                    assert spec_path is not None
                    verdict_path = spec_path.expanduser().resolve().parent / verdict_path
                if not verdict_path.is_file():
                    failures.append("reviewerEvidence.reviewVerdict does not exist")
                elif verdict_hash != file_sha256(verdict_path):
                    failures.append("reviewerEvidence review verdict changed after acceptance")
            if not isinstance(verdict_hash, str) or len(verdict_hash) != 64:
                failures.append("reviewerEvidence.reviewVerdictSha256 is required")
    notes = entry.get("aiVisionNotes")
    if not isinstance(notes, str) or len(notes.strip()) < 12:
        failures.append("aiVisionNotes must explain the accepted visual result")
    if (
        simplified_visual_gate_enabled(spec, pass_id)
        and feature_review_policy(spec).get("enabled") is not True
    ):
        failures.append(
            "v4 visual gate requires primary feature reviews to be enabled"
        )
    else:
        failures.extend(feature_gate_failures(spec, entry, pass_id))
    return failures


def _latest_history_entry(spec: dict[str, Any], pass_id: str) -> dict[str, Any] | None:
    history = spec.get("reviewHistory")
    if not isinstance(history, list):
        return None
    for item in reversed(history):
        if isinstance(item, dict) and item.get("passId") == pass_id and item.get("action") == "continue":
            return item
    return None


def phase_spec_projection(spec: Mapping[str, Any], pass_id: str) -> dict[str, Any]:
    """Return only stable core plus the contract consumed by one phase.

    This projection is intentionally LLM-facing. It does not replace the source
    JSON or discard future-phase data; it prevents a Blockout turn from spending
    attention on PBR, motion, receipts, or recursive microdetail that cannot yet
    improve the observed silhouette.
    """

    selected = str(pass_id)
    stable_fields = (
        "targetName",
        "targetId",
        "sourceImage",
        "referencePreparation",
        "coordinateFrame",
        "silhouette",
        "viewEvidence",
        "componentNamingContract",
        "assumptions",
        "risks",
    )
    projection: dict[str, Any] = {
        field: copy.deepcopy(spec.get(field))
        for field in stable_fields
        if field in spec
    }
    if isinstance(spec.get("qualityContract"), Mapping):
        projection["qualityContract"] = copy.deepcopy(spec["qualityContract"])
    components = [
        item
        for item in spec.get("componentTree", [])
        if isinstance(item, Mapping)
    ]

    if selected == "blockout":
        assessment = spec.get("preSpecAssessment")
        if isinstance(assessment, Mapping):
            complexity = assessment.get("complexity")
            object_class = assessment.get("objectClass")
            object_class = object_class if isinstance(object_class, Mapping) else {}
            projection["preSpecAssessment"] = {
                "objectClass": {
                    key: copy.deepcopy(object_class.get(key))
                    for key in (
                        "primaryType",
                        "representationKind",
                        "formLanguage",
                        "structureKind",
                    )
                    if key in object_class
                },
                "complexity": copy.deepcopy(complexity),
                "complexityTier": (
                    complexity.get("tier") if isinstance(complexity, Mapping) else "moderate"
                ),
                "specDepthDecision": copy.deepcopy(
                    assessment.get("specDepthDecision", {})
                ),
            }
        allowed = {
            "id", "name", "componentType", "level", "role", "parent",
            "importance", "confidence", "transform", "attachment", "primitive",
            "parameters", "geometryDescriptor", "blockoutProxy", "fidelityTier",
            "evidenceRefs",
        }
        projection["componentTree"] = [
            {key: copy.deepcopy(value) for key, value in item.items() if key in allowed}
            for item in components
            if item.get("level", "macro") == "macro"
        ]
        projection["viewHypothesisPolicy"] = copy.deepcopy(
            spec.get("viewHypothesisPolicy", {})
        )
        projection["featureReviewTargets"] = copy.deepcopy(
            feature_targets_for_pass(dict(spec), "blockout")
        )
        projection["qualityTargets"] = phase_quality_targets(spec, selected)
    elif selected in {"form", "structure", "structural-pass", "form-refinement"}:
        projected_components: list[dict[str, Any]] = []
        for item in components:
            copied = copy.deepcopy(dict(item))
            copied.pop("actionProfile", None)
            copied.pop("surfaceDetail", None)
            copied.pop("material", None)
            copied.pop("materialLayers", None)
            projected_components.append(copied)
        projection.update(
            {
                "componentTree": projected_components,
                "surfaceTopologyPlan": copy.deepcopy(spec.get("surfaceTopologyPlan", {})),
                "detailDecompositionContract": copy.deepcopy(
                    spec.get("detailDecompositionContract", {})
                ),
                "repetitionSystems": copy.deepcopy(spec.get("repetitionSystems", [])),
                "featureReviewTargets": copy.deepcopy(
                    feature_targets_for_pass(dict(spec), "form")
                ),
                "viewHypothesisPolicy": copy.deepcopy(spec.get("viewHypothesisPolicy", {})),
                "qualityTargets": phase_quality_targets(spec, selected),
            }
        )
    elif selected in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
        projection.update(
            {
                "componentMaterialBindings": [
                    {
                        key: copy.deepcopy(item.get(key))
                        for key in ("id", "parent", "material", "materialLayers")
                        if key in item
                    }
                    for item in components
                ],
                "materials": copy.deepcopy(spec.get("materials", [])),
                "lookDevTargets": copy.deepcopy(spec.get("lookDevTargets", {})),
                "lightingFromPhoto": copy.deepcopy(spec.get("lightingFromPhoto", [])),
                "featureReviewTargets": copy.deepcopy(
                    feature_targets_for_pass(dict(spec), "lookdev")
                ),
                "qualityTargets": phase_quality_targets(spec, selected),
            }
        )
    elif selected in RUNTIME_PASS_IDS:
        projection.update(
            {
                "componentActions": [
                    {
                        key: copy.deepcopy(item.get(key))
                        for key in ("id", "parent", "transform", "actionProfile")
                        if key in item
                    }
                    for item in components
                ],
                "interactionContract": copy.deepcopy(spec.get("interactionContract", {})),
                "actionReadiness": copy.deepcopy(spec.get("actionReadiness", {})),
                "featureReviewTargets": copy.deepcopy(
                    feature_targets_for_pass(dict(spec), "interaction")
                ),
                "qualityTargets": phase_quality_targets(spec, selected),
            }
        )
    assessment = spec.get("preSpecAssessment")
    if isinstance(assessment, Mapping):
        style_projection = visual_style_projection(
            assessment.get("visualStyle"),
            selected,
        )
        if style_projection:
            projected_assessment = projection.setdefault("preSpecAssessment", {})
            if isinstance(projected_assessment, dict):
                projected_assessment["visualStyle"] = style_projection
            projection["styleDirectives"] = visual_style_directives(
                assessment.get("visualStyle"),
                selected,
            )
    return projection


def phase_work_packet(spec: dict[str, Any], pass_id: str) -> dict[str, Any]:
    """Project the large sculpt contract into one concise, executable phase packet."""

    config = effective_pass_config(spec, pass_id)
    phase_order = ["blockout", "form", "lookdev", "interaction"]
    canonical_phase = (
        "form" if pass_id in {"structure", "structural-pass", "form-refinement"}
        else "lookdev" if pass_id in {"material-pass", "surface-pass", "lighting-pass"}
        else "interaction" if pass_id in RUNTIME_PASS_IDS
        else pass_id
    )
    try:
        phase_index = phase_order.index(canonical_phase)
    except ValueError:
        phase_index = -1
    components = [
        item
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and item.get("componentType", "part") != "assembly"
    ]
    if canonical_phase == "blockout":
        editable_components = [
            str(item.get("id")) for item in components if item.get("level", "macro") == "macro"
        ]
    elif canonical_phase in {"form", "lookdev", "interaction"}:
        editable_components = [str(item.get("id")) for item in components]
    else:
        editable_components = []
    materials = [
        str(item.get("id"))
        for item in spec.get("materials", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]
    baseline_pass = config.get("visualBaselinePassId")
    baseline = (
        _latest_history_entry(spec, str(baseline_pass))
        if isinstance(baseline_pass, str) and baseline_pass
        else None
    )
    depth = {
        "macroComponents": sum(item.get("level", "macro") == "macro" for item in components),
        "mesoComponents": sum(item.get("level") == "meso" for item in components),
        "microFeatureGroups": detail_feature_count(spec),
        "materials": len(
            [
                item
                for item in spec.get("materials", [])
                if isinstance(item, Mapping)
            ]
        ),
        "repetitionSystems": len(
            [
                item
                for item in spec.get("repetitionSystems", [])
                if isinstance(item, Mapping)
            ]
        ),
    }
    execution = (
        spec.get("phaseExecutionContract")
        if isinstance(spec.get("phaseExecutionContract"), Mapping)
        else {}
    )
    owned_fields = execution.get("phaseOwnedFields")
    phase_owned = (
        owned_fields.get(canonical_phase, [])
        if isinstance(owned_fields, Mapping)
        else []
    )
    repairable_prior_paths = list(
        dict.fromkeys(
            str(path)
            for phase in phase_order[: max(phase_index, 0)]
            for path in (
                owned_fields.get(phase, [])
                if isinstance(owned_fields, Mapping)
                and isinstance(owned_fields.get(phase), list)
                else []
            )
            if isinstance(path, str) and path
        )
    )
    editable_paths = list(
        dict.fromkeys(
            [
                *repairable_prior_paths,
                *(
                    str(path)
                    for path in phase_owned
                    if isinstance(path, str) and path
                ),
            ]
        )
    )
    deferred = execution.get("deferredWork")
    deferred_work = dict(deferred) if isinstance(deferred, Mapping) else {}
    later_deferred = {
        phase: copy.deepcopy(deferred_work.get(phase, []))
        for phase in [*phase_order[phase_index + 1 :], "finalization"]
        if phase in deferred_work
    }
    visual_scout = copy.deepcopy(execution.get("visualScout", {}))
    if (
        isinstance(visual_scout, dict)
        and phase_execution_version(spec) >= SIMPLIFIED_PHASE_EXECUTION_VERSION
    ):
        phase_rubrics = visual_scout.get("phaseRubrics")
        active_rubric = copy.deepcopy(
            phase_rubrics.get(canonical_phase, {})
            if isinstance(phase_rubrics, Mapping)
            else {}
        )
        assessment = spec.get("preSpecAssessment")
        style = (
            assessment.get("visualStyle")
            if isinstance(assessment, Mapping)
            else None
        )
        if isinstance(active_rubric, dict):
            active_rubric["styleChecks"] = visual_style_directives(
                style,
                canonical_phase,
            )
        visual_scout["activePhaseInput"] = {
            "phaseId": canonical_phase,
            "phaseRubric": active_rubric,
        }
    return {
        "passId": pass_id,
        "objective": config.get("objective", ""),
        "acceptance": config.get("acceptance", []),
        "editableComponentIds": editable_components,
        "editableMaterialIds": materials
        if phase_index >= phase_order.index("lookdev")
        else [],
        "requiredViews": config.get("requiredViews", []),
        "diagnosticViews": config.get("diagnosticViews", []),
        "requiredLayerScores": config.get("requiredLayerScores", {}),
        "ownedLayers": config.get("ownedLayers", []),
        "protectedLayers": config.get("preserveLayers", []),
        "minimumRefinementDelta": config.get(
            "minimumRefinementDelta", MIN_REFINEMENT_SCORE_DELTA
        ),
        "maximumVisualRegression": config.get(
            "maximumVisualRegression", MAX_REFINEMENT_REGRESSION
        ),
        "derivedDepth": depth,
        "specDeltaContract": {
            "strategy": "stable-core-plus-phase-delta",
            "editablePaths": editable_paths,
            "activePhaseOwnedPaths": copy.deepcopy(phase_owned),
            "repairablePriorPhasePaths": repairable_prior_paths,
            "correctionAuthority": copy.deepcopy(
                execution.get("correctionAuthority", {})
            ),
            "crossPhaseRepairRule": (
                "The active phase must review and may improve any earlier phase "
                "through an exact impact-assessed correction batch applied to a "
                "challenger. A passed phase is a baseline, not frozen. Compare "
                "source/current/previous renders and veto only visible whole-result "
                "regression; future-phase work remains forbidden."
            ),
            "stableCoreFields": copy.deepcopy(execution.get("stableCoreFields", [])),
            "stableCoreChangeRule": (
                "Change a stable-core field only when observed evidence falsifies it; record the reason."
            ),
            "futurePhaseWorkForbidden": later_deferred,
        },
        "visualCycle": {
            "steps": copy.deepcopy(
                execution.get("cycle", {}).get(
                    "steps",
                    [
                        "spec-delta",
                        "build-render",
                        "reference-comparison",
                        "independent-review",
                        "promote-or-rollback",
                    ],
                )
                if isinstance(execution.get("cycle"), Mapping)
                else []
            ),
            "maximumNonVisualOperationsBeforeRender": 2,
            "visibleProgressRequired": True,
            "comparisonAuthority": execution.get("cycle", {}).get(
                "comparisonAuthority",
                "source-image-only",
            ),
            "multiViewPresentation": "single-2x2-sheet",
            "administrativeWorkCountsAsProgress": False,
        },
        "visualScout": visual_scout,
        "qualityGate": copy.deepcopy(
            execution.get(
                "qualityGate",
                {
                    "mode": "ai-scout-human",
                    "aiOverallFloor": SIMPLIFIED_AI_OVERALL_FLOOR,
                    "blindScoutDecisions": ["approve", "reject"],
                    "maxBlindScoutObservations": MAX_BLIND_SCOUT_OBSERVATIONS,
                },
            )
            if phase_execution_version(spec) >= SIMPLIFIED_PHASE_EXECUTION_VERSION
            else {}
        ),
        "humanApproval": copy.deepcopy(execution.get("humanApproval", {})),
        "userFeedback": latest_user_phase_feedback(spec, pass_id),
        "contextProjection": phase_spec_projection(spec, pass_id),
        "frozenBaseline": (
            {
                "passId": baseline_pass,
                "specHash": baseline.get("specHash"),
                "layerScores": baseline.get("layerScores", {}),
                "comparisonSha256": (
                    baseline.get("evidence", {}).get("comparisonSha256")
                    if isinstance(baseline.get("evidence"), dict)
                    else ""
                ),
                "renderSnapshot": copy.deepcopy(
                    baseline.get("renderSnapshot", {})
                ),
            }
            if isinstance(baseline, dict)
            else {}
        ),
    }


def prior_pass_regression_failures(
    spec: dict[str, Any], entry: dict[str, Any], config: dict[str, Any]
) -> list[str]:
    baseline_pass_value = config.get("visualBaselinePassId")
    if not isinstance(baseline_pass_value, str) or not baseline_pass_value.strip():
        return []
    baseline_pass = baseline_pass_value.strip()
    baseline = _latest_history_entry(spec, baseline_pass)
    if baseline is None:
        return [f"visual review needs an accepted {baseline_pass!r} regression baseline"]
    tolerance_value = config.get("maximumVisualRegression", 0.0)
    tolerance = float(tolerance_value) if is_number(tolerance_value) else 0.0
    failures: list[str] = []
    preserve_layers = config.get("preserveLayers", [])
    layers = (
        [str(item) for item in preserve_layers if isinstance(item, str) and item]
        if isinstance(preserve_layers, list)
        else []
    )
    for layer in layers:
        before = _score_for_layer(baseline.get("layerScores"), layer)
        after = _score_for_layer(entry.get("layerScores"), layer)
        # Protected layers are veto-only, not acceptance targets for this phase.
        # Still require the independent reviewer to score them: silently omitting
        # one would make a later lookdev/optimization pass able to hide damaged form.
        if before is not None and after is None:
            failures.append(
                f"protected layer {layer!r} needs an independent score against "
                f"accepted {baseline_pass!r}"
            )
        elif before is not None and after is not None and after < before - tolerance:
            failures.append(
                f"protected layer {layer!r} regressed from accepted {baseline_pass!r} "
                f"by more than {tolerance}"
            )
    baseline_views = review_visual_views(baseline)
    current_views = review_visual_views(entry)
    baseline_by_id = {
        _canonical_regression_view_id(view): view
        for view in baseline_views
        if _acceptance_diagnostic_view(view)
    }
    current_by_id = {
        _canonical_regression_view_id(view): view
        for view in current_views
        if _acceptance_diagnostic_view(view)
    }
    for view_id, before_view in baseline_by_id.items():
        after_view = current_by_id.get(view_id)
        if not isinstance(after_view, dict):
            failures.append(
                f"current review needs a comparable acceptance view for protected "
                f"{baseline_pass!r} view {view_id!r}"
            )
            continue
        before_quality = _view_diagnostic_quality(before_view)
        after_quality = _view_diagnostic_quality(after_view)
        for metric, before in before_quality.items():
            if simplified_visual_gate_enabled(spec, str(entry.get("passId") or "")):
                # The current workflow delegates visual regression to the
                # source/current/previous image comparison and blind scout.
                continue
            metric_tolerance = tolerance
            after = after_quality.get(metric)
            if after is None or after < before - metric_tolerance:
                failures.append(
                    f"protected view {view_id!r} {metric} regressed from accepted "
                    f"{baseline_pass!r} by more than {metric_tolerance}"
                )
    return failures


def _prior_pass_regression_failures(
    spec: dict[str, Any], entry: dict[str, Any], config: dict[str, Any]
) -> list[str]:
    """Compatibility alias for callers of the former private helper."""

    return prior_pass_regression_failures(spec, entry, config)


def _post_optimization_regression_failures(
    spec: dict[str, Any], entry: dict[str, Any], config: dict[str, Any]
) -> list[str]:
    """Compatibility wrapper for callers using the old optimization-only name."""

    return prior_pass_regression_failures(spec, entry, config)


def blind_scout_entry_failures(
    spec: Mapping[str, Any],
    entry: Mapping[str, Any],
    pass_id: str,
    *,
    require_approve: bool = False,
) -> list[str]:
    """Validate the compact blind-scout record stored with an accepted review.

    The scout is deliberately forbidden from naming spec IDs, parameter paths,
    scores, or numeric fixes.  It reports only what a person can see in the
    comparison; the main agent maps those observations after both reviewers return.
    """

    if not simplified_visual_gate_enabled(spec, pass_id):
        return []
    evidence = entry.get("evidence")
    comparison_hash = (
        evidence.get("comparisonSha256")
        if isinstance(evidence, Mapping)
        else None
    )
    scout = entry.get("blindScout")
    failures: list[str] = []
    if not isinstance(scout, Mapping):
        return ["blindScout is required for the v4 visual gate"]
    allowed_scout_fields = {
        "artifactType",
        "version",
        "phaseId",
        "decision",
        "comparisonSha256",
        "reviewedAt",
        "reviewer",
        "observations",
    }
    unexpected_scout_fields = sorted(set(scout) - allowed_scout_fields)
    if unexpected_scout_fields:
        failures.append(
            "blindScout contains forbidden fields: "
            + ", ".join(str(field) for field in unexpected_scout_fields)
        )
    if scout.get("artifactType") != "threejs-sculpt-blind-scout":
        failures.append("blindScout.artifactType is invalid")
    if scout.get("version") != BLIND_SCOUT_ARTIFACT_VERSION:
        failures.append(
            f"blindScout.version must be {BLIND_SCOUT_ARTIFACT_VERSION}"
        )
    expected_phase_id = blind_scout_phase_id(pass_id)
    if scout.get("phaseId") != expected_phase_id:
        failures.append(
            f"blindScout.phaseId must match the active phase {expected_phase_id!r}"
        )
    decision = scout.get("decision")
    if decision not in {"approve", "reject"}:
        failures.append("blindScout.decision must be approve or reject")
    if scout.get("comparisonSha256") != comparison_hash:
        failures.append("blindScout is not bound to the comparison hash")
    if not isinstance(scout.get("reviewedAt"), str) or not scout["reviewedAt"].strip():
        failures.append("blindScout.reviewedAt is required")
    reviewer = scout.get("reviewer")
    if not isinstance(reviewer, Mapping):
        failures.append("blindScout.reviewer is required")
    else:
        unexpected_reviewer_fields = sorted(
            set(reviewer) - {"role", "contextId", "model"}
        )
        if unexpected_reviewer_fields:
            failures.append(
                "blindScout.reviewer contains forbidden fields: "
                + ", ".join(str(field) for field in unexpected_reviewer_fields)
            )
        if reviewer.get("role") != "blind-visual-scout":
            failures.append("blindScout.reviewer.role must be blind-visual-scout")
        if not isinstance(reviewer.get("contextId"), str) or not reviewer["contextId"].strip():
            failures.append("blindScout.reviewer.contextId is required")
        if not isinstance(reviewer.get("model"), str) or not reviewer["model"].strip():
            failures.append("blindScout.reviewer.model is required")
        primary = entry.get("reviewerEvidence")
        primary_context = (
            primary.get("reviewerContextId")
            if isinstance(primary, Mapping)
            else None
        )
        if (
            isinstance(primary_context, str)
            and primary_context.strip()
            and reviewer.get("contextId") == primary_context
        ):
            failures.append("blindScout contextId must differ from the primary reviewer")
    observations = scout.get("observations")
    if not isinstance(observations, list):
        failures.append("blindScout.observations must be an array")
        observations = []
    if len(observations) > MAX_BLIND_SCOUT_OBSERVATIONS:
        failures.append(
            f"blindScout.observations may contain at most {MAX_BLIND_SCOUT_OBSERVATIONS} items"
        )
    all_categories = {
        category
        for categories in BLIND_SCOUT_PHASE_CATEGORIES.values()
        for category in categories
    }
    blocking_count = 0
    forbidden_tokens = {
        "componentid",
        "componentids",
        "parameterpath",
        "score",
        "numeric",
        "value",
        "beforevalue",
        "expectedvalue",
    }
    for index, observation in enumerate(observations):
        label = f"blindScout.observations[{index}]"
        if not isinstance(observation, Mapping):
            failures.append(f"{label} must be an object")
            continue
        unexpected_observation_fields = sorted(
            set(observation)
            - {
                "visualRegion",
                "category",
                "phaseScope",
                "direction",
                "severity",
                "viewIds",
            }
        )
        if unexpected_observation_fields:
            failures.append(
                f"{label} contains forbidden fields: "
                + ", ".join(str(field) for field in unexpected_observation_fields)
            )
        for field in ("visualRegion", "category", "direction"):
            if not isinstance(observation.get(field), str) or not observation[field].strip():
                failures.append(f"{label}.{field} is required")
        direction = observation.get("direction")
        if isinstance(direction, str) and re.search(r"\d", direction):
            failures.append(f"{label}.direction must not contain a numeric fix")
        severity = observation.get("severity")
        if severity not in {"critical", "major", "minor"}:
            failures.append(f"{label}.severity must be critical, major, or minor")
        category = observation.get("category")
        if category not in all_categories:
            failures.append(f"{label}.category is not a canonical visual category")
        expected_scope = blind_scout_phase_scope(expected_phase_id, str(category))
        phase_scope = observation.get("phaseScope")
        if phase_scope != expected_scope:
            failures.append(
                f"{label}.phaseScope must be {expected_scope!r} for "
                f"{expected_phase_id} category {category!r}"
            )
        if expected_scope in {"current", "protected"} and severity in {"critical", "major"}:
            blocking_count += 1
        view_ids = observation.get("viewIds")
        if not isinstance(view_ids, list) or not view_ids or not all(
            isinstance(view_id, str) and view_id.strip() for view_id in view_ids
        ):
            failures.append(f"{label}.viewIds must contain reviewed view ids")
        elif isinstance(evidence, Mapping):
            known_views = {
                view.get("viewId")
                for view in evidence.get("views", [])
                if isinstance(view, Mapping) and isinstance(view.get("viewId"), str)
            }
            unknown = sorted(set(view_ids) - known_views)
            if unknown:
                failures.append(f"{label}.viewIds reference unknown views: " + ", ".join(unknown))
        for key in observation:
            if str(key).lower() in forbidden_tokens:
                failures.append(f"{label} must not contain spec/score/numeric field {key!r}")
    if decision == "approve" and blocking_count:
        failures.append(
            "blindScout approve cannot contain current/protected critical or major observations"
        )
    if decision == "reject" and not blocking_count:
        failures.append(
            "blindScout reject requires at least one current/protected critical or major observation"
        )
    if require_approve and decision != "approve":
        failures.append("blindScout decision must be approve before phase promotion")
    return list(dict.fromkeys(failures))


def blind_scout_mapping_failures(
    scout: Any,
    mapping: Any,
    target_catalog: Mapping[str, Mapping[str, Any]],
    *,
    main_agent_context: str | None = None,
) -> list[str]:
    """Validate the main agent's 1:1 bridge from blind observations to spec targets."""

    if not isinstance(mapping, Mapping):
        return ["blindScoutMapping is required for the v4 visual gate"]

    failures: list[str] = []
    unexpected_fields = sorted(
        set(mapping) - {"artifactType", "version", "mapper", "items"}
    )
    if unexpected_fields:
        failures.append(
            "blindScoutMapping contains unsupported fields: "
            + ", ".join(str(field) for field in unexpected_fields)
        )
    if mapping.get("artifactType") != BLIND_SCOUT_MAPPING_ARTIFACT_TYPE:
        failures.append(
            f"blindScoutMapping.artifactType must be "
            f"{BLIND_SCOUT_MAPPING_ARTIFACT_TYPE!r}"
        )
    if mapping.get("version") != BLIND_SCOUT_MAPPING_VERSION:
        failures.append(
            f"blindScoutMapping.version must be {BLIND_SCOUT_MAPPING_VERSION}"
        )

    mapper = mapping.get("mapper")
    if not isinstance(mapper, Mapping):
        failures.append("blindScoutMapping.mapper is required")
    else:
        unexpected_mapper_fields = sorted(set(mapper) - {"role", "contextId"})
        if unexpected_mapper_fields:
            failures.append(
                "blindScoutMapping.mapper contains unsupported fields: "
                + ", ".join(str(field) for field in unexpected_mapper_fields)
            )
        if mapper.get("role") != "main-agent":
            failures.append("blindScoutMapping.mapper.role must be main-agent")
        mapper_context = mapper.get("contextId")
        if not isinstance(mapper_context, str) or not mapper_context.strip():
            failures.append("blindScoutMapping.mapper.contextId is required")
        elif (
            isinstance(main_agent_context, str)
            and main_agent_context.strip()
            and mapper_context != main_agent_context
        ):
            failures.append(
                "blindScoutMapping mapper contextId must match the main agent "
                "builder contextId"
            )

    observations = scout.get("observations") if isinstance(scout, Mapping) else None
    if not isinstance(observations, list):
        failures.append("blindScoutMapping requires valid blindScout.observations")
        observations = []

    items = mapping.get("items")
    if not isinstance(items, list):
        failures.append("blindScoutMapping.items must be an array")
        items = []

    seen_indices: set[int] = set()
    for item_index, item in enumerate(items):
        label = f"blindScoutMapping.items[{item_index}]"
        if not isinstance(item, Mapping):
            failures.append(f"{label} must be an object")
            continue
        unexpected_item_fields = sorted(
            set(item) - {"observationIndex", "status", "targets", "reason"}
        )
        if unexpected_item_fields:
            failures.append(
                f"{label} contains unsupported fields: "
                + ", ".join(str(field) for field in unexpected_item_fields)
            )
        observation_index = item.get("observationIndex")
        observation: Mapping[str, Any] | None = None
        if not isinstance(observation_index, int) or isinstance(observation_index, bool):
            failures.append(f"{label}.observationIndex must be an integer")
        else:
            if observation_index in seen_indices:
                failures.append(f"{label}.observationIndex duplicates {observation_index}")
            seen_indices.add(observation_index)
            if 0 <= observation_index < len(observations):
                candidate = observations[observation_index]
                if isinstance(candidate, Mapping):
                    observation = candidate
            else:
                failures.append(
                    f"{label}.observationIndex does not reference a scout observation"
                )

        status = item.get("status")
        if status not in {"mapped", "unmapped", "deferred"}:
            failures.append(f"{label}.status must be mapped, unmapped, or deferred")
        targets = item.get("targets")
        if not isinstance(targets, list):
            failures.append(f"{label}.targets must be an array")
            targets = []

        valid_target_count = 0
        for target_index, target in enumerate(targets):
            target_label = f"{label}.targets[{target_index}]"
            if not isinstance(target, Mapping):
                failures.append(f"{target_label} must be an object")
                continue
            unexpected_target_fields = sorted(set(target) - {"targetType", "target"})
            if unexpected_target_fields:
                failures.append(
                    f"{target_label} contains unsupported fields: "
                    + ", ".join(str(field) for field in unexpected_target_fields)
                )
            target_type = target.get("targetType")
            target_id = target.get("target")
            if target_type not in CORRECTION_TARGET_TYPES:
                failures.append(
                    f"{target_label}.targetType must be a canonical spec target type"
                )
                continue
            if not isinstance(target_id, str) or not target_id.strip():
                failures.append(f"{target_label}.target is required")
                continue
            known_targets = target_catalog.get(str(target_type), {})
            if not isinstance(known_targets, Mapping) or target_id not in known_targets:
                failures.append(
                    f"{target_label} must reference an existing {target_type} id"
                )
                continue
            valid_target_count += 1

        if status == "mapped" and valid_target_count == 0:
            failures.append(
                f"{label} with status mapped must contain a valid spec target"
            )
        if status in {"unmapped", "deferred"} and targets:
            failures.append(f"{label} with status {status} must not contain targets")
        if status == "unmapped" and (
            not isinstance(item.get("reason"), str) or not item["reason"].strip()
        ):
            failures.append(f"{label}.reason is required when status is unmapped")

        if observation is not None:
            phase_scope = observation.get("phaseScope")
            severity = observation.get("severity")
            if phase_scope == "deferred" and status != "deferred":
                failures.append(
                    f"{label}.status must be deferred for a future-phase observation"
                )
            if phase_scope != "deferred" and status == "deferred":
                failures.append(
                    f"{label}.status cannot defer a current/protected observation"
                )
            if (
                phase_scope in {"current", "protected"}
                and severity in {"critical", "major"}
                and status != "mapped"
            ):
                failures.append(
                    f"{label} must map the current/protected {severity} observation "
                    "before the gate can pass"
                )

    expected_indices = set(range(len(observations)))
    if seen_indices != expected_indices:
        failures.append(
            "blindScoutMapping.items must contain exactly one item for each "
            "blindScout observation index"
        )
    return list(dict.fromkeys(failures))


def review_failures(
    spec: dict[str, Any],
    entry: dict[str, Any],
    pass_id: str,
    spec_path: Path | None = None,
) -> list[str]:
    failures: list[str] = []
    if entry.get("passId") != pass_id:
        return [f"review passId must be {pass_id!r}"]
    if entry.get("action") != "continue":
        return ["latest review action is not continue"]
    current_hash = review_spec_hash(spec, pass_id)
    review_hash = entry.get("specHash")
    if schema_version_at_least(spec, "3.0") and review_hash != current_hash:
        failures.append("review was not produced for the current spec content")

    kind = evidence_type(spec, pass_id)
    config = effective_pass_config(spec, pass_id)
    if kind == "visual":
        failures.extend(perceptual_review_failures(spec, entry))
        failures.extend(_visual_review_failures(spec, entry, pass_id, config, spec_path))
        failures.extend(
            blind_scout_entry_failures(
                spec,
                entry,
                pass_id,
                require_approve=True,
            )
        )
        reviewer_evidence = entry.get("reviewerEvidence")
        failures.extend(
            blind_scout_mapping_failures(
                entry.get("blindScout"),
                entry.get("blindScoutMapping"),
                review_target_catalog(spec),
                main_agent_context=(
                    reviewer_evidence.get("builderContextId")
                    if isinstance(reviewer_evidence, Mapping)
                    else None
                ),
            )
        )
        failures.extend(prior_pass_regression_failures(spec, entry, config))
    elif kind == "runtime":
        checks = entry.get("runtimeChecks")
        if not isinstance(checks, dict):
            failures.append("runtimeChecks object is required")
        else:
            for name in config.get("requiredRuntimeChecks", []):
                if checks.get(name) is not True:
                    failures.append(f"runtime check {name!r} must pass")
    else:
        metrics = entry.get("metrics")
        if not isinstance(metrics, dict):
            failures.append("measured metrics are required")
        else:
            configured_targets = config.get("metricTargets")
            if isinstance(configured_targets, dict):
                metric_targets = configured_targets
            else:
                budget = spec.get("performanceBudget")
                budget = budget if isinstance(budget, dict) else {}
                metric_targets = {
                    "fps": {"min": budget.get("fpsTarget")},
                    "drawCalls": {"max": budget.get("maxDrawCalls")},
                    "triangles": {"max": budget.get("targetTriangles")},
                }
            required_metrics = config.get("requiredMetrics")
            if not isinstance(required_metrics, list) or not required_metrics:
                required_metrics = list(metric_targets)
            for name in required_metrics:
                target = metric_targets.get(name)
                value = metrics.get(name)
                if (
                    not is_number(value)
                    or not isinstance(target, dict)
                    or not any(is_number(target.get(bound)) for bound in ("min", "max"))
                ):
                    failures.append(f"metric {name!r} is missing or invalid")
                    continue
                if is_number(target.get("min")) and float(value) < float(target["min"]):
                    failures.append(f"metric {name!r} must be >= {target['min']}")
                if is_number(target.get("max")) and float(value) > float(target["max"]):
                    failures.append(f"metric {name!r} must be <= {target['max']}")
        artifacts = entry.get("artifacts")
        if not isinstance(artifacts, dict):
            artifacts = {}
        for name in config.get("requiredArtifacts", []):
            if not artifacts.get(name):
                failures.append(f"artifact {name!r} is required")
        if config.get("requiredPostOptimizationVisualReview") is True:
            failures.extend(_visual_review_failures(spec, entry, pass_id, config, spec_path))
            failures.extend(prior_pass_regression_failures(spec, entry, config))
    return list(dict.fromkeys(failures))


def _latest_review(
    spec: dict[str, Any],
    pass_id: str,
    after_index: int,
    *,
    require_current_hash: bool = True,
) -> tuple[int, dict[str, Any] | None]:
    history = spec.get("reviewHistory", [])
    if not isinstance(history, list):
        return -1, None
    require_hash = require_current_hash and schema_version_at_least(spec, "3.0")
    for index in range(len(history) - 1, after_index, -1):
        entry = history[index]
        if not isinstance(entry, dict) or entry.get("passId") != pass_id:
            continue
        if require_hash and entry.get("specHash") != review_spec_hash(spec, pass_id):
            continue
        return index, entry
    return -1, None


def human_phase_approval_required(
    spec: Mapping[str, Any],
    pass_id: str | None = None,
) -> bool:
    contract = spec.get("phaseExecutionContract")
    if not isinstance(contract, Mapping) or contract.get("version") not in {3, 4}:
        return False
    policy = contract.get("humanApproval")
    if not isinstance(policy, Mapping) or policy.get("required") is not True:
        return False
    perceptual = spec.get("perceptualContract")
    approval_mode = (
        perceptual.get("approvalMode")
        if isinstance(perceptual, Mapping)
        else "phase-by-phase"
    )
    if approval_mode != "final-only":
        return True
    ids = pass_order(dict(spec))
    return bool(ids) and pass_id == ids[-1]


def phase_review_key(entry: Mapping[str, Any]) -> str:
    """Bind a human decision to the exact system-reviewed phase artifact."""

    evidence = entry.get("evidence")
    evidence = evidence if isinstance(evidence, Mapping) else {}
    reviewer = entry.get("reviewerEvidence")
    reviewer = reviewer if isinstance(reviewer, Mapping) else {}
    payload = {
        "passId": entry.get("passId"),
        "reviewId": entry.get("reviewId") or reviewer.get("reviewId"),
        "specHash": entry.get("specHash"),
        "action": entry.get("action"),
        "comparisonSha256": evidence.get("comparisonSha256"),
        "reviewedArtifactSha256": reviewer.get("reviewedArtifactSha256"),
        "blindScout": entry.get("blindScout"),
        "blindScoutMapping": entry.get("blindScoutMapping"),
        "runtimeChecks": entry.get("runtimeChecks"),
        "metrics": entry.get("metrics"),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _reviewed_artifact_sha256(entry: Mapping[str, Any]) -> str:
    evidence = entry.get("evidence")
    if isinstance(evidence, Mapping):
        comparison = evidence.get("comparisonSha256")
        if isinstance(comparison, str):
            return comparison
    reviewer = entry.get("reviewerEvidence")
    if isinstance(reviewer, Mapping):
        artifact = reviewer.get("reviewedArtifactSha256")
        if isinstance(artifact, str):
            return artifact
    return ""


def matching_user_phase_decision(
    spec: Mapping[str, Any],
    pass_id: str,
    entry: Mapping[str, Any],
) -> dict[str, Any] | None:
    approvals = spec.get("userPhaseApprovals")
    if not isinstance(approvals, list):
        return None
    review_key = phase_review_key(entry)
    for item in reversed(approvals):
        if not isinstance(item, dict):
            continue
        if (
            item.get("passId") == pass_id
            and item.get("reviewKey") == review_key
            and item.get("specHash") == entry.get("specHash")
            and item.get("reviewedArtifactSha256")
            == _reviewed_artifact_sha256(entry)
        ):
            return item
    return None


def latest_user_phase_feedback(
    spec: Mapping[str, Any],
    pass_id: str,
) -> list[dict[str, Any]]:
    approvals = spec.get("userPhaseApprovals")
    if not isinstance(approvals, list):
        return []
    for item in reversed(approvals):
        if (
            isinstance(item, Mapping)
            and item.get("passId") == pass_id
            and item.get("decision") == "changes-requested"
        ):
            feedback = item.get("feedback")
            return [
                dict(finding)
                for finding in feedback
                if isinstance(finding, Mapping)
            ] if isinstance(feedback, list) else []
    return []


def record_user_phase_decision(
    spec: dict[str, Any],
    pass_id: str,
    decision: str,
    *,
    user_statement: str,
    feedback: list[dict[str, Any]] | None = None,
    recorded_at: str | None = None,
) -> dict[str, Any]:
    """Record explicit user judgment only after the complete system gate passes."""

    if decision not in {"approved", "changes-requested"}:
        raise ValueError("user phase decision must be approved or changes-requested")
    if not isinstance(user_statement, str) or not user_statement.strip():
        raise ValueError("user phase decision requires the user's explicit statement")
    status = pipeline_status(spec)
    if (
        status.get("currentPass") != pass_id
        or status.get("state") != "awaiting-user-approval"
    ):
        raise ValueError(
            "user approval can be recorded only after the current phase passes "
            "deterministic preflight and both AI review layers"
        )
    pending = status.get("pendingUserApproval")
    if not isinstance(pending, Mapping):
        raise ValueError("current phase has no system-passed artifact awaiting user approval")
    normalized_feedback = [
        {
            "visualRegion": str(item.get("visualRegion") or "").strip(),
            "problem": str(item.get("problem") or "").strip(),
            "expectedDirection": str(item.get("expectedDirection") or "").strip(),
        }
        for item in (feedback or [])
        if isinstance(item, Mapping)
    ]
    if decision == "changes-requested" and (
        not normalized_feedback
        or any(not all(item.values()) for item in normalized_feedback)
    ):
        raise ValueError(
            "changes-requested requires feedback items with visualRegion, problem, "
            "and expectedDirection"
        )
    if decision == "approved" and normalized_feedback:
        raise ValueError("approved user phase decisions must not include change feedback")
    record = {
        "passId": pass_id,
        "decision": decision,
        "reviewKey": pending.get("reviewKey"),
        "reviewId": pending.get("reviewId", ""),
        "specHash": pending.get("specHash"),
        "reviewedArtifactSha256": pending.get("reviewedArtifactSha256", ""),
        "userStatement": user_statement.strip(),
        "feedback": normalized_feedback,
        "recordedAt": recorded_at
        or datetime.now(timezone.utc).isoformat(),
    }
    approvals = spec.setdefault("userPhaseApprovals", [])
    if not isinstance(approvals, list):
        raise ValueError("userPhaseApprovals must be an array")
    approvals.append(record)
    return record


def pipeline_status(
    spec: dict[str, Any],
    spec_path: Path | None = None,
) -> dict[str, Any]:
    ids = pass_order(spec)
    completed: list[str] = []
    completion_index = -1
    current = "complete"
    state = "complete"
    latest_action = ""
    gate_failures: list[str] = []
    pending_correction_batch: dict[str, Any] = {}
    pending_user_approval: dict[str, Any] = {}
    user_feedback: list[dict[str, Any]] = []

    for pass_id in ids:
        index, entry = _latest_review(spec, pass_id, completion_index)
        if entry is None:
            current = pass_id
            _, previous_entry = _latest_review(
                spec,
                pass_id,
                completion_index,
                require_current_hash=False,
            )
            previous_action = (
                str(previous_entry.get("action") or "")
                if isinstance(previous_entry, dict)
                else ""
            )
            if isinstance(previous_entry, dict) and is_pending_quality_attempt(previous_entry):
                latest_action = previous_action
                pending_correction_batch = (
                    previous_entry.get("correctionBatch")
                    if isinstance(previous_entry.get("correctionBatch"), dict)
                    else correction_batch_from_verdict(
                        {
                            "reviewId": previous_entry.get("reviewId"),
                            "action": previous_action,
                            "issues": previous_entry.get("reviewIssues", []),
                            "corrections": previous_entry.get("reviewCorrections", []),
                        }
                    )
                )
                state = "needs-refinement"
                gate_failures = ["apply the complete pending correction batch before rendering again"]
            else:
                state = "ready"
            break
        latest_action = str(entry.get("action") or "")
        failures = review_failures(spec, entry, pass_id, spec_path)
        if not failures:
            if human_phase_approval_required(spec, pass_id):
                user_decision = matching_user_phase_decision(spec, pass_id, entry)
                if user_decision is None:
                    current = pass_id
                    state = "awaiting-user-approval"
                    pending_user_approval = {
                        "required": True,
                        "systemPassed": True,
                        "passId": pass_id,
                        "reviewKey": phase_review_key(entry),
                        "reviewId": entry.get("reviewId", ""),
                        "specHash": entry.get("specHash"),
                        "reviewedArtifactSha256": _reviewed_artifact_sha256(entry),
                        "instruction": (
                            "Show the user the current output and exact evidence, then ask for "
                            "explicit approval or structured change feedback."
                        ),
                    }
                    gate_failures = ["explicit user approval is required to complete this phase"]
                    break
                if user_decision.get("decision") == "changes-requested":
                    current = pass_id
                    state = "needs-user-refinement"
                    user_feedback = latest_user_phase_feedback(spec, pass_id)
                    gate_failures = [
                        "user requested changes: "
                        + "; ".join(
                            f"{item.get('visualRegion')}: {item.get('problem')} "
                            f"→ {item.get('expectedDirection')}"
                            for item in user_feedback
                        )
                    ]
                    break
            completed.append(pass_id)
            completion_index = index
            continue
        current = pass_id
        gate_failures = failures
        quality_direction_stop = (
            latest_action == "stop"
            and str(entry.get("candidateDisposition") or "").startswith("rejected-")
        )
        state = "needs-strategy-change" if quality_direction_stop else {
            "stop": "stopped",
            "request-input": "awaiting-input",
            STRATEGY_RESET_ACTION: "needs-strategy-change",
            "refine-spec": "needs-refinement",
            "refine-code": "needs-refinement",
            "refine-batch": "needs-refinement",
        }.get(latest_action, "needs-review")
        if quality_direction_stop:
            gate_failures = list(
                dict.fromkeys(
                    [
                        "reviewer stopped a regressed challenger; the champion was restored and a different strategy is required",
                        *gate_failures,
                    ]
                )
            )
        if is_pending_quality_attempt(entry):
            state = "needs-refinement"
            pending_correction_batch = (
                entry.get("correctionBatch")
                if isinstance(entry.get("correctionBatch"), dict)
                else correction_batch_from_verdict(
                    {
                        "reviewId": entry.get("reviewId"),
                        "action": latest_action,
                        "issues": entry.get("reviewIssues", []),
                        "corrections": entry.get("reviewCorrections", []),
                    }
                )
            )
        break

    required = [] if current == "complete" else next_required_evidence(spec, current)
    history = spec.get("reviewHistory", [])
    current_records = (
        [
            entry
            for entry in history
            if isinstance(entry, dict) and entry.get("passId") == current
        ]
        if isinstance(history, list) and current != "complete"
        else []
    )
    current_budget = refinement_budget(current_records)
    if (
        current != "complete"
        and current_budget["exhausted"]
        and state == "needs-refinement"
    ):
        state = "needs-strategy-change"
        exhaustion = (
            "refinement budget is exhausted; restore/retain the champion and record "
            "a strategy-reset before more rendering"
        )
        gate_failures = list(dict.fromkeys([exhaustion, *gate_failures]))
    remaining_passes = [] if current == "complete" else ids[len(completed):]
    return {
        "passGateMode": "adaptive-sequential",
        "passOrder": ids,
        "currentPass": current,
        "completedPasses": completed,
        "lastCompletedPass": completed[-1] if completed else "",
        "state": state,
        "latestAction": latest_action,
        "pendingCorrectionBatch": pending_correction_batch,
        "pendingUserApproval": pending_user_approval,
        "userFeedback": user_feedback
        or ([] if current == "complete" else latest_user_phase_feedback(spec, current)),
        "refinementBudget": current_budget,
        "blockedReason": "; ".join(gate_failures),
        "gateFailures": gate_failures,
        "nextRequiredEvidence": required,
        "userProgress": user_progress_contract(
            "assembled-quality-passes",
            len(completed),
            len(ids),
            current,
            remaining_passes,
        ),
        "specHash": spec_content_hash(spec),
    }


def next_required_evidence(spec: dict[str, Any], pass_id: str) -> list[str]:
    config = effective_pass_config(spec, pass_id)
    evidence = [str(item) for item in config.get("acceptance", []) if str(item).strip()]
    kind = evidence_type(spec, pass_id)
    if kind == "visual":
        evidence.extend(
            [
                "hash-bound reference + render comparison manifest for every required view",
                "one artifact-bound AI reviewer record with composite score and critique",
                "one hash-bound blind visual scout record with binary approve/reject verdict",
                "latest review action=continue for the current spec",
            ]
        )
    elif kind == "runtime":
        evidence.append("all required runtime checks recorded as true")
    else:
        evidence.append("measured performance metrics and required capture artifacts")
        if config.get("requiredPostOptimizationVisualReview") is True:
            evidence.extend(
                [
                    "a fresh post-optimization comparison manifest for every required view",
                    "AI visual scores bound to that final comparison artifact",
                    "no visual score or diagnostic regression beyond the configured tolerance",
                ]
            )
    if human_phase_approval_required(spec, pass_id):
        evidence.append(
            "explicit user approval bound to the exact system-passed phase artifact"
        )
    return list(dict.fromkeys(evidence))


def sync_pipeline(spec: dict[str, Any]) -> dict[str, Any]:
    assessment = spec.get("preSpecAssessment")
    derivation: dict[str, Any] | None = None
    if isinstance(assessment, dict):
        visual_style = assessment.get("visualStyle")
        if isinstance(visual_style, dict):
            sync_visual_style(visual_style)
        complexity_value = assessment.get("complexity")
        if isinstance(complexity_value, dict):
            complexity_is_stateful = is_stateful_complexity_contract(complexity_value)
            derivation = derive_complexity_tier(complexity_value)
            if complexity_is_stateful:
                if derivation.get("status") == "assessed":
                    complexity_value["tier"] = derivation["baseTier"]
                complexity_value["derivation"] = derivation

    effective_tier = _spec_complexity(spec)
    mins = complexity_minimums(effective_tier)
    quality_profile = str(spec.get("qualityProfile") or "balanced")
    required_hypothesis_views = adaptive_hypothesis_views(
        effective_tier,
        quality_profile,
        _hypothesis_first_view(spec),
    )

    if isinstance(assessment, dict) and isinstance(derivation, dict):
        decision = assessment.get("specDepthDecision")
        if isinstance(decision, dict):
            decision["requiredDepth"] = derivation["requiredDepth"]
            required_levels = [
                level
                for level, count in (
                    ("macro", mins["macroLayers"]),
                    ("meso", mins["mesoLayers"]),
                    ("micro", mins["microLayers"]),
                )
                if count > 0
            ]
            existing_levels = decision.get("minimumComponentLevels")
            if isinstance(existing_levels, list):
                decision["minimumComponentLevels"] = list(
                    dict.fromkeys(
                        [
                            *required_levels,
                            *(
                                str(level)
                                for level in existing_levels
                                if isinstance(level, str) and level
                            ),
                        ]
                    )
                )
            else:
                decision["minimumComponentLevels"] = required_levels
            decision["needsRepetitionSystems"] = (
                decision.get("needsRepetitionSystems") is True
                or effective_tier in {"complex", "ultra"}
            )
            decision["needsMaterialLocalOverrides"] = (
                decision.get("needsMaterialLocalOverrides") is True
                or effective_tier != "simple"
            )
            decision["needsMultipleReviewViews"] = (
                decision.get("needsMultipleReviewViews") is True
                or len(required_hypothesis_views) > 1
            )
            decision["needsActionReadyHierarchy"] = (
                decision.get("needsActionReadyHierarchy") is True
                or "actionReadinessNeed=3 requires action-ready hierarchy"
                in derivation.get("activeOverrides", [])
            )

    quality_contract = spec.get("qualityContract")
    if isinstance(quality_contract, dict):
        min_depth = quality_contract.get("minimumSpecDepth")
        if isinstance(min_depth, dict):
            for field, key in (
                ("macroComponents", "macroLayers"),
                ("mesoComponents", "mesoLayers"),
                ("microFeatureGroups", "microLayers"),
                ("materials", "materials"),
            ):
                if field not in min_depth:
                    continue
                current_val = min_depth.get(field)
                if isinstance(current_val, int) and not isinstance(current_val, bool):
                    min_depth[field] = max(current_val, mins[key])
            repetition_floor = 1 if effective_tier in {"complex", "ultra"} else 0
            decision = (
                assessment.get("specDepthDecision")
                if isinstance(assessment, dict)
                and isinstance(assessment.get("specDepthDecision"), dict)
                else {}
            )
            if decision.get("needsRepetitionSystems") is True:
                repetition_floor = 1
            current_repetitions = min_depth.get("repetitionSystems")
            if isinstance(current_repetitions, int) and not isinstance(
                current_repetitions, bool
            ):
                min_depth["repetitionSystems"] = max(
                    current_repetitions,
                    repetition_floor,
                )

    view_policy = spec.get("viewHypothesisPolicy")
    if isinstance(view_policy, dict):
        registration_fields = (
            view_policy.get("manifestPath"),
            view_policy.get("manifestSha256"),
            view_policy.get("cacheKey"),
        )
        has_registered_evidence = any(
            isinstance(value, str) and value.strip()
            for value in registration_fields
        )
        if not has_registered_evidence:
            view_policy["requiredViews"] = required_hypothesis_views
            skip = view_policy.get("skipAssessment")
            if isinstance(skip, dict):
                base_tier = derivation.get("baseTier") if isinstance(derivation, dict) else None
                skip["objectIsSimple"] = (
                    base_tier == "simple"
                    or (base_tier == "unassessed" and effective_tier == "simple")
                )

    execution = spec.get("phaseExecutionContract")
    if (
        isinstance(execution, dict)
        and phase_execution_version(spec) >= SIMPLIFIED_PHASE_EXECUTION_VERSION
    ):
        execution["correctionAuthority"] = {
            "mode": "cumulative-prior-phase-repair",
            "laterPhaseMayRepairEarlierPhase": True,
            "futurePhaseEditsForbidden": True,
            "impactAssessmentRequired": True,
            "challengerOnly": True,
            "previousRenderComparisonRequired": True,
            "protectedPhaseRegressionVeto": True,
            "priorPhaseReviewRequired": True,
            "priorPhaseImprovementAllowed": True,
            "priorPhaseIsNotFrozen": True,
            "rule": (
                "The active phase must review its own and every earlier phase's visible "
                "quality, and may improve earlier work when evidence exposes a defect "
                "or clear opportunity. Assess impact first, including predicted effects "
                "and mitigations for affected later phases, edit only a challenger, and "
                "promote only when the cumulative result is better or unchanged."
            ),
        }
        execution["visualScout"] = blind_scout_execution_contract()
        execution["qualityGate"] = {
            "mode": "ai-scout-human",
            "signals": [
                "aiOverallScore>=0.70",
                "blindScoutDecision=approve",
                "humanApproval=approved",
            ],
            "aiOverallFloor": SIMPLIFIED_AI_OVERALL_FLOOR,
            "blindScoutDecisions": ["approve", "reject"],
            "maxBlindScoutObservations": MAX_BLIND_SCOUT_OBSERVATIONS,
            "centroidAndAspect": "diagnostic-only",
            "humanApprovalAfterSystemPass": True,
        }
        perceptual = spec.get("perceptualContract")
        approval_mode = (
            perceptual.get("approvalMode")
            if isinstance(perceptual, Mapping)
            else "phase-by-phase"
        )
        execution["humanApproval"] = human_approval_contract(
            str(approval_mode or "phase-by-phase")
        )
        loop = spec.get("selfCorrectLoop")
        acceptance = loop.get("visualAcceptance") if isinstance(loop, dict) else None
        if isinstance(acceptance, dict):
            policy = acceptance.get("featureReviewPolicy")
            if not isinstance(policy, dict):
                acceptance["featureReviewPolicy"] = primary_feature_review_policy(
                    str(spec.get("qualityProfile") or "balanced")
                )
            else:
                policy["enabled"] = True
            acceptance["scoringRule"] = (
                "The primary independent reviewer returns one composite 0-to-1 score, "
                "reviews every critical or mustPass feature target, and supplies concrete "
                "corrections; the blind visual scout supplies only the independent binary "
                "visual gate."
            )
    targets = spec.get("qualityTargets")
    diagnostics = (
        targets.get("diagnosticTargets")
        if isinstance(targets, dict)
        else None
    )
    if isinstance(diagnostics, dict):
        diagnostics.pop("silhouetteIou", None)
        diagnostics["guardrailMode"] = "advisory-only"
    if schema_version_at_least(spec, CURRENT_SCHEMA_VERSION):
        configured = {
            str(item.get("id")): item
            for item in spec.get("buildPasses", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        canonical = build_pass_plan(
            _spec_complexity(spec),
            None,
            str(spec.get("qualityProfile") or "balanced"),
            interaction_required=interaction_required(spec),
            hypothesis_first_view=_hypothesis_first_view(spec),
        )
        spec["buildPasses"] = [
            {**copy.deepcopy(configured.get(str(item["id"]), {})), **item}
            for item in canonical
        ]
        for item in spec["buildPasses"]:
            if isinstance(item, dict):
                item.pop("maximumSilhouetteIouRegression", None)
        if simplified_visual_gate_enabled(spec):
            for item in spec["buildPasses"]:
                if not isinstance(item, dict) or item.get("evidenceType") != "visual":
                    continue
                item["minimumOverallScore"] = SIMPLIFIED_AI_OVERALL_FLOOR
                item["requiredLayerScores"] = {}
                item["ownedLayers"] = []
                item["preserveLayers"] = []
                item["maximumVisualRegression"] = 0.10 if item.get("id") != "blockout" else 0.0
                sanity = item.get("visualSanity")
                if isinstance(sanity, dict):
                    sanity["requiredCategories"] = []
        loop = spec.get("selfCorrectLoop")
        if isinstance(loop, dict):
            pass_ids = [str(item["id"]) for item in canonical]
            loop["reviewAfterPasses"] = pass_ids
            screenshot = loop.get("screenshotPolicy")
            if isinstance(screenshot, dict):
                screenshot["requiredForPasses"] = [
                    str(item["id"])
                    for item in canonical
                    if item.get("evidenceType") == "visual"
                ]
    payload = pipeline_status(spec)
    spec["sculptPipeline"] = payload
    return payload


def check_pass(spec: dict[str, Any], requested_pass: str) -> tuple[bool, str, dict[str, Any]]:
    status = pipeline_status(spec)
    ids = status["passOrder"]
    if requested_pass not in ids:
        return False, f"unknown build pass {requested_pass!r}; expected one of: {', '.join(ids)}", status
    if status["state"] in {"stopped", "awaiting-input", "awaiting-user-approval"}:
        return False, f"workflow is {status['state']}: {status['blockedReason']}", status
    current = status["currentPass"]
    completed = status["completedPasses"]
    if requested_pass in completed:
        return True, f"pass {requested_pass!r} is complete and may be regenerated", status
    if requested_pass == current:
        return True, f"pass {requested_pass!r} is the current pass", status
    return False, f"pass {requested_pass!r} is locked; current pass is {current!r}", status
