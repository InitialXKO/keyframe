#!/usr/bin/env python3
"""Append one authoritative review for the current sculpt pass."""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sculpt_contract import (
    CORRECTION_OPERATIONS,
    CORRECTION_TARGET_TYPES,
    REFINEMENT_ACTIONS,
    STRATEGY_RESET_ACTION,
    correction_batch_from_plan,
    correction_batch_from_verdict,
    diagnostic_quality_vector,
    deterministic_quality_gate_failures,
    effective_pass_config,
    evidence_type,
    file_sha256,
    is_pending_quality_attempt,
    parse_json,
    pipeline_status,
    prior_pass_regression_failures,
    quality_candidate_disposition,
    refinement_budget,
    review_failures,
    review_target_catalog,
    resolve_correction_parameter,
    review_spec_hash,
    sculpt_representation_signature,
    sync_pipeline,
    visual_acceptance_threshold,
    visual_gate_threshold,
    simplified_visual_gate_enabled,
    visual_checkpoint_presentation,
    visual_evidence_integrity_failures,
    visual_evidence_manifest_sha256,
    visual_preflight_failures,
    write_spec_atomic,
)
from sculpt_checkpoint import capture_checkpoint, restore_checkpoint
from sculpt_module_contract import module_build_receipt_path
from sculpt_module_review import (
    PASS_REVIEW_ARTIFACT_TYPE,
    PASS_REVIEW_VERSION,
    _issue_lineage_keys,
    _snapshot_refinement_renders,
    impact_assessment_failures,
    review_contract_failures,
)
from sculpt_module_state import (
    cache_path as module_cache_path,
    implementation_contract_paths,
    implementation_semantic_hashes,
    recorded_reviewer_context_ids,
)
from sculpt_modules import load_document, module_status, save_document
from sculpt_pass_orchestrator import pass_specific_gaps


VALID_ACTIONS = {
    "continue",
    *REFINEMENT_ACTIONS,
    STRATEGY_RESET_ACTION,
    "request-input",
    "stop",
}
VALID_ROOT_CAUSES = {
    "camera-framing",
    "spec",
    "geometry",
    "material",
    "lighting",
    "evidence",
    "performance",
    "mixed",
}
PASS_PREFLIGHT_ARTIFACT_TYPE = "threejs-sculpt-pass-preflight"
PASS_PREFLIGHT_VERSION = 1


def _pass_quality_state_path(spec_path: Path) -> Path:
    return spec_path.parent / ".sculpt-cache" / spec_path.stem / "pass-quality-state.json"


def _load_pass_quality_state(spec_path: Path) -> dict[str, Any]:
    path = _pass_quality_state_path(spec_path)
    if not path.is_file():
        return {"version": 1, "champions": {}}
    value = parse_json(path.read_text(encoding="utf-8"), "pass quality state")
    if not isinstance(value, dict) or not isinstance(value.get("champions"), dict):
        raise ValueError("pass quality state is invalid")
    return value


def _pass_checkpoint_files(document: Any) -> tuple[list[Path], dict[Path, list[str]]]:
    files = [document.path]
    roles: dict[Path, list[str]] = {document.path: ["manifest", "authoring"]}
    for module_id, (module_path, module) in document.modules.items():
        files.append(module_path)
        roles[module_path] = ["module-spec", "authoring"]
        contract = module.get("contract") if isinstance(module.get("contract"), dict) else {}
        declared_implementations = contract.get("implementationFiles", [])
        if isinstance(declared_implementations, list) and declared_implementations:
            for implementation in implementation_contract_paths(document.path, module):
                files.append(implementation)
                roles[implementation] = ["implementation", "authoring"]

        build_path = module_build_receipt_path(document.path, module_id)
        if not build_path.is_file():
            continue
        files.append(build_path)
        roles[build_path] = ["build-receipt", "generated"]
        build = parse_json(build_path.read_text(encoding="utf-8"), "module build receipt")
        if not isinstance(build, dict):
            raise ValueError("module build receipt must be a JSON object")
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


def _pass_implementation_semantic_hashes(document: Any) -> dict[str, str]:
    """Hash every declared runtime source/asset owned by the assembled pass."""

    implementations: list[Path] = []
    for _, module in document.modules.values():
        contract = module.get("contract") if isinstance(module.get("contract"), dict) else {}
        declared = contract.get("implementationFiles", [])
        if isinstance(declared, list) and declared:
            implementations.extend(implementation_contract_paths(document.path, module))
    return implementation_semantic_hashes(list(dict.fromkeys(implementations)))


def _module_quality_state_snapshot(spec_path: Path) -> dict[str, Any]:
    """Capture restorable module acceptance/champions without copying audit attempts."""

    path = module_cache_path(spec_path)
    if not path.is_file():
        return {}
    cache = parse_json(path.read_text(encoding="utf-8"), "module quality state")
    if not isinstance(cache, dict):
        raise ValueError("module quality state must be a JSON object")
    modules = cache.get("modules")
    champions = cache.get("reviewChampions")
    return {
        "modules": copy.deepcopy(modules) if isinstance(modules, dict) else {},
        "reviewChampions": (
            copy.deepcopy(champions) if isinstance(champions, dict) else {}
        ),
    }


def _restore_module_quality_state(
    spec_path: Path,
    snapshot: Any,
) -> dict[str, Any]:
    """Restore champion acceptance pointers while retaining append-only review attempts."""

    if not isinstance(snapshot, dict):
        return {"restored": False, "reason": "champion has no module quality snapshot"}
    modules = snapshot.get("modules")
    champions = snapshot.get("reviewChampions")
    if not isinstance(modules, dict) or not isinstance(champions, dict):
        return {"restored": False, "reason": "module quality snapshot is invalid"}
    path = module_cache_path(spec_path)
    cache: dict[str, Any] = {"version": 2, "modules": {}, "reviewAttempts": {}}
    if path.is_file():
        loaded = parse_json(path.read_text(encoding="utf-8"), "module quality state")
        if not isinstance(loaded, dict):
            raise ValueError("module quality state must be a JSON object")
        cache = loaded
    cache["version"] = 2
    cache["modules"] = copy.deepcopy(modules)
    cache["reviewChampions"] = copy.deepcopy(champions)
    cache.pop("reviewPreflights", None)
    cache["updatedAt"] = datetime.now(timezone.utc).isoformat()
    write_spec_atomic(path, cache)
    return {
        "restored": True,
        "acceptedModuleIds": sorted(modules),
        "championModuleIds": sorted(champions),
    }


def _snapshot_visual_evidence(record: dict[str, Any]) -> dict[str, Any]:
    """Prefer immutable reviewed visuals and fall back only for legacy champions."""

    snapshot = record.get("renderSnapshot")
    if isinstance(snapshot, dict):
        comparison = _existing_local_file(snapshot.get("comparisonImage"))
        comparison_hash = snapshot.get("comparisonSha256")
        views = snapshot.get("views")
        snapshot_views: list[dict[str, Any]] = []
        if (
            comparison is not None
            and isinstance(comparison_hash, str)
            and file_sha256(comparison) == comparison_hash
            and isinstance(views, list)
        ):
            for view in views:
                if not isinstance(view, dict):
                    snapshot_views = []
                    break
                render = _existing_local_file(view.get("renderScreenshot"))
                render_hash = view.get("renderSha256")
                if (
                    render is None
                    or not isinstance(render_hash, str)
                    or file_sha256(render) != render_hash
                ):
                    snapshot_views = []
                    break
                snapshot_views.append(dict(view))
            if snapshot_views:
                return {
                    "views": snapshot_views,
                    "comparisonImage": str(comparison),
                    "comparisonSha256": comparison_hash,
                }
    evidence = record.get("evidence")
    if isinstance(evidence, dict) and not visual_evidence_integrity_failures(evidence):
        return evidence
    return {}


def _capture_pass_candidate(
    document: Any,
    spec_path: Path,
    pass_id: str,
    entry: dict[str, Any],
) -> dict[str, Any]:
    files, roles = _pass_checkpoint_files(document)
    checkpoint = capture_checkpoint(
        spec_path.parent,
        spec_path.parent / ".sculpt-cache" / spec_path.stem / "quality-checkpoints",
        files,
        roles=roles,
        metadata={
            "scope": "assembled-pass-quality-candidate",
            "passId": pass_id,
            "reviewId": entry.get("reviewId"),
            "overallScore": entry.get("aiVisionScore"),
            "layerScores": entry.get("layerScores", {}),
        },
    )
    return {
        "checkpointId": checkpoint.parent.name,
        "checkpointManifest": str(checkpoint),
    }


