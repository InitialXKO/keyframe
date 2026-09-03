#!/usr/bin/env python3
"""Inspect and gate the current adaptive sculpt pass."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

from sculpt_contract import (
    check_pass as contract_check_pass,
    component_type,
    detail_feature_count,
    is_stateful_complexity_contract,
    load_spec_file,
    pass_order,  # compatibility re-export for existing script consumers
    phase_work_packet,
    pipeline_status,
    sync_pipeline,
    write_spec_atomic,
)
from sculpt_geometry import (
    VALID_PRIMITIVES,
    validate_geometry_component,
    validate_repetition_systems,
)
from sculpt_capabilities import capability_report
from sculpt_perception import perceptual_context
from sculpt_style import validate_visual_style, visual_style_assessment_gaps
from visual_feature_gate import (
    feature_target_is_generic,
    required_feature_targets_for_pass,
)


ATTACHMENT_ROLES = {
    "appendage", "branch", "limb", "arm", "leg", "handle", "connector",
    "tube", "cable", "horn", "wing", "tail", "root", "fork", "rib",
    "support", "hinge", "socket", "pipe",
}
ATTACHMENT_PRIMITIVES = {"cylinder", "cone", "capsule", "tube", "curve-sweep"}
SPECIAL_PRIMITIVE_PROFILES = {
    "fiber-system": "fiber",
    "volume-field": "volume",
}


def has_non_empty(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() not in {"none", "unassessed", "n/a"}
    if isinstance(value, list):
        return any(has_non_empty(item) for item in value)
    if isinstance(value, dict):
        return any(has_non_empty(item) for item in value.values())
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(float(value)) and abs(float(value)) > 0
    return False


def has_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def is_vector3(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(has_number(item) for item in value)


def layer_number(value: Any, keys: tuple[str, ...]) -> float:
    if has_number(value):
        return float(value)
    if isinstance(value, dict):
        for key in keys:
            if has_number(value.get(key)):
                return float(value[key])
    return 0.0


def component_requires_attachment(component: dict[str, Any]) -> bool:
    if component_type(component) == "assembly" or not component.get("parent"):
        return False
    tokens = set(
        re.findall(
            r"[a-z0-9]+",
            " ".join(
                str(component.get(field) or "").lower()
                for field in ("name", "id", "role")
            ),
        )
    )
    primitive = str(component.get("primitive") or "").lower()
    return bool(tokens & ATTACHMENT_ROLES) or primitive in ATTACHMENT_PRIMITIVES


def attachment_complete(component: dict[str, Any]) -> bool:
    attachment = component.get("attachment")
    if not isinstance(attachment, dict):
        return False
    return all(
        (
            is_vector3(attachment.get("localStart")),
            is_vector3(attachment.get("localEnd")),
            has_non_empty(attachment.get("parentSocket") or attachment.get("parentId")),
            has_non_empty(attachment.get("contactType")),
            layer_number(attachment.get("embedDepth"), ("base", "amount", "value")) > 0
            or layer_number(attachment.get("overlap"), ("base", "amount", "value")) > 0,
            has_number(attachment.get("gapTolerance")),
        )
    )


def attachment_gaps(spec: dict[str, Any]) -> list[str]:
    gaps: list[str] = []
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict) or not component_requires_attachment(component):
            continue
        if not attachment_complete(component):
            component_id = str(component.get("id") or component.get("name") or "(unnamed)")
            gaps.append(
                f"component {component_id!r} needs parent socket, endpoints, contact, overlap, and gap tolerance"
            )
    return gaps


def _intentional_uniform_surface(value: dict[str, Any]) -> bool:
    text = " ".join(
        str(value.get(field) or "")
        for field in ("surfaceIntent", "samplingNotes", "shaderNotes", "notes")
    ).lower()
    return any(
        phrase in text
        for phrase in (
            "intentionally smooth",
            "intentional smooth",
            "intentionally uniform",
            "intentional uniform",
            "flat graphic color",
        )
    )


def _hero_material_ids(spec: dict[str, Any], materials: list[dict[str, Any]]) -> set[str]:
    hero_ids: set[str] = set()
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict) or component_type(component) == "assembly":
            continue
        importance = component.get("importance", 1.0)
        if not has_number(importance) or float(importance) < 0.5:
            continue
        material_layers = (
            component.get("materialLayers")
            if isinstance(component.get("materialLayers"), list)
            else []
        )
        for value in [component.get("material"), *material_layers]:
            if isinstance(value, str) and value.strip():
                hero_ids.add(value)
        for feature in component.get("localFeatures", []) if isinstance(component.get("localFeatures"), list) else []:
            if isinstance(feature, dict) and isinstance(feature.get("material"), str):
                hero_ids.add(feature["material"])
    if hero_ids:
        return hero_ids
    return {
        str(item["id"])
        for item in materials
        if isinstance(item.get("id"), str) and item.get("qualityTier") != "utility"
    }


def material_gaps(
    spec: dict[str, Any],
    *,
    require_surface_descriptor: bool = False,
) -> list[str]:
    materials = [item for item in spec.get("materials", []) if isinstance(item, dict)]
    if not materials:
        return ["materials array is empty"]
    materials_by_id = {
        item.get("id"): item
        for item in materials
        if isinstance(item.get("id"), str)
    }
    gaps: list[str] = []
    contract = spec.get("qualityContract")
    minimums = contract.get("minimumSpecDepth") if isinstance(contract, dict) else {}
    minimum_materials = minimums.get("materials") if isinstance(minimums, dict) else None
    if (
        not isinstance(minimum_materials, int)
        or isinstance(minimum_materials, bool)
        or minimum_materials < 0
    ):
        gaps.append(
            "qualityContract.minimumSpecDepth.materials must be a non-negative integer"
        )
    elif len(materials) < minimum_materials:
        gaps.append(
            f"materials is below the selected complexity depth ({len(materials)} < {minimum_materials})"
        )
    hero_ids = _hero_material_ids(spec, materials)
    for material in materials:
        material_id = str(material.get("id") or "(unnamed)")
        if material.get("qualityTier") == "utility" or material_id not in hero_ids:
            continue
        surface_descriptor = material.get("surfaceDescriptor")
        if require_surface_descriptor and (
            not isinstance(surface_descriptor, dict)
            or surface_descriptor.get("status") != "assessed"
        ):
            gaps.append(
                f"hero material {material_id!r} needs an assessed surfaceDescriptor "
                "for rigidity, optical finish, microrelief, evidence, and confidence"
            )
        intentional_uniform = _intentional_uniform_surface(material)
        variation = material.get("colorVariation")
        albedo = material.get("albedo")
        palette_values = (
            variation.get("palette", []) if isinstance(variation, dict) else []
        )
        secondary = albedo.get("secondary", []) if isinstance(albedo, dict) else []
        palette = len([item for item in [*palette_values, *secondary] if has_non_empty(item)]) >= 2
        response = (
            layer_number(material.get("roughness"), ("variation",)) > 0
            or layer_number(material.get("normal"), ("strength", "amplitude")) > 0
            or layer_number(material.get("bump"), ("amplitude", "strength")) > 0
            or layer_number(material.get("displacement"), ("amplitude", "strength")) > 0
        )
        locality = (
            layer_number(material.get("ambientOcclusion"), ("cavityStrength", "strength")) > 0
            or isinstance(material.get("referencePbr"), dict)
        )
        if not palette and not intentional_uniform:
            gaps.append(
                f"hero material {material_id!r} needs a multi-color reference palette or an explicit intentional-uniform rule"
            )
        if not response and not intentional_uniform:
            gaps.append(
                f"hero material {material_id!r} needs executable roughness variation or normal/bump/displacement response"
            )
        if not locality and not intentional_uniform:
            gaps.append(
                f"hero material {material_id!r} needs executable AO/reference-PBR locality or an explicit intentional-smooth rule"
            )

    lookdev = spec.get("lookDevTargets")
    quality_first = isinstance(lookdev, dict) and lookdev.get("qualityPriority") == "reference-fidelity"
    if quality_first and has_non_empty(spec.get("sourceImage")):
        for material in materials:
            if material.get("qualityTier") == "utility":
                continue
            reference = material.get("referencePbr")
            maps = reference.get("maps") if isinstance(reference, dict) else None
            assessments = reference.get("channelAssessments") if isinstance(reference, dict) else None
            required_channels = ["albedo", "roughness", "height", "normal", "ao"]
            if isinstance(assessments, dict):
                required_channels = [
                    channel
                    for channel in required_channels
                    if channel == "albedo" or not (
                        isinstance(assessments.get(channel), dict)
                        and assessments[channel].get("eligible") is False
                    )
                ]
            has_browser_urls = isinstance(maps, dict) and all(
                isinstance(maps.get(channel), dict)
                and has_non_empty(maps[channel].get("url"))
                for channel in required_channels
            )
            if (
                isinstance(assessments, dict)
                and isinstance(assessments.get("albedo"), dict)
                and assessments["albedo"].get("eligible") is False
            ):
                has_browser_urls = False
            texture_set = material.get("textureSet")
            channels = texture_set.get("channels") if isinstance(texture_set, dict) else None
            authored_albedo = (
                isinstance(texture_set, dict)
                and texture_set.get("status") == "ready"
                and texture_set.get("sourceType") in {"imagegen-authored", "external-authored"}
                and isinstance(channels, dict)
                and isinstance(channels.get("albedo"), dict)
                and has_non_empty(channels["albedo"].get("url"))
            )
            if (
                not authored_albedo
                and (
                    not isinstance(reference, dict)
                    or reference.get("usable") is not True
                    or reference.get("materialCropConfirmed") is not True
                    or not has_browser_urls
                )
            ):
                material_id = str(material.get("id") or "(unnamed)")
                gaps.append(
                    f"material {material_id!r} needs confirmed material-crop PBR maps with browser URLs, or use balanced quality"
                )
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict):
            continue
        primitive = component.get("primitive")
        expected = SPECIAL_PRIMITIVE_PROFILES.get(primitive)
        if expected is None:
            continue
        material_id = component.get("material")
        material = materials_by_id.get(material_id)
        if not isinstance(material, dict):
            continue
        actual = material.get("materialProfile", "standard")
        if actual != expected:
            component_id = str(component.get("id") or "(unnamed)")
            gaps.append(
                f"material {material_id!r} used by {primitive} component {component_id!r} "
                f"needs materialProfile {expected!r}"
            )
    return gaps


def surface_gaps(spec: dict[str, Any]) -> list[str]:
    components = [
        item
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and component_type(item) != "assembly"
    ]
    gaps: list[str] = []
    for item in components:
        importance = item.get("importance", 1.0)
        if has_number(importance) and float(importance) < 0.75:
            continue
        detail = item.get("surfaceDetail")
        meaningful = isinstance(detail, dict) and any(
            layer_number(detail.get(field), ("base", "amount", "value")) > 0
            for field in ("macroRoughness", "microRoughness", "bumpAmplitude")
        )
        if meaningful or (isinstance(detail, dict) and _intentional_uniform_surface(detail)):
            continue
        component_id = str(item.get("id") or item.get("name") or "(unnamed)")
        gaps.append(
            f"important component {component_id!r} needs numeric executable surfaceDetail or an explicit intentionally-smooth rule"
        )
    return gaps


def lighting_gaps(spec: dict[str, Any]) -> list[str]:
    lighting = spec.get("lightingFromPhoto", [])
    if not isinstance(lighting, list):
        return ["lightingFromPhoto must describe the review lighting"]
    text = " ".join(str(item).lower() for item in lighting)
    groups = {
        "key light": ("key", "main light", "sun"),
        "fill or environment light": ("fill", "ambient", "environment", "hdr", "hemisphere"),
        "tone/exposure": ("tone", "exposure", "aces", "filmic"),
        "contact shadow": ("contact shadow", "ground shadow", "ambient occlusion", "ao"),
    }
    return [f"lightingFromPhoto is missing {label}" for label, words in groups.items() if not any(word in text for word in words)]


def interaction_gaps(spec: dict[str, Any]) -> list[str]:
    contract = spec.get("interactionContract")
    if not isinstance(contract, dict) or contract.get("status") != "required":
        return ["interactionContract.status must be required for an interaction pass"]
    readiness = spec.get("actionReadiness")
    if not isinstance(readiness, dict) or readiness.get("enabled") is not True:
        return ["actionReadiness.enabled must be true for an interaction pass"]
    affordances = [
        item
        for item in contract.get("motionAffordances", [])
        if isinstance(item, dict) and item.get("enabledByDefault") is True
    ]
    if not affordances:
        return ["interaction requires at least one enabled motion affordance"]
    moving_ids = {
        item.get("componentId")
        for item in affordances
        if isinstance(item.get("componentId"), str)
    }
    components = {
        item.get("id"): item
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and component_type(item) != "assembly"
    }
    missing = [
        str(component_id)
        for component_id in sorted(moving_ids)
        if component_id not in components
        or not isinstance(components[component_id].get("actionProfile"), dict)
    ]
    if missing:
        return ["moving components missing actionProfile: " + ", ".join(missing)]
    return []


def interaction_assessment_gaps(spec: dict[str, Any]) -> list[str]:
    contract = spec.get("interactionContract")
    if not isinstance(contract, dict):
        return ["interactionContract is required for the interaction phase"]
    if contract.get("status") == "unassessed":
        return [
            "assess object-class motion affordances and set interactionContract.status to not-required or required"
        ]
    return []


def view_hypothesis_decision_gaps(spec: dict[str, Any]) -> list[str]:
    """Require 2x2 planning evidence before Blockout, with one narrow skip."""

    if not has_non_empty(spec.get("sourceImage")):
        return []
    policy = spec.get("viewHypothesisPolicy")
    if not isinstance(policy, dict):
        return ["declare the pre-Blockout viewHypothesisPolicy"]
    decision = policy.get("decision")
    enabled = policy.get("enabled") is True
    if decision in {"required", "not-needed"}:
        if decision == "required" and not enabled:
            return ["invoke imagegen and register the one cached 2x2 turnaround before Blockout build"]
        if decision == "not-needed":
            skip_gaps = view_hypothesis_skip_gaps(spec)
            if skip_gaps:
                return skip_gaps
        return []
    # Compatibility: an older policy explicitly enabled by the author is an
    # already-resolved 'required' decision even when it lacks the new field.
    if enabled:
        return []
    return [
        "before the first Blockout build, invoke imagegen and register one 2x2 turnaround; "
        "skip only after proving the object is both simple and symmetric"
    ]


def view_hypothesis_skip_gaps(spec: dict[str, Any]) -> list[str]:
    policy = spec.get("viewHypothesisPolicy")
    assessment = spec.get("preSpecAssessment")
    complexity = assessment.get("complexity") if isinstance(assessment, dict) else None
    tier = complexity.get("tier") if isinstance(complexity, dict) else None
    modifiers = complexity.get("modifiers") if isinstance(complexity, dict) else None
    occlusion_risk = modifiers.get("occlusionRisk") if isinstance(modifiers, dict) else 0
    skip = policy.get("skipAssessment") if isinstance(policy, dict) else None
    gaps: list[str] = []
    if occlusion_risk and isinstance(occlusion_risk, int) and occlusion_risk > 0:
        gaps.append(f"2x2 turnaround may not be skipped when occlusionRisk ({occlusion_risk}) > 0")
    if tier != "simple":
        gaps.append("2x2 turnaround may be skipped only when complexity.tier is simple")
    if not isinstance(skip, dict):
        return [*gaps, "2x2 turnaround skip requires a structured skipAssessment"]
    if skip.get("objectIsSimple") is not True:
        gaps.append("skipAssessment.objectIsSimple must be true")
    if skip.get("symmetry") not in {"bilateral", "radial", "axial"}:
        gaps.append(
            "skipAssessment.symmetry must be bilateral, radial, or axial"
        )
    confidence = skip.get("confidence")
    if not has_number(confidence) or float(confidence) < 0.8:
        gaps.append("skipAssessment.confidence must be at least 0.8")
    evidence = skip.get("evidenceRefs")
    if not isinstance(evidence, list) or not any(
        isinstance(item, str) and item.strip() for item in evidence
    ):
        gaps.append("skipAssessment.evidenceRefs must identify the symmetry evidence")
    reason = skip.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < 12:
        gaps.append("skipAssessment.reason must explain why hidden views are safely inferable")
    return gaps


def pre_spec_gaps(spec: dict[str, Any]) -> list[str]:
    assessment = spec.get("preSpecAssessment")
    if not isinstance(assessment, dict):
        return ["preSpecAssessment is required before blockout"]
    object_class = assessment.get("objectClass")
    gaps: list[str] = []
    if not isinstance(object_class, dict):
        gaps.append("preSpecAssessment.objectClass is required")
    else:
        if not has_non_empty(object_class.get("primaryType")):
            gaps.append("identify the primary object type from the reference")
        required_fields = ["formLanguage", "structureKind"]
        if "representationKind" in object_class:
            required_fields.insert(0, "representationKind")
        for field in required_fields:
            if not has_non_empty(object_class.get(field)):
                gaps.append(f"fill preSpecAssessment.objectClass.{field} from visual inspection")
    complexity = assessment.get("complexity")
    if not isinstance(complexity, dict):
        gaps.append("preSpecAssessment.complexity is required before blockout")
    elif is_stateful_complexity_contract(complexity):
        if complexity.get("status") != "assessed":
            gaps.append("preSpecAssessment.complexity must be assessed before blockout build")
    elif complexity.get("tier") not in {"simple", "moderate", "complex", "ultra"}:
        gaps.append("legacy preSpecAssessment.complexity requires a valid assessed tier")
    visual_style = assessment.get("visualStyle")
    gaps.extend(visual_style_assessment_gaps(visual_style))
    if isinstance(visual_style, dict) and visual_style.get("status") == "assessed":
        evidence_ids = {
            item.get("id")
            for item in spec.get("viewEvidence", [])
            if isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and item["id"].strip()
        }
        style_errors, _ = validate_visual_style(
            visual_style,
            evidence_ids=evidence_ids,
        )
        gaps.extend(f"invalid visual style: {error}" for error in style_errors)
    silhouette = spec.get("silhouette")
    if not isinstance(silhouette, dict) or not has_non_empty(
        [silhouette.get("boundingShape"), silhouette.get("aspectRatios"), silhouette.get("dominantCurves")]
    ):
        gaps.append("record the observed silhouette shape/proportions before blockout")
    return gaps


def quality_contract_view_gaps(spec: dict[str, Any]) -> list[str]:
    contract = spec.get("qualityContract")
    if not isinstance(contract, dict):
        return ["qualityContract is required"]
    required = contract.get("requiredReviewViewIds")
    if not isinstance(required, list) or not required:
        return ["qualityContract.requiredReviewViewIds must be a non-empty array"]
    if not all(isinstance(item, str) and item.strip() for item in required):
        return ["qualityContract.requiredReviewViewIds must contain non-empty strings"]
    if len(set(required)) != len(required):
        return ["qualityContract.requiredReviewViewIds contains duplicates"]
    known = {
        item.get("id")
        for item in spec.get("viewEvidence", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    missing = sorted(set(required) - known)
    return (
        [
            "qualityContract.requiredReviewViewIds references missing viewEvidence: "
            + ", ".join(missing)
        ]
        if missing
        else []
    )


def quality_contract_shape_gaps(spec: dict[str, Any]) -> list[str]:
    contract = spec.get("qualityContract")
    if not isinstance(contract, dict):
        return ["qualityContract is required"]
    gaps: list[str] = []
    allowed_fields = {"minimumSpecDepth", "requiredReviewViewIds"}
    unknown_fields = sorted(set(contract) - allowed_fields)
    if unknown_fields:
        gaps.append(
            "qualityContract has unsupported fields: " + ", ".join(unknown_fields)
        )
    minimums = contract.get("minimumSpecDepth")
    if not isinstance(minimums, dict):
        return [*gaps, "qualityContract.minimumSpecDepth is required"]
    required_fields = (
        "macroComponents",
        "mesoComponents",
        "microFeatureGroups",
        "materials",
        "repetitionSystems",
    )
    unknown_minimums = sorted(set(minimums) - set(required_fields))
    if unknown_minimums:
        gaps.append(
            "qualityContract.minimumSpecDepth has unsupported fields: "
            + ", ".join(unknown_minimums)
        )
    for field in required_fields:
        value = minimums.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            gaps.append(
                f"qualityContract.minimumSpecDepth.{field} must be a non-negative integer"
            )
    return gaps


def feature_contract_gaps(spec: dict[str, Any], pass_id: str) -> list[str]:
    canonical = (
        "form"
        if pass_id in {"structure", "structural-pass", "form-refinement"}
        else "lookdev"
        if pass_id in {"material-pass", "surface-pass", "lighting-pass"}
        else pass_id
    )
    targets = required_feature_targets_for_pass(spec, canonical)
    if not targets:
        return [
            f"featureReviewTargets needs at least one critical or mustPass target for {canonical!r}"
        ]
    gaps: list[str] = []
    for target in targets:
        target_id = str(target.get("id") or "(unnamed)")
        for field in ("passIds", "componentRefs", "evidenceRefs", "criteria"):
            value = target.get(field)
            if not isinstance(value, list) or not any(
                isinstance(item, str) and item.strip() for item in value
            ):
                gaps.append(
                    f"required featureReviewTarget {target_id!r} needs non-empty {field}"
                )
        if feature_target_is_generic(target):
            gaps.append(
                f"replace generic starter featureReviewTarget {target_id!r} with source-specific evidence and criteria"
            )
    return gaps


def spec_depth_gaps(
    spec: dict[str, Any], fields: tuple[str, ...]
) -> list[str]:
    contract = spec.get("qualityContract")
    minimums = contract.get("minimumSpecDepth") if isinstance(contract, dict) else None
    if not isinstance(minimums, dict):
        return ["qualityContract.minimumSpecDepth is required"]
    components = [
        item
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and component_type(item) != "assembly"
    ]
    actual = {
        "macroComponents": sum(item.get("level") == "macro" for item in components),
        "mesoComponents": sum(item.get("level") == "meso" for item in components),
        "microFeatureGroups": detail_feature_count(spec),
        "repetitionSystems": len(
            [item for item in spec.get("repetitionSystems", []) if isinstance(item, dict)]
        ),
    }
    gaps: list[str] = []
    for field in fields:
        required = minimums.get(field)
        if not isinstance(required, int) or isinstance(required, bool) or required < 0:
            gaps.append(
                f"qualityContract.minimumSpecDepth.{field} must be a non-negative integer"
            )
        elif actual[field] < required:
            gaps.append(
                f"{field} is below the selected complexity depth ({actual[field]} < {required})"
            )
    return gaps


def detail_decomposition_gaps(
    spec: dict[str, Any],
    *,
    include_all_components: bool,
) -> list[str]:
    contract = spec.get("detailDecompositionContract")
    if not isinstance(contract, dict) or contract.get("status") != "planned":
        return [
            "detailDecompositionContract must be planned before geometry; inventory visible sub-detail first"
        ]
    gaps: list[str] = []
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict):
            continue
        component_id = str(component.get("id") or "(unnamed)")
        if component_type(component) == "assembly":
            continue
        if not include_all_components and component.get("level", "macro") != "macro":
            continue
        plan = component.get("detailPlan")
        if not isinstance(plan, dict) or plan.get("status") != "planned":
            gaps.append(f"component {component_id!r} detailPlan is not planned")
            continue
        if (
            plan.get("observedComplexity") in {"compound", "complex"}
            and plan.get("decompositionMode") == "atomic"
        ):
            gaps.append(
                f"component {component_id!r} is compound/complex but detailPlan is atomic"
            )
        if not has_non_empty(plan.get("coverageNotes")):
            gaps.append(f"component {component_id!r} detailPlan lacks coverageNotes")
    return gaps


def pass_specific_evidence(pass_id: str) -> list[str]:
    if pass_id in {"structure", "form", "structural-pass", "form-refinement"}:
        return ["child joints have explicit attachment contracts and no visible floating roots"]
    if pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
        return ["palette, material response, local detail, lighting, and contact shadow are reviewable"]
    if pass_id in {"interaction", "interaction-pass"}:
        return ["runtime checks cover load, transforms, and the requested interaction"]
    if pass_id in {"optimization", "optimization-pass"}:
        return ["measured FPS, draw calls, triangles, device, and performance capture"]
    return []


def pass_specific_gaps(spec: dict[str, Any], pass_id: str) -> list[str]:
    gaps = quality_contract_shape_gaps(spec)
    if pass_id == "blockout":
        gaps.extend(pre_spec_gaps(spec))
        gaps.extend(view_hypothesis_decision_gaps(spec))
        gaps.extend(quality_contract_view_gaps(spec))
        gaps.extend(feature_contract_gaps(spec, pass_id))
        gaps.extend(spec_depth_gaps(spec, ("macroComponents",)))
    if pass_id in {"structure", "form", "structural-pass", "form-refinement"}:
        gaps.extend(attachment_gaps(spec))
        gaps.extend(detail_decomposition_gaps(spec, include_all_components=True))
        gaps.extend(quality_contract_view_gaps(spec))
        gaps.extend(feature_contract_gaps(spec, pass_id))
        if pass_id in {"form", "form-refinement"}:
            gaps.extend(view_hypothesis_decision_gaps(spec))
        gaps.extend(
            spec_depth_gaps(
                spec,
                (
                    "macroComponents",
                    "mesoComponents",
                    *(
                        ("microFeatureGroups",)
                        if pass_id in {"form", "form-refinement"}
                        else ()
                    ),
                    "repetitionSystems",
                ),
            )
        )
    if pass_id in {"lookdev", "material-pass", "surface-pass", "lighting-pass"}:
        gaps.extend(quality_contract_view_gaps(spec))
        gaps.extend(feature_contract_gaps(spec, pass_id))
    if pass_id in {"lookdev", "material-pass", "surface-pass"}:
        gaps.extend(material_gaps(spec, require_surface_descriptor=True))
    if pass_id in {"lookdev", "surface-pass"}:
        gaps.extend(surface_gaps(spec))
    if pass_id in {"lookdev", "lighting-pass"}:
        gaps.extend(lighting_gaps(spec))
    if pass_id in {"interaction", "interaction-pass"}:
        gaps.extend(interaction_assessment_gaps(spec))
        gaps.extend(interaction_gaps(spec))
    return list(dict.fromkeys(gaps))


def check_pass(
    spec: dict[str, Any],
    requested_pass: str,
    *,
    _geometry_prevalidated: bool = False,
) -> tuple[bool, str, dict[str, Any]]:
    allowed, message, status = contract_check_pass(spec, requested_pass)
    if not allowed:
        return allowed, message, status
    if not _geometry_prevalidated:
        capability_errors = geometry_capability_report(spec)["errors"]
        if capability_errors:
            return (
                False,
                f"pass {requested_pass!r} has unsupported geometry: {'; '.join(capability_errors)}",
                status,
            )
    gaps = pass_specific_gaps(spec, requested_pass)
    if gaps:
        return False, f"pass {requested_pass!r} needs spec refinement: {'; '.join(gaps)}", status
    return True, message, status


def geometry_capability_report(spec: dict[str, Any]) -> dict[str, Any]:
    """Summarize whether the declared hierarchy has real registered emitters."""
    components = [item for item in spec.get("componentTree", []) if isinstance(item, dict)]
    component_lookup = {
        str(item["id"]): item
        for item in components
        if isinstance(item.get("id"), str) and item["id"].strip()
    }
    repetition_systems = spec.get("repetitionSystems", [])
    errors = validate_repetition_systems(repetition_systems)
    for component in components:
        errors.extend(
            validate_geometry_component(
                component,
                repetition_systems,
                component_lookup,
            )
        )
    errors = list(dict.fromkeys(errors))
    return {
        "canGenerate": not errors,
        "parts": sum(component_type(item) == "part" for item in components),
        "assemblies": sum(component_type(item) == "assembly" for item in components),
        "repetitionSystems": len(repetition_systems) if isinstance(repetition_systems, list) else 0,
        "supportedPrimitives": sorted(VALID_PRIMITIVES),
        "errors": errors,
    }


def status_payload(spec: dict[str, Any]) -> dict[str, Any]:
    status = pipeline_status(spec)
    capabilities = geometry_capability_report(spec)
    current_gaps = (
        []
        if status["currentPass"] == "complete"
        else pass_specific_gaps(spec, str(status["currentPass"]))
    )
    current_gaps.extend(f"geometry: {error}" for error in capabilities["errors"])
    return {
        "targetName": spec.get("targetName"),
        **status,
        "geometryCapabilities": capabilities,
        "currentPassGaps": list(dict.fromkeys(current_gaps)),
    }


def context_payload(spec: dict[str, Any]) -> dict[str, Any]:
    """Emit one phase-local LLM packet instead of the full future-phase spec."""

    status = pipeline_status(spec)
    current = str(status.get("currentPass") or "complete")
    packet = {} if current == "complete" else phase_work_packet(spec, current)
    capability = capability_report(spec, None if current == "complete" else current)
    return {
        "targetName": spec.get("targetName"),
        "currentPass": current,
        "state": status.get("state"),
        "userProgress": status.get("userProgress", {}),
        "perceptualCore": perceptual_context(spec),
        "capabilities": capability,
        "activeBlockerPolicy": {
            "maximum": 3,
            "selection": "highest-salience-visible-blockers-inside-viewing-contract",
            "unsupportedIssueResult": "capability-gap",
            "numericScores": "trend-only",
        },
        "workPacket": packet,
        "readRule": (
            "Use workPacket.contextProjection for this cycle. Read future-phase fields only after "
            "the current phase is promoted or a named validation failure proves they are required."
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "sync", "context"):
        child = subparsers.add_parser(command)
        child.add_argument("spec", type=Path)
    check = subparsers.add_parser("check")
    check.add_argument("spec", type=Path)
    check.add_argument("--pass-id", required=True)
    args = parser.parse_args(argv)
    path = args.spec.expanduser().resolve()
    try:
        from sculpt_modules import (
            is_module_manifest,
            load_document,
            module_status,
            read_raw_spec,
            save_document,
        )

        raw_spec = read_raw_spec(path)
        if is_module_manifest(raw_spec):
            modular_status = module_status(path, raw_spec)
            if args.command in {"status", "sync", "context"}:
                if modular_status["assemblyReady"]:
                    document = load_document(path, allow_missing=False)
                    if args.command == "sync":
                        sync_pipeline(document.resolved)
                        save_document(document)
                    modular_status["passWorkflow"] = (
                        context_payload(document.resolved)
                        if args.command == "context"
                        else status_payload(document.resolved)
                    )
                print(json.dumps(modular_status, indent=2, ensure_ascii=False))
                return 0 if not modular_status["errors"] else 1
            if not modular_status["assemblyReady"]:
                print(
                    json.dumps(
                        {
                            "allowed": False,
                            "message": (
                                "pass workflow is locked until every required module is accepted; "
                                f"current module is {modular_status.get('currentModule')!r}"
                            ),
                            **modular_status,
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                return 1
        spec = load_spec_file(path)
        if args.command == "status":
            print(json.dumps(status_payload(spec), indent=2, ensure_ascii=False))
            return 0
        if args.command == "context":
            print(json.dumps(context_payload(spec), indent=2, ensure_ascii=False))
            return 0
        if args.command == "sync":
            sync_pipeline(spec)
            write_spec_atomic(path, spec)
            print(json.dumps(status_payload(spec), indent=2, ensure_ascii=False))
            return 0
        allowed, message, status = check_pass(spec, args.pass_id)
        print(json.dumps({"allowed": allowed, "message": message, **status}, indent=2, ensure_ascii=False))
        return 0 if allowed else 1
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
