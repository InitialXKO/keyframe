#!/usr/bin/env python3
"""Migrate an ObjectSculptSpec explicitly without inventing missing geometry."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

from sculpt_contract import (
    CURRENT_SCHEMA_VERSION,
    parse_schema_version,
    primary_feature_review_policy,
    review_governance_contract,
    sync_pipeline,
    write_spec_atomic,
)
from sculpt_modules import is_module_manifest, read_raw_spec
from new_sculpt_spec import (
    make_detail_decomposition_contract,
    make_detail_plan,
    make_phase_execution_contract,
)
from sculpt_perception import ensure_perceptual_fields
from sculpt_style import make_unassessed_visual_style, sync_visual_style


TARGET_SCHEMA = CURRENT_SCHEMA_VERSION
SUPPORTED_SOURCE_VERSIONS = {(2, 0, 0), (3, 0, 0), (3, 1, 0), (3, 2, 0)}


def add_detail_decomposition_scaffolding(spec: dict[str, Any]) -> int:
    updated = 0
    if not isinstance(spec.get("detailDecompositionContract"), dict):
        spec["detailDecompositionContract"] = make_detail_decomposition_contract()
        updated += 1
    components = spec.get("componentTree")
    if isinstance(components, list):
        for component in components:
            if not isinstance(component, dict):
                continue
            if (
                component.get("componentType") != "assembly"
                and not isinstance(component.get("detailPlan"), dict)
            ):
                component["detailPlan"] = make_detail_plan()
                updated += 1
    return updated


def approval_mode(spec: dict[str, Any]) -> str:
    perceptual = spec.get("perceptualContract")
    mode = perceptual.get("approvalMode") if isinstance(perceptual, dict) else None
    return str(mode) if mode in {"final-only", "phase-by-phase"} else "phase-by-phase"


def add_progressive_execution_contract(spec: dict[str, Any]) -> int:
    existing = spec.get("phaseExecutionContract")
    current = make_phase_execution_contract(approval_mode(spec))
    if isinstance(existing, dict) and existing.get("version") == 4:
        updates = 0
        for field in (
            "visualScout",
            "stableCoreFields",
            "phaseOwnedFields",
            "cycle",
            "humanApproval",
        ):
            if existing.get(field) != current.get(field):
                existing[field] = copy.deepcopy(current[field])
                updates += 1
        return updates
    spec["phaseExecutionContract"] = current
    spec.setdefault("userPhaseApprovals", [])
    return 1


def add_review_governance(spec: dict[str, Any]) -> int:
    expected = review_governance_contract()
    if spec.get("reviewGovernance") == expected:
        return 0
    spec["reviewGovernance"] = expected
    return 1


def enable_primary_feature_review(spec: dict[str, Any]) -> int:
    loop = spec.get("selfCorrectLoop")
    acceptance = loop.get("visualAcceptance") if isinstance(loop, dict) else None
    if not isinstance(acceptance, dict):
        return 0
    policy = acceptance.get("featureReviewPolicy")
    if not isinstance(policy, dict):
        acceptance["featureReviewPolicy"] = primary_feature_review_policy(
            str(spec.get("qualityProfile") or "balanced")
        )
        return 1
    if policy.get("enabled") is True:
        return 0
    policy["enabled"] = True
    return 1


def add_visual_style_scaffolding(spec: dict[str, Any]) -> int:
    assessment = spec.get("preSpecAssessment")
    if not isinstance(assessment, dict):
        return 0
    style = assessment.get("visualStyle")
    if not isinstance(style, dict):
        assessment["visualStyle"] = make_unassessed_visual_style()
        return 1
    if "overallStyleProfile" not in style:
        sync_visual_style(style)
        return 1
    return 0


def migrate_spec(spec: dict[str, Any], target: str = TARGET_SCHEMA) -> tuple[dict[str, Any], dict[str, Any]]:
    if target != TARGET_SCHEMA:
        raise ValueError(f"only migration target {TARGET_SCHEMA!r} is supported")
    source = str(spec.get("schemaVersion") or "2.0")
    source_version = parse_schema_version(source)
    if source_version > parse_schema_version(target):
        raise ValueError(f"cannot migrate newer schema {source!r} down to {target!r}")
    if source_version not in SUPPORTED_SOURCE_VERSIONS:
        raise ValueError(f"unsupported source schemaVersion {source!r}")
    if source == target:
        migrated = copy.deepcopy(spec)
        detail_updates = add_detail_decomposition_scaffolding(migrated)
        execution_updates = add_progressive_execution_contract(migrated)
        governance_updates = add_review_governance(migrated)
        feature_review_updates = enable_primary_feature_review(migrated)
        perceptual_updates = ensure_perceptual_fields(migrated)
        style_updates = add_visual_style_scaffolding(migrated)
        if (
            detail_updates
            or execution_updates
            or governance_updates
            or feature_review_updates
            or perceptual_updates
            or style_updates
        ):
            revision = migrated.get("specRevision", 0)
            migrated["specRevision"] = revision + 1 if isinstance(revision, int) else 1
            sync_pipeline(migrated)
        return migrated, {
            "changed": (
                detail_updates > 0
                or execution_updates > 0
                or governance_updates > 0
                or feature_review_updates > 0
                or perceptual_updates > 0
                or style_updates > 0
            ),
            "fromVersion": source,
            "toVersion": target,
            "componentsUpdated": 0,
            "detailDecompositionUpdates": detail_updates,
            "phaseExecutionContractUpdates": execution_updates,
            "reviewGovernanceUpdates": governance_updates,
            "primaryFeatureReviewUpdates": feature_review_updates,
            "freshReviewRequired": bool(
                execution_updates or governance_updates or feature_review_updates
            ),
            "perceptualContractUpdates": perceptual_updates,
            "visualStyleUpdates": style_updates,
            "reviewHistoryPreserved": True,
        }

    migrated = copy.deepcopy(spec)
    legacy_intent = migrated.pop("intendedUse", None)
    if isinstance(legacy_intent, str) and legacy_intent:
        migrated["legacyIntent"] = {
            "value": legacy_intent,
            "deprecated": True,
            "rule": "Migration hint only; it does not select quality or performance passes.",
        }
    interaction_required = legacy_intent in {"animated", "playable", "destructible"}
    migrated["interactionContract"] = {
        "version": 1,
        "status": "required" if interaction_required else "unassessed",
        "assessmentReason": (
            "Legacy intent required interaction; declare exact motion affordances before form."
            if interaction_required
            else ""
        ),
        "policy": "auto-infer",
        "activationThreshold": 0.8,
        "motionAffordances": [],
        "rules": [
            "Infer motion from observed joints or a strong object-class prior even when the user is silent.",
            "Auto-activate only high-confidence motion; keep lower-confidence motion as a bounded assumption.",
            "Never infer physics, destruction, or speculative hidden mechanisms.",
            "Every active motion must target an exact component id and numeric pivot, axis, and limits or rate.",
        ],
        "legacyIntentHint": legacy_intent or "",
    }
    readiness = migrated.get("actionReadiness")
    if isinstance(readiness, dict):
        readiness["enabled"] = interaction_required
    migrated["performanceAudit"] = {
        "enabled": False,
        "blocking": False,
        "activation": "explicit-user-budget-only",
        "maximumVisualRegression": 0.0,
        "policy": (
            "Run only after lookdev acceptance and restore the visual champion on any regression."
        ),
    }
    loop = migrated.get("selfCorrectLoop")
    if isinstance(loop, dict):
        loop["visualSanity"] = {
            "enabled": True,
            "obviousErrorVeto": True,
            "requiredVerdictField": "sanityChecks",
            "categories": [
                "assemblyCorrectness",
                "proportionBalance",
                "shapeSilhouette",
                "materialPlausibility",
                "surfaceQuality",
                "signatureDetail",
            ],
            "rule": (
                "Critical or major placement, balance, shape, material, surface, or detail defects veto acceptance."
            ),
        }
    for target_entry in migrated.get("featureReviewTargets", []):
        if not isinstance(target_entry, dict) or not isinstance(target_entry.get("passIds"), list):
            continue
        target_entry["passIds"] = [
            item
            for item in target_entry["passIds"]
            if item not in {"structure", "structural-pass", "optimization", "optimization-pass"}
        ]
    updated = 0
    components = migrated.get("componentTree")
    if isinstance(components, list):
        for component in components:
            if not isinstance(component, dict):
                continue
            if "componentType" not in component:
                component["componentType"] = "part"
                updated += 1
            if component.get("componentType") == "part":
                descriptor = component.get("geometryDescriptor")
                if descriptor is None:
                    descriptor = {}
                    component["geometryDescriptor"] = descriptor
                if isinstance(descriptor, dict):
                    descriptor.setdefault("parameters", {})
    detail_updates = add_detail_decomposition_scaffolding(migrated)
    execution_updates = add_progressive_execution_contract(migrated)
    governance_updates = add_review_governance(migrated)
    feature_review_updates = enable_primary_feature_review(migrated)
    perceptual_updates = ensure_perceptual_fields(migrated)
    style_updates = add_visual_style_scaffolding(migrated)

    migrated["schemaVersion"] = target
    revision = migrated.get("specRevision", 0)
    migrated["specRevision"] = revision + 1 if isinstance(revision, int) else 1
    sync_pipeline(migrated)
    return migrated, {
        "changed": True,
        "fromVersion": source,
        "toVersion": target,
        "componentsUpdated": updated,
        "detailDecompositionUpdates": detail_updates,
        "phaseExecutionContractUpdates": execution_updates,
        "reviewGovernanceUpdates": governance_updates,
        "primaryFeatureReviewUpdates": feature_review_updates,
        "freshReviewRequired": bool(
            execution_updates or governance_updates or feature_review_updates
        ),
        "perceptualContractUpdates": perceptual_updates,
        "visualStyleUpdates": style_updates,
        "reviewHistoryPreserved": True,
        "retiredPasses": ["structure", "optimization"],
        "interactionRequiresFreshAssessment": not interaction_required,
        "reviewPolicy": (
            "Review history is retained for audit. Relevant reviews remain stale until the migrated "
            "geometry is validated again; hashes are never rewritten to manufacture a pass."
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--to", default=TARGET_SCHEMA, choices=(TARGET_SCHEMA,))
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument("--in-place", action="store_true")
    destination.add_argument("--out", type=Path)
    parser.add_argument("--report-json", action="store_true")
    args = parser.parse_args(argv)

    source = args.spec.expanduser().resolve()
    raw_spec = read_raw_spec(source)
    if is_module_manifest(raw_spec):
        raise ValueError(
            "the compositional manifest is migrated through its global spec; use `sculpt module resolve` "
            f"to export a schema {CURRENT_SCHEMA_VERSION} compatibility spec"
        )
    migrated, report = migrate_spec(raw_spec, args.to)
    output = source if args.in_place else (args.out.expanduser().resolve() if args.out else None)
    if output is not None:
        write_spec_atomic(output, migrated)
        report["output"] = str(output)
    if args.report_json or output is None:
        print(json.dumps({"report": report, "spec": migrated if output is None else None}, indent=2, ensure_ascii=False))
    else:
        print(output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