def split_items(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(";") if item.strip()]


def load_json_argument(value: str | None, label: str, default: Any) -> Any:
    if not value:
        return default
    stripped = value.lstrip()
    if stripped.startswith(("{", "[")):
        text = value
    else:
        candidate = Path(value).expanduser()
        try:
            text = candidate.read_text(encoding="utf-8") if candidate.is_file() else value
        except OSError:
            text = value
    try:
        return parse_json(text, label)
    except ValueError as exc:
        raise ValueError(f"{label} must be valid inline JSON or a JSON file path: {exc}") from exc


def score(value: float | None, label: str, default: float = 0.0) -> float:
    if value is None:
        return default
    if not math.isfinite(float(value)) or not 0 <= float(value) <= 1:
        raise ValueError(f"{label} must be from 0 to 1")
    return float(value)


def is_virtual_path(value: str) -> bool:
    return "://" in value or value.startswith(("data:", "blob:"))


def validate_local_path(value: Any, label: str, allow_missing: bool) -> None:
    if allow_missing or not isinstance(value, str) or not value or is_virtual_path(value):
        return
    if not Path(value).expanduser().exists():
        raise FileNotFoundError(f"{label} does not exist: {value}")


def validate_views(views: list[dict[str, Any]], allow_missing: bool) -> None:
    seen: set[str] = set()
    for index, view in enumerate(views):
        view_id = str(view.get("viewId") or "primary")
        if view_id in seen:
            raise ValueError(f"duplicate evidence viewId {view_id!r}")
        seen.add(view_id)
        view["viewId"] = view_id
        for field in ("referenceImage", "renderScreenshot", "comparisonImage"):
            validate_local_path(view.get(field), f"evidence view {index}.{field}", allow_missing)


def _pass_preflight_path(spec_path: Path, pass_id: str) -> Path:
    safe_pass_id = "".join(
        character if character.isalnum() or character in {"-", "_"} else "-"
        for character in pass_id
    ).strip("-") or "pass"
    return (
        spec_path.parent
        / ".sculpt-cache"
        / spec_path.stem
        / f"pass-preflight-{safe_pass_id}.json"
    )


def _existing_local_file(value: Any, root: Path | None = None) -> Path | None:
    if not isinstance(value, str) or not value.strip() or is_virtual_path(value):
        return None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute() and root is not None:
        candidate = root / candidate
    try:
        resolved = candidate.resolve()
        return resolved if resolved.is_file() else None
    except OSError:
        return None


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
        path = _existing_local_file(value)
        if path is not None:
            snapshot[str(path)] = file_sha256(path)
    return dict(sorted(snapshot.items()))


def _evidence_render_hashes(evidence: dict[str, Any]) -> list[str]:
    return sorted(
        {
            str(view.get("renderSha256"))
            for view in evidence.get("views", [])
            if isinstance(view, dict) and isinstance(view.get("renderSha256"), str)
        }
    )


def _latest_pending_pass_refinement(
    spec: dict[str, Any],
    pass_id: str,
) -> dict[str, Any] | None:
    history = spec.get("reviewHistory", [])
    if not isinstance(history, list):
        return None
    for entry in reversed(history):
        if not isinstance(entry, dict) or entry.get("passId") != pass_id:
            continue
        if is_pending_quality_attempt(entry):
            return entry
        return None
    return None


def _latest_pending_pass_strategy_reset(
    spec: dict[str, Any],
    pass_id: str,
) -> dict[str, Any] | None:
    history = spec.get("reviewHistory", [])
    if not isinstance(history, list):
        return None
    for entry in reversed(history):
        if not isinstance(entry, dict) or entry.get("passId") != pass_id:
            continue
        return entry if entry.get("action") == STRATEGY_RESET_ACTION else None
    return None


def _pass_refinement_progress_failures(
    spec: dict[str, Any],
    pass_id: str,
    verdict: dict[str, Any],
) -> list[str]:
    previous = _latest_pending_pass_refinement(spec, pass_id)
    if previous is None:
        return []
    previous_overall = previous.get("aiVisionScore", previous.get("estimatedFidelity"))
    current_overall = verdict.get("overallScore")
    improved = (
        isinstance(previous_overall, (int, float))
        and not isinstance(previous_overall, bool)
        and isinstance(current_overall, (int, float))
        and not isinstance(current_overall, bool)
        and float(current_overall) >= float(previous_overall) + 0.01
    )
    previous_layers = (
        previous.get("layerScores")
        if isinstance(previous.get("layerScores"), dict)
        else {}
    )
    current_layers = (
        verdict.get("layerScores")
        if isinstance(verdict.get("layerScores"), dict)
        else {}
    )
    if not improved:
        improved = any(
            isinstance(previous_layers.get(layer), (int, float))
            and not isinstance(previous_layers.get(layer), bool)
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
            and float(value) >= float(previous_layers[layer]) + 0.01
            for layer, value in current_layers.items()
        )
    failures: list[str] = []
    if not improved:
        failures.append("refinement did not improve any independently reviewed quality score")
    previous_blockers = {
        issue.get("rootCauseKey")
        for issue in previous.get("reviewIssues", [])
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and issue.get("severity") in {"critical", "major"}
        and isinstance(issue.get("rootCauseKey"), str)
    }
    unresolved = previous_blockers - {
        item
        for item in verdict.get("resolvedRootCauseKeys", [])
        if isinstance(item, str)
    }
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
        and issue.get("rootCauseKey") in set(verdict.get("resolvedRootCauseKeys", []))
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
        and issue.get("severity") in {"critical", "major"}
        and isinstance(issue.get("rootCauseKey"), str)
    }
    new_blockers = current_blockers - previous_blockers
    if new_blockers:
        failures.append(
            "a new blocking root cause cannot be introduced within the same strategy; "
            "record strategy-reset before changing defect identity: "
            + ", ".join(sorted(new_blockers))
        )
    previous_lineages = set(
        item
        for item in previous.get("issueLineageKeys", [])
        if isinstance(item, str)
    ) or _issue_lineage_keys(
        previous.get("reviewIssues", []),
        previous.get("reviewCorrections", []),
    )
    current_lineages = _issue_lineage_keys(
        verdict.get("issues", []),
        verdict.get("corrections", []),
    )
    if previous_lineages & current_lineages:
        failures.append(
            "a blocking defect remains open under the same canonical issue lineage"
        )
    return failures


def _pending_pass_batch_failures(
    spec: dict[str, Any],
    pass_id: str,
    evidence: dict[str, Any],
    implementation_semantic_files: dict[str, str],
) -> list[str]:
    previous = _latest_pending_pass_refinement(spec, pass_id)
    if previous is None:
        strategy_reset = _latest_pending_pass_strategy_reset(spec, pass_id)
        if strategy_reset is None:
            return []
        failures: list[str] = []
        reset_signature = strategy_reset.get("representationSignature")
        if (
            not isinstance(reset_signature, str)
            or reset_signature == sculpt_representation_signature(spec)
        ):
            failures.append(
                "strategy-reset requires a different topology/geometry representation before rendering"
            )
        previous_evidence = strategy_reset.get("evidence")
        if (
            isinstance(previous_evidence, dict)
            and previous_evidence.get("comparisonSha256") == evidence.get("comparisonSha256")
        ):
            failures.append("strategy-reset reused the previous comparison image")
        previous_views = (
            previous_evidence.get("views", [])
            if isinstance(previous_evidence, dict)
            else []
        )
        previous_render_hashes = {
            view.get("renderSha256")
            for view in previous_views
            if isinstance(view, dict)
            and isinstance(view.get("renderSha256"), str)
        }
        current_render_hashes = {
            view.get("renderSha256")
            for view in evidence.get("views", [])
            if isinstance(view, dict) and isinstance(view.get("renderSha256"), str)
        }
        if previous_render_hashes and previous_render_hashes == current_render_hashes:
            failures.append("strategy-reset produced no new render artifact")
        return failures
    failures: list[str] = []
    previous_evidence = previous.get("evidence")
    if isinstance(previous_evidence, dict):
        if previous_evidence.get("comparisonSha256") == evidence.get("comparisonSha256"):
            failures.append("pending quality attempt reused the previous comparison image")
        if _evidence_render_hashes(previous_evidence) == _evidence_render_hashes(evidence):
            failures.append("pending quality attempt produced no new render artifact")
    batch = previous.get("correctionBatch")
    if not isinstance(batch, dict):
        return list(dict.fromkeys(failures))
    scopes = set(
        item for item in batch.get("scopes", []) if isinstance(item, str)
    )
    if "code" in scopes:
        previous_semantic_files = previous.get("implementationSemanticFiles")
        if not isinstance(previous_semantic_files, dict) or not previous_semantic_files:
            failures.append(
                "pending code correction has no semantic implementation baseline; "
                "record a fresh assembled review before consuming a quality attempt"
            )
        elif previous_semantic_files == implementation_semantic_files:
            failures.append(
                "pending correction batch requires an executable code change before rendering"
            )
    if "spec" in scopes and previous.get("specHash") == review_spec_hash(spec, pass_id):
        failures.append(
            "pending correction batch requires a spec change before rendering"
        )
    elif "spec" in scopes and batch.get("version") == 2:
        catalog = review_target_catalog(spec)
        for correction in batch.get("corrections", []):
            if not isinstance(correction, dict) or correction.get("scope") != "spec":
                continue
            resolved, current_value = resolve_correction_parameter(
                catalog,
                correction.get("targetType"),
                correction.get("target"),
                correction.get("parameterPath"),
            )
            if not resolved or current_value != correction.get("expectedValue"):
                failures.append(
                    "pending correction was not applied exactly: "
                    f"{correction.get('targetType')} {correction.get('target')!r} "
                    f"{correction.get('parameterPath')!r} expected "
                    f"{correction.get('expectedValue')!r}, got "
                    f"{current_value!r}"
                )
    return list(dict.fromkeys(failures))


