#!/usr/bin/env python3
"""Validate and apply typed perceptual corrections to a challenger spec."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Mapping

from sculpt_capabilities import OPERATOR_TO_PACK, PACK_BY_ID
from sculpt_contract import (
    CORRECTION_OPERATIONS,
    load_spec_file,
    pipeline_status,
    resolve_correction_parameter,
    review_target_catalog,
    write_spec_atomic,
)


ARTIFACT_TYPE = "threejs-sculpt-perceptual-correction-batch"
TARGET_ROOTS = {
    "component": "componentTree",
    "detail-feature": "componentTree",
    "material": "materials",
    "repetition": "repetitionSystems",
    "feature": "featureReviewTargets",
    "topology-group": "surfaceTopologyPlan",
    "motion-affordance": "interactionContract",
    "global": "viewingContract",
}
OPERATOR_RULES: dict[str, tuple[frozenset[str], tuple[str, ...]]] = {
    "set-bevel-profile": (frozenset({"component"}), ("geometryDescriptor", "dimensions")),
    "repair-attachment": (frozenset({"component"}), ("attachment", "transform")),
    "retune-panel-proportion": (frozenset({"component"}), ("dimensions", "transform.scale", "geometryDescriptor")),
    "retune-hard-surface-material": (
        frozenset({"material"}),
        (
            "baseColor",
            "roughness",
            "metalness",
            "anisotropy",
            "anisotropyRotation",
            "clearcoat",
            "clearcoatRoughness",
            "envMapIntensity",
            "normal",
            "localOverrides",
            "textureProjection",
        ),
    ),
    "adjust-organic-landmark": (frozenset({"component", "detail-feature"}), ("transform", "dimensions", "geometryDescriptor")),
    "repair-gaze": (frozenset({"component"}), ("transform.rotation", "geometryDescriptor.parameters")),
    "retune-skin-response": (frozenset({"material"}), ("baseColor", "roughness", "normal", "localOverrides")),
    "set-fiber-flow": (frozenset({"component", "repetition"}), ("geometryDescriptor", "transform")),
    "retune-fiber-density": (frozenset({"component", "repetition"}), ("geometryDescriptor", "count", "layout")),
    "repair-fiber-root": (frozenset({"component"}), ("attachment", "transform")),
    "edit-fold-field": (frozenset({"component"}), ("geometryDescriptor.parameters", "dimensions")),
    "repair-cloth-anchor": (frozenset({"component"}), ("attachment", "transform")),
    "retune-cloth-response": (frozenset({"material"}), ("roughness", "sheen", "normal", "localOverrides")),
    "retune-transmission": (frozenset({"material"}), ("transmission", "ior", "thickness", "roughness", "attenuation")),
    "repair-wall-thickness": (frozenset({"component", "material"}), ("dimensions", "geometryDescriptor", "thickness")),
    "separate-transparent-layers": (frozenset({"component"}), ("transform", "geometryDescriptor")),
    "repair-branch-junction": (frozenset({"component"}), ("attachment", "geometryDescriptor", "transform")),
    "retune-taper": (frozenset({"component"}), ("dimensions", "geometryDescriptor")),
    "redistribute-foliage": (frozenset({"component", "repetition"}), ("geometryDescriptor", "layout", "count", "transform")),
    "reshape-landform": (frozenset({"component"}), ("geometryDescriptor", "dimensions", "transform")),
    "redistribute-rocks": (frozenset({"component"}), ("geometryDescriptor", "transform")),
    "retune-earth-material": (
        frozenset({"material"}),
        (
            "baseColor",
            "colorVariation",
            "roughness",
            "normal",
            "bump",
            "displacement",
            "ambientOcclusion",
            "textureProjection",
            "localOverrides",
        ),
    ),
    "set-pivot-axis-limits": (frozenset({"component", "motion-affordance"}), ("actionProfile.pivot", "pivot", "axis", "limits", "rate")),
    "repair-motion-clearance": (frozenset({"component", "motion-affordance"}), ("transform", "limits", "clearance")),
    "retune-emission": (frozenset({"material"}), ("emissive", "emissiveIntensity", "baseColor")),
    "retune-volume-density": (frozenset({"component", "material"}), ("geometryDescriptor.parameters", "density", "opacity")),
    "place-decal": (frozenset({"component", "detail-feature", "feature"}), ("transform", "geometryDescriptor", "detailPlan")),
    "retune-marking-contrast": (frozenset({"material", "detail-feature"}), ("baseColor", "localOverrides", "materialRef")),
    "retune-render-quality": (
        frozenset({"global"}),
        (
            "status",
            "backend",
            "antiAliasing.mode",
            "antiAliasing.qualityPreset",
            "antiAliasing.fallbackOrder",
            "maxPixelRatio",
            "fallbackPolicy",
        ),
    ),
}


def _resolve_parent(target: Any, parameter_path: str) -> tuple[Any, str, int | None]:
    segments = parameter_path.split(".")
    current = target
    for segment in segments[:-1]:
        if "[" in segment and segment.endswith("]"):
            key, index_text = segment[:-1].split("[", 1)
            current = current[key][int(index_text)]
        else:
            current = current[segment]
    final = segments[-1]
    if "[" in final and final.endswith("]"):
        key, index_text = final[:-1].split("[", 1)
        return current[key], "", int(index_text)
    return current, final, None


def _combine(before: Any, value: Any, operation: str) -> Any:
    if operation in {"set", "replace"}:
        return copy.deepcopy(value)
    if isinstance(before, (int, float)) and not isinstance(before, bool):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"{operation} requires a numeric value")
        return before * value if operation == "scale" else before + value
    if isinstance(before, list):
        values = value if isinstance(value, list) else [value] * len(before)
        if len(values) != len(before) or not all(
            isinstance(item, (int, float)) and not isinstance(item, bool)
            for item in [*before, *values]
        ):
            raise ValueError(f"{operation} requires matching numeric vectors")
        if operation == "scale":
            return [before[index] * values[index] for index in range(len(before))]
        return [before[index] + values[index] for index in range(len(before))]
    raise ValueError(f"{operation} is unsupported for {type(before).__name__}")


def correction_failures(
    spec: Mapping[str, Any],
    batch: Any,
    *,
    active_phase: str | None = None,
) -> list[str]:
    if not isinstance(batch, Mapping):
        return ["correction batch must be an object"]
    failures: list[str] = []
    artifact_type = batch.get("artifactType")
    version = batch.get("version")
    if artifact_type not in {ARTIFACT_TYPE, "threejs-sculpt-correction-batch"}:
        failures.append(
            f"artifactType must be {ARTIFACT_TYPE} or threejs-sculpt-correction-batch"
        )
    if (artifact_type, version) not in {
        (ARTIFACT_TYPE, 1),
        ("threejs-sculpt-correction-batch", 2),
    }:
        failures.append("correction batch artifactType/version pair is unsupported")
    corrections = batch.get("corrections")
    if not isinstance(corrections, list) or not corrections:
        return [*failures, "corrections must be a non-empty array"]
    if len(corrections) > 3:
        failures.append("one perceptual batch may contain at most three corrections")
    catalog = review_target_catalog(spec)
    from sculpt_capabilities import capability_report, matched_pack_ids

    active_packs = set(capability_report(spec)["activePacks"])
    for index, correction in enumerate(corrections):
        label = f"corrections[{index}]"
        if not isinstance(correction, Mapping):
            failures.append(f"{label} must be an object")
            continue
        pack_id = correction.get("packId")
        operator = correction.get("operatorId")
        if pack_id not in PACK_BY_ID:
            failures.append(f"{label}.packId is unknown")
        if operator not in OPERATOR_TO_PACK:
            failures.append(f"{label}.operatorId is unsupported; record capability-gap")
        elif OPERATOR_TO_PACK[operator] != pack_id:
            failures.append(f"{label}.operatorId is not owned by packId")
        rule = OPERATOR_RULES.get(str(operator))
        target_type = correction.get("targetType")
        parameter_path = correction.get("parameterPath")
        if rule is None:
            failures.append(f"{label}.operatorId has no executable target/path schema")
        else:
            allowed_types, allowed_prefixes = rule
            if target_type not in allowed_types:
                failures.append(f"{label}.targetType is forbidden for operatorId")
            if not isinstance(parameter_path, str) or not any(
                parameter_path == prefix or parameter_path.startswith(prefix + ".")
                or parameter_path.startswith(prefix + "[")
                for prefix in allowed_prefixes
            ):
                failures.append(f"{label}.parameterPath is forbidden for operatorId")
        root = TARGET_ROOTS.get(str(target_type))
        pack = PACK_BY_ID.get(str(pack_id))
        if pack is not None and root not in pack.editable_roots:
            failures.append(f"{label}.targetType is outside pack editableRoots")
        target_id = correction.get("target")
        if target_type == "component":
            component = catalog.get("component", {}).get(target_id)
            routed = matched_pack_ids(component) if isinstance(component, Mapping) else []
            if pack_id not in routed:
                failures.append(f"{label}.packId is not routed to the target component")
        elif pack_id not in active_packs:
            failures.append(f"{label}.packId is not active for this object")
        operation = correction.get("operation")
        if operation not in CORRECTION_OPERATIONS:
            failures.append(f"{label}.operation is unsupported")
        resolved, before = resolve_correction_parameter(
            catalog,
            correction.get("targetType"),
            correction.get("target"),
            correction.get("parameterPath"),
        )
        if not resolved:
            failures.append(f"{label}.parameterPath does not resolve on the exact target")
        elif "beforeValue" in correction and correction.get("beforeValue") != before:
            failures.append(f"{label}.beforeValue does not match the challenger spec")
        for field in ("issueId", "expectedVisualEffect", "falsifyingView"):
            if not isinstance(correction.get(field), str) or not correction[field].strip():
                failures.append(f"{label}.{field} is required")
    from sculpt_module_review import impact_assessment_failures

    failures.extend(
        impact_assessment_failures(
            {
                "action": "refine-spec",
                "corrections": corrections,
                "impactAssessment": batch.get("impactAssessment"),
            },
            catalog,
            expected_active_phase=active_phase,
        )
    )
    return failures


def apply_correction_batch(
    spec: Mapping[str, Any],
    batch: Mapping[str, Any],
    *,
    active_phase: str | None = None,
) -> dict[str, Any]:
    challenger = copy.deepcopy(dict(spec))
    failures = correction_failures(challenger, batch, active_phase=active_phase)
    if failures:
        raise ValueError("; ".join(failures))
    catalog = review_target_catalog(challenger)
    applied: list[dict[str, Any]] = []
    for correction in batch["corrections"]:
        target = catalog[correction["targetType"]][correction["target"]]
        parent, key, index = _resolve_parent(target, correction["parameterPath"])
        before = parent[index] if index is not None else parent[key]
        after = _combine(before, correction.get("value"), correction["operation"])
        if index is not None:
            parent[index] = after
        else:
            parent[key] = after
        applied.append(
            {
                "issueId": correction["issueId"],
                "packId": correction["packId"],
                "operatorId": correction["operatorId"],
                "target": correction["target"],
                "parameterPath": correction["parameterPath"],
                "beforeValue": before,
                "afterValue": copy.deepcopy(after),
            }
        )
    revision = challenger.get("specRevision", 0)
    challenger["specRevision"] = revision + 1 if isinstance(revision, int) else 1
    challenger.setdefault("perceptualCorrectionHistory", []).append(
        {
            "batchId": str(batch.get("batchId") or "perceptual-correction"),
            "challengerOnly": True,
            "applied": applied,
        }
    )
    return challenger


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--batch", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    spec = load_spec_file(args.spec.expanduser().resolve())
    batch = json.loads(args.batch.expanduser().resolve().read_text(encoding="utf-8"))
    active_phase = str(pipeline_status(spec).get("currentPass") or "")
    output = args.out.expanduser().resolve()
    if output == args.spec.expanduser().resolve():
        raise ValueError("--out must be a separate challenger path; champion mutation is forbidden")
    failures = correction_failures(spec, batch, active_phase=active_phase)
    if failures:
        challenger = copy.deepcopy(spec)
        plan = challenger.setdefault("capabilityPlan", {})
        if not isinstance(plan, dict):
            raise ValueError("capabilityPlan must be an object")
        gaps = plan.setdefault("capabilityGaps", [])
        if not isinstance(gaps, list):
            raise ValueError("capabilityPlan.capabilityGaps must be an array")
        gaps.append(
            {
                "id": str(batch.get("batchId") or "unsupported-correction"),
                "status": "unresolved",
                "inViewingContract": True,
                "failures": failures,
            }
        )
        revision = challenger.get("specRevision", 0)
        challenger["specRevision"] = revision + 1 if isinstance(revision, int) else 1
        write_spec_atomic(output, challenger)
        print(
            json.dumps(
                {
                    "ok": False,
                    "output": str(output),
                    "capabilityGapRecorded": True,
                    "failures": failures,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 1
    challenger = apply_correction_batch(spec, batch, active_phase=active_phase)
    write_spec_atomic(output, challenger)
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output),
                "correctionCount": len(batch["corrections"]),
                "challengerOnly": True,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
