"""Independent, append-only visual review gate for composable sculpt modules."""

from __future__ import annotations

import hashlib
import math
import re
import shutil
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sculpt_contract import (
    BLIND_SCOUT_ARTIFACT_VERSION,
    BLIND_SCOUT_PHASE_CATEGORIES,
    CORRECTION_OPERATIONS,
    CORRECTION_SCOPES,
    CORRECTION_TARGET_TYPES,
    REFINEMENT_ACTIONS,
    STRATEGY_RESET_ACTION,
    blind_scout_mapping_failures,
    blind_scout_phase_id,
    blind_scout_phase_scope,
    correction_batch_from_verdict,
    deterministic_quality_gate_failures,
    diagnostic_quality_vector,
    effective_pass_config,
    file_sha256,
    is_pending_quality_attempt,
    quality_candidate_disposition,
    refinement_budget,
    resolve_correction_parameter,
    review_target_catalog,
    simplified_visual_gate_enabled,
    visual_checkpoint_presentation,
    visual_evidence_authority_failures,
    visual_evidence_integrity_failures,
    write_spec_atomic,
)
from sculpt_checkpoint import capture_checkpoint, restore_checkpoint
from sculpt_manifest import entry_by_id, load_modules, read_object, resolve_manifest
from sculpt_module_contract import (
    MODULE_BUILD_RECEIPT_ARTIFACT_TYPE,
    MODULE_BUILD_RECEIPT_VERSION,
    module_build_receipt_path,
)
from sculpt_image_io import load_image_rgba as load_image
from sculpt_module_state import (
    _load_cache,
    cache_path,
    check_module,
    diagnostic_floor_contract,
    implementation_contract_paths,
    implementation_semantic_hashes,
    interface_hash,
    module_representation_signature,
    module_preview_pass,
    module_required_layer_scores,
    module_status,
    recorded_reviewer_context_ids,
    visual_gate_floor,
)
from sculpt_perception import perceptual_review_failures


MODULE_REVIEW_ARTIFACT_TYPE = "threejs-sculpt-module-review"
MODULE_REVIEW_VERSION = 1
PASS_REVIEW_ARTIFACT_TYPE = "threejs-sculpt-pass-review"
PASS_REVIEW_VERSION = 1
REVIEW_ACTIONS = {
    "continue",
    *REFINEMENT_ACTIONS,
    STRATEGY_RESET_ACTION,
    "request-input",
    "stop",
}
BLOCKING_SEVERITIES = {"critical", "major"}
DOWNSTREAM_IMPACT_PHASE_ORDER = (
    "blockout",
    "form",
    "lookdev",
    "interaction",
    "finalization",
)
ACTIVE_IMPACT_PHASES = frozenset(DOWNSTREAM_IMPACT_PHASE_ORDER[:-1])
ISSUE_FAILURE_CLASSES = {
    "topology",
    "geometry",
    "proportion",
    "attachment",
    "material",
    "surface",
    "lighting",
    "evidence",
    "performance",
    "other",
}
SANITY_CATEGORIES = {
    "assemblyCorrectness",
    "proportionBalance",
    "shapeSilhouette",
    "materialPlausibility",
    "surfaceQuality",
    "signatureDetail",
}
MODULE_PREFLIGHT_ARTIFACT_TYPE = "threejs-sculpt-module-preflight"
MODULE_PREFLIGHT_VERSION = 1
BLIND_SCOUT_ARTIFACT_TYPE = "threejs-sculpt-blind-scout"
BLIND_SCOUT_VERSION = BLIND_SCOUT_ARTIFACT_VERSION
MAX_BLIND_SCOUT_OBSERVATIONS = 7


def _is_score(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and 0 <= float(value) <= 1
    )


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _finite_nonnegative(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) >= 0
    )


def _finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _validate_quantified_delta(
    value: Any,
    label: str,
    evidence_view_ids: set[str],
    failures: list[str],
) -> None:
    if not isinstance(value, dict):
        failures.append(f"{label} must be an object with metric/from/to/tolerance/unit/viewIds")
        return
    if not isinstance(value.get("metric"), str) or len(value.get("metric", "").strip()) < 3:
        failures.append(f"{label}.metric must name the measured outcome")
    for field in ("from", "to"):
        if not _finite_number(value.get(field)):
            failures.append(f"{label}.{field} must be a finite number")
    tolerance = value.get("tolerance")
    if not _finite_nonnegative(tolerance):
        failures.append(f"{label}.tolerance must be a non-negative number")
    if (
        _finite_number(value.get("from"))
        and _finite_number(value.get("to"))
        and float(value["from"]) == float(value["to"])
    ):
        failures.append(f"{label}.to must differ from .from")
    if not isinstance(value.get("unit"), str) or not value.get("unit", "").strip():
        failures.append(f"{label}.unit is required")
    view_ids = value.get("viewIds")
    if not isinstance(view_ids, list) or not view_ids or not all(
        isinstance(item, str) and item for item in view_ids
    ):
        failures.append(f"{label}.viewIds must contain reviewed view ids")
    elif evidence_view_ids:
        unknown = sorted(set(view_ids) - evidence_view_ids)
        if unknown:
            failures.append(f"{label}.viewIds reference unknown reviewed views: " + ", ".join(unknown))