def _pass_preflight_binding(
    spec_path: Path,
    spec: dict[str, Any],
    pass_id: str,
    evidence: dict[str, Any],
    evidence_argument: str | None,
    implementation_semantic_files: dict[str, str],
) -> dict[str, Any]:
    evidence_input = _existing_local_file(evidence_argument)
    source = _existing_local_file(spec.get("sourceImage"), spec_path.parent)
    policy = spec.get("viewHypothesisPolicy")
    policy = policy if isinstance(policy, dict) else {}
    hypothesis_manifest = _existing_local_file(policy.get("manifestPath"), spec_path.parent)
    return {
        "passId": pass_id,
        "reviewSpecHash": review_spec_hash(spec, pass_id),
        "evidenceManifestSha256": evidence.get("manifestSha256"),
        "evidencePayloadSha256": visual_evidence_manifest_sha256(evidence),
        "comparisonSha256": evidence.get("comparisonSha256"),
        "implementationSemanticFiles": implementation_semantic_files,
        "evidenceInputPath": str(evidence_input) if evidence_input is not None else "",
        "evidenceInputSha256": file_sha256(evidence_input) if evidence_input is not None else "",
        "evidenceFiles": _evidence_file_snapshot(evidence),
        "sourceImagePath": str(source) if source is not None else "",
        "sourceImageSha256": file_sha256(source) if source is not None else "",
        "hypothesisManifestPath": (
            str(hypothesis_manifest) if hypothesis_manifest is not None else ""
        ),
        "hypothesisManifestSha256": (
            file_sha256(hypothesis_manifest) if hypothesis_manifest is not None else ""
        ),
    }