def blind_scout_contract_failures(
    scout: Any,
    evidence: Mapping[str, Any],
    *,
    require_approve: bool = False,
    primary_reviewer_context: str | None = None,
    expected_phase: str | None = None,
) -> list[str]:
    """Validate the ID-free, binary visual scout record supplied by a reviewer."""

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
    if scout.get("artifactType") != BLIND_SCOUT_ARTIFACT_TYPE:
        failures.append(f"blindScout.artifactType must be {BLIND_SCOUT_ARTIFACT_TYPE!r}")
    if scout.get("version") != BLIND_SCOUT_VERSION:
        failures.append(f"blindScout.version must be {BLIND_SCOUT_VERSION}")
    canonical_phase = blind_scout_phase_id(
        expected_phase if expected_phase is not None else str(scout.get("phaseId") or "")
    )
    if (
        canonical_phase not in BLIND_SCOUT_PHASE_CATEGORIES
        or scout.get("phaseId") != canonical_phase
    ):
        failures.append(
            f"blindScout.phaseId must match the active phase {canonical_phase!r}"
        )
    decision = scout.get("decision")
    if decision not in {"approve", "reject"}:
        failures.append("blindScout.decision must be approve or reject")
    if scout.get("comparisonSha256") != evidence.get("comparisonSha256"):
        failures.append("blindScout.comparisonSha256 must match the evidence comparison hash")
    if not isinstance(scout.get("reviewedAt"), str) or not scout["reviewedAt"].strip():
        failures.append("blindScout.reviewedAt is required")
    reviewer = scout.get("reviewer")
    if not isinstance(reviewer, Mapping):
        failures.append("blindScout.reviewer must be an object")
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
        for field in ("contextId", "model"):
            if not isinstance(reviewer.get(field), str) or not reviewer[field].strip():
                failures.append(f"blindScout.reviewer.{field} is required")
        if (
            isinstance(primary_reviewer_context, str)
            and primary_reviewer_context.strip()
            and reviewer.get("contextId") == primary_reviewer_context
        ):
            failures.append("blindScout reviewer contextId must differ from primary reviewer")
    observations = scout.get("observations")
    if not isinstance(observations, list):
        failures.append("blindScout.observations must be an array")
        observations = []
    if len(observations) > MAX_BLIND_SCOUT_OBSERVATIONS:
        failures.append(
            f"blindScout.observations may contain at most {MAX_BLIND_SCOUT_OBSERVATIONS} items"
        )
    known_views = {
        item.get("viewId")
        for item in evidence.get("views", [])
        if isinstance(item, Mapping) and isinstance(item.get("viewId"), str)
    }
    all_categories = {
        category
        for categories in BLIND_SCOUT_PHASE_CATEGORIES.values()
        for category in categories
    }
    blocking = 0
    forbidden = {
        "componentid",
        "componentids",
        "parameterpath",
        "score",
        "numericfix",
        "beforevalue",
        "expectedvalue",
        "value",
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
        expected_scope = blind_scout_phase_scope(canonical_phase, str(category))
        if observation.get("phaseScope") != expected_scope:
            failures.append(
                f"{label}.phaseScope must be {expected_scope!r} for "
                f"{canonical_phase} category {category!r}"
            )
        if expected_scope in {"current", "protected"} and severity in {"critical", "major"}:
            blocking += 1
        view_ids = observation.get("viewIds")
        if not isinstance(view_ids, list) or not view_ids or not all(
            isinstance(item, str) and item.strip() for item in view_ids
        ):
            failures.append(f"{label}.viewIds must contain reviewed view ids")
        elif known_views:
            unknown = sorted(set(view_ids) - known_views)
            if unknown:
                failures.append(f"{label}.viewIds reference unknown views: " + ", ".join(unknown))
        for key in observation:
            if str(key).lower() in forbidden:
                failures.append(f"{label} must not contain spec/score/numeric field {key!r}")
    if decision == "approve" and blocking:
        failures.append(
            "blindScout approve cannot contain current/protected critical or major observations"
        )
    if decision == "reject" and not blocking:
        failures.append(
            "blindScout reject requires a current/protected critical or major observation"
        )
    if require_approve and decision != "approve":
        failures.append("blindScout decision must be approve before phase promotion")
    return list(dict.fromkeys(failures))


def _validate_observed_mismatch(
    value: Any,
    label: str,
    evidence_view_ids: set[str],
    failures: list[str],
) -> None:
    if not isinstance(value, dict):
        failures.append(
            f"{label} must be an object with parameterPath/actual/expected/unit/tolerance/viewIds"
        )
        return
    if not isinstance(value.get("parameterPath"), str) or not value.get("parameterPath", "").strip():
        failures.append(f"{label}.parameterPath is required")
    for field in ("actual", "expected"):
        if field not in value:
            failures.append(f"{label}.{field} is required")
    if not isinstance(value.get("unit"), str) or not value.get("unit", "").strip():
        failures.append(f"{label}.unit is required")
    if not _finite_nonnegative(value.get("tolerance")):
        failures.append(f"{label}.tolerance must be a non-negative number")
    view_ids = value.get("viewIds")
    if not isinstance(view_ids, list) or not view_ids or not all(
        isinstance(item, str) and item for item in view_ids
    ):
        failures.append(f"{label}.viewIds must contain reviewed view ids")
    elif evidence_view_ids:
        unknown = sorted(set(view_ids) - evidence_view_ids)
        if unknown:
            failures.append(f"{label}.viewIds reference unknown reviewed views: " + ", ".join(unknown))


def review_contract_failures(
    verdict: dict[str, Any],
    evidence: dict[str, Any],
    artifact_type: str = MODULE_REVIEW_ARTIFACT_TYPE,
    artifact_version: int = MODULE_REVIEW_VERSION,
    target_catalog: Mapping[str, Mapping[str, Any]] | None = None,
    required_sanity_categories: list[str] | None = None,
    *,
    require_blind_scout: bool = False,
    simplified_visual_gate: bool = False,
    blind_scout_phase: str | None = None,
) -> list[str]:
    failures: list[str] = []
    if verdict.get("artifactType") != artifact_type:
        failures.append(f"artifactType must be {artifact_type!r}")
    if verdict.get("version") != artifact_version:
        failures.append(f"version must be {artifact_version}")
    review_id = verdict.get("reviewId")
    if not isinstance(review_id, str) or not review_id.strip():
        failures.append("reviewId is required")
    action = verdict.get("action")
    if action not in REVIEW_ACTIONS:
        failures.append(
            "action must be continue, refine-spec, refine-code, refine-batch, "
            "strategy-reset, request-input, or stop"
        )
    evidence_view_ids = {
        item.get("viewId")
        for item in evidence.get("views", [])
        if isinstance(item, dict) and isinstance(item.get("viewId"), str) and item.get("viewId")
    }
    if verdict.get("comparisonSha256") != evidence.get("comparisonSha256"):
        failures.append("verdict comparisonSha256 does not match the reviewed evidence")
    builder = verdict.get("builder")
    reviewer = verdict.get("reviewer")
    if require_blind_scout:
        primary_context = (
            reviewer.get("contextId")
            if isinstance(reviewer, dict)
            else None
        )
        failures.extend(
            blind_scout_contract_failures(
                verdict.get("blindScout"),
                evidence,
                require_approve=action == "continue",
                primary_reviewer_context=primary_context,
                expected_phase=blind_scout_phase,
            )
        )
        failures.extend(
            blind_scout_mapping_failures(
                verdict.get("blindScout"),
                verdict.get("blindScoutMapping"),
                target_catalog or {},
                main_agent_context=(
                    builder.get("contextId")
                    if isinstance(builder, dict)
                    else None
                ),
            )
        )
    summary = verdict.get("summary")
    if not isinstance(summary, str) or len(summary.strip()) < 12:
        failures.append("summary must contain a concrete visual assessment")

    builder_context = builder.get("contextId") if isinstance(builder, dict) else None
    reviewer_context = reviewer.get("contextId") if isinstance(reviewer, dict) else None
    if not isinstance(builder_context, str) or not builder_context.strip():
        failures.append("builder.contextId is required")
    if not isinstance(reviewer_context, str) or not reviewer_context.strip():
        failures.append("reviewer.contextId is required")
    if (
        isinstance(builder_context, str)
        and isinstance(reviewer_context, str)
        and builder_context.strip() == reviewer_context.strip()
    ):
        failures.append("builder and reviewer contextId must differ")
    if not isinstance(reviewer, dict) or reviewer.get("role") != "independent-reviewer":
        failures.append("reviewer.role must be 'independent-reviewer'")
    if not isinstance(reviewer, dict) or not isinstance(reviewer.get("model"), str) or not reviewer.get("model", "").strip():
        failures.append("reviewer.model is required")

    issues = verdict.get("issues", [])
    issue_ids: set[str] = set()
    issues_by_id: dict[str, dict[str, Any]] = {}
    if not isinstance(issues, list):
        failures.append("issues must be an array")
        issues = []
    for index, issue in enumerate(issues):
        label = f"issues[{index}]"
        if not isinstance(issue, dict):
            failures.append(f"{label} must be an object")
            continue
        issue_id = issue.get("id")
        if not isinstance(issue_id, str) or not issue_id.strip():
            failures.append(f"{label}.id is required")
        elif issue_id in issue_ids:
            failures.append(f"duplicate issue id {issue_id!r}")
        else:
            issue_ids.add(issue_id)
            issues_by_id[issue_id] = issue
        if issue.get("severity") not in {"critical", "major", "minor"}:
            failures.append(f"{label}.severity must be critical, major, or minor")
        if issue.get("status") not in {"open", "resolved"}:
            failures.append(f"{label}.status must be open or resolved")
        if issue.get("failureClass") not in ISSUE_FAILURE_CLASSES:
            failures.append(
                f"{label}.failureClass must be one of: "
                + ", ".join(sorted(ISSUE_FAILURE_CLASSES))
            )
        for field in ("target", "reason"):
            if not isinstance(issue.get(field), str) or not issue.get(field, "").strip():
                failures.append(f"{label}.{field} is required")
        for field in ("rootCauseKey", "evidenceCheck"):
            if not isinstance(issue.get(field), str) or not issue.get(field, "").strip():
                failures.append(f"{label}.{field} is required")
        if action in REFINEMENT_ACTIONS and issue.get("status") == "open":
            target_type = issue.get("targetType")
            target_id = issue.get("target")
            if target_type not in CORRECTION_TARGET_TYPES:
                failures.append(
                    f"{label}.targetType must be one of: "
                    + ", ".join(sorted(CORRECTION_TARGET_TYPES))
                )
            elif target_catalog is not None and (
                target_type not in target_catalog or target_id not in target_catalog[target_type]
            ):
                failures.append(
                    f"{label}.target must reference an existing {target_type} id; got {target_id!r}"
                )
            _validate_observed_mismatch(
                issue.get("observedMismatch"),
                f"{label}.observedMismatch",
                evidence_view_ids,
                failures,
            )

    open_issue_ids = {
        issue.get("id")
        for issue in issues
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and isinstance(issue.get("id"), str)
    }

    required_sanity = list(dict.fromkeys(required_sanity_categories or []))
    if action == "continue" or action in REFINEMENT_ACTIONS:
        sanity_checks = verdict.get("sanityChecks")
        if required_sanity and not isinstance(sanity_checks, dict):
            failures.append(
                "scored review requires sanityChecks for: "
                + ", ".join(required_sanity)
            )
            sanity_checks = {}
        if isinstance(sanity_checks, dict):
            for category in required_sanity:
                label = f"sanityChecks.{category}"
                check = sanity_checks.get(category)
                if not isinstance(check, dict):
                    failures.append(f"{label} must be an object")
                    continue
                status = check.get("status")
                if status not in {"pass", "fail"}:
                    failures.append(f"{label}.status must be pass or fail")
                if not isinstance(check.get("summary"), str) or len(
                    check.get("summary", "").strip()
                ) < 8:
                    failures.append(f"{label}.summary must state the visual finding")
                component_ids = check.get("componentIds")
                if not isinstance(component_ids, list) or not all(
                    isinstance(item, str) and item for item in component_ids
                ):
                    failures.append(f"{label}.componentIds must be an array of exact ids")
                elif target_catalog is not None:
                    known_components = target_catalog.get("component", {})
                    unknown_components = sorted(
                        set(component_ids) - set(known_components)
                    )
                    if unknown_components:
                        failures.append(
                            f"{label}.componentIds reference unknown components: "
                            + ", ".join(unknown_components)
                        )
                view_ids = check.get("viewIds")
                if not isinstance(view_ids, list) or not view_ids or not all(
                    isinstance(item, str) and item for item in view_ids
                ):
                    failures.append(f"{label}.viewIds must contain reviewed view ids")
                elif evidence_view_ids:
                    unknown = sorted(set(view_ids) - evidence_view_ids)
                    if unknown:
                        failures.append(
                            f"{label}.viewIds reference unknown reviewed views: "
                            + ", ".join(unknown)
                        )
                layer_scores = verdict.get("layerScores")
                if not isinstance(layer_scores, dict) or not _is_score(
                    layer_scores.get(category)
                ):
                    failures.append(
                        f"{label} requires layerScores.{category} from 0 to 1"
                    )
                matching_issues = [
                    issue
                    for issue in issues
                    if isinstance(issue, dict)
                    and issue.get("status") == "open"
                    and issue.get("sanityCategory") == category
                ]
                if status == "fail" and not matching_issues:
                    failures.append(
                        f"{label} fail requires an open issue with matching sanityCategory"
                    )
                if action == "continue" and status != "pass":
                    failures.append(
                        f"continue is vetoed because {label}.status is not pass"
                    )
        for index, issue in enumerate(issues):
            if not isinstance(issue, dict):
                continue
            category = issue.get("sanityCategory")
            if category is not None and category not in SANITY_CATEGORIES:
                failures.append(f"issues[{index}].sanityCategory is invalid")
            if (
                issue.get("status") == "open"
                and issue.get("severity") in BLOCKING_SEVERITIES
                and required_sanity
                and category not in SANITY_CATEGORIES
            ):
                failures.append(
                    f"issues[{index}] blocking visual defect must name a valid sanityCategory"
                )

    corrections = verdict.get("corrections", [])
    if not isinstance(corrections, list):
        failures.append("corrections must be an array")
        corrections = []
    for index, correction in enumerate(corrections):
        label = f"corrections[{index}]"
        if not isinstance(correction, dict):
            failures.append(f"{label} must be an object")
            continue
        if correction.get("issueId") not in issue_ids:
            failures.append(f"{label}.issueId must reference an issue in this verdict")
        elif action in REFINEMENT_ACTIONS and correction.get("issueId") not in open_issue_ids:
            failures.append(f"{label}.issueId must reference an open issue for refinement")
        scope = correction.get("scope")
        if scope is not None and scope not in CORRECTION_SCOPES:
            failures.append(f"{label}.scope must be spec or code")
        if action == "refine-batch" and scope not in CORRECTION_SCOPES:
            failures.append(f"{label}.scope is required for refine-batch")
        expected_scope = "spec" if action == "refine-spec" else "code" if action == "refine-code" else None
        if expected_scope is not None and scope is not None and scope != expected_scope:
            failures.append(
                f"{label}.scope conflicts with {action}; use refine-batch for mixed spec/code corrections"
            )
        for field in ("target", "parameterPath", "change", "unit"):
            if not isinstance(correction.get(field), str) or not correction.get(field, "").strip():
                failures.append(f"{label}.{field} is required")
        if action in REFINEMENT_ACTIONS:
            target_type = correction.get("targetType")
            target_id = correction.get("target")
            if target_type not in CORRECTION_TARGET_TYPES:
                failures.append(
                    f"{label}.targetType must be one of: "
                    + ", ".join(sorted(CORRECTION_TARGET_TYPES))
                )
            elif target_catalog is not None and (
                target_type not in target_catalog or target_id not in target_catalog[target_type]
            ):
                failures.append(
                    f"{label}.target must reference an existing {target_type} id; got {target_id!r}"
                )
            linked_issue = issues_by_id.get(str(correction.get("issueId")))
            if isinstance(linked_issue, dict) and (
                linked_issue.get("targetType") != target_type
                or linked_issue.get("target") != target_id
            ):
                failures.append(f"{label} target must exactly match its issue target")
            if isinstance(linked_issue, dict):
                mismatch = linked_issue.get("observedMismatch")
                if isinstance(mismatch, dict):
                    if (
                        "beforeValue" in correction
                        and mismatch.get("actual") != correction.get("beforeValue")
                    ):
                        failures.append(
                            f"{label}.beforeValue must equal its issue observedMismatch.actual"
                        )
                    if (
                        "expectedValue" in correction
                        and mismatch.get("expected") != correction.get("expectedValue")
                    ):
                        failures.append(
                            f"{label}.expectedValue must equal its issue observedMismatch.expected"
                        )

            effective_scope = scope or expected_scope
            parameter_path = correction.get("parameterPath")
            if effective_scope == "spec":
                if target_catalog is None:
                    failures.append(f"{label} requires the current spec target catalog")
                else:
                    resolved, current_value = resolve_correction_parameter(
                        target_catalog,
                        target_type,
                        target_id,
                        parameter_path,
                    )
                    if not resolved:
                        failures.append(
                            f"{label}.parameterPath must resolve on {target_type} {target_id!r}"
                        )
                    elif (
                        "beforeValue" in correction
                        and correction.get("beforeValue") != current_value
                    ):
                        failures.append(
                            f"{label}.beforeValue must equal the current spec value {current_value!r}"
                        )
            elif effective_scope == "code" and (
                not isinstance(parameter_path, str)
                or not parameter_path.startswith("implementation.")
            ):
                failures.append(
                    f"{label}.parameterPath for code scope must start with 'implementation.'"
                )

            operation = correction.get("operation")
            if operation not in CORRECTION_OPERATIONS:
                failures.append(
                    f"{label}.operation must be one of: "
                    + ", ".join(sorted(CORRECTION_OPERATIONS))
                )
            for field in ("beforeValue", "value", "expectedValue"):
                if field not in correction:
                    failures.append(f"{label}.{field} is required")
            if operation in {"set", "replace"} and (
                "value" in correction
                and "expectedValue" in correction
                and correction.get("value") != correction.get("expectedValue")
            ):
                failures.append(f"{label}.expectedValue must equal .value for {operation}")
            if operation == "scale":
                value = correction.get("value")
                if not (
                    _finite_number(value)
                    or (
                        isinstance(value, list)
                        and value
                        and all(_finite_number(item) for item in value)
                    )
                ):
                    failures.append(f"{label}.value for scale must be a finite factor or vector")
            if operation in {"translate", "rotate"}:
                value = correction.get("value")
                if not (
                    isinstance(value, list)
                    and len(value) == 3
                    and all(_finite_number(item) for item in value)
                ):
                    failures.append(f"{label}.value for {operation} must be three finite numbers")
            _validate_quantified_delta(
                correction.get("expectedDelta"),
                f"{label}.expectedDelta",
                evidence_view_ids,
                failures,
            )

    resolved = verdict.get("resolvedIssueIds", [])
    if not isinstance(resolved, list) or not all(isinstance(item, str) and item for item in resolved):
        failures.append("resolvedIssueIds must be an array of issue ids")
    resolved_root_causes = verdict.get("resolvedRootCauseKeys", [])
    if not isinstance(resolved_root_causes, list) or not all(
        isinstance(item, str) and item for item in resolved_root_causes
    ):
        failures.append("resolvedRootCauseKeys must be an array of stable root-cause keys")

    if action in REFINEMENT_ACTIONS:
        open_issues = open_issue_ids
        corrected = {
            correction.get("issueId")
            for correction in corrections
            if isinstance(correction, dict)
        }
        if not open_issues:
            failures.append(f"{action} requires at least one open issue")
        if open_issues - corrected:
            failures.append(
                "every open refine issue needs an actionable correction: "
                + ", ".join(sorted(str(item) for item in open_issues - corrected))
            )
        if action == "refine-batch":
            correction_scopes = {
                correction.get("scope")
                for correction in corrections
                if isinstance(correction, dict)
                and correction.get("issueId") in open_issues
            }
            if correction_scopes != set(CORRECTION_SCOPES):
                failures.append(
                    "refine-batch requires both spec and code correction scopes"
                )
    if action == "continue" or action in REFINEMENT_ACTIONS:
        if not _is_score(verdict.get("overallScore")):
            failures.append(f"{action} requires overallScore from 0 to 1")
        layer_scores = verdict.get("layerScores")
        if simplified_visual_gate:
            if layer_scores is not None and (
                not isinstance(layer_scores, dict)
                or any(
                    not isinstance(layer, str)
                    or not layer
                    or not _is_score(value)
                    for layer, value in layer_scores.items()
                )
            ):
                failures.append(
                    f"{action} optional layerScores values must be named scores from 0 to 1"
                )
        elif not isinstance(layer_scores, dict) or not layer_scores:
            failures.append(f"{action} requires non-empty layerScores")
        elif any(not isinstance(layer, str) or not layer or not _is_score(value) for layer, value in layer_scores.items()):
            failures.append(f"{action} layerScores values must be named scores from 0 to 1")
    if action == "continue":
        if not simplified_visual_gate and not isinstance(verdict.get("featureReviews"), list):
            failures.append("continue requires featureReviews")
    if action == STRATEGY_RESET_ACTION:
        for field in ("strategyId", "strategyChange", "falsifyingCheck"):
            if not isinstance(verdict.get(field), str) or len(verdict.get(field, "").strip()) < 8:
                failures.append(f"strategy-reset requires a concrete {field}")
        root_causes = verdict.get("rootCauseKeys")
        if not isinstance(root_causes, list) or not all(
            isinstance(item, str) and item for item in root_causes
        ):
            failures.append("strategy-reset requires rootCauseKeys")
    failures.extend(
        impact_assessment_failures(
            verdict,
            target_catalog,
            expected_active_phase=blind_scout_phase,
        )
    )
    if action == "request-input":
        required_evidence = verdict.get("requiredEvidence")
        if not isinstance(required_evidence, list) or not required_evidence:
            failures.append(
                "request-input requires concrete requiredEvidence; exhausted refinement budget is not evidence"
            )
        else:
            evidence_view_ids = {
                view.get("viewId")
                for view in evidence.get("views", [])
                if isinstance(view, dict)
                and isinstance(view.get("viewId"), str)
                and isinstance(view.get("referenceProvenance"), dict)
                and view["referenceProvenance"].get("origin") in {"observed", "prepared-reference"}
            }
            provenance = evidence.get("renderProvenance")
            declared_view_ids = set(
                _strings(
                    provenance.get("declaredViewIds")
                    if isinstance(provenance, dict)
                    else evidence.get("declaredViewIds")
                )
            )
            evidence_issue_ids = {
                issue.get("id")
                for issue in issues
                if isinstance(issue, dict)
                and issue.get("status") == "open"
                and issue.get("failureClass") == "evidence"
            }
            if not evidence_issue_ids:
                failures.append(
                    "request-input requires an open issue with failureClass='evidence'"
                )
            for index, item in enumerate(required_evidence):
                label = f"requiredEvidence[{index}]"
                if not isinstance(item, dict):
                    failures.append(f"{label} must be an object")
                    continue
                for field in ("issueId", "missingViewId", "sourceConstraint"):
                    if not isinstance(item.get(field), str) or not item.get(field, "").strip():
                        failures.append(f"{label}.{field} is required")
                for field in ("missingEvidence", "blockedCriterion", "unblockAction"):
                    if not isinstance(item.get(field), str) or len(item.get(field, "").strip()) < 8:
                        failures.append(f"{label}.{field} is required")
                if item.get("issueId") not in evidence_issue_ids:
                    failures.append(
                        f"{label}.issueId must reference an open evidence issue"
                    )
                missing_view_id = item.get("missingViewId")
                if isinstance(missing_view_id, str) and missing_view_id in evidence_view_ids:
                    failures.append(
                        f"{label}.missingViewId is already present in reviewed evidence"
                    )
                if isinstance(missing_view_id, str) and missing_view_id not in declared_view_ids:
                    failures.append(
                        f"{label}.missingViewId is not declared by the current module/global viewEvidence"
                    )
                if item.get("sourceConstraint") not in {
                    "occluded",
                    "out-of-frame",
                    "insufficient-resolution",
                    "material-ambiguity",
                }:
                    failures.append(f"{label}.sourceConstraint is invalid")
                wording = " ".join(str(item.get(field) or "") for field in item).lower()
                if any(token in wording for token in ("budget", "batch limit", "refinement limit")):
                    failures.append(
                        f"{label} describes process exhaustion, not missing source evidence"
                    )
    if action == "stop":
        if not isinstance(verdict.get("stopReason"), str) or len(verdict.get("stopReason", "").strip()) < 12:
            failures.append("stop requires a concrete stopReason")
        if not _strings(verdict.get("stopEvidence")):
            failures.append("stop requires verified stopEvidence")
    return list(dict.fromkeys(failures))


def impact_assessment_failures(
    verdict: Mapping[str, Any],
    target_catalog: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    expected_active_phase: str | None = None,
) -> list[str]:
    """Reject unbounded edits before they can mutate a challenger."""

    action = verdict.get("action")
    if action not in {*REFINEMENT_ACTIONS, STRATEGY_RESET_ACTION}:
        return []
    assessment = verdict.get("impactAssessment")
    if not isinstance(assessment, Mapping):
        return ["impactAssessment is required before refinement or strategy-reset"]
    failures: list[str] = []
    if assessment.get("verdict") != "safe-to-apply":
        failures.append("impactAssessment.verdict must be safe-to-apply")
    if assessment.get("risk") not in {"low", "medium", "high"}:
        failures.append("impactAssessment.risk must be low, medium, or high")
    active_phase = assessment.get("activePhase")
    if active_phase not in ACTIVE_IMPACT_PHASES:
        failures.append(
            "impactAssessment.activePhase must be one of: "
            + ", ".join(sorted(ACTIVE_IMPACT_PHASES))
        )
    canonical_expected_phase = (
        blind_scout_phase_id(expected_active_phase)
        if isinstance(expected_active_phase, str) and expected_active_phase.strip()
        else None
    )
    if canonical_expected_phase is not None:
        if canonical_expected_phase not in ACTIVE_IMPACT_PHASES:
            failures.append(
                f"active correction phase {canonical_expected_phase!r} is unsupported"
            )
        elif active_phase != canonical_expected_phase:
            failures.append(
                "impactAssessment.activePhase must match the active correction phase "
                f"{canonical_expected_phase!r}"
            )
    for field in ("expectedEffect", "rollbackCheckpoint"):
        if not isinstance(assessment.get(field), str) or len(
            str(assessment.get(field) or "").strip()
        ) < 8:
            failures.append(f"impactAssessment.{field} must be concrete")
    for field, allow_empty in (
        ("targetIds", False),
        ("allowedPaths", False),
        ("protectedComponentIds", True),
        ("possibleSideEffects", True),
        ("structuralInvariants", False),
    ):
        value = assessment.get(field)
        if not isinstance(value, list) or (not allow_empty and not value) or not all(
            isinstance(item, str) and item.strip() for item in (value or [])
        ):
            failures.append(
                f"impactAssessment.{field} must be "
                + ("an array of strings" if allow_empty else "a non-empty array of strings")
            )
    downstream_impact = assessment.get("downstreamImpact")
    if not isinstance(downstream_impact, list) or not downstream_impact:
        failures.append("impactAssessment.downstreamImpact must be a non-empty array")
    else:
        for index, item in enumerate(downstream_impact):
            label = f"impactAssessment.downstreamImpact[{index}]"
            if not isinstance(item, Mapping):
                failures.append(f"{label} must be an object")
                continue
            downstream_phase = item.get("phase")
            if downstream_phase not in DOWNSTREAM_IMPACT_PHASE_ORDER:
                failures.append(
                    f"{label}.phase must be one of: "
                    + ", ".join(DOWNSTREAM_IMPACT_PHASE_ORDER)
                )
            elif active_phase in ACTIVE_IMPACT_PHASES and (
                DOWNSTREAM_IMPACT_PHASE_ORDER.index(downstream_phase)
                <= DOWNSTREAM_IMPACT_PHASE_ORDER.index(active_phase)
            ):
                failures.append(
                    f"{label}.phase must be later than impactAssessment.activePhase "
                    f"{active_phase!r}"
                )
            for field in (
                "prediction",
                "currentMitigation",
                "futureVerification",
            ):
                value = item.get(field)
                if not isinstance(value, str) or len(value.strip()) < 8:
                    failures.append(f"{label}.{field} must be concrete")
    target_ids = {
        str(item) for item in assessment.get("targetIds", [])
        if isinstance(item, str) and item
    }
    allowed_paths = {
        str(item) for item in assessment.get("allowedPaths", [])
        if isinstance(item, str) and item
    }
    protected_ids = {
        str(item) for item in assessment.get("protectedComponentIds", [])
        if isinstance(item, str) and item
    }
    corrections = [
        item for item in verdict.get("corrections", [])
        if isinstance(item, Mapping)
    ]
    if action in REFINEMENT_ACTIONS:
        correction_targets = {
            str(item.get("target")) for item in corrections
            if isinstance(item.get("target"), str) and item.get("target")
        }
        correction_paths = {
            str(item.get("parameterPath")) for item in corrections
            if isinstance(item.get("parameterPath"), str) and item.get("parameterPath")
        }
        if correction_targets != target_ids:
            failures.append(
                "impactAssessment.targetIds must exactly match correction targets"
            )
        if correction_paths != allowed_paths:
            failures.append(
                "impactAssessment.allowedPaths must exactly match correction parameter paths"
            )
        if assessment.get("strategyChange") is not False:
            failures.append("refinement impactAssessment.strategyChange must be false")
    else:
        if assessment.get("strategyChange") is not True:
            failures.append("strategy-reset impactAssessment.strategyChange must be true")
    component_targets = {
        str(item.get("target"))
        for item in corrections
        if item.get("targetType") == "component"
    }
    overlap = sorted(component_targets & protected_ids)
    if overlap:
        failures.append(
            "impactAssessment cannot protect and modify the same component: "
            + ", ".join(overlap)
        )
    if target_catalog is not None:
        known_targets = {
            str(target_id)
            for group in target_catalog.values()
            if isinstance(group, Mapping)
            for target_id in group
        }
        unknown_targets = sorted(target_ids - known_targets)
        if unknown_targets:
            failures.append(
                "impactAssessment.targetIds reference unknown targets: "
                + ", ".join(unknown_targets)
            )
        known_components = target_catalog.get("component", {})
        unknown_protected = sorted(
            protected_ids
            - (
                set(str(item) for item in known_components)
                if isinstance(known_components, Mapping)
                else set()
            )
        )
        if unknown_protected:
            failures.append(
                "impactAssessment.protectedComponentIds reference unknown components: "
                + ", ".join(unknown_protected)
            )
    return list(dict.fromkeys(failures))


def _review_contract_failures(
    verdict: dict[str, Any],
    evidence: dict[str, Any],
    target_catalog: Mapping[str, Mapping[str, Any]] | None = None,
    required_sanity_categories: list[str] | None = None,
    *,
    require_blind_scout: bool = False,
    simplified_visual_gate: bool = False,
    blind_scout_phase: str | None = None,
) -> list[str]:
    return review_contract_failures(
        verdict,
        evidence,
        target_catalog=target_catalog,
        required_sanity_categories=required_sanity_categories,
        require_blind_scout=require_blind_scout,
        simplified_visual_gate=simplified_visual_gate,
        blind_scout_phase=blind_scout_phase,
    )


def _implementation_hashes(files: list[Path]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for resolved in files:
        hashes[str(resolved)] = file_sha256(resolved)
    if not hashes:
        raise ValueError("visual review requires at least one module-owned implementation file")
    return dict(sorted(hashes.items()))


def _render_provenance_failures(
    evidence: dict[str, Any],
    manifest: dict[str, Any],
    module: dict[str, Any],
    module_id: str,
    module_hash_value: str,
    implementation_files: dict[str, str],
    semantic_files: dict[str, str],
    manifest_path: Path,
) -> list[str]:
    provenance = evidence.get("renderProvenance")
    if not isinstance(provenance, dict):
        return [
            "module evidence is missing renderProvenance; rerun compare with "
            "--sculpt-manifest and --module-id"
        ]
    failures: list[str] = []
    if provenance.get("artifactType") != "threejs-sculpt-render-provenance":
        failures.append("renderProvenance artifact type is invalid")
    if provenance.get("version") != 2:
        failures.append(
            "renderProvenance version must be 2 with generated-factory runtime attestation"
        )
    if provenance.get("moduleId") != module_id:
        failures.append("renderProvenance is bound to a different module")
    if provenance.get("moduleHash") != module_hash_value:
        failures.append("renderProvenance module spec snapshot is stale")
    payload = module.get("payload") if isinstance(module.get("payload"), dict) else {}
    global_spec = manifest.get("globalSpec") if isinstance(manifest.get("globalSpec"), dict) else {}
    declared_view_ids = sorted({
        item.get("id")
        for source in (global_spec.get("viewEvidence", []), payload.get("viewEvidence", []))
        if isinstance(source, list)
        for item in source
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item.get("id")
    })
    if provenance.get("declaredViewIds") != declared_view_ids:
        failures.append("renderProvenance declared view inventory is stale or incomplete")
    if provenance.get("implementationFiles") != implementation_files:
        failures.append("renderProvenance implementation snapshot is stale or incomplete")
    if provenance.get("implementationSemanticFiles") != semantic_files:
        failures.append("renderProvenance executable semantic snapshot is stale")
    if provenance.get("renderSha256") != _render_hashes(evidence):
        failures.append("renderProvenance does not bind the reviewed render images")
    failures.extend(
        _generated_runtime_provenance_failures(
            provenance,
            module_id,
            module_hash_value,
            manifest_path,
            module_preview_pass(module),
        )
    )
    return failures


def _generated_runtime_provenance_failures(
    provenance: dict[str, Any],
    module_id: str,
    module_hash_value: str,
    manifest_path: Path,
    expected_pass_id: str,
) -> list[str]:
    """Prove the reviewed pixels came from the current generated factory in a live scene."""

    failures: list[str] = []
    raw_build_path = provenance.get("buildReceiptPath")
    build_path = (
        Path(raw_build_path).expanduser().resolve()
        if isinstance(raw_build_path, str) and raw_build_path.strip()
        else None
    )
    if build_path != module_build_receipt_path(manifest_path, module_id):
        failures.append("render provenance is not bound to the canonical module build receipt")
    embedded_build = provenance.get("buildReceipt")
    if build_path is None or not build_path.is_file():
        failures.append("generated module build receipt is missing")
        build_receipt: dict[str, Any] = {}
    else:
        try:
            loaded_build = read_object(build_path, "module build receipt")
        except (OSError, ValueError) as exc:
            failures.append(f"generated module build receipt is invalid: {exc}")
            loaded_build = {}
        build_receipt = loaded_build if isinstance(loaded_build, dict) else {}
        if provenance.get("buildReceiptSha256") != file_sha256(build_path):
            failures.append("generated module build receipt changed after render capture")
        if embedded_build != build_receipt:
            failures.append("embedded generated build receipt differs from the current file")
    if build_receipt.get("artifactType") != MODULE_BUILD_RECEIPT_ARTIFACT_TYPE:
        failures.append("generated module build receipt artifact type is invalid")
    if build_receipt.get("version") != MODULE_BUILD_RECEIPT_VERSION:
        failures.append(
            f"generated module build receipt version must be {MODULE_BUILD_RECEIPT_VERSION}"
        )
    if build_receipt.get("moduleId") != module_id:
        failures.append("generated module build receipt belongs to another module")
    if build_receipt.get("moduleHash") != module_hash_value:
        failures.append("generated module build receipt is stale for the current module spec")
    if build_receipt.get("manifestPath") != str(manifest_path.expanduser().resolve()):
        failures.append("generated module build receipt belongs to another sculpt manifest")
    if build_receipt.get("passId") != expected_pass_id:
        failures.append(
            f"generated module build receipt must use the module preview pass {expected_pass_id!r}"
        )
    resolved_spec_data: dict[str, Any] | None = None
    generated_source = ""
    for path_field, hash_field, label in (
        ("resolvedSpec", "resolvedSpecSha256", "resolved spec"),
        ("generatedOutput", "generatedOutputSha256", "generated factory"),
    ):
        raw_path = build_receipt.get(path_field)
        current_path = (
            Path(raw_path).expanduser().resolve()
            if isinstance(raw_path, str) and raw_path.strip()
            else None
        )
        if current_path is None or not current_path.is_file():
            failures.append(f"{label} recorded by the module build is missing")
        elif build_receipt.get(hash_field) != file_sha256(current_path):
            failures.append(f"{label} changed after the attested module build")
        elif path_field == "resolvedSpec":
            try:
                resolved_value = read_object(current_path, "resolved module spec")
            except (OSError, ValueError) as exc:
                failures.append(f"resolved module spec is invalid: {exc}")
            else:
                resolved_spec_data = resolved_value
        elif path_field == "generatedOutput":
            generated_source = current_path.read_text(encoding="utf-8")
            factory_id = build_receipt.get("factoryId")
            if "export const createSculptModel" not in generated_source:
                failures.append("attested generated factory has no stable createSculptModel export")
            if not isinstance(factory_id, str) or factory_id not in generated_source:
                failures.append("attested generated factory does not contain its recorded factoryId")
    if resolved_spec_data is not None and generated_source:
        try:
            from generate_threejs_factory import (
                generate,
                generated_factory_contract_from_source,
            )

            current_manifest = read_object(manifest_path, "sculpt manifest")
            expected_resolved = resolve_manifest(
                manifest_path,
                current_manifest,
                selected=[module_id],
            )
            if resolved_spec_data != expected_resolved:
                failures.append("attested resolved spec is not the current module resolution")
            pass_id = build_receipt.get("passId")
            if not isinstance(pass_id, str) or not pass_id:
                raise ValueError("build receipt passId is missing")
            recomputed_source = generate(
                resolved_spec_data,
                pass_id,
                _geometry_prevalidated=True,
            )
            if generated_source != recomputed_source:
                failures.append("generated factory is not the deterministic output of the resolved spec")
            recomputed_contract = generated_factory_contract_from_source(recomputed_source)
            for field, value in recomputed_contract.items():
                if build_receipt.get(field) != value:
                    failures.append(
                        f"generated module build receipt {field} does not match recomputed output"
                    )
        except (OSError, ValueError, TypeError) as exc:
            failures.append(f"generated factory contract could not be recomputed: {exc}")
    for field in ("factoryId", "factoryExport", "specSha256", "passId"):
        if not isinstance(build_receipt.get(field), str) or not build_receipt.get(field):
            failures.append(f"generated module build receipt has no {field}")

    runtime_path_value = provenance.get("runtimeReceiptPath")
    runtime_path = (
        Path(runtime_path_value).expanduser().resolve()
        if isinstance(runtime_path_value, str) and runtime_path_value.strip()
        else None
    )
    if runtime_path is None or not runtime_path.is_file():
        failures.append("live scene runtime receipt is missing")
        loaded_runtime: Any = None
    else:
        if provenance.get("runtimeReceiptSha256") != file_sha256(runtime_path):
            failures.append("live scene runtime receipt changed after render capture")
        try:
            loaded_runtime = read_object(runtime_path, "live scene runtime receipt")
        except (OSError, ValueError) as exc:
            failures.append(f"live scene runtime receipt is invalid: {exc}")
            loaded_runtime = None
    runtime = provenance.get("runtimeReceipt")
    if not isinstance(runtime, dict):
        failures.append("render provenance has no generated-factory runtime receipt")
        return list(dict.fromkeys(failures))
    if not (
        loaded_runtime == runtime
        or isinstance(loaded_runtime, list)
        and sum(1 for item in loaded_runtime if item == runtime) == 1
    ):
        failures.append("embedded runtime receipt is not present in the captured runtime file")
    if runtime.get("artifactType") != "threejs-sculpt-runtime-receipt":
        failures.append("live scene runtime receipt artifact type is invalid")
    if runtime.get("version") != 1:
        failures.append("live scene runtime receipt version must be 1")
    for field in ("factoryId", "factoryExport", "specSha256", "passId"):
        if runtime.get(field) != build_receipt.get(field):
            failures.append(f"live scene runtime {field} does not match the generated build")
    if runtime.get("factoryExport") != "createSculptModel":
        failures.append("reviewed scene did not use the stable generated createSculptModel export")
    if runtime.get("rootAttachedToScene") is not True:
        failures.append("generated factory root was not attached to the rendered THREE.Scene")
    if runtime.get("rootEffectivelyVisible") is not True:
        failures.append("generated factory root was hidden in the rendered scene")
    material_status = runtime.get("materialStatus")
    if material_status is not None and material_status != "ready":
        failures.append(f"material textures were not ready at capture: {material_status}")
    for field in (
        "missingComponentIds",
        "missingMeshComponentIds",
        "hiddenMeshComponentIds",
        "unexpectedGeneratedDescendantMeshes",
        "unexpectedVisibleMeshes",
        "geometryChangedComponentIds",
    ):
        value = runtime.get(field)
        if not isinstance(value, list):
            failures.append(f"live scene runtime {field} must be an array")
        elif value:
            failures.append(f"live scene runtime {field} must be empty: " + ", ".join(map(str, value)))
    component_ids = set(_strings(runtime.get("componentIds")))
    mesh_ids = set(_strings(runtime.get("meshComponentIds")))
    if len(component_ids) != len(runtime.get("componentIds", [])):
        failures.append("live scene runtime componentIds contains duplicates or invalid ids")
    if len(mesh_ids) != len(runtime.get("meshComponentIds", [])):
        failures.append("live scene runtime meshComponentIds contains duplicates or invalid ids")
    if mesh_ids and not _strings(runtime.get("geometryFingerprint")):
        failures.append("live scene runtime has meshes but no geometry fingerprint")
    initial_geometry = _strings(runtime.get("initialGeometryFingerprint"))
    current_geometry = _strings(runtime.get("geometryFingerprint"))
    if initial_geometry != current_geometry:
        failures.append("runtime geometry differs from the factory-created geometry")
    fingerprint_ids = {
        value.split(":", 1)[0]
        for value in current_geometry
        if ":" in value
    }
    if not mesh_ids <= fingerprint_ids:
        failures.append("runtime geometry fingerprint does not cover every live renderable")
    expected_component_ids = set(_strings(build_receipt.get("expectedComponentIds")))
    expected_mesh_ids = set(_strings(build_receipt.get("expectedMeshComponentIds")))
    expected_primitives = build_receipt.get("expectedPrimitives")
    actual_primitives = runtime.get("componentPrimitives")
    if not isinstance(expected_primitives, dict) or not isinstance(actual_primitives, dict):
        failures.append("generated/runtime primitive inventory is invalid")
    else:
        primitive_mismatches = sorted(
            component_id
            for component_id, primitive in expected_primitives.items()
            if actual_primitives.get(component_id) != primitive
        )
        if primitive_mismatches:
            failures.append(
                "runtime primitive inventory differs from generated output: "
                + ", ".join(primitive_mismatches)
            )
    if not expected_component_ids:
        failures.append("generated module build receipt has no expected component inventory")
    missing_components = expected_component_ids - component_ids
    missing_meshes = expected_mesh_ids - mesh_ids
    if missing_components:
        failures.append(
            "rendered generated root is missing expected components: "
            + ", ".join(sorted(missing_components))
        )
    if missing_meshes:
        failures.append(
            "rendered generated root is missing expected mesh components: "
            + ", ".join(sorted(missing_meshes))
        )
    return list(dict.fromkeys(failures))


def diagnostic_veto_failures(
    manifest: dict[str, Any], module: dict[str, Any], evidence: dict[str, Any]
) -> list[str]:
    from make_visual_comparison_sheet import silhouette_diagnostics

    gate = module.get("qualityGate") if isinstance(module.get("qualityGate"), dict) else {}
    global_spec = (
        manifest.get("globalSpec")
        if isinstance(manifest.get("globalSpec"), dict)
        else {}
    )
    simplified = simplified_visual_gate_enabled(global_spec)
    required_views = set(_strings(gate.get("requiredViews")))
    diagnostic_views = set(_strings(gate.get("diagnosticViews")))
    reviewed_views = required_views | diagnostic_views
    view_by_id = {
        view.get("viewId"): view
        for view in evidence.get("views", [])
        if isinstance(view, dict) and isinstance(view.get("viewId"), str)
    }
    failures: list[str] = []
    missing = reviewed_views - set(view_by_id)
    if missing:
        failures.append("visual evidence is missing required/diagnostic views: " + ", ".join(sorted(missing)))
    for view_id in sorted(reviewed_views & set(view_by_id)):
        view = view_by_id[view_id]
        try:
            reference = load_image(Path(str(view.get("referenceImage"))).expanduser())
            render = load_image(Path(str(view.get("renderScreenshot"))).expanduser())
            recomputed, _, _ = silhouette_diagnostics(reference, render)
        except (OSError, ValueError, TypeError) as exc:
            failures.append(f"view {view_id!r} diagnostics could not be recomputed from pixels: {exc}")
            continue
        if view.get("fitDiagnostics") != recomputed:
            failures.append(
                f"view {view_id!r} fit diagnostics do not match deterministic pixel recomputation"
            )
    thresholds = diagnostic_floor_contract(manifest)
    custom_thresholds = gate.get("diagnosticThresholds")
    if isinstance(custom_thresholds, dict):
        for field, value in custom_thresholds.items():
            if not isinstance(value, (int, float)) or isinstance(value, bool) or field not in thresholds:
                continue
            thresholds[field] = (
                max(thresholds[field], float(value))
                if field.startswith("minimum")
                else min(thresholds[field], float(value))
            )
    for view_id in sorted(reviewed_views & set(view_by_id)):
        reviewed_view = view_by_id[view_id]
        diagnostics = reviewed_view.get("fitDiagnostics")
        if not isinstance(diagnostics, dict):
            failures.append(f"view {view_id!r} has no fit diagnostics")
            continue
        mask = diagnostics.get("maskDiagnostics")
        warnings = mask.get("warnings", []) if isinstance(mask, dict) else []
        if not isinstance(mask, dict) or not isinstance(warnings, list):
            failures.append(f"view {view_id!r} has invalid mask diagnostics")
            continue
        if warnings:
            failures.append(f"view {view_id!r} has unreliable masks: " + "; ".join(str(item) for item in warnings))
        for side in ("reference", "render"):
            info = mask.get(side)
            coverage = info.get("foregroundCoverage") if isinstance(info, dict) else None
            if not _is_score(coverage) or float(coverage) <= 0.01 or float(coverage) >= 0.95:
                failures.append(f"view {view_id!r} {side} foreground mask is unusable")
        metrics = () if simplified else (
            ("centroidDelta", "maximumCentroidDelta", lambda value, limit: value <= limit, "above"),
            ("aspectRatioDelta", "maximumAspectRatioDelta", lambda value, limit: value <= limit, "above"),
        )
        provenance = reviewed_view.get("referenceProvenance")
        synthetic_hypothesis = (
            isinstance(provenance, dict)
            and provenance.get("origin") == "synthetic-hypothesis"
        )
        synthetic_limits = {
            "maximumCentroidDelta": 0.18,
            "maximumAspectRatioDelta": 0.30,
        }
        for field, threshold_field, predicate, relation in metrics:
            value = diagnostics.get(field)
            limit = thresholds.get(threshold_field)
            if synthetic_hypothesis and not simplified:
                synthetic_limit = synthetic_limits[threshold_field]
                limit = (
                    min(float(limit), synthetic_limit)
                    if threshold_field.startswith("minimum") and _is_score(limit)
                    else max(float(limit), synthetic_limit)
                    if _is_score(limit)
                    else synthetic_limit
                )
            if not _is_score(value) or not _is_score(limit):
                failures.append(f"view {view_id!r} has invalid {field} diagnostic")
            elif not predicate(float(value), float(limit)):
                failures.append(
                    f"view {view_id!r} {field} {float(value):.3f} is {relation} veto threshold {float(limit):.3f}"
                )
        if synthetic_hypothesis:
            # ImageGen can constrain inferred volume, not unseen material truth.
            continue
        if simplified:
            continue
        appearance = diagnostics.get("appearance")
        geometry_appearance_metrics = (
            ("detailEnergyRatio", "minimumDetailEnergyRatio", lambda value, limit: value >= limit, "below"),
            ("edgeDensityRatio", "minimumEdgeDensityRatio", lambda value, limit: value >= limit, "below"),
        )
        lookdev_appearance_metrics = (
            (
                "foregroundHistogramIntersection",
                "minimumHistogramIntersection",
                lambda value, limit: value >= limit,
                "below",
            ),
            ("foregroundMeanColorDelta", "maximumMeanColorDelta", lambda value, limit: value <= limit, "above"),
            (
                "highlightCoverageRatio",
                "minimumHighlightCoverageRatio",
                lambda value, limit: value >= limit,
                "below",
            ),
            (
                "highlightEnergyRatio",
                "minimumHighlightEnergyRatio",
                lambda value, limit: value >= limit,
                "below",
            ),
        )
        appearance_metrics = (
            (*geometry_appearance_metrics, *lookdev_appearance_metrics)
            if module_preview_pass(module) == "lookdev"
            else geometry_appearance_metrics
        )
        for field, threshold_field, predicate, relation in appearance_metrics:
            value = appearance.get(field) if isinstance(appearance, dict) else None
            limit = thresholds.get(threshold_field)
            if not _is_score(value) or not _is_score(limit):
                failures.append(f"view {view_id!r} has invalid {field} appearance diagnostic")
            elif not predicate(float(value), float(limit)):
                failures.append(
                    f"view {view_id!r} {field} {float(value):.3f} is {relation} veto threshold "
                    f"{float(limit):.3f}"
                )
        counts = appearance.get("sampleCounts") if isinstance(appearance, dict) else None
        if not isinstance(counts, dict) or any(
            not isinstance(counts.get(side), int) or counts.get(side, 0) < 16
            for side in ("reference", "render")
        ):
            failures.append(f"view {view_id!r} has too few foreground samples for diagnostics")
    return list(dict.fromkeys(failures))


def module_evidence_scope_failures(
    manifest_path: Path,
    manifest: dict[str, Any],
    module: dict[str, Any],
    module_id: str,
    evidence: dict[str, Any],
) -> list[str]:
    """Reject whole-object/reference vs isolated-module comparisons before scoring."""

    payload = module.get("payload") if isinstance(module.get("payload"), dict) else {}
    owned_component_ids = {
        item.get("id")
        for item in payload.get("componentTree", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    global_spec = (
        manifest.get("globalSpec")
        if isinstance(manifest.get("globalSpec"), dict)
        else {}
    )
    global_source_value = global_spec.get("sourceImage")

    def local_file(value: Any) -> Path | None:
        if not isinstance(value, str) or not value.strip() or "://" in value:
            return None
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = manifest_path.parent / candidate
        resolved = candidate.resolve()
        return resolved if resolved.is_file() else None

    global_source = local_file(global_source_value)
    failures: list[str] = []
    for view in evidence.get("views", []):
        if not isinstance(view, dict):
            continue
        view_id = str(view.get("viewId") or "unknown")
        scope = view.get("evaluationScope")
        if not isinstance(scope, dict):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: module evidence requires "
                "evaluationScope; do not compare a full-object reference with an isolated module render"
            )
            continue
        if scope.get("kind") != "module-local" or scope.get("moduleId") != module_id:
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: evaluationScope must be "
                f"module-local for module {module_id!r}"
            )
        component_ids = scope.get("componentIds")
        scoped_components = (
            set(component_ids)
            if isinstance(component_ids, list)
            and component_ids
            and all(isinstance(item, str) and item for item in component_ids)
            else set()
        )
        if not scoped_components:
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: componentIds must name the module-local targets"
            )
        elif not scoped_components <= owned_component_ids:
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: componentIds are not owned by "
                f"module {module_id!r}: "
                + ", ".join(sorted(scoped_components - owned_component_ids))
            )
        isolation = scope.get("referenceIsolation")
        if not isinstance(isolation, dict):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: referenceIsolation is required"
            )
            continue
        method = isolation.get("method")
        if method not in {"pre-isolated", "crop", "alpha-mask", "binary-mask"}:
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: referenceIsolation.method is invalid"
            )
        source = local_file(isolation.get("sourceImage"))
        source_hash = isolation.get("sourceImageSha256")
        if (
            source is None
            or not isinstance(source_hash, str)
            or file_sha256(source) != source_hash
        ):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: isolated reference source/hash is invalid"
            )
        provenance = view.get("referenceProvenance")
        observed_reference = (
            isinstance(provenance, dict)
            and provenance.get("origin") in {"observed", "prepared-reference"}
        )
        if (
            global_source is not None
            and observed_reference
            and source != global_source
        ):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: acceptance module crop/mask must derive from sourceImage"
            )
        reference = local_file(view.get("referenceImage"))
        isolated_hash = isolation.get("isolatedReferenceSha256")
        if (
            reference is None
            or not isinstance(isolated_hash, str)
            or isolated_hash != view.get("referenceSha256")
            or file_sha256(reference) != isolated_hash
        ):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: isolated reference hash does not match referenceImage"
            )
        if (
            global_source is not None
            and reference is not None
            and (
                reference == global_source
                or file_sha256(reference) == file_sha256(global_source)
            )
        ):
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: full sourceImage cannot be scored "
                "against an isolated module render; provide a module crop or mask"
            )
        if global_source is not None and observed_reference and method == "pre-isolated":
            failures.append(
                f"view {view_id!r} evidence-scope-mismatch: observed module evidence must "
                "declare crop, alpha-mask, or binary-mask derivation from sourceImage"
            )
        if method == "crop":
            region = isolation.get("regionNormalized")
            valid_region = not (
                not isinstance(region, list)
                or len(region) != 4
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(float(value))
                    for value in region
                )
                or float(region[0]) < 0
                or float(region[1]) < 0
                or float(region[2]) <= 0
                or float(region[3]) <= 0
                or float(region[0]) + float(region[2]) > 1
                or float(region[1]) + float(region[3]) > 1
            )
            if not valid_region:
                failures.append(
                    f"view {view_id!r} evidence-scope-mismatch: crop requires valid regionNormalized [x,y,w,h]"
                )
            elif source is not None and reference is not None:
                try:
                    source_width, source_height, source_pixels = load_image(source)
                    reference_width, reference_height, reference_pixels = load_image(reference)
                    x0 = max(0, min(source_width - 1, math.floor(float(region[0]) * source_width)))
                    y0 = max(0, min(source_height - 1, math.floor(float(region[1]) * source_height)))
                    x1 = max(x0 + 1, min(source_width, math.ceil((float(region[0]) + float(region[2])) * source_width)))
                    y1 = max(y0 + 1, min(source_height, math.ceil((float(region[1]) + float(region[3])) * source_height)))
                    derived_pixels = [
                        source_pixels[y * source_width + x]
                        for y in range(y0, y1)
                        for x in range(x0, x1)
                    ]
                    crop_matches = (
                        reference_width == x1 - x0
                        and reference_height == y1 - y0
                        and reference_pixels == derived_pixels
                    )
                except (OSError, ValueError):
                    crop_matches = False
                if not crop_matches:
                    failures.append(
                        f"view {view_id!r} evidence-scope-mismatch: referenceImage pixels do not equal the declared source crop"
                    )
        if method == "binary-mask":
            mask = local_file(isolation.get("maskImage"))
            mask_hash = isolation.get("maskSha256")
            if mask is None or not isinstance(mask_hash, str) or file_sha256(mask) != mask_hash:
                failures.append(
                    f"view {view_id!r} evidence-scope-mismatch: binary-mask requires a hash-bound maskImage"
                )
            elif source is not None and reference is not None:
                try:
                    source_width, source_height, source_pixels = load_image(source)
                    mask_width, mask_height, mask_pixels = load_image(mask)
                    reference_width, reference_height, reference_pixels = load_image(reference)
                    derived_pixels = [
                        source_pixel if mask_pixel[3] >= 128 and sum(mask_pixel[:3]) >= 384 else (0, 0, 0, 0)
                        for source_pixel, mask_pixel in zip(source_pixels, mask_pixels)
                    ]
                    mask_matches = (
                        mask_width == source_width
                        and mask_height == source_height
                        and reference_width == source_width
                        and reference_height == source_height
                        and len(mask_pixels) == len(source_pixels)
                        and reference_pixels == derived_pixels
                    )
                except (OSError, ValueError):
                    mask_matches = False
                if not mask_matches:
                    failures.append(
                        f"view {view_id!r} evidence-scope-mismatch: referenceImage pixels do not equal sourceImage with the declared binary mask"
                    )
        if method == "alpha-mask" and reference is not None:
            try:
                source_width, source_height, source_pixels = load_image(source) if source is not None else (0, 0, [])
                reference_width, reference_height, pixels = load_image(reference)
                alpha_matches = (
                    source_width == reference_width
                    and source_height == reference_height
                    and len(source_pixels) == len(pixels)
                    and any(pixel[3] < 250 for pixel in pixels)
                    and any(pixel[3] >= 250 for pixel in pixels)
                    and all(
                        reference_pixel == source_pixel
                        or reference_pixel == (0, 0, 0, 0)
                        for source_pixel, reference_pixel in zip(source_pixels, pixels)
                    )
                )
            except (OSError, ValueError):
                alpha_matches = False
            if not alpha_matches:
                failures.append(
                    f"view {view_id!r} evidence-scope-mismatch: alpha-mask reference is not a pixel-preserving mask of sourceImage"
                )
    return list(dict.fromkeys(failures))


def _feature_gate_failures(
    manifest: dict[str, Any],
    module: dict[str, Any],
    entry: dict[str, Any],
    evidence: dict[str, Any],
    verdict: dict[str, Any],
) -> list[str]:
    payload = module.get("payload") if isinstance(module.get("payload"), dict) else {}
    targets = {
        target.get("id"): target
        for target in payload.get("featureReviewTargets", [])
        if isinstance(target, dict)
        and isinstance(target.get("id"), str)
        and (target.get("tier") == "critical" or target.get("mustPass") is True)
    }
    global_spec = manifest.get("globalSpec") if isinstance(manifest.get("globalSpec"), dict) else {}
    simplified = simplified_visual_gate_enabled(global_spec)
    group_by_id = {
        target.get("id"): target
        for target in global_spec.get("featureReviewTargets", [])
        if isinstance(target, dict) and isinstance(target.get("id"), str)
    }
    for feature_id in entry.get("covers", []):
        group = group_by_id.get(feature_id)
        if isinstance(group, dict):
            covered_target = dict(group)
            covered_target.setdefault("minimumScore", module.get("qualityGate", {}).get("minimumScore", 0.0))
            covered_target["requiresDedicatedEvidence"] = True
            covered_target["reviewViewIds"] = list(
                group.get("reviewViewIds") or group.get("evidenceRefs", [])
            )
            targets[feature_id] = covered_target

    reviews = verdict.get("featureReviews", [])
    review_by_id: dict[str, dict[str, Any]] = {}
    failures: list[str] = []
    for review in reviews if isinstance(reviews, list) else []:
        if not isinstance(review, dict) or not isinstance(review.get("id"), str):
            failures.append("featureReviews entries must have an id")
            continue
        if review["id"] in review_by_id:
            failures.append(f"duplicate feature review {review['id']!r}")
        review_by_id[review["id"]] = review
    available_views = {
        view.get("viewId")
        for view in evidence.get("views", [])
        if isinstance(view, dict) and isinstance(view.get("viewId"), str)
    }
    for feature_id, target in targets.items():
        review = review_by_id.get(feature_id)
        if not isinstance(review, dict):
            failures.append(f"critical/covered feature {feature_id!r} has no independent review")
            continue
        if review.get("visible") is not True:
            failures.append(f"critical/covered feature {feature_id!r} is not explicitly visible")
        score = review.get("score")
        configured_minimum = target.get(
            "minimumScore", module.get("qualityGate", {}).get("minimumScore", 0.0)
        )
        minimum = (
            max(float(configured_minimum), visual_gate_floor(manifest, entry))
            if _is_score(configured_minimum)
            else configured_minimum
        )
        if not simplified:
            if not _is_score(score) or not _is_score(minimum):
                failures.append(f"critical/covered feature {feature_id!r} has an invalid score contract")
            elif float(score) < float(minimum):
                failures.append(
                    f"critical/covered feature {feature_id!r} score {float(score):.3f} "
                    f"is below {float(minimum):.3f}"
                )
        required_views = set(_strings(target.get("reviewViewIds"))) if target.get("requiresDedicatedEvidence") is True else set()
        review_views = set(_strings(review.get("viewIds")))
        missing_evidence = required_views - available_views
        missing_bindings = required_views - review_views
        if missing_evidence:
            failures.append(
                f"critical/covered feature {feature_id!r} evidence is missing views: "
                + ", ".join(sorted(missing_evidence))
            )
        if missing_bindings:
            failures.append(
                f"critical/covered feature {feature_id!r} review is not bound to views: "
                + ", ".join(sorted(missing_bindings))
            )
    return list(dict.fromkeys(failures))