def _write_pass_preflight_receipt(
    spec_path: Path,
    spec: dict[str, Any],
    pass_id: str,
    evidence: dict[str, Any],
    evidence_argument: str | None,
    implementation_semantic_files: dict[str, str],
    failures: list[str],
    rollback: dict[str, Any] | None = None,
) -> Path:
    receipt_path = _pass_preflight_path(spec_path, pass_id)
    payload = {
        "artifactType": PASS_PREFLIGHT_ARTIFACT_TYPE,
        "version": PASS_PREFLIGHT_VERSION,
        "ok": not failures,
        "binding": _pass_preflight_binding(
            spec_path,
            spec,
            pass_id,
            evidence,
            evidence_argument,
            implementation_semantic_files,
        ),
        "failures": failures,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    if rollback:
        payload.update(
            {
                "candidateDisposition": "rejected-preflight-regression",
                "championCheckpointId": rollback.get("championCheckpointId"),
                "candidateCheckpointId": rollback.get("candidateCheckpointId"),
                "restoredCheckpoint": rollback.get("restoredCheckpoint", {}),
            }
        )
    write_spec_atomic(
        receipt_path,
        payload,
    )
    return receipt_path


def _record_pass_preflight_regression(
    document: Any,
    spec_path: Path,
    spec: dict[str, Any],
    pass_id: str,
    evidence: dict[str, Any],
    quality_failures: list[str],
    pass_records: list[dict[str, Any]],
) -> dict[str, Any]:
    pending = _latest_pending_pass_refinement(spec, pass_id)
    quality_state = _load_pass_quality_state(spec_path)
    champions = quality_state.get("champions")
    champion = champions.get(pass_id) if isinstance(champions, dict) else None
    if (
        not isinstance(pending, dict)
        or not isinstance(champion, dict)
        or not isinstance(champion.get("checkpointManifest"), str)
        or not quality_failures
        or refinement_budget(pass_records).get("exhausted") is True
    ):
        return {}

    history = spec.get("reviewHistory")
    if not isinstance(history, list):
        raise ValueError("reviewHistory must be an array")
    history_before_restore = copy.deepcopy(history)
    comparison_hash = str(evidence.get("comparisonSha256") or "")
    attempt_number = len(pass_records) + 1
    preflight_id = (
        f"{pass_id}-deterministic-preflight-{attempt_number}-"
        f"{comparison_hash[:12] or 'comparison'}"
    )
    recorded_at = datetime.now(timezone.utc).isoformat()
    candidate_render_snapshot = _snapshot_refinement_renders(
        spec_path,
        f"assembled-{pass_id}",
        preflight_id,
        evidence,
    )
    candidate_checkpoint = _capture_pass_candidate(
        document,
        spec_path,
        pass_id,
        {
            "reviewId": preflight_id,
            "aiVisionScore": None,
            "layerScores": {},
        },
    )
    candidate_record = {
        **candidate_checkpoint,
        "passId": pass_id,
        "reviewId": preflight_id,
        "specHash": review_spec_hash(spec, pass_id),
        "implementationSemanticFiles": _pass_implementation_semantic_hashes(document),
        "overallScore": None,
        "layerScores": {},
        "evidence": evidence,
        "renderSnapshot": candidate_render_snapshot,
        "moduleQualityState": _module_quality_state_snapshot(spec_path),
        "recordedAt": recorded_at,
    }
    restored_checkpoint = restore_checkpoint(
        champion["checkpointManifest"],
        spec_path.parent,
    )
    restored_checkpoint["moduleQualityState"] = _restore_module_quality_state(
        spec_path,
        champion.get("moduleQualityState"),
    )
    restored_document = load_document(spec_path)
    restored_spec = restored_document.resolved
    active_evidence = champion.get("evidence")
    active_evidence = active_evidence if isinstance(active_evidence, dict) else {}
    active_presentation_evidence = _snapshot_visual_evidence(champion)
    active_score = champion.get("overallScore")
    audit_entry: dict[str, Any] = {
        "timestamp": recorded_at,
        "specHash": champion.get("specHash"),
        "passId": pass_id,
        "action": pending.get("action"),
        "summary": (
            "Deterministic visual preflight rejected the refinement and restored "
            "the active champion before another edit cycle."
        ),
        "estimatedFidelity": active_score,
        "matched": pending.get("matched", []),
        "mismatches": quality_failures,
        "specFixes": pending.get("specFixes", []),
        "codeFixes": pending.get("codeFixes", []),
        "rootCause": pending.get("rootCause", ""),
        "correctionPlan": pending.get("correctionPlan", []),
        "artifacts": pending.get("artifacts", {}),
        "representationSignature": sculpt_representation_signature(restored_spec),
        "implementationSemanticFiles": champion.get(
            "implementationSemanticFiles", {}
        ),
        "reviewId": preflight_id,
        "reviewIssues": pending.get("reviewIssues", []),
        "reviewCorrections": pending.get("reviewCorrections", []),
        "issueLineageKeys": pending.get("issueLineageKeys", []),
        "resolvedIssueIds": pending.get("resolvedIssueIds", []),
        "resolvedRootCauseKeys": pending.get("resolvedRootCauseKeys", []),
        "evidence": active_evidence,
        "aiVisionScore": active_score,
        "visualAcceptanceThreshold": pending.get("visualAcceptanceThreshold"),
        "layerScores": champion.get("layerScores", {}),
        "featureReviews": pending.get("featureReviews", []),
        "renderSnapshot": champion.get("renderSnapshot", {}),
        "aiVisionNotes": (
            "The active score remains the independent champion score; the rejected "
            "challenger received no reviewer score."
        ),
        "accepted": False,
        "candidateDisposition": "rejected-preflight-regression",
        "meaningfulImprovement": False,
        "improvedLayers": [],
        "regressedLayers": ["deterministicDiagnostics"],
        "failures": quality_failures,
        "attemptType": "deterministic-preflight",
        "championCheckpointId": champion.get("checkpointId"),
        "championCheckpointManifest": champion.get("checkpointManifest"),
        "candidateCheckpointId": candidate_record.get("checkpointId"),
        "candidateCheckpointManifest": candidate_record.get("checkpointManifest"),
        "candidateSpecHash": candidate_record.get("specHash"),
        "candidateImplementationSemanticFiles": candidate_record.get(
            "implementationSemanticFiles", {}
        ),
        "candidateAiVisionScore": None,
        "candidateLayerScores": {},
        "candidateEvidence": evidence,
        "candidateRenderSnapshot": candidate_record.get("renderSnapshot", {}),
        "candidateRepresentationSignature": sculpt_representation_signature(spec),
        "restoredCheckpoint": restored_checkpoint,
    }
    correction_batch = pending.get("correctionBatch")
    if isinstance(correction_batch, dict):
        audit_entry["correctionBatch"] = correction_batch
    restored_spec["reviewHistory"] = [*history_before_restore, audit_entry]
    sync_pipeline(restored_spec)
    save_document(restored_document, spec_path)
    quality_state["version"] = 1
    quality_state["champions"] = champions
    quality_state["updatedAt"] = recorded_at
    write_spec_atomic(_pass_quality_state_path(spec_path), quality_state)

    final_status = pipeline_status(restored_spec, spec_path)
    presentation: dict[str, Any] = {}
    if active_presentation_evidence:
        presentation = visual_checkpoint_presentation(
            active_presentation_evidence,
            checkpoint=f"assembled-{pass_id}-active-champion",
            artifact_state="restored-champion",
            progress=final_status.get("userProgress", {}),
        )
    return {
        "championCheckpointId": champion.get("checkpointId"),
        "candidateCheckpointId": candidate_record.get("checkpointId"),
        "restoredCheckpoint": restored_checkpoint,
        "activeChampion": presentation,
        "refinementBudget": refinement_budget(
            [*pass_records, audit_entry]
        ),
        "status": final_status,
    }


def _require_pass_preflight_receipt(
    spec_path: Path,
    spec: dict[str, Any],
    pass_id: str,
    evidence: dict[str, Any],
    evidence_argument: str | None,
    implementation_semantic_files: dict[str, str],
) -> Path:
    receipt_path = _pass_preflight_path(spec_path, pass_id)
    if not receipt_path.is_file():
        raise ValueError(
            "modular pass review requires a current passing preflight receipt; "
            "run --preflight-only before spawning the independent reviewer"
        )
    receipt = parse_json(receipt_path.read_text(encoding="utf-8"), "pass preflight receipt")
    if not isinstance(receipt, dict):
        raise ValueError("pass preflight receipt must be a JSON object")
    failures: list[str] = []
    if receipt.get("artifactType") != PASS_PREFLIGHT_ARTIFACT_TYPE:
        failures.append("artifact type is invalid")
    if receipt.get("version") != PASS_PREFLIGHT_VERSION:
        failures.append(f"version must be {PASS_PREFLIGHT_VERSION}")
    if receipt.get("ok") is not True:
        failures.append("latest pass preflight did not pass")
    current_binding = _pass_preflight_binding(
        spec_path,
        spec,
        pass_id,
        evidence,
        evidence_argument,
        implementation_semantic_files,
    )
    recorded_binding = receipt.get("binding")
    if not isinstance(recorded_binding, dict):
        failures.append("binding is missing")
    elif recorded_binding != current_binding:
        changed = sorted(
            key
            for key in set(recorded_binding) | set(current_binding)
            if recorded_binding.get(key) != current_binding.get(key)
        )
        failures.append("bound inputs changed after preflight: " + ", ".join(changed))
    if failures:
        raise ValueError(
            "modular pass review requires a fresh passing preflight: "
            + "; ".join(failures)
        )
    return receipt_path


def _consume_pass_preflight_receipt(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--pass-id", required=True)
    parser.add_argument("--action", choices=sorted(VALID_ACTIONS))
    parser.add_argument("--summary")
    parser.add_argument(
        "--verdict-json",
        type=Path,
        help="Hash-bound verdict written by a fresh independent reviewer context.",
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="Run deterministic evidence vetoes and exit before spawning a reviewer.",
    )
    parser.add_argument("--fidelity", type=float, help="Optional human estimate from 0 to 1")
    parser.add_argument("--matched", help="Semicolon-separated matched criteria")
    parser.add_argument("--mismatches", help="Semicolon-separated mismatches")
    parser.add_argument("--spec-fixes", help="Semicolon-separated spec tasks")
    parser.add_argument("--code-fixes", help="Semicolon-separated code tasks")
    parser.add_argument("--evidence", help="Semicolon-separated extra artifact paths or notes")
    parser.add_argument("--root-cause", choices=sorted(VALID_ROOT_CAUSES))
    parser.add_argument(
        "--correction-plan-json",
        help=(
            "Legacy JSON array/file of quantified corrections with targetType, target, "
            "parameterPath, operation, beforeValue, value, expectedValue, unit, reason, and expectedDelta"
        ),
    )
    parser.add_argument(
        "--impact-assessment-json",
        help=(
            "Required pre-edit impact assessment for a legacy manual correction plan, "
            "including activePhase and structured later-phase downstreamImpact entries."
        ),
    )

    parser.add_argument(
        "--evidence-set-json",
        help="JSON array/file of {viewId,referenceImage,renderScreenshot,comparisonImage} views",
    )
    parser.add_argument("--reference-screenshot", help="Legacy single-view reference path/URL")
    parser.add_argument("--render-screenshot", help="Legacy single-view render path/URL")
    parser.add_argument("--comparison-image", help="Legacy single-view comparison sheet path/URL")
    parser.add_argument("--camera-view", help="Legacy single-view id")
    parser.add_argument("--visual-notes")
    parser.add_argument("--ai-vision-notes")
    parser.add_argument(
        "--reviewer-model",
        help="AI vision model that inspected the exact comparison artifact hash.",
    )
    parser.add_argument("--ai-vision-score", type=float)
    parser.add_argument(
        "--visual-threshold",
        type=float,
        help="Optional stricter threshold; it cannot lower the spec quality bar.",
    )
    parser.add_argument("--layer-scores-json", help="JSON object/file of AI layer scores")
    parser.add_argument(
        "--feature-reviews-json",
        help=(
            "JSON array/file of semantic feature scores; include viewIds for targets "
            "that require dedicated face/hand evidence"
        ),
    )
    parser.add_argument(
        "--blind-scout-json",
        help=(
            "JSON object/file containing the independent blind scout record "
            "(decision approve|reject, observations only; no IDs or scores)."
        ),
    )

    parser.add_argument("--runtime-checks-json", help="JSON object/file of named runtime booleans")
    parser.add_argument("--metrics-json", help="JSON object/file of measured numeric performance values")
    parser.add_argument("--artifacts-json", help="JSON object/file of evidence artifact paths")
    parser.add_argument("--performance-capture", help="Shortcut for artifacts.performanceCapture")
    parser.add_argument(
        "--allow-missing-local-files",
        action="store_true",
        help="Allow planned paths; normally local evidence must already exist.",
    )
    parser.add_argument(
        "--require-screenshot-files",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("--in-place", action="store_true")
    output_group.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    spec_path = args.spec.expanduser().resolve()
    document = load_document(spec_path)
    if document.modular and not module_status(spec_path, document.raw)["assemblyReady"]:
        raise ValueError(
            "final pass review is locked until every required module is accepted; "
            "use `sculpt module review` for a visual module or `module accept` for a structural module"
        )
    spec = document.resolved
    status = pipeline_status(spec, spec_path)
    if status["currentPass"] == "complete":
        raise ValueError("all build passes are already complete")
    if args.pass_id != status["currentPass"]:
        raise ValueError(
            f"only the current pass may be reviewed; current={status['currentPass']!r}, "
            f"requested={args.pass_id!r}"
        )

    evidence_payload = load_json_argument(args.evidence_set_json, "--evidence-set-json", [])
    evidence_manifest = evidence_payload if isinstance(evidence_payload, dict) else None
    views = evidence_payload
    if isinstance(evidence_payload, dict):
        views = evidence_payload.get("views", evidence_payload.get("evidenceSet", []))
    if not isinstance(views, list) or not all(isinstance(item, dict) for item in views):
        raise ValueError("--evidence-set-json must be an array of view objects")
    if not views and any((args.reference_screenshot, args.render_screenshot, args.comparison_image)):
        views = [
            {
                "viewId": args.camera_view or "primary",
                "referenceImage": args.reference_screenshot or spec.get("sourceImage", ""),
                "renderScreenshot": args.render_screenshot or "",
                "comparisonImage": args.comparison_image or "",
                "notes": args.visual_notes or "",
            }
        ]
    validate_views(views, args.allow_missing_local_files)
    kind = evidence_type(spec, args.pass_id)
    config = effective_pass_config(spec, args.pass_id)
    visual_review_required = kind == "visual" or config.get(
        "requiredPostOptimizationVisualReview"
    ) is True
    normalized_evidence = (
        {**evidence_manifest, "views": views, "type": "visual"}
        if evidence_manifest is not None
        else None
    )
    implementation_semantic_files = (
        _pass_implementation_semantic_hashes(document) if document.modular else {}
    )
    if args.preflight_only:
        if not visual_review_required:
            raise ValueError("--preflight-only applies only to visual evidence gates")
        if normalized_evidence is None:
            raise ValueError("--preflight-only requires the manifest object written by sculpt compare")
        pass_failures = pass_specific_gaps(spec, args.pass_id)
        visual_failures = visual_preflight_failures(
            spec,
            normalized_evidence,
            args.pass_id,
            spec_path,
        )
        batch_failures = _pending_pass_batch_failures(
            spec,
            args.pass_id,
            normalized_evidence,
            implementation_semantic_files,
        )
        failures = [*pass_failures, *visual_failures, *batch_failures]
        review_history = spec.get("reviewHistory", [])
        pass_records = (
            [
                entry
                for entry in review_history
                if isinstance(entry, dict) and entry.get("passId") == args.pass_id
            ]
            if isinstance(review_history, list)
            else []
        )
        budget = refinement_budget(pass_records)
        if budget["exhausted"]:
            failures.append(
                "refinement budget is exhausted; retain the champion and record a "
                "strategy-reset before another edit/build/render/reviewer cycle"
            )
        failures = list(dict.fromkeys(failures))
        quality_failures = deterministic_quality_gate_failures(visual_failures)
        rollback: dict[str, Any] = {}
        if (
            not budget["exhausted"]
            and not pass_failures
            and not batch_failures
            and quality_failures
            and set(visual_failures) == set(quality_failures)
        ):
            rollback = _record_pass_preflight_regression(
                document,
                spec_path,
                spec,
                args.pass_id,
                normalized_evidence,
                quality_failures,
                pass_records,
            )
            if rollback:
                budget = rollback["refinementBudget"]
        final_status = rollback.get("status", status)
        receipt_path = _write_pass_preflight_receipt(
            spec_path,
            spec,
            args.pass_id,
            normalized_evidence,
            args.evidence_set_json,
            implementation_semantic_files,
            failures,
            rollback,
        )
        presentation = visual_checkpoint_presentation(
            normalized_evidence,
            checkpoint=f"assembled-{args.pass_id}-preflight",
            artifact_state=(
                "rejected-challenger" if rollback else "candidate"
            ),
            progress=final_status.get("userProgress", {}),
        )
        presentation["preflight"] = {
            "ok": not failures,
            "failures": failures,
        }
        presentation["strategyChangeRequired"] = budget.get("exhausted") is True
        if rollback.get("activeChampion"):
            presentation["activeChampion"] = rollback["activeChampion"]
        if rollback:
            presentation["reviewResult"] = {
                "accepted": False,
                "candidateDisposition": "rejected-preflight-regression",
                "failures": failures,
            }
        print(
            json.dumps(
                {
                    "ok": not failures,
                    "passId": args.pass_id,
                    "comparisonSha256": normalized_evidence.get("comparisonSha256"),
                    "preflightReceipt": str(receipt_path),
                    "refinementBudget": budget,
                    "candidateDisposition": (
                        "rejected-preflight-regression"
                        if rollback
                        else "preflight-failed"
                        if failures
                        else "candidate"
                    ),
                    "restoredCheckpoint": rollback.get("restoredCheckpoint", {}),
                    "strategyChangeRequired": budget.get("exhausted") is True,
                    "failures": failures,
                    "userProgress": final_status.get("userProgress", {}),
                    "userPresentation": presentation,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0 if not failures else 1

    action = args.action
    summary = args.summary
    verdict: dict[str, Any] | None = None
    resolved_verdict_path: Path | None = None
    pass_preflight_receipt: Path | None = None
    if args.verdict_json is not None:
        if not visual_review_required:
            raise ValueError("--verdict-json applies only to a visual evidence gate")
        if normalized_evidence is None:
            raise ValueError("--verdict-json requires the manifest object written by sculpt compare")
        resolved_verdict_path = args.verdict_json.expanduser().resolve()
        verdict_value = load_json_argument(
            str(resolved_verdict_path),
            "--verdict-json",
            {},
        )
        if not isinstance(verdict_value, dict):
            raise ValueError("--verdict-json must contain a JSON object")
        verdict = verdict_value
        governance_action = str(verdict.get("action")) in {
            STRATEGY_RESET_ACTION,
            "request-input",
            "stop",
        }
        if document.modular and not governance_action:
            pass_preflight_receipt = _require_pass_preflight_receipt(
                spec_path,
                spec,
                args.pass_id,
                normalized_evidence,
                args.evidence_set_json,
                implementation_semantic_files,
            )
        contract_evidence = dict(normalized_evidence)
        contract_evidence["declaredViewIds"] = sorted({
            item.get("id")
            for item in spec.get("viewEvidence", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item.get("id")
        })
        verdict_failures = review_contract_failures(
            verdict,
            contract_evidence,
            PASS_REVIEW_ARTIFACT_TYPE,
            PASS_REVIEW_VERSION,
            review_target_catalog(spec),
            (
                effective_pass_config(spec, args.pass_id)
                .get("visualSanity", {})
                .get("requiredCategories", [])
                if isinstance(
                    effective_pass_config(spec, args.pass_id).get("visualSanity"),
                    dict,
                )
                else []
            ),
            require_blind_scout=simplified_visual_gate_enabled(spec, args.pass_id),
            simplified_visual_gate=simplified_visual_gate_enabled(spec, args.pass_id),
            blind_scout_phase=args.pass_id,
        )
        expected_spec_hash = review_spec_hash(spec, args.pass_id)
        if verdict.get("passId") != args.pass_id:
            verdict_failures.append(f"verdict passId must be {args.pass_id!r}")
        if verdict.get("specHash") != expected_spec_hash:
            verdict_failures.append("verdict specHash is stale for the current pass")
        reviewer_context_id = (
            verdict.get("reviewer", {}).get("contextId")
            if isinstance(verdict.get("reviewer"), dict)
            else None
        )
        if reviewer_context_id in recorded_reviewer_context_ids(spec_path, document.raw):
            verdict_failures.append(
                "each assembled phase attempt requires a fresh independent reviewer contextId "
                "across all modules and assembled phases"
            )
        if verdict_failures:
            raise ValueError("invalid independent pass verdict: " + "; ".join(dict.fromkeys(verdict_failures)))
        verdict_action = str(verdict.get("action"))
        verdict_summary = str(verdict.get("summary"))
        if action is not None and action != verdict_action:
            raise ValueError("--action cannot override the independent verdict action")
        if summary is not None and summary.strip() != verdict_summary.strip():
            raise ValueError("--summary cannot override the independent verdict summary")
        action = verdict_action
        summary = verdict_summary
    elif visual_review_required and (views or args.action == "continue"):
        raise ValueError(
            "visual review with artifact evidence or action=continue requires --verdict-json "
            "from a fresh independent reviewer; manual AI fields cannot approve or refine the pass"
        )

    if action not in VALID_ACTIONS:
        raise ValueError("--action is required when no independent verdict supplies it")
    review_history = spec.get("reviewHistory", [])
    pass_records = (
        [
            entry
            for entry in review_history
            if isinstance(entry, dict) and entry.get("passId") == args.pass_id
        ]
        if isinstance(review_history, list)
        else []
    )
    if (action == "continue" or action in REFINEMENT_ACTIONS) and refinement_budget(pass_records)["exhausted"]:
        raise ValueError(
            "atomic refinement budget is exhausted; record one strategy-reset with a "
            "different representation before any further refinement"
        )
    if action == STRATEGY_RESET_ACTION:
        budget = refinement_budget(pass_records)
        if budget.get("remainingStrategyResets", 0) < 1:
            raise ValueError("strategy-reset budget is exhausted")
        active_root_causes: set[str] = set()
        for record in reversed(pass_records):
            if not isinstance(record, dict):
                continue
            if not is_pending_quality_attempt(record):
                break
            active_root_causes.update(
                issue.get("rootCauseKey")
                for issue in record.get("reviewIssues", [])
                if isinstance(issue, dict)
                and issue.get("status") == "open"
                and issue.get("severity") in {"critical", "major"}
                and isinstance(issue.get("rootCauseKey"), str)
            )
        declared_root_causes = set(verdict.get("rootCauseKeys", [])) if verdict else set()
        if not active_root_causes:
            raise ValueError("strategy-reset requires a failed refinement cycle")
        if not declared_root_causes or not declared_root_causes <= active_root_causes:
            raise ValueError(
                "strategy-reset rootCauseKeys must reference blockers from the active failed cycle"
            )
    if action == "refine-batch" and verdict is None:
        raise ValueError("refine-batch requires --verdict-json with per-correction spec/code scope")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("--summary is required when no independent verdict supplies it")
    if action == "continue" and args.allow_missing_local_files:
        raise ValueError("action=continue cannot use --allow-missing-local-files")
    if action == "continue" and visual_review_required:
        if evidence_manifest is None:
            raise ValueError(
                "action=continue requires the manifest object written by sculpt compare; "
                "a path-only evidence array is not trustworthy"
            )
        manifest_failures = visual_evidence_integrity_failures(
            {**evidence_manifest, "views": views, "type": "visual"}
        )
        if manifest_failures:
            raise ValueError("visual evidence integrity failed: " + "; ".join(manifest_failures))
        if verdict is None and args.ai_vision_score is None:
            raise ValueError("--ai-vision-score is required for action=continue")
        if verdict is None and (
            not isinstance(args.reviewer_model, str) or not args.reviewer_model.strip()
        ):
            raise ValueError("--reviewer-model is required for action=continue")
        if verdict is None and (
            not isinstance(args.ai_vision_notes, str) or len(args.ai_vision_notes.strip()) < 12
        ):
            raise ValueError("--ai-vision-notes must explain the visual verdict")

    if verdict is not None and any(
        value is not None
        for value in (
            args.ai_vision_score,
            args.reviewer_model,
            args.ai_vision_notes,
            args.layer_scores_json,
            args.feature_reviews_json,
            args.blind_scout_json,
        )
    ):
        raise ValueError(
            "manual AI score/model/notes/layer/feature fields cannot override --verdict-json"
        )

    layer_scores = (
        verdict.get("layerScores", {})
        if verdict is not None
        else load_json_argument(args.layer_scores_json, "--layer-scores-json", {})
    )
    if not isinstance(layer_scores, dict):
        raise ValueError("--layer-scores-json must be a JSON object")
    for name, value in layer_scores.items():
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"layer score {name!r} must be numeric")
        layer_scores[name] = score(float(value), f"layer score {name!r}")
    feature_reviews = (
        verdict.get("featureReviews", [])
        if verdict is not None
        else load_json_argument(args.feature_reviews_json, "--feature-reviews-json", [])
    )
    if not isinstance(feature_reviews, list) or not all(isinstance(item, dict) for item in feature_reviews):
        raise ValueError("--feature-reviews-json must be an array of objects")
    for index, review in enumerate(feature_reviews):
        if not isinstance(review.get("id"), str) or not review["id"].strip():
            raise ValueError(f"feature review {index}.id is required")
        if "score" in review:
            if not isinstance(review.get("score"), (int, float)) or isinstance(review.get("score"), bool):
                raise ValueError(f"feature review {index}.score must be numeric")
            review["score"] = score(review.get("score"), f"feature review {index}.score")
    blind_scout = (
        verdict.get("blindScout")
        if verdict is not None
        else load_json_argument(args.blind_scout_json, "--blind-scout-json", None)
    )
    if blind_scout is not None and not isinstance(blind_scout, dict):
        raise ValueError("--blind-scout-json must contain a JSON object")
    correction_plan = load_json_argument(
        args.correction_plan_json,
        "--correction-plan-json",
        [],
    )
    if not isinstance(correction_plan, list) or not all(
        isinstance(item, dict) for item in correction_plan
    ):
        raise ValueError("--correction-plan-json must be an array of objects")
    impact_assessment = load_json_argument(
        args.impact_assessment_json,
        "--impact-assessment-json",
        None,
    )
    if impact_assessment is not None and not isinstance(impact_assessment, dict):
        raise ValueError("--impact-assessment-json must be an object")
    for index, correction in enumerate(correction_plan):
        for field in ("targetType", "target", "parameterPath", "operation", "unit", "reason"):
            if not isinstance(correction.get(field), str) or not correction[field].strip():
                raise ValueError(f"correction {index}.{field} is required")
        if correction.get("targetType") not in CORRECTION_TARGET_TYPES:
            raise ValueError(
                f"correction {index}.targetType must be one of: "
                + ", ".join(sorted(CORRECTION_TARGET_TYPES))
            )
        if correction.get("operation") not in CORRECTION_OPERATIONS:
            raise ValueError(
                f"correction {index}.operation must be one of: "
                + ", ".join(sorted(CORRECTION_OPERATIONS))
            )
        for field in ("beforeValue", "value", "expectedValue"):
            if field not in correction:
                raise ValueError(f"correction {index}.{field} is required")
        expected_delta = correction.get("expectedDelta")
        if not isinstance(expected_delta, dict):
            raise ValueError(f"correction {index}.expectedDelta must be an object")
        for field in ("metric", "unit"):
            if not isinstance(expected_delta.get(field), str) or not expected_delta[field].strip():
                raise ValueError(f"correction {index}.expectedDelta.{field} is required")
        for field in ("from", "to", "tolerance"):
            value = expected_delta.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
                raise ValueError(f"correction {index}.expectedDelta.{field} must be finite")
        if not isinstance(expected_delta.get("viewIds"), list) or not expected_delta["viewIds"] or not all(
            isinstance(item, str) and item for item in expected_delta["viewIds"]
        ):
            raise ValueError(f"correction {index}.expectedDelta.viewIds must contain reviewed view ids")
        catalog = review_target_catalog(spec)
        target_type = correction.get("targetType")
        target_id = correction.get("target")
        if target_type not in catalog or target_id not in catalog[target_type]:
            raise ValueError(
                f"correction {index}.target must reference an existing {target_type} id"
            )
        if action == "refine-spec":
            resolved, _ = resolve_correction_parameter(
                catalog,
                target_type,
                target_id,
                correction.get("parameterPath"),
            )
            if not resolved:
                raise ValueError(
                    f"correction {index}.parameterPath must resolve on its target"
                )
        elif action == "refine-code" and not correction["parameterPath"].startswith("implementation."):
            raise ValueError(
                f"correction {index}.parameterPath for code scope must start with 'implementation.'"
            )
    if action in REFINEMENT_ACTIONS and verdict is None:
        impact_failures = impact_assessment_failures(
            {
                "action": action,
                "corrections": correction_plan,
                "impactAssessment": impact_assessment,
            },
            review_target_catalog(spec),
            expected_active_phase=args.pass_id,
        )
        if impact_failures:
            raise ValueError("; ".join(impact_failures))

    runtime_checks = load_json_argument(args.runtime_checks_json, "--runtime-checks-json", {})
    metrics = load_json_argument(args.metrics_json, "--metrics-json", {})
    artifacts = load_json_argument(args.artifacts_json, "--artifacts-json", {})
    if not isinstance(runtime_checks, dict):
        raise ValueError("--runtime-checks-json must be a JSON object")
    if not all(isinstance(value, bool) for value in runtime_checks.values()):
        raise ValueError("--runtime-checks-json values must be boolean")
    if not isinstance(metrics, dict):
        raise ValueError("--metrics-json must be a JSON object")
    if not all(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        for value in metrics.values()
    ):
        raise ValueError("--metrics-json values must be finite numbers")
    if not isinstance(artifacts, dict):
        raise ValueError("--artifacts-json must be a JSON object")
    if args.performance_capture:
        artifacts["performanceCapture"] = args.performance_capture
    for name, value in artifacts.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"artifact {name!r} must be a non-empty path or URL")
        validate_local_path(value, f"artifact {name!r}", args.allow_missing_local_files)

    required_threshold = (
        visual_gate_threshold(spec, args.pass_id)
        if simplified_visual_gate_enabled(spec, args.pass_id)
        else visual_acceptance_threshold(spec)
    )
    if args.visual_threshold is not None and args.visual_threshold < required_threshold:
        raise ValueError(
            f"--visual-threshold cannot lower the spec threshold {required_threshold}"
        )
    threshold = max(
        required_threshold,
        score(args.visual_threshold, "--visual-threshold", required_threshold),
    )
    ai_score = (
        score(verdict.get("overallScore"), "verdict.overallScore")
        if verdict is not None
        else score(args.ai_vision_score, "--ai-vision-score")
        if args.ai_vision_score is not None
        else None
    )
    fidelity = (
        ai_score or 0.0
        if verdict is not None
        else score(args.fidelity, "--fidelity", ai_score or 0.0)
    )
    review_issues = verdict.get("issues", []) if verdict is not None else []
    review_corrections = verdict.get("corrections", []) if verdict is not None else []
    correction_batch = correction_batch_from_verdict(verdict)
    if not correction_batch:
        correction_batch = correction_batch_from_plan(
            action,
            f"{args.pass_id}-{len(spec.get('reviewHistory', [])) + 1}",
            correction_plan,
            impact_assessment,
        )
    verdict_mismatches = [
        str(issue.get("reason"))
        for issue in review_issues
        if isinstance(issue, dict)
        and issue.get("status") == "open"
        and isinstance(issue.get("reason"), str)
    ]
    batch_corrections = (
        correction_batch.get("corrections", []) if correction_batch else []
    )
    batch_spec_fixes = [
        str(correction.get("change"))
        for correction in batch_corrections
        if isinstance(correction, dict) and correction.get("scope") == "spec"
    ]
    batch_code_fixes = [
        str(correction.get("change"))
        for correction in batch_corrections
        if isinstance(correction, dict) and correction.get("scope") == "code"
    ]
    reviewed_at = datetime.now(timezone.utc).isoformat()
    entry: dict[str, Any] = {
        "timestamp": reviewed_at,
        "specHash": review_spec_hash(spec, args.pass_id),
        "passId": args.pass_id,
        "action": action,
        "summary": summary,
        "estimatedFidelity": fidelity,
        "matched": [] if verdict is not None else split_items(args.matched),
        "mismatches": verdict_mismatches if verdict is not None else split_items(args.mismatches),
        "specFixes": (
            batch_spec_fixes
        ) if verdict is not None else split_items(args.spec_fixes),
        "codeFixes": (
            batch_code_fixes
        ) if verdict is not None else split_items(args.code_fixes),
        "rootCause": str(verdict.get("rootCause") or "") if verdict is not None else args.root_cause or "",
        "correctionPlan": [] if verdict is not None else correction_plan,
        "artifacts": artifacts,
        "representationSignature": sculpt_representation_signature(spec),
        "implementationSemanticFiles": implementation_semantic_files,
    }
    if correction_batch:
        entry["correctionBatch"] = correction_batch
    if verdict is not None and resolved_verdict_path is not None:
        entry["reviewId"] = verdict.get("reviewId")
        entry["reviewIssues"] = review_issues
        entry["reviewCorrections"] = review_corrections
        entry["sanityChecks"] = verdict.get("sanityChecks", {})
        entry["issueLineageKeys"] = sorted(
            _issue_lineage_keys(review_issues, review_corrections)
        )
        entry["resolvedIssueIds"] = verdict.get("resolvedIssueIds", [])
        entry["resolvedRootCauseKeys"] = verdict.get("resolvedRootCauseKeys", [])
        entry["strategyId"] = verdict.get("strategyId")
        entry["strategyChange"] = verdict.get("strategyChange")
        entry["rootCauseKeys"] = verdict.get("rootCauseKeys", [])
        entry["falsifyingCheck"] = verdict.get("falsifyingCheck")
        entry["requiredEvidence"] = verdict.get("requiredEvidence", [])
        entry["stopReason"] = verdict.get("stopReason")
        entry["stopEvidence"] = verdict.get("stopEvidence", [])
        entry["reviewVerdict"] = str(resolved_verdict_path)
        entry["reviewVerdictSha256"] = file_sha256(resolved_verdict_path)
        entry["blindScout"] = verdict.get("blindScout")
        entry["blindScoutMapping"] = verdict.get("blindScoutMapping")
    elif blind_scout is not None:
        entry["blindScout"] = blind_scout
    if views:
        if evidence_manifest is not None:
            entry["evidence"] = {
                key: value
                for key, value in evidence_manifest.items()
                if key != "evidenceSet"
            }
            entry["evidence"]["type"] = "visual"
            entry["evidence"]["views"] = views
        else:
            entry["evidence"] = {"type": "visual", "views": views}
        entry["aiVisionScore"] = ai_score
        entry["visualAcceptanceThreshold"] = threshold
        entry["layerScores"] = layer_scores
        entry["featureReviews"] = feature_reviews
        entry["aiVisionNotes"] = summary if verdict is not None else args.ai_vision_notes or ""
        if verdict is not None and resolved_verdict_path is not None:
            reviewer = verdict.get("reviewer", {})
            builder = verdict.get("builder", {})
            entry["reviewerEvidence"] = {
                "type": "ai-vision",
                "model": reviewer.get("model", ""),
                "role": reviewer.get("role", ""),
                "builderContextId": builder.get("contextId", ""),
                "reviewerContextId": reviewer.get("contextId", ""),
                "reviewId": verdict.get("reviewId", ""),
                "reviewedArtifactSha256": entry["evidence"].get("comparisonSha256"),
                "reviewVerdict": str(resolved_verdict_path),
                "reviewVerdictSha256": file_sha256(resolved_verdict_path),
                "reviewedAt": reviewed_at,
            }
        elif args.reviewer_model:
            entry["reviewerEvidence"] = {
                "type": "ai-vision",
                "model": args.reviewer_model.strip(),
                "reviewedArtifactSha256": entry["evidence"].get("comparisonSha256"),
                "reviewedAt": reviewed_at,
            }
    if runtime_checks:
        entry["runtimeChecks"] = runtime_checks
    if metrics:
        entry["metrics"] = metrics
    extra_evidence = split_items(args.evidence)
    if extra_evidence:
        entry["extraEvidence"] = extra_evidence

    output = spec_path if args.in_place else (args.out.expanduser().resolve() if args.out else None)
    # A reviewer `stop` still judged a concrete rendered challenger. Quality
    # comparison and champion rollback must not disappear merely because the
    # recommended next action is terminal; that was the path that let a 0.57
    # challenger remain active after a 0.64 champion.
    scored_candidate = verdict is not None and bool(views) and (
        action == "continue" or action in REFINEMENT_ACTIONS or action == "stop"
    )
    managed_quality = (
        scored_candidate
        and output == spec_path
    )
    quality_state = _load_pass_quality_state(spec_path) if managed_quality else {}
    champions = quality_state.get("champions", {}) if managed_quality else {}
    baseline_champion = champions.get(args.pass_id) if isinstance(champions, dict) else None
    if not isinstance(baseline_champion, dict):
        baseline_champion = None
    diagnostic_scores = diagnostic_quality_vector(entry.get("evidence", {}))
    entry["diagnosticScores"] = diagnostic_scores
    disposition = (
        quality_candidate_disposition(
            baseline_champion,
            {
                "overallScore": entry.get("aiVisionScore"),
                "layerScores": entry.get("layerScores", {}),
                "diagnosticScores": diagnostic_scores,
            },
            owned_layers=config.get("ownedLayers", list(config.get("requiredLayerScores", {}))),
            protected_layers=config.get("preserveLayers", []),
            required_layers=config.get("requiredLayerScores", {}),
            minimum_delta=float(config.get("minimumRefinementDelta", 0.02)),
            maximum_regression=float(config.get("maximumVisualRegression", 0.0)),
            diagnostic_metrics=(
                set()
                if simplified_visual_gate_enabled(spec, args.pass_id)
                else None
            ),
            blind_scout_decision=(
                entry.get("blindScout", {}).get("decision")
                if isinstance(entry.get("blindScout"), dict)
                else None
            ),
        )
        if managed_quality
        else {
            "disposition": "not-managed",
            "meaningfulImprovement": False,
            "improvedLayers": [],
            "regressedLayers": [],
        }
    )
    refinement_findings = (
        _pass_refinement_progress_failures(spec, args.pass_id, verdict)
        if verdict is not None and scored_candidate
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
    preservation_failures = (
        prior_pass_regression_failures(spec, entry, config)
        if managed_quality
        else []
    )
    if preservation_failures:
        disposition = {
            **disposition,
            "disposition": "rejected-regression",
            "meaningfulImprovement": False,
            "regressedLayers": sorted(
                set([*disposition.get("regressedLayers", []), "protected-baseline"])
            ),
        }
    gate_failures: list[str] = [*lineage_failures, *preservation_failures]
    if action == "continue":
        gate_failures.extend(pass_specific_gaps(spec, args.pass_id))
        gate_failures.extend(review_failures(spec, entry, args.pass_id, spec_path))
        if verdict is not None:
            gate_failures.extend(
                failure
                for failure in refinement_findings
                if "did not improve any independently reviewed quality score" not in failure
            )
    if managed_quality and disposition["disposition"] == "rejected-regression":
        gate_failures.append(
            "challenger regressed independently scored layers: "
            + ", ".join(disposition["regressedLayers"])
        )
    if managed_quality and disposition["disposition"] == "rejected-incomplete":
        gate_failures.append(
            "challenger is missing required independent scores: "
            + ", ".join(disposition.get("missingLayers", []))
        )
    gate_failures = list(dict.fromkeys(gate_failures))
    if (
        managed_quality
        and action == "continue"
        and not gate_failures
        and disposition["disposition"] == "rejected-no-improvement"
    ):
        disposition = {**disposition, "disposition": "gate-pass"}
    if action == "continue" and gate_failures and not managed_quality:
        raise ValueError(f"{kind} gate failed: {'; '.join(gate_failures)}")
    entry["accepted"] = action == "continue" and not gate_failures
    entry["candidateDisposition"] = disposition["disposition"]
    entry["meaningfulImprovement"] = disposition.get("meaningfulImprovement", False)
    entry["improvedLayers"] = disposition.get("improvedLayers", [])
    entry["regressedLayers"] = disposition.get("regressedLayers", [])
    entry["failures"] = list(dict.fromkeys(gate_failures))

    history = spec.setdefault("reviewHistory", [])
    if not isinstance(history, list):
        raise ValueError("reviewHistory must be an array")
    history.append(entry)
    # Checkpoints intentionally restore authoring state, not the audit ledger.
    # Keep a detached snapshot so every rejected challenger remains append-only.
    history_with_candidate = copy.deepcopy(history)
    sync_pipeline(spec)

    if output:
        save_document(document, output)
        if managed_quality:
            candidate_render_snapshot = _snapshot_refinement_renders(
                spec_path,
                f"assembled-{args.pass_id}",
                entry.get("reviewId"),
                entry.get("evidence", {}),
            )
            candidate_checkpoint = _capture_pass_candidate(
                document,
                spec_path,
                args.pass_id,
                entry,
            )
            candidate_record = {
                **candidate_checkpoint,
                "passId": args.pass_id,
                "reviewId": entry.get("reviewId"),
                "specHash": entry.get("specHash"),
                "implementationSemanticFiles": entry.get(
                    "implementationSemanticFiles", {}
                ),
                "overallScore": entry.get("aiVisionScore"),
                "layerScores": entry.get("layerScores", {}),
                "diagnosticScores": diagnostic_scores,
                "evidence": entry.get("evidence", {}),
                "renderSnapshot": candidate_render_snapshot,
                "moduleQualityState": _module_quality_state_snapshot(spec_path),
                "recordedAt": reviewed_at,
            }
            entry["candidateRenderSnapshot"] = candidate_render_snapshot
            promoted = (
                action != "stop"
                and disposition["disposition"] in {"seed", "promoted", "gate-pass"}
            )
            if promoted:
                entry["renderSnapshot"] = candidate_render_snapshot
                champions[args.pass_id] = candidate_record
                entry["championCheckpointId"] = candidate_record["checkpointId"]
                entry["championCheckpointManifest"] = candidate_record[
                    "checkpointManifest"
                ]
                # The checkpoint ID is content-addressed and only exists after the
                # first save/capture. Persist its audit link without recapturing a
                # self-referential checkpoint.
                save_document(document, output)
            elif baseline_champion is not None:
                restore_result = restore_checkpoint(
                    baseline_champion["checkpointManifest"],
                    spec_path.parent,
                )
                restore_result["moduleQualityState"] = _restore_module_quality_state(
                    spec_path,
                    baseline_champion.get("moduleQualityState"),
                )
                restored_document = load_document(spec_path)
                restored_spec = restored_document.resolved
                restored_history = restored_spec.get("reviewHistory")
                if not isinstance(restored_history, list):
                    raise ValueError("restored reviewHistory must be an array")
                audit_entry = dict(entry)
                audit_entry.update(
                    {
                        "specHash": baseline_champion.get("specHash"),
                        "implementationSemanticFiles": baseline_champion.get(
                            "implementationSemanticFiles", {}
                        ),
                        "aiVisionScore": baseline_champion.get("overallScore"),
                        "layerScores": baseline_champion.get("layerScores", {}),
                        "diagnosticScores": baseline_champion.get(
                            "diagnosticScores", {}
                        ),
                        "evidence": baseline_champion.get("evidence", {}),
                        "renderSnapshot": baseline_champion.get(
                            "renderSnapshot", {}
                        ),
                        "championCheckpointId": baseline_champion.get("checkpointId"),
                        "candidateCheckpointId": candidate_record.get("checkpointId"),
                        "candidateCheckpointManifest": candidate_record.get("checkpointManifest"),
                        "candidateSpecHash": candidate_record.get("specHash"),
                        "candidateImplementationSemanticFiles": candidate_record.get(
                            "implementationSemanticFiles", {}
                        ),
                        "candidateAiVisionScore": candidate_record.get("overallScore"),
                        "candidateLayerScores": candidate_record.get("layerScores", {}),
                        "candidateDiagnosticScores": candidate_record.get(
                            "diagnosticScores", {}
                        ),
                        "candidateEvidence": candidate_record.get("evidence", {}),
                        "candidateRenderSnapshot": candidate_record.get(
                            "renderSnapshot", {}
                        ),
                        "restoredCheckpoint": restore_result,
                    }
                )
                restored_spec["reviewHistory"] = [
                    *history_with_candidate[:-1],
                    audit_entry,
                ]
                sync_pipeline(restored_spec)
                save_document(restored_document, spec_path)
                document = restored_document
                spec = restored_spec
            quality_state["version"] = 1
            quality_state["champions"] = champions
            quality_state["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_spec_atomic(_pass_quality_state_path(spec_path), quality_state)
        _consume_pass_preflight_receipt(pass_preflight_receipt)

    final_status = pipeline_status(spec, spec_path)
    candidate_disposition = str(disposition["disposition"])
    artifact_state = (
        "accepted-champion"
        if entry.get("accepted") is True
        else "rejected-challenger"
        if candidate_disposition.startswith("rejected-")
        else "candidate-champion"
        if candidate_disposition in {"seed", "promoted", "gate-pass"}
        else "candidate"
    )
    presentation = (
        visual_checkpoint_presentation(
            normalized_evidence,
            checkpoint=f"assembled-{args.pass_id}-review",
            artifact_state=artifact_state,
            progress=final_status.get("userProgress", {}),
        )
        if normalized_evidence is not None
        else {
            "displayRequired": True,
            "displayBeforeNextStep": True,
            "checkpoint": f"assembled-{args.pass_id}-review",
            "visualArtifactsAvailable": False,
            "visualArtifactReason": "This non-visual pass has no comparison artifact.",
            "progress": final_status.get("userProgress", {}),
        }
    )
    presentation["reviewResult"] = {
        "action": action,
        "accepted": entry.get("accepted") is True,
        "candidateDisposition": candidate_disposition,
        "overallScore": entry.get("aiVisionScore"),
        "failures": entry.get("failures", []),
    }
    if candidate_disposition.startswith("rejected-") and isinstance(baseline_champion, dict):
        champion_evidence = _snapshot_visual_evidence(baseline_champion)
        if champion_evidence:
            presentation["activeChampion"] = visual_checkpoint_presentation(
                champion_evidence,
                checkpoint=f"assembled-{args.pass_id}-active-champion",
                artifact_state="restored-champion",
                progress=final_status.get("userProgress", {}),
            )
        else:
            presentation["activeChampionUnavailable"] = (
                "The prior champion evidence is stale or unavailable; do not display it as current."
            )
    result_payload: dict[str, Any] = {
        "ok": True,
        "passId": args.pass_id,
        "action": action,
        "accepted": entry.get("accepted") is True,
        "candidateDisposition": candidate_disposition,
        "userProgress": final_status.get("userProgress", {}),
        "userPresentation": presentation,
    }
    if output:
        result_payload["output"] = str(output)
    else:
        result_payload["spec"] = spec
    print(json.dumps(result_payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