def _continue_gate_failures(
    manifest: dict[str, Any],
    module: dict[str, Any],
    entry: dict[str, Any],
    evidence: dict[str, Any],
    verdict: dict[str, Any],
    diagnostics_preflighted: bool = False,
) -> list[str]:
    gate = module.get("qualityGate") if isinstance(module.get("qualityGate"), dict) else {}
    failures: list[str] = []
    overall = verdict.get("overallScore")
    configured_minimum = gate.get("minimumScore")
    minimum = (
        max(float(configured_minimum), visual_gate_floor(manifest, entry))
        if _is_score(configured_minimum)
        else configured_minimum
    )
    if _is_score(overall) and _is_score(minimum) and float(overall) < float(minimum):
        failures.append(f"overall score {float(overall):.3f} is below {float(minimum):.3f}")
    simplified = simplified_visual_gate_enabled(
        manifest.get("globalSpec", {})
        if isinstance(manifest.get("globalSpec"), dict)
        else {},
        module_preview_pass(module),
    )
    failures.extend(
        perceptual_review_failures(
            manifest.get("globalSpec", {})
            if isinstance(manifest.get("globalSpec"), dict)
            else {},
            {
                "evidence": evidence,
                "reviewCorrections": verdict.get("corrections", []),
                "correctionBatch": correction_batch_from_verdict(verdict),
            },
        )
    )
    layer_scores = verdict.get("layerScores") if isinstance(verdict.get("layerScores"), dict) else {}
    if not simplified:
        for layer, threshold in module_required_layer_scores(module).items():
            value = layer_scores.get(layer)
            if not _is_score(value):
                failures.append(f"required layer {layer!r} has no valid score")
            elif float(value) < float(threshold):
                failures.append(
                    f"layer {layer!r} score {float(value):.3f} is below {float(threshold):.3f}"
                )
    if not simplified:
        for issue in verdict.get("issues", []):
            if (
                isinstance(issue, dict)
                and issue.get("status") == "open"
                and issue.get("severity") in BLOCKING_SEVERITIES
            ):
                failures.append(f"blocking issue {issue.get('id')!r} remains open")
    if not diagnostics_preflighted and not simplified:
        failures.extend(diagnostic_veto_failures(manifest, module, evidence))
    # Covered/signature features always need an explicit independent visibility
    # check.  The lightweight gate removes per-feature numeric thresholds, not
    # the evidence that an identity-defining feature exists in the render.
    failures.extend(_feature_gate_failures(manifest, module, entry, evidence, verdict))
    if simplified:
        failures.extend(
            blind_scout_contract_failures(
                verdict.get("blindScout"),
                evidence,
                require_approve=True,
                primary_reviewer_context=(
                    verdict.get("reviewer", {}).get("contextId")
                    if isinstance(verdict.get("reviewer"), dict)
                    else None
                ),
                expected_phase=module_preview_pass(module),
            )
        )
    return list(dict.fromkeys(failures))


def _render_hashes(evidence: dict[str, Any]) -> list[str]:
    return sorted(
        {
            str(view.get("renderSha256"))
            for view in evidence.get("views", [])
            if isinstance(view, dict) and isinstance(view.get("renderSha256"), str)
        }
    )


def _evidence_file_snapshot(evidence: dict[str, Any]) -> dict[str, str]:
    values: list[Any] = [evidence.get("comparisonImage")]
    for view in evidence.get("views", []):
        if not isinstance(view, dict):
            continue
        values.extend(
            view.get(field)
            for field in ("referenceImage", "renderScreenshot", "comparisonImage")
        )
    snapshot: dict[str, str] = {}
    for value in values:
        if not isinstance(value, str) or not value.strip() or "://" in value:
            continue
        path = Path(value).expanduser().resolve()
        snapshot[str(path)] = file_sha256(path) if path.is_file() else "missing"
    return dict(sorted(snapshot.items()))


def _safe_cache_segment(value: Any) -> str:
    raw = str(value or "snapshot")
    readable = re.sub(r"[^a-zA-Z0-9_-]+", "-", raw).strip("-")[:48] or "snapshot"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
    return f"{readable}-{digest}"


def _snapshot_refinement_renders(
    manifest_path: Path,
    module_id: str,
    review_id: Any,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Preserve reviewed renders so normal fixed-path rerenders cannot erase the baseline."""

    destination_dir = (
        cache_path(manifest_path).parent
        / "review-renders"
        / _safe_cache_segment(module_id)
        / _safe_cache_segment(review_id)
    )
    destination_dir.mkdir(parents=True, exist_ok=True)
    snapshots: list[dict[str, str]] = []
    for index, view in enumerate(evidence.get("views", [])):
        if not isinstance(view, dict) or not isinstance(view.get("viewId"), str):
            continue
        source_value = view.get("renderScreenshot")
        expected_hash = view.get("renderSha256")
        if not isinstance(source_value, str) or not isinstance(expected_hash, str):
            raise ValueError("reviewed render snapshot is missing its path or hash")
        source = Path(source_value).expanduser().resolve()
        if not source.is_file() or file_sha256(source) != expected_hash:
            raise ValueError("reviewed render changed before its immutable snapshot was stored")
        suffix = source.suffix.lower() if source.suffix.lower() in {".png", ".jpg", ".jpeg"} else ".img"
        destination = destination_dir / (
            f"{index + 1:02d}-{_safe_cache_segment(view['viewId'])}-{expected_hash[:12]}{suffix}"
        )
        if not destination.is_file() or file_sha256(destination) != expected_hash:
            temporary = destination.with_name(destination.name + ".tmp")
            shutil.copyfile(source, temporary)
            if file_sha256(temporary) != expected_hash:
                temporary.unlink(missing_ok=True)
                raise ValueError("immutable render snapshot hash does not match reviewed evidence")
            temporary.replace(destination)
        snapshots.append(
            {
                "viewId": view["viewId"],
                "renderScreenshot": str(destination),
                "renderSha256": expected_hash,
            }
        )
    if not snapshots:
        raise ValueError("refinement review has no render views to preserve")
    comparison_value = evidence.get("comparisonImage")
    comparison_hash = evidence.get("comparisonSha256")
    if not isinstance(comparison_value, str) or not isinstance(comparison_hash, str):
        raise ValueError("reviewed comparison snapshot is missing its path or hash")
    comparison_source = Path(comparison_value).expanduser().resolve()
    if not comparison_source.is_file() or file_sha256(comparison_source) != comparison_hash:
        raise ValueError("reviewed comparison changed before its immutable snapshot was stored")
    comparison_suffix = (
        comparison_source.suffix.lower()
        if comparison_source.suffix.lower() in {".png", ".jpg", ".jpeg"}
        else ".img"
    )
    comparison_destination = destination_dir / f"comparison-{comparison_hash[:12]}{comparison_suffix}"
    if (
        not comparison_destination.is_file()
        or file_sha256(comparison_destination) != comparison_hash
    ):
        temporary = comparison_destination.with_name(comparison_destination.name + ".tmp")
        shutil.copyfile(comparison_source, temporary)
        if file_sha256(temporary) != comparison_hash:
            temporary.unlink(missing_ok=True)
            raise ValueError("immutable comparison snapshot hash does not match reviewed evidence")
        temporary.replace(comparison_destination)
    return {
        "artifactType": "threejs-sculpt-render-snapshot",
        "version": 1,
        "views": snapshots,
        "comparisonImage": str(comparison_destination),
        "comparisonSha256": comparison_hash,
    }


def _module_checkpoint_files(
    manifest_path: Path,
    manifest: dict[str, Any],
    module_id: str,
    implementation_files: dict[str, str],
) -> tuple[list[Path], dict[Path, list[str]]]:
    """Resolve only authoring/build files; append-only review cache stays outside rollback."""

    module_path = load_modules(manifest_path, manifest, [module_id])[module_id][0]
    files = [manifest_path, module_path, *(Path(value) for value in implementation_files)]
    roles: dict[Path, list[str]] = {
        manifest_path: ["manifest", "authoring"],
        module_path: ["module-spec", "authoring"],
    }
    for value in implementation_files:
        roles[Path(value)] = ["implementation", "authoring"]

    build_path = module_build_receipt_path(manifest_path, module_id)
    if build_path.is_file():
        files.append(build_path)
        roles[build_path] = ["build-receipt", "generated"]
        build = read_object(build_path, "module build receipt")
        for field, role in (
            ("resolvedSpec", "resolved-spec"),
            ("generatedOutput", "generated-factory"),
        ):
            value = build.get(field)
            if isinstance(value, str) and value.strip():
                artifact = Path(value).expanduser().resolve()
                files.append(artifact)
                roles[artifact] = [role, "generated"]
    return list(dict.fromkeys(files)), roles


def _capture_module_candidate(
    manifest_path: Path,
    manifest: dict[str, Any],
    module_id: str,
    implementation_files: dict[str, str],
    verdict: dict[str, Any],
) -> dict[str, Any]:
    files, roles = _module_checkpoint_files(
        manifest_path,
        manifest,
        module_id,
        implementation_files,
    )
    checkpoint = capture_checkpoint(
        manifest_path.parent,
        cache_path(manifest_path).parent / "quality-checkpoints",
        files,
        roles=roles,
        metadata={
            "scope": "module-quality-candidate",
            "moduleId": module_id,
            "reviewId": verdict.get("reviewId"),
            "overallScore": verdict.get("overallScore"),
            "layerScores": verdict.get("layerScores", {}),
        },
    )
    checkpoint_id = checkpoint.parent.name
    return {
        "checkpointId": checkpoint_id,
        "checkpointManifest": str(checkpoint),
    }


def _module_quality_policy(module: dict[str, Any]) -> dict[str, Any]:
    required = module_required_layer_scores(module)
    preview_pass = module_preview_pass(module)
    if preview_pass == "lookdev":
        owned = [
            layer
            for layer in required
            if any(token in layer.lower() for token in ("material", "surface", "lighting", "light"))
        ]
        protected = [layer for layer in required if layer not in owned]
        if not owned:
            owned = list(required)
    else:
        owned = list(required)
        protected = []
    return {
        "previewPass": preview_pass,
        "requiredLayers": required,
        "ownedLayers": owned,
        "protectedLayers": protected,
    }


def _verified_previous_render_evidence(attempt: dict[str, Any]) -> dict[str, Any]:
    snapshot = attempt.get("renderSnapshot")
    if isinstance(snapshot, dict):
        if snapshot.get("artifactType") != "threejs-sculpt-render-snapshot":
            raise ValueError("previous render snapshot artifact type is invalid")
        if snapshot.get("version") != 1:
            raise ValueError("previous render snapshot version is invalid")
        views = snapshot.get("views")
        if not isinstance(views, list) or not views:
            raise ValueError("previous render snapshot has no views")
        for view in views:
            if not isinstance(view, dict):
                raise ValueError("previous render snapshot contains an invalid view")
            path = Path(str(view.get("renderScreenshot") or "")).expanduser()
            expected_hash = view.get("renderSha256")
            if not path.is_file() or not isinstance(expected_hash, str) or file_sha256(path) != expected_hash:
                raise ValueError("previous immutable render snapshot is missing or changed")
        return snapshot

    # Compatibility for attempts recorded before immutable snapshots existed.
    previous_evidence_path = Path(str(attempt.get("evidenceManifest"))).expanduser()
    if (
        not previous_evidence_path.is_file()
        or attempt.get("evidenceSha256") != file_sha256(previous_evidence_path)
    ):
        raise ValueError("previous evidence artifact changed after its review")
    previous_evidence = read_object(previous_evidence_path, "previous visual evidence manifest")
    previous_integrity = visual_evidence_integrity_failures(previous_evidence)
    if previous_integrity:
        raise ValueError("; ".join(previous_integrity))
    return previous_evidence


def _render_pixel_delta(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, float]:
    from make_visual_comparison_sheet import resize_contain

    previous_views = {
        view.get("viewId"): view
        for view in previous.get("views", [])
        if isinstance(view, dict) and isinstance(view.get("viewId"), str)
    }
    current_views = {
        view.get("viewId"): view
        for view in current.get("views", [])
        if isinstance(view, dict) and isinstance(view.get("viewId"), str)
    }
    maximum_mean_delta = 0.0
    maximum_changed_fraction = 0.0
    compared = 0
    for view_id in sorted(set(previous_views) & set(current_views)):
        old_path = Path(str(previous_views[view_id].get("renderScreenshot"))).expanduser()
        new_path = Path(str(current_views[view_id].get("renderScreenshot"))).expanduser()
        old_w, old_h, old_pixels = load_image(old_path)
        new_w, new_h, new_pixels = load_image(new_path)
        old_panel = resize_contain(old_w, old_h, old_pixels, 128, 128)
        new_panel = resize_contain(new_w, new_h, new_pixels, 128, 128)
        absolute_sum = 0
        changed = 0
        for old_pixel, new_pixel in zip(old_panel, new_panel):
            channel_deltas = [abs(first - second) for first, second in zip(old_pixel, new_pixel)]
            absolute_sum += sum(channel_deltas)
            changed += int(max(channel_deltas) >= 8)
        sample_count = max(1, len(old_panel))
        maximum_mean_delta = max(
            maximum_mean_delta,
            absolute_sum / (sample_count * 3 * 255),
        )
        maximum_changed_fraction = max(maximum_changed_fraction, changed / sample_count)
        compared += 1
    return {
        "comparedViews": float(compared),
        "maximumMeanAbsoluteDelta": maximum_mean_delta,
        "maximumChangedPixelFraction": maximum_changed_fraction,
    }


def _reported_quality_improved(previous: dict[str, Any], verdict: dict[str, Any]) -> bool:
    old_overall = previous.get("overallScore")
    new_overall = verdict.get("overallScore")
    if _is_score(old_overall) and _is_score(new_overall) and float(new_overall) >= float(old_overall) + 0.01:
        return True
    old_layers = previous.get("layerScores") if isinstance(previous.get("layerScores"), dict) else {}
    new_layers = verdict.get("layerScores") if isinstance(verdict.get("layerScores"), dict) else {}
    return any(
        _is_score(old_layers.get(layer))
        and _is_score(value)
        and float(value) >= float(old_layers[layer]) + 0.01
        for layer, value in new_layers.items()
    )


def _normalize_lineage_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def _issue_lineage_keys(
    issues: Any,
    corrections: Any,
) -> set[str]:
    """Derive semantic defect identity independently of reviewer-chosen IDs/root keys."""

    correction_paths: dict[str, list[str]] = {}
    if isinstance(corrections, list):
        for correction in corrections:
            if not isinstance(correction, dict) or not isinstance(correction.get("issueId"), str):
                continue
            correction_paths.setdefault(correction["issueId"], []).append(
                _normalize_lineage_text(correction.get("parameterPath"))
            )
    keys: set[str] = set()
    if not isinstance(issues, list):
        return keys
    for issue in issues:
        if (
            not isinstance(issue, dict)
            or issue.get("status") != "open"
        ):
            continue
        issue_id = issue.get("id")
        payload = {
            "failureClass": _normalize_lineage_text(issue.get("failureClass")),
            "target": _normalize_lineage_text(issue.get("target")),
            "parameterPaths": sorted(
                path for path in correction_paths.get(str(issue_id), []) if path
            ),
        }
        keys.add(
            hashlib.sha256(
                repr(sorted(payload.items())).encode("utf-8")
            ).hexdigest()
        )
    return keys


def _latest_pending_refinement_attempt(
    attempts: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        if attempt.get("accepted") is True or attempt.get("action") in {
            "stop",
            STRATEGY_RESET_ACTION,
        }:
            return None
        if attempt.get("action") == "request-input":
            continue
        if is_pending_quality_attempt(attempt):
            return attempt
    return None


def _active_refinement_cycle(attempts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active: list[dict[str, Any]] = []
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        if attempt.get("accepted") is True or attempt.get("action") == STRATEGY_RESET_ACTION:
            break
        if attempt.get("action") == "stop":
            if str(attempt.get("candidateDisposition") or "").startswith("rejected-"):
                active.append(attempt)
            break
        active.append(attempt)
    return list(reversed(active))


def _pending_strategy_reset(attempts: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return a reset until one materially changed render consumes it."""

    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        action = attempt.get("action")
        if attempt.get("accepted") is True or action in {"request-input", "stop"}:
            return None
        if is_pending_quality_attempt(attempt):
            return None
        if action == STRATEGY_RESET_ACTION:
            return attempt
    return None


def _pending_request_input(attempts: list[dict[str, Any]]) -> dict[str, Any] | None:
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        action = attempt.get("action")
        if attempt.get("accepted") is True or action in {
            "stop",
            STRATEGY_RESET_ACTION,
            *REFINEMENT_ACTIONS,
        }:
            return None
        if action == "request-input":
            return attempt
    return None


def _attempt_correction_batch(attempt: dict[str, Any]) -> dict[str, Any]:
    batch = attempt.get("correctionBatch")
    if isinstance(batch, dict) and batch.get("correctionCount", 0) > 0:
        return batch
    return correction_batch_from_verdict(
        {
            "reviewId": attempt.get("reviewId"),
            "action": attempt.get("action"),
            "issues": attempt.get("issues", []),
            "corrections": attempt.get("corrections", []),
        }
    )


def _refinement_preflight_failures(
    attempts: list[dict[str, Any]],
    module_hash: str,
    representation_signature: str,
    implementation_semantic_files: dict[str, str],
    evidence: dict[str, Any],
) -> list[str]:
    latest = next(
        (attempt for attempt in reversed(attempts) if isinstance(attempt, dict)),
        None,
    )
    if (
        isinstance(latest, dict)
        and latest.get("action") == "stop"
        and str(latest.get("candidateDisposition") or "").startswith("rejected-")
    ):
        return [
            "the reviewer stopped a regressed challenger; the champion is active and a strategy-reset with a materially different representation is required before another render"
        ]
    pending_input = _pending_request_input(attempts)
    if pending_input is not None:
        requested_views = {
            item.get("missingViewId")
            for item in pending_input.get("requiredEvidence", [])
            if isinstance(item, dict) and isinstance(item.get("missingViewId"), str)
        }
        current_views = {
            view.get("viewId")
            for view in evidence.get("views", [])
            if isinstance(view, dict)
            and isinstance(view.get("viewId"), str)
            and isinstance(view.get("referenceProvenance"), dict)
            and view["referenceProvenance"].get("origin") in {"observed", "prepared-reference"}
        }
        missing_views = requested_views - current_views
        if missing_views:
            return [
                "request-input remains blocked by missing observed views: "
                + ", ".join(sorted(missing_views))
            ]
        # New observed evidence unlocks evaluation, but does not erase batch usage
        # or semantic lineage from the current strategy.
        return []
    previous = _latest_pending_refinement_attempt(attempts)
    strategy_reset = _pending_strategy_reset(attempts)
    if previous is None and strategy_reset is None:
        return []
    if previous is None and strategy_reset is not None:
        failures: list[str] = []
        if strategy_reset.get("representationSignature") == representation_signature:
            failures.append(
                "strategy-reset requires a different topology/geometry representation before rendering"
            )
        if strategy_reset.get("comparisonSha256") == evidence.get("comparisonSha256"):
            failures.append("strategy-reset reused the previous comparison image")
        if strategy_reset.get("renderSha256") == _render_hashes(evidence):
            failures.append("strategy-reset produced no new render artifact")
        return failures
    assert previous is not None
    batch = _attempt_correction_batch(previous)
    scopes = set(_strings(batch.get("scopes")))
    failures: list[str] = []
    if "spec" in scopes and previous.get("moduleHash") == module_hash:
        failures.append(
            "pending correction batch requires a module spec change before rendering"
        )
    if (
        "code" in scopes
        and previous.get("implementationSemanticFiles") == implementation_semantic_files
    ):
        failures.append(
            "pending correction batch requires an executable code change before rendering"
        )
    if previous.get("comparisonSha256") == evidence.get("comparisonSha256"):
        failures.append("pending correction batch reused the previous comparison image")
    if previous.get("renderSha256") == _render_hashes(evidence):
        failures.append("pending correction batch produced no new render artifact")
    try:
        previous_evidence = _verified_previous_render_evidence(previous)
        delta = _render_pixel_delta(previous_evidence, evidence)
    except (OSError, ValueError, TypeError) as exc:
        failures.append(f"refinement pixel delta could not be verified: {exc}")
    else:
        if delta["comparedViews"] < 1:
            failures.append("refinement has no matching before/after render views")
        elif (
            delta["maximumMeanAbsoluteDelta"] < 0.003
            and delta["maximumChangedPixelFraction"] < 0.01
        ):
            failures.append(
                "refinement render delta is below the perceptible-change floor "
                f"(mean={delta['maximumMeanAbsoluteDelta']:.5f}, "
                f"changed={delta['maximumChangedPixelFraction']:.5f})"
            )
    return list(dict.fromkeys(failures))


def _refinement_delta_failures(
    attempts: list[dict[str, Any]],
    verdict: dict[str, Any],
) -> list[str]:
    previous = _latest_pending_refinement_attempt(attempts)
    if previous is None:
        return []
    failures: list[str] = []
    if not _reported_quality_improved(previous, verdict):
        failures.append("refinement did not improve any independently reviewed quality score")
    previous_blockers = {
        issue.get("rootCauseKey")
        for attempt in _active_refinement_cycle(attempts)
        if isinstance(attempt, dict) and attempt.get("accepted") is not True
        for issue in attempt.get("issues", [])
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and issue.get("severity") in BLOCKING_SEVERITIES
        and isinstance(issue.get("rootCauseKey"), str)
    }
    resolved_root_causes = set(_strings(verdict.get("resolvedRootCauseKeys")))
    unresolved = previous_blockers - resolved_root_causes
    if unresolved:
        failures.append(
            "previous blocking root causes were not explicitly resolved: "
            + ", ".join(sorted(unresolved))
        )
    reopened = {
        issue.get("rootCauseKey")
        for issue in verdict.get("issues", [])
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and issue.get("rootCauseKey") in resolved_root_causes
    }
    if reopened:
        failures.append(
            "a root cause cannot be resolved and reopened under a new issue id: "
            + ", ".join(sorted(str(item) for item in reopened))
        )
    current_blockers = {
        issue.get("rootCauseKey")
        for issue in verdict.get("issues", [])
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and issue.get("severity") in BLOCKING_SEVERITIES
        and isinstance(issue.get("rootCauseKey"), str)
    }
    new_blockers = current_blockers - previous_blockers
    if new_blockers:
        failures.append(
            "a new blocking root cause cannot be introduced within the same strategy; "
            "record strategy-reset before changing defect identity: "
            + ", ".join(sorted(new_blockers))
        )
    previous_lineages: set[str] = set()
    for attempt in _active_refinement_cycle(attempts):
        if not isinstance(attempt, dict) or attempt.get("accepted") is True:
            continue
        stored = set(_strings(attempt.get("issueLineageKeys")))
        previous_lineages.update(
            stored
            or _issue_lineage_keys(
                attempt.get("issues", []),
                attempt.get("corrections", []),
            )
        )
    current_lineages = _issue_lineage_keys(
        verdict.get("issues", []),
        verdict.get("corrections", []),
    )
    repeated_lineages = previous_lineages & current_lineages
    if repeated_lineages:
        failures.append(
            "a blocking defect remains open under the same canonical issue lineage"
        )
    return failures


def _module_preflight_context(
    manifest_path: Path,
    module_id: str,
    evidence_path: Path,
    implementation_files: list[Path] | None = None,
    verify_evidence: bool = True,
) -> dict[str, Any]:
    path = manifest_path.expanduser().resolve()
    manifest = read_object(path, "manifest JSON")
    entries = entry_by_id(manifest)
    if module_id not in entries:
        raise ValueError(f"unknown module {module_id!r}")
    entry = entries[module_id]
    if entry.get("gateType") != "visual":
        raise ValueError("structural modules use `sculpt module accept`; visual modules use review")
    before = module_status(path, manifest)
    if before.get("currentModule") != module_id:
        raise ValueError(
            "only the current highest-risk ready module may be reviewed; "
            f"current={before.get('currentModule')!r}"
        )
    checked = check_module(path, module_id, strict_quality=True)
    if not checked["ok"]:
        raise ValueError("module check failed: " + "; ".join(checked["errors"]))
    resolved_evidence_path = evidence_path.expanduser().resolve()
    evidence = read_object(resolved_evidence_path, "visual evidence manifest")
    module = load_modules(path, manifest, [module_id])[module_id][1]
    gate = module.get("qualityGate") if isinstance(module.get("qualityGate"), dict) else {}
    required_views = set(_strings(gate.get("requiredViews")))
    diagnostic_views = set(_strings(gate.get("diagnosticViews")))
    evidence_contract_failures: list[str] = []
    evidence_scope_failures: list[str] = []
    hypothesis_failures: list[str] = []
    provenance_failures: list[str] = []
    diagnostic_failures: list[str] = []
    refinement_failures: list[str] = []
    failures: list[str] = []
    if verify_evidence:
        evidence_contract_failures.extend(visual_evidence_integrity_failures(evidence))
        evidence_contract_failures.extend(
            visual_evidence_authority_failures(evidence, required_views)
        )
        evidence_scope_failures.extend(
            module_evidence_scope_failures(
                path,
                manifest,
                module,
                module_id,
                evidence,
            )
        )
        evidence_contract_failures.extend(evidence_scope_failures)
        if diagnostic_views:
            from sculpt_view_hypotheses import hypothesis_evidence_failures

            global_spec = manifest.get("globalSpec") if isinstance(manifest.get("globalSpec"), dict) else {}
            hypothesis_failures.extend(
                hypothesis_evidence_failures(
                    path,
                    global_spec,
                    evidence,
                    diagnostic_views,
                )
            )
    declared_implementation = implementation_contract_paths(path, module)
    if implementation_files is not None:
        root = path.parent.resolve()
        supplied = {
            (
                (root / item.expanduser()).resolve()
                if not item.expanduser().is_absolute()
                else item.expanduser().resolve()
            )
            for item in implementation_files
        }
        if supplied != set(declared_implementation):
            raise ValueError(
                "supplied implementation files must exactly match module contract.implementationFiles"
            )
    implementation_hashes = _implementation_hashes(declared_implementation)
    semantic_implementation_hashes = implementation_semantic_hashes(declared_implementation)
    cache = _load_cache(path)
    attempts_by_module = cache.get("reviewAttempts", {}) if isinstance(cache, dict) else {}
    attempts = (
        attempts_by_module.get(module_id, [])
        if isinstance(attempts_by_module, dict)
        else []
    )
    if not isinstance(attempts, list):
        attempts = []
    pending_attempt = _latest_pending_refinement_attempt(attempts)
    pending_batch = _attempt_correction_batch(pending_attempt) if pending_attempt else {}
    representation_signature = module_representation_signature(
        manifest,
        module_id,
        module,
    )
    if verify_evidence:
        provenance_failures.extend(
            _render_provenance_failures(
                evidence,
                manifest,
                module,
                module_id,
                str(checked.get("moduleHash") or ""),
                implementation_hashes,
                semantic_implementation_hashes,
                path,
            )
        )
        if not evidence_scope_failures:
            diagnostic_failures.extend(diagnostic_veto_failures(manifest, module, evidence))
        refinement_failures.extend(
            _refinement_preflight_failures(
                attempts,
                str(checked.get("moduleHash") or ""),
                representation_signature,
                semantic_implementation_hashes,
                evidence,
            )
        )
        failures.extend(evidence_contract_failures)
        failures.extend(hypothesis_failures)
        failures.extend(provenance_failures)
        failures.extend(diagnostic_failures)
        failures.extend(refinement_failures)
    return {
        "path": path,
        "manifest": manifest,
        "entry": entry,
        "checked": checked,
        "evidencePath": resolved_evidence_path,
        "evidence": evidence,
        "module": module,
        "gate": gate,
        "requiredViews": required_views,
        "implementationFiles": implementation_hashes,
        "implementationSemanticFiles": semantic_implementation_hashes,
        "representationSignature": representation_signature,
        "evidenceFiles": _evidence_file_snapshot(evidence),
        "pendingCorrectionBatch": pending_batch,
        "refinementBudget": refinement_budget(attempts),
        "pendingAttempt": pending_attempt,
        "evidenceContractFailures": list(dict.fromkeys(evidence_contract_failures)),
        "evidenceScopeFailures": list(dict.fromkeys(evidence_scope_failures)),
        "hypothesisFailures": list(dict.fromkeys(hypothesis_failures)),
        "provenanceFailures": list(dict.fromkeys(provenance_failures)),
        "diagnosticFailures": list(dict.fromkeys(diagnostic_failures)),
        "deterministicQualityFailures": deterministic_quality_gate_failures(
            diagnostic_failures
        ),
        "refinementFailures": list(dict.fromkeys(refinement_failures)),
        "failures": list(dict.fromkeys(failures)),
    }


def _diagnostic_metric_snapshot(evidence: dict[str, Any]) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for view in evidence.get("views", []):
        if not isinstance(view, dict) or not isinstance(view.get("viewId"), str):
            continue
        diagnostics = view.get("fitDiagnostics")
        if not isinstance(diagnostics, dict):
            continue
        values = {
            field: diagnostics.get(field)
            for field in ("centroidDelta", "aspectRatioDelta")
            if _finite_number(diagnostics.get(field))
        }
        appearance = diagnostics.get("appearance")
        if isinstance(appearance, dict):
            values["appearance"] = {
                field: appearance.get(field)
                for field in (
                    "detailEnergyRatio",
                    "edgeDensityRatio",
                    "foregroundHistogramIntersection",
                    "foregroundMeanColorDelta",
                    "highlightCoverageRatio",
                    "highlightEnergyRatio",
                )
                if _finite_number(appearance.get(field))
            }
        snapshot[view["viewId"]] = values
    return snapshot


def _candidate_differs_from_module_champion(
    context: dict[str, Any],
    champion: dict[str, Any],
) -> bool:
    return any(
        (
            context["checked"].get("moduleHash") != champion.get("moduleHash"),
            context["implementationFiles"] != champion.get("implementationFiles"),
            context["implementationSemanticFiles"]
            != champion.get("implementationSemanticFiles"),
            context["representationSignature"] != champion.get("representationSignature"),
        )
    )


def _record_module_preflight_regression(
    cache: dict[str, Any],
    context: dict[str, Any],
    module_id: str,
    quality_failures: list[str],
    recorded_at: str,
) -> dict[str, Any]:
    attempts_by_module = cache.setdefault("reviewAttempts", {})
    if not isinstance(attempts_by_module, dict):
        attempts_by_module = {}
        cache["reviewAttempts"] = attempts_by_module
    attempts = attempts_by_module.setdefault(module_id, [])
    if not isinstance(attempts, list):
        attempts = []
        attempts_by_module[module_id] = attempts
    pending_attempt = context.get("pendingAttempt")
    champions = cache.get("reviewChampions")
    champion = champions.get(module_id) if isinstance(champions, dict) else None
    if (
        not isinstance(pending_attempt, dict)
        or not isinstance(champion, dict)
        or not isinstance(champion.get("checkpointManifest"), str)
        or not quality_failures
        or context.get("refinementBudget", {}).get("exhausted") is True
        or not _candidate_differs_from_module_champion(context, champion)
    ):
        return {}

    non_diagnostic_failures = [
        *context.get("evidenceContractFailures", []),
        *context.get("hypothesisFailures", []),
        *context.get("provenanceFailures", []),
        *context.get("refinementFailures", []),
    ]
    diagnostic_failures = context.get("diagnosticFailures", [])
    if non_diagnostic_failures or set(diagnostic_failures) != set(quality_failures):
        return {}

    comparison_hash = str(context["evidence"].get("comparisonSha256") or "")
    attempt_number = len(attempts) + 1
    preflight_id = (
        f"{module_id}-deterministic-preflight-{attempt_number}-"
        f"{comparison_hash[:12] or 'comparison'}"
    )
    candidate_render_snapshot = _snapshot_refinement_renders(
        context["path"],
        module_id,
        preflight_id,
        context["evidence"],
    )
    candidate_checkpoint = _capture_module_candidate(
        context["path"],
        context["manifest"],
        module_id,
        context["implementationFiles"],
        {"reviewId": preflight_id, "overallScore": None, "layerScores": {}},
    )
    candidate_record = {
        **candidate_checkpoint,
        "moduleHash": context["checked"].get("moduleHash"),
        "implementationFiles": context["implementationFiles"],
        "implementationSemanticFiles": context["implementationSemanticFiles"],
        "representationSignature": context["representationSignature"],
        "evidenceManifest": str(context["evidencePath"]),
        "evidenceSha256": file_sha256(context["evidencePath"]),
        "comparisonSha256": comparison_hash,
        "renderSha256": _render_hashes(context["evidence"]),
        "renderSnapshot": candidate_render_snapshot,
        "diagnosticMetrics": _diagnostic_metric_snapshot(context["evidence"]),
        "recordedAt": recorded_at,
    }
    restored_checkpoint = restore_checkpoint(
        champion["checkpointManifest"],
        context["path"].parent,
    )
    correction_batch = _attempt_correction_batch(pending_attempt)
    attempt = {
        "attempt": attempt_number,
        "attemptType": "deterministic-preflight",
        "reviewId": preflight_id,
        "action": pending_attempt.get("action"),
        "accepted": False,
        "recordedAt": recorded_at,
        "moduleHash": champion.get("moduleHash"),
        "implementationFiles": champion.get("implementationFiles", {}),
        "implementationSemanticFiles": champion.get(
            "implementationSemanticFiles", {}
        ),
        "representationSignature": champion.get("representationSignature"),
        "evidenceManifest": champion.get("evidenceManifest"),
        "evidenceSha256": champion.get("evidenceSha256"),
        "comparisonSha256": champion.get("comparisonSha256"),
        "renderSha256": champion.get("renderSha256", []),
        "renderSnapshot": champion.get("renderSnapshot", {}),
        "candidateDisposition": "rejected-preflight-regression",
        "meaningfulImprovement": False,
        "improvedLayers": [],
        "regressedLayers": ["deterministicDiagnostics"],
        "championCheckpointId": champion.get("checkpointId"),
        "championCheckpointManifest": champion.get("checkpointManifest"),
        "candidateCheckpointId": candidate_record.get("checkpointId"),
        "candidateCheckpointManifest": candidate_record.get("checkpointManifest"),
        "candidateModuleHash": candidate_record.get("moduleHash"),
        "candidateImplementationFiles": candidate_record.get("implementationFiles", {}),
        "candidateImplementationSemanticFiles": candidate_record.get(
            "implementationSemanticFiles", {}
        ),
        "candidateRepresentationSignature": candidate_record.get(
            "representationSignature"
        ),
        "candidateEvidenceManifest": candidate_record.get("evidenceManifest"),
        "candidateEvidenceSha256": candidate_record.get("evidenceSha256"),
        "candidateComparisonSha256": candidate_record.get("comparisonSha256"),
        "candidateRenderSha256": candidate_record.get("renderSha256", []),
        "candidateRenderSnapshot": candidate_record.get("renderSnapshot", {}),
        "candidateDiagnosticMetrics": candidate_record.get("diagnosticMetrics", {}),
        "restoredCheckpoint": restored_checkpoint,
        "overallScore": champion.get("overallScore"),
        "layerScores": champion.get("layerScores", {}),
        "candidateOverallScore": None,
        "candidateLayerScores": {},
        "sanityChecks": pending_attempt.get("sanityChecks", {}),
        "featureReviews": pending_attempt.get("featureReviews", []),
        "issues": pending_attempt.get("issues", []),
        "corrections": pending_attempt.get("corrections", []),
        "issueLineageKeys": pending_attempt.get("issueLineageKeys", []),
        "correctionBatch": correction_batch,
        "resolvedIssueIds": pending_attempt.get("resolvedIssueIds", []),
        "resolvedRootCauseKeys": pending_attempt.get("resolvedRootCauseKeys", []),
        "summary": (
            "Deterministic visual preflight rejected the refinement and restored "
            "the active champion before another edit cycle."
        ),
        "failures": quality_failures,
    }
    attempts.append(attempt)
    active_snapshot = champion.get("renderSnapshot")
    champion_presentation: dict[str, Any] = {}
    if isinstance(active_snapshot, dict):
        views = active_snapshot.get("views")
        champion_presentation = visual_checkpoint_presentation(
            {
                "views": views if isinstance(views, list) else [],
                "comparisonImage": active_snapshot.get("comparisonImage", ""),
            },
            checkpoint="module-preflight-active-champion",
            artifact_state="restored-champion",
        )
    return {
        "attempt": attempt,
        "candidate": candidate_record,
        "restoredCheckpoint": restored_checkpoint,
        "activeChampion": champion_presentation,
        "refinementBudget": refinement_budget(attempts),
    }


def preflight_module_review(
    manifest_path: Path,
    module_id: str,
    evidence_path: Path,
    implementation_files: list[Path] | None = None,
) -> dict[str, Any]:
    """Return the cheap fail-closed result that must pass before spawning a reviewer."""
    context = _module_preflight_context(
        manifest_path,
        module_id,
        evidence_path,
        implementation_files,
    )
    failures = list(context["failures"])
    if context["refinementBudget"].get("exhausted") is True:
        failures.append(
            "refinement budget is exhausted; retain the champion and record a "
            "strategy-reset before another edit/build/render/reviewer cycle"
        )
    failures = list(dict.fromkeys(failures))
    ok = not failures
    now = datetime.now(timezone.utc).isoformat()
    cache = _load_cache(context["path"])
    cache["version"] = 2
    preflights = cache.setdefault("reviewPreflights", {})
    if not isinstance(preflights, dict):
        preflights = {}
        cache["reviewPreflights"] = preflights
    receipt = {
        "artifactType": MODULE_PREFLIGHT_ARTIFACT_TYPE,
        "version": MODULE_PREFLIGHT_VERSION,
        "ok": ok,
        "moduleId": module_id,
        "moduleHash": context["checked"].get("moduleHash"),
        "evidenceManifest": str(context["evidencePath"]),
        "evidenceSha256": file_sha256(context["evidencePath"]),
        "comparisonSha256": context["evidence"].get("comparisonSha256"),
        "implementationFiles": context["implementationFiles"],
        "implementationSemanticFiles": context["implementationSemanticFiles"],
        "evidenceFiles": context["evidenceFiles"],
        "recordedAt": now,
        "failures": failures,
    }
    rollback = _record_module_preflight_regression(
        cache,
        context,
        module_id,
        context.get("deterministicQualityFailures", []),
        now,
    )
    if rollback:
        receipt.update(
            {
                "candidateDisposition": "rejected-preflight-regression",
                "championCheckpointId": rollback["attempt"].get(
                    "championCheckpointId"
                ),
                "candidateCheckpointId": rollback["attempt"].get(
                    "candidateCheckpointId"
                ),
                "restoredCheckpoint": rollback["restoredCheckpoint"],
            }
        )
    preflights[module_id] = receipt
    cache["updatedAt"] = now
    write_spec_atomic(cache_path(context["path"]), cache)
    current_budget = rollback.get("refinementBudget", context["refinementBudget"])
    return {
        "ok": ok,
        "moduleId": module_id,
        "moduleHash": context["checked"].get("moduleHash"),
        "comparisonSha256": context["evidence"].get("comparisonSha256"),
        "pendingCorrectionBatch": context["pendingCorrectionBatch"],
        "refinementBudget": current_budget,
        "candidateDisposition": (
            "rejected-preflight-regression" if rollback else "preflight-failed" if failures else "candidate"
        ),
        "restoredCheckpoint": rollback.get("restoredCheckpoint", {}),
        "activeChampion": rollback.get("activeChampion", {}),
        "strategyChangeRequired": current_budget.get("exhausted") is True,
        "failures": failures,
    }


def _module_preflight_receipt(
    manifest_path: Path,
    module_id: str,
    evidence_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    path = manifest_path.expanduser().resolve()
    resolved_evidence = evidence_path.expanduser().resolve()
    cache = _load_cache(path)
    preflights = cache.get("reviewPreflights") if isinstance(cache, dict) else None
    receipt = preflights.get(module_id) if isinstance(preflights, dict) else None
    failures: list[str] = []
    if not isinstance(receipt, dict):
        return cache, {}, ["run a passing `sculpt module preflight` before creating/reusing a reviewer verdict"]
    if receipt.get("artifactType") != MODULE_PREFLIGHT_ARTIFACT_TYPE:
        failures.append("module preflight receipt artifact type is invalid")
    if receipt.get("version") != MODULE_PREFLIGHT_VERSION:
        failures.append(f"module preflight receipt version must be {MODULE_PREFLIGHT_VERSION}")
    if receipt.get("ok") is not True:
        failures.append("latest module preflight did not pass")
    if receipt.get("moduleId") != module_id:
        failures.append("module preflight receipt is bound to another module")
    if receipt.get("evidenceManifest") != str(resolved_evidence):
        failures.append("module preflight receipt is bound to another evidence manifest")
    if not resolved_evidence.is_file() or receipt.get("evidenceSha256") != file_sha256(resolved_evidence):
        failures.append("module evidence changed after preflight")
    return cache, receipt, list(dict.fromkeys(failures))


def review_module(
    manifest_path: Path,
    module_id: str,
    verdict_path: Path,
    evidence_path: Path,
    implementation_files: list[Path] | None = None,
) -> dict[str, Any]:
    resolved_verdict_path = verdict_path.expanduser().resolve()
    verdict = read_object(resolved_verdict_path, "module review verdict")
    preview_action = str(verdict.get("action"))
    governance_action = preview_action in {
        STRATEGY_RESET_ACTION,
        "request-input",
        "stop",
    }
    cache, preflight_receipt, receipt_failures = _module_preflight_receipt(
        manifest_path,
        module_id,
        evidence_path,
    )
    if receipt_failures and not governance_action:
        raise ValueError("module review requires a current passing preflight receipt: " + "; ".join(receipt_failures))
    context = _module_preflight_context(
        manifest_path,
        module_id,
        evidence_path,
        implementation_files,
        verify_evidence=False,
    )
    if context["failures"]:
        raise ValueError("module review preflight failed: " + "; ".join(context["failures"]))
    current_receipt_contract = {
        "moduleHash": context["checked"].get("moduleHash"),
        "comparisonSha256": context["evidence"].get("comparisonSha256"),
        "implementationFiles": context["implementationFiles"],
        "implementationSemanticFiles": context["implementationSemanticFiles"],
        "evidenceFiles": context["evidenceFiles"],
    }
    stale_fields = [
        field
        for field, value in current_receipt_contract.items()
        if preflight_receipt.get(field) != value
    ] if not governance_action else []
    if stale_fields:
        raise ValueError(
            "module review requires a fresh preflight; changed fields: "
            + ", ".join(stale_fields)
        )
    path = context["path"]
    manifest = context["manifest"]
    entry = context["entry"]
    checked = context["checked"]
    resolved_evidence_path = context["evidencePath"]
    evidence = context["evidence"]
    module = context["module"]
    gate = context["gate"]
    required_views = context["requiredViews"]
    implementation_hashes = context["implementationFiles"]
    semantic_implementation_hashes = context["implementationSemanticFiles"]
    resolved_spec = resolve_manifest(path, manifest, [module_id])
    correction_targets = review_target_catalog(resolved_spec)
    preview_phase = module_preview_pass(module)
    sanity_contract = effective_pass_config(resolved_spec, preview_phase).get(
        "visualSanity"
    )
    required_sanity_categories = (
        sanity_contract.get("requiredCategories", [])
        if isinstance(sanity_contract, dict)
        else []
    )
    contract_failures = _review_contract_failures(
        verdict,
        evidence,
        correction_targets,
        required_sanity_categories,
        # v4 modules use the same compact composite-score + blind-scout gate
        # as assembled phases; legacy manifests keep their layer contract.
        require_blind_scout=simplified_visual_gate_enabled(
            resolved_spec,
            preview_phase,
        ),
        simplified_visual_gate=simplified_visual_gate_enabled(
            resolved_spec,
            preview_phase,
        ),
        blind_scout_phase=preview_phase,
    )
    if contract_failures:
        raise ValueError("invalid module review verdict: " + "; ".join(contract_failures))
    cache["version"] = 2
    attempts_by_module = cache.setdefault("reviewAttempts", {})
    attempts = attempts_by_module.setdefault(module_id, [])
    if not isinstance(attempts, list):
        attempts = []
        attempts_by_module[module_id] = attempts
    if any(attempt.get("reviewId") == verdict.get("reviewId") for attempt in attempts if isinstance(attempt, dict)):
        raise ValueError(f"reviewId {verdict.get('reviewId')!r} has already been recorded")
    reviewer = verdict.get("reviewer") if isinstance(verdict.get("reviewer"), dict) else {}
    reviewer_context_id = reviewer.get("contextId")
    if reviewer_context_id in recorded_reviewer_context_ids(path, manifest):
        raise ValueError(
            "each module phase attempt requires a fresh independent reviewer contextId "
            "across all modules and assembled phases"
        )

    action = str(verdict.get("action"))
    budget = refinement_budget(attempts)
    if (action == "continue" or action in REFINEMENT_ACTIONS) and budget["exhausted"]:
        champions_value = cache.get("reviewChampions")
        champion_value = (
            champions_value.get(module_id)
            if isinstance(champions_value, dict)
            else None
        )
        if isinstance(champion_value, dict) and isinstance(
            champion_value.get("checkpointManifest"), str
        ):
            restore_checkpoint(champion_value["checkpointManifest"], path.parent)
        raise ValueError(
            "atomic refinement budget is exhausted; record one strategy-reset with a "
            "different representation before any further refinement; the champion "
            "checkpoint has been restored"
        )
    if action == STRATEGY_RESET_ACTION:
        if budget.get("remainingStrategyResets", 0) < 1:
            raise ValueError(
                "strategy-reset budget is exhausted; only concrete missing evidence or a "
                "verified capability limit may pause the task"
            )
        active_root_causes = {
            issue.get("rootCauseKey")
            for attempt in _active_refinement_cycle(attempts)
            if isinstance(attempt, dict)
            for issue in attempt.get("issues", [])
            if isinstance(issue, dict)
            and issue.get("status") == "open"
            and issue.get("severity") in BLOCKING_SEVERITIES
            and isinstance(issue.get("rootCauseKey"), str)
        }
        declared_root_causes = set(_strings(verdict.get("rootCauseKeys")))
        if not active_root_causes:
            raise ValueError("strategy-reset requires a failed refinement cycle")
        if not declared_root_causes or not declared_root_causes <= active_root_causes:
            raise ValueError(
                "strategy-reset rootCauseKeys must reference blockers from the active failed cycle"
            )
    correction_batch = correction_batch_from_verdict(verdict)
    perceptual = (
        resolved_spec.get("perceptualContract")
        if isinstance(resolved_spec.get("perceptualContract"), dict)
        else {}
    )
    if perceptual.get("enforcementMode") == "strict" and correction_batch:
        from sculpt_corrections import correction_failures

        typed_failures = correction_failures(
            resolved_spec,
            correction_batch,
            active_phase=preview_phase,
        )
        if typed_failures:
            raise ValueError(
                "invalid typed perceptual correction batch: "
                + "; ".join(typed_failures)
            )
    # `stop` is still a scored rendered challenger. Always compare it with the
    # champion and restore on regression; the reviewer action remains intact in
    # audit instead of becoming a loophole around rollback.
    scored_candidate = (
        action == "continue" or action in REFINEMENT_ACTIONS or action == "stop"
    )
    render_snapshot = (
        _snapshot_refinement_renders(
            path,
            module_id,
            verdict.get("reviewId"),
            evidence,
        )
        if scored_candidate
        else {}
    )
    candidate_checkpoint = (
        _capture_module_candidate(
            path,
            manifest,
            module_id,
            implementation_hashes,
            verdict,
        )
        if scored_candidate
        else {}
    )
    champions = cache.setdefault("reviewChampions", {})
    if not isinstance(champions, dict):
        champions = {}
        cache["reviewChampions"] = champions
    baseline_champion = champions.get(module_id)
    if not isinstance(baseline_champion, dict):
        baseline_champion = None
    quality_policy = _module_quality_policy(module)
    if simplified_visual_gate_enabled(resolved_spec, preview_phase):
        quality_policy = {
            **quality_policy,
            "requiredLayers": {},
            "ownedLayers": [],
            "protectedLayers": [],
        }
    candidate_quality = {
        "overallScore": verdict.get("overallScore"),
        "layerScores": verdict.get("layerScores", {}),
        "diagnosticScores": diagnostic_quality_vector(evidence),
        "sanityChecks": verdict.get("sanityChecks", {}),
    }
    disposition = (
        quality_candidate_disposition(
            baseline_champion,
            candidate_quality,
            owned_layers=quality_policy["ownedLayers"],
            protected_layers=quality_policy["protectedLayers"],
            required_layers=quality_policy["requiredLayers"],
            minimum_delta=(
                0.01
                if simplified_visual_gate_enabled(resolved_spec, preview_phase)
                else 0.02
            ),
            diagnostic_metrics=(
                set()
                if simplified_visual_gate_enabled(
                    resolved_spec,
                    preview_phase,
                )
                else None
            ),
            blind_scout_decision=(
                verdict.get("blindScout", {}).get("decision")
                if isinstance(verdict.get("blindScout"), dict)
                else None
            ),
        )
        if scored_candidate
        else {
            "disposition": "not-scored",
            "meaningfulImprovement": False,
            "improvedLayers": [],
            "regressedLayers": [],
        }
    )
    refinement_findings = (
        _refinement_delta_failures(attempts, verdict)
        if scored_candidate and _latest_pending_refinement_attempt(attempts) is not None
        else []
    )
    lineage_failures = [
        failure
        for failure in refinement_findings
        if "cannot be resolved and reopened" in failure
        or "new blocking root cause" in failure
    ]
    if action in REFINEMENT_ACTIONS and lineage_failures:
        disposition = {
            **disposition,
            "disposition": "rejected-invalid-lineage",
            "meaningfulImprovement": False,
        }
    quality_failures: list[str] = []
    quality_failures.extend(lineage_failures)
    if action == "continue":
        quality_failures.extend(
            _continue_gate_failures(
                manifest,
                module,
                entry,
                evidence,
                verdict,
                diagnostics_preflighted=True,
            )
        )
        quality_failures.extend(refinement_findings)
    if scored_candidate and disposition["disposition"] == "rejected-regression":
        quality_failures.append(
            "challenger regressed independently scored layers: "
            + ", ".join(disposition["regressedLayers"])
        )
    if scored_candidate and disposition["disposition"] == "rejected-incomplete":
        quality_failures.append(
            "challenger is missing required independent scores: "
            + ", ".join(disposition.get("missingLayers", []))
        )
    quality_failures = list(dict.fromkeys(quality_failures))
    gate_pass_without_delta = (
        action == "continue"
        and not quality_failures
        and disposition["disposition"] == "rejected-no-improvement"
    )
    if gate_pass_without_delta:
        disposition = {**disposition, "disposition": "gate-pass"}
    accepted = (
        action == "continue"
        and not quality_failures
        and disposition["disposition"] in {"seed", "promoted", "gate-pass"}
    )
    now = datetime.now(timezone.utc).isoformat()
    candidate_record = {
        **candidate_checkpoint,
        "moduleHash": checked.get("moduleHash"),
        "implementationFiles": implementation_hashes,
        "implementationSemanticFiles": semantic_implementation_hashes,
        "representationSignature": context["representationSignature"],
        "evidenceManifest": str(resolved_evidence_path),
        "evidenceSha256": file_sha256(resolved_evidence_path),
        "comparisonSha256": evidence.get("comparisonSha256"),
        "renderSha256": _render_hashes(evidence),
        "renderSnapshot": render_snapshot,
        "overallScore": verdict.get("overallScore"),
        "layerScores": verdict.get("layerScores", {}),
        "diagnosticScores": candidate_quality["diagnosticScores"],
        "reviewId": verdict.get("reviewId"),
        "blindScout": verdict.get("blindScout"),
        "blindScoutMapping": verdict.get("blindScoutMapping"),
        "reviewerContextId": reviewer_context_id,
        "previewPass": quality_policy["previewPass"],
        "recordedAt": now,
    }
    promoted = (
        scored_candidate
        and action != "stop"
        and disposition["disposition"] in {"seed", "promoted", "gate-pass"}
    )
    restored_checkpoint: dict[str, Any] = {}
    if promoted:
        champions[module_id] = candidate_record
        active_record = candidate_record
    elif scored_candidate and baseline_champion is not None:
        restored_checkpoint = restore_checkpoint(
            baseline_champion["checkpointManifest"],
            path.parent,
        )
        active_record = baseline_champion
    else:
        active_record = candidate_record
    attempt = {
        "attempt": len(attempts) + 1,
        "reviewId": verdict.get("reviewId"),
        "blindScout": verdict.get("blindScout"),
        "blindScoutMapping": verdict.get("blindScoutMapping"),
        "action": action,
        "accepted": accepted,
        "recordedAt": now,
        "moduleHash": active_record.get("moduleHash"),
        "implementationFiles": active_record.get("implementationFiles", {}),
        "implementationSemanticFiles": active_record.get("implementationSemanticFiles", {}),
        "representationSignature": active_record.get("representationSignature"),
        "reviewVerdict": str(resolved_verdict_path),
        "reviewVerdictSha256": file_sha256(resolved_verdict_path),
        "evidenceManifest": active_record.get("evidenceManifest"),
        "evidenceSha256": active_record.get("evidenceSha256"),
        "comparisonSha256": active_record.get("comparisonSha256"),
        "renderSha256": active_record.get("renderSha256", []),
        "renderSnapshot": active_record.get("renderSnapshot", {}),
        "candidateDisposition": disposition["disposition"],
        "meaningfulImprovement": disposition.get("meaningfulImprovement", False),
        "improvedLayers": disposition.get("improvedLayers", []),
        "regressedLayers": disposition.get("regressedLayers", []),
        "championCheckpointId": active_record.get("checkpointId"),
        "championCheckpointManifest": active_record.get("checkpointManifest"),
        "candidateCheckpointId": candidate_record.get("checkpointId"),
        "candidateCheckpointManifest": candidate_record.get("checkpointManifest"),
        "candidateModuleHash": candidate_record.get("moduleHash"),
        "candidateImplementationFiles": candidate_record.get("implementationFiles", {}),
        "candidateImplementationSemanticFiles": candidate_record.get(
            "implementationSemanticFiles", {}
        ),
        "candidateRepresentationSignature": candidate_record.get("representationSignature"),
        "candidateEvidenceManifest": candidate_record.get("evidenceManifest"),
        "candidateEvidenceSha256": candidate_record.get("evidenceSha256"),
        "candidateComparisonSha256": candidate_record.get("comparisonSha256"),
        "candidateRenderSha256": candidate_record.get("renderSha256", []),
        "candidateRenderSnapshot": candidate_record.get("renderSnapshot", {}),
        "restoredCheckpoint": restored_checkpoint,
        "reviewer": verdict.get("reviewer"),
        "overallScore": active_record.get("overallScore"),
        "layerScores": active_record.get("layerScores", {}),
        "diagnosticScores": active_record.get("diagnosticScores", {}),
        "candidateOverallScore": verdict.get("overallScore"),
        "candidateLayerScores": verdict.get("layerScores", {}),
        "candidateDiagnosticScores": candidate_quality["diagnosticScores"],
        "sanityChecks": verdict.get("sanityChecks", {}),
        "featureReviews": verdict.get("featureReviews", []),
        "issues": verdict.get("issues", []),
        "corrections": verdict.get("corrections", []),
        "issueLineageKeys": sorted(
            _issue_lineage_keys(
                verdict.get("issues", []),
                verdict.get("corrections", []),
            )
        ),
        "correctionBatch": correction_batch,
        "resolvedIssueIds": verdict.get("resolvedIssueIds", []),
        "resolvedRootCauseKeys": verdict.get("resolvedRootCauseKeys", []),
        "strategyId": verdict.get("strategyId"),
        "strategyChange": verdict.get("strategyChange"),
        "rootCauseKeys": verdict.get("rootCauseKeys", []),
        "falsifyingCheck": verdict.get("falsifyingCheck"),
        "requiredEvidence": verdict.get("requiredEvidence", []),
        "stopReason": verdict.get("stopReason"),
        "stopEvidence": verdict.get("stopEvidence", []),
        "summary": verdict.get("summary"),
        "failures": quality_failures,
    }
    attempts.append(attempt)
    preflights = cache.get("reviewPreflights")
    if isinstance(preflights, dict):
        preflights.pop(module_id, None)
    records = cache.setdefault("modules", {})
    if accepted:
        records[module_id] = {
            "moduleHash": candidate_record.get("moduleHash"),
            "interfaceHash": interface_hash(module),
            "gateType": "visual",
            "evidenceScopeVersion": 1,
            "score": verdict.get("overallScore"),
            "layerScores": verdict.get("layerScores", {}),
            "sanityChecks": verdict.get("sanityChecks", {}),
            "notes": verdict.get("summary", ""),
            "threshold": gate.get("minimumScore"),
            "evidenceManifest": str(resolved_evidence_path),
            "evidenceSha256": file_sha256(resolved_evidence_path),
            "comparisonSha256": evidence.get("comparisonSha256"),
            "reviewVerdict": str(resolved_verdict_path),
            "reviewVerdictSha256": file_sha256(resolved_verdict_path),
            "reviewerModel": verdict.get("reviewer", {}).get("model", ""),
            "reviewerContextId": verdict.get("reviewer", {}).get("contextId", ""),
            "builderContextId": verdict.get("builder", {}).get("contextId", ""),
            "implementationFiles": implementation_hashes,
            "implementationSemanticFiles": semantic_implementation_hashes,
            "requiredViews": sorted(required_views),
            "acceptedAt": now,
            "reviewId": verdict.get("reviewId"),
        }
    elif not restored_checkpoint:
        records.pop(module_id, None)
    cache["updatedAt"] = now
    write_spec_atomic(cache_path(path), cache)
    status = module_status(path, read_object(path, "manifest JSON"))
    status.update(
        {
            "reviewAccepted": accepted,
            "reviewAction": action,
            "reviewFailures": quality_failures,
            "reviewAttempt": len(attempts),
            "pendingCorrectionBatch": correction_batch,
            "candidateDisposition": disposition["disposition"],
            "championCheckpointId": active_record.get("checkpointId"),
            "restoredCheckpoint": restored_checkpoint,
        }
    )
    candidate_disposition = str(disposition["disposition"])
    artifact_state = (
        "accepted-champion"
        if accepted
        else "rejected-challenger"
        if candidate_disposition.startswith("rejected-")
        else "candidate-champion"
        if candidate_disposition in {"seed", "promoted", "gate-pass"}
        else "candidate"
    )
    candidate_presentation = visual_checkpoint_presentation(
        evidence,
        checkpoint="module-review",
        artifact_state=artifact_state,
        progress=status.get("userProgress", {}),
    )
    candidate_presentation["reviewResult"] = {
        "action": action,
        "accepted": accepted,
        "candidateDisposition": disposition["disposition"],
        "overallScore": verdict.get("overallScore"),
        "failures": quality_failures,
    }
    active_snapshot = active_record.get("renderSnapshot")
    if restored_checkpoint and isinstance(active_snapshot, dict):
        snapshot_views = active_snapshot.get("views")
        champion_evidence = {
            "views": snapshot_views if isinstance(snapshot_views, list) else [],
            "comparisonImage": active_snapshot.get("comparisonImage", ""),
        }
        candidate_presentation["activeChampion"] = visual_checkpoint_presentation(
            champion_evidence,
            checkpoint="module-review-active-champion",
            artifact_state="restored-champion",
            progress=status.get("userProgress", {}),
        )
    status["userPresentation"] = candidate_presentation
    return status
