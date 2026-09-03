#!/usr/bin/env python3
"""Validate an ObjectSculptSpec JSON file for procedural Three.js generation."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

from visual_feature_gate import feature_review_policy, feature_targets_are_generic
from sculpt_contract import (
    BLIND_SCOUT_ARTIFACT_VERSION,
    COMPONENT_TYPES,
    CURRENT_SCHEMA_VERSION,
    MAX_BLIND_SCOUT_OBSERVATIONS,
    SIMPLIFIED_AI_OVERALL_FLOOR,
    CORE_COMPLEXITY_AXES,
    MODIFIER_COMPLEXITY_AXES,
    TIER_RANKS,
    derive_complexity_tier,
    complexity_minimums,
    is_stateful_complexity_contract,
    adaptive_hypothesis_views,
    human_approval_contract,
    blind_scout_execution_contract,
    blind_scout_phase_rubrics,
    component_type,
    detail_feature_count,
    load_spec_file,
    parse_schema_version,
    pass_order as canonical_pass_order,
    pipeline_status,
    review_failures,
    review_governance_contract,
    schema_version_at_least,
    phase_execution_version,
)
from sculpt_pass_orchestrator import (
    material_gaps,
    pass_specific_gaps,
    surface_gaps,
    view_hypothesis_skip_gaps,
)
from sculpt_geometry import (
    VALID_PRIMITIVES,  # compatibility re-export for existing script consumers
    validate_geometry_component,
    validate_repetition_systems,
    validate_surface_topology_plan,
)
from sculpt_specialized_regions import validate_specialized_regions
from sculpt_capabilities import validate_capability_plan
from sculpt_perception import validate_perceptual_contract
from sculpt_style import validate_visual_style


REQUIRED_TOP_LEVEL = {
    "targetName": str,
    "suitability": str,
    "coordinateFrame": dict,
    "silhouette": dict,
    "componentTree": list,
    "materials": list,
    "proceduralStrategy": list,
}
VALID_SUITABILITY = {"pass", "conditional", "reject"}
VALID_COMPONENT_LEVELS = {"macro", "meso", "micro"}
VALID_COMPLEXITY_TIERS = {"unassessed", "simple", "moderate", "complex", "ultra", "ultra-complex"}
TERMINOLOGY_LIST_FIELDS = {"geometryTerms", "materialTerms", "lightingTerms"}
VALID_REVIEW_ACTIONS = {
    "continue",
    "refine-spec",
    "refine-code",
    "refine-batch",
    "request-input",
    "stop",
}
VALID_REVIEW_ROOT_CAUSES = {
    "",
    "camera-framing",
    "spec",
    "geometry",
    "material",
    "lighting",
    "evidence",
    "performance",
    "mixed",
}
VALID_CORRECTION_ACTIONS = {"set", "scale", "translate", "rotate", "replace", "inspect"}
VALID_REPETITION_ATTACHMENT_RELATIONS = {"contact", "overlap", "gap", "free"}
VALID_DETAIL_CONTRACT_STATUSES = {"unassessed", "planned"}
VALID_DETAIL_COMPLEXITIES = {"unassessed", "simple", "compound", "complex"}
VALID_DETAIL_DECOMPOSITION_MODES = {
    "unassessed",
    "atomic",
    "children",
    "features",
    "hybrid",
}
VALID_DETAIL_SCALE_BANDS = {"macro", "meso", "micro"}
VALID_DETAIL_FEATURE_CLASSES = {
    "structural-part",
    "surface-relief",
    "recess",
    "cutout",
    "seam",
    "fastener",
    "repetition",
    "material-detail",
    "decal",
}
VALID_DETAIL_GEOMETRY_EFFECTS = {"silhouette", "surface", "cutout", "none"}
VALID_DETAIL_REALIZATION_MODES = {
    "component",
    "local-feature",
    "topology-group",
    "repetition-system",
    "material",
    "geometry-feature",
    "geometry-parameter",
}
DETAIL_PARAMETER_PATH_PATTERN = re.compile(
    r"^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$"
)
COMPONENT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
COMPONENT_PLACEHOLDER_TOKENS = frozenset(
    {"placeholder", "temp", "temporary", "todo", "unnamed", "unknown", "generic", "default", "sample", "test", "foo", "bar", "baz"}
)
COMPONENT_GENERIC_TOKENS = frozenset(
    {"part", "mesh", "object", "component", "geometry", "shape", "item", "thing", "body", "model", "asset", "node", "group", "assembly", "piece", "element", "primitive"}
)
COMPONENT_QUALIFIER_TOKENS = frozenset(
    {"main", "primary", "secondary", "left", "right", "front", "rear", "upper", "lower", "inner", "outer", "top", "bottom", "center", "central", "a", "b", "c"}
)
ATTACHMENT_ROLES = {
    "appendage",
    "branch",
    "limb",
    "arm",
    "leg",
    "handle",
    "connector",
    "tube",
    "cable",
    "horn",
    "wing",
    "tail",
    "root",
    "fork",
    "rib",
    "support",
    "hinge",
    "socket",
    "pipe",
}
ATTACHMENT_PRIMITIVES = {"cylinder", "cone", "capsule", "tube", "curve-sweep"}
PASS_WARNING_KEYWORDS = {
    "blockout": (
        "preSpecAssessment",
        "silhouette",
        "qualityContract",
        "featureReviewTargets",
        "reviewView",
        "assumption",
        "risk",
    ),
    "structure": (
        "visualStyle",
        "component",
        "attachment",
        "hierarchy",
        "qualityContract",
        "featureReviewTargets",
        "reviewView",
        "detail",
        "meso",
    ),
    "form": (
        "visualStyle",
        "component",
        "attachment",
        "hierarchy",
        "qualityContract",
        "featureReviewTargets",
        "reviewView",
        "detail",
        "surfaceDetail",
        "micro",
    ),
    "lookdev": (
        "visualStyle",
        "material",
        "lookDev",
        "lighting",
        "surface",
        "PBR",
        "texture",
        "qualityContract",
        "featureReviewTargets",
        "reviewView",
    ),
    "interaction": ("visualStyle", "action", "pivot", "socket", "collider"),
    "optimization": ("performance", "FPS", "draw", "triangle"),
}
PASS_ALIASES = {
    "structural-pass": "structure",
    "form-refinement": "form",
    "material-pass": "lookdev",
    "surface-pass": "lookdev",
    "lighting-pass": "lookdev",
    "interaction-pass": "interaction",
    "optimization-pass": "optimization",
}

SUPPORTED_SCHEMA_VERSIONS = {(2, 0, 0), (3, 0, 0), (3, 1, 0), (3, 2, 0)}
VALID_MATERIAL_PROFILES = frozenset(
    {"standard", "cloth", "fiber", "glass", "liquid", "volume"}
)
PROFILE_UNIT_INTERVAL_FIELDS = (
    "sheen",
    "sheenRoughness",
    "anisotropy",
    "transmission",
    "opacity",
)
PROFILE_NONNEGATIVE_FIELDS = ("thickness", "dispersion", "emissiveIntensity")
PROFILE_HEX_COLOR_FIELDS = ("sheenColor", "attenuationColor", "emissive")
PROFILE_BOOLEAN_FIELDS = ("alphaHash", "depthWrite", "forceSinglePass")
SPECIAL_PRIMITIVE_PROFILES = {
    "fiber-system": "fiber",
    "volume-field": "volume",
}
HEX_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$")
EXECUTABLE_LOCAL_MATERIAL_TYPES = frozenset(
    {
        "dirt",
        "dust",
        "wear",
        "stain",
        "moss",
        "patina",
        "rust",
        "oxide",
        "wetness",
        "soot",
        "scorch",
        "fade",
        "scratch",
        "chip",
    }
)
LOCAL_MATERIAL_METADATA_TYPES = frozenset({"material-map-evidence"})
VALID_LOCAL_MATERIAL_MASK_PATTERNS = frozenset(
    {"noise", "cavity", "edge", "vertical", "speckle", "streak"}
)
SURFACE_DESCRIPTOR_RIGIDITY = frozenset(
    {"rigid", "semi-rigid", "flexible", "soft"}
)
SURFACE_DESCRIPTOR_FINISH = frozenset(
    {"mirror", "glossy", "satin", "matte"}
)
SURFACE_DESCRIPTOR_RELIEF = frozenset(
    {"smooth", "grain", "pebbled", "wrinkled", "fibrous", "pitted", "brushed", "custom"}
)
SURFACE_DESCRIPTOR_CHANNELS = frozenset(
    {"none", "normal", "bump", "displacement"}
)
SURFACE_DESCRIPTOR_BASIS = frozenset({"observed", "inferred"})
LOOKDEV_SURFACE_PASSES = frozenset({"lookdev", "material-pass", "surface-pass"})
EXECUTABLE_SHADING_TREATMENTS = frozenset(
    {
        "physically-based",
        "physically-plausible-stylized",
        "smooth-lit",
        "flat-lit",
        "unlit",
        "toon-ramp",
        "cel-banded",
        "emissive-dominant",
    }
)
TEXTURE_SOURCE_TYPES = frozenset(
    {"procedural", "reference-extracted", "imagegen-authored", "external-authored"}
)
TEXTURE_CHANNELS = frozenset(
    {"albedo", "roughness", "metalness", "height", "normal", "ao"}
)


def schema_at_least(spec: dict[str, Any], minimum: str) -> bool:
    """Use numeric schema comparison while keeping malformed specs reportable."""
    try:
        return schema_version_at_least(spec, minimum)
    except ValueError:
        return False


def validate_shading_execution(
    spec: dict[str, Any], errors: list[str], warnings: list[str], for_pass: str | None
) -> None:
    assessment = spec.get("preSpecAssessment")
    style = assessment.get("visualStyle") if isinstance(assessment, dict) else None
    axes = style.get("axes") if isinstance(style, dict) and style.get("status") == "assessed" else None
    shading = axes.get("shadingTreatment") if isinstance(axes, dict) else None
    primary = shading.get("primary") if isinstance(shading, dict) else None
    if not isinstance(primary, str) or primary in EXECUTABLE_SHADING_TREATMENTS:
        return
    message = f"visualStyle shadingTreatment {primary!r} has no executable Three.js material route"
    if PASS_ALIASES.get(for_pass, for_pass) == "lookdev":
        errors.append(message)
    else:
        warnings.append("quality: " + message)


def warning_applies_to_pass(warning: str, pass_id: str | None) -> bool:
    if pass_id is None or not warning.startswith("quality:"):
        return True
    selected = PASS_ALIASES.get(pass_id, pass_id)
    if selected == "blockout" and any(
        token in warning
        for token in (
            "materialFamilies",
            "motionPotential",
            "specializedRegions",
            "surfaceTopologyPlan",
            "detailDecompositionContract",
            "detailPlan",
            "interactionContract",
        )
    ):
        return False
    keywords = PASS_WARNING_KEYWORDS.get(selected)
    return keywords is None or any(keyword.lower() in warning.lower() for keyword in keywords)


def is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def validate_unit_interval(value: Any, label: str, errors: list[str]) -> None:
    if not is_number(value) or value < 0 or value > 1:
        errors.append(f"{label} must be a number from 0 to 1")


def load_spec(path: Path) -> dict[str, Any]:
    return load_spec_file(path)


def as_number_list(value: Any, length: int) -> bool:
    return (
        isinstance(value, list)
        and len(value) == length
        and all(is_number(item) for item in value)
    )


def validate_score_block(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    scores = spec.get("scores")
    if scores is None:
        warnings.append("missing scores block; image validation evidence will be weaker")
        return
    if not isinstance(scores, dict):
        errors.append("scores must be an object")
        return
    for key, value in scores.items():
        if not isinstance(value, int) or value < 0 or value > 3:
            errors.append(
                f"score {key!r} must be an ordinal integer from 0 to 3; "
                "decimal 0-to-1 quality values belong only in review overallScore/layerScores"
            )


def validate_nonnegative_int(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        errors.append(f"{label} must be a non-negative integer")


def validate_pre_spec_assessment(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    assessment = spec.get("preSpecAssessment")
    if assessment is None:
        warnings.append("quality: missing preSpecAssessment; spec may be shallow because complexity was not assessed first")
        return
    if not isinstance(assessment, dict):
        errors.append("preSpecAssessment must be an object")
        return
    object_class = assessment.get("objectClass")
    if not isinstance(object_class, dict):
        errors.append("preSpecAssessment.objectClass must be an object")
    else:
        primary_type = object_class.get("primaryType")
        if primary_type is not None and not isinstance(primary_type, str):
            errors.append("preSpecAssessment.objectClass.primaryType must be a string")
        if primary_type in {None, "", "unassessed"}:
            warnings.append("quality: preSpecAssessment.objectClass.primaryType is unassessed")
        for field in (
            "representationKind",
            "formLanguage",
            "structureKind",
            "motionPotential",
            "materialFamilies",
        ):
            value = object_class.get(field)
            validate_string_array(value, f"preSpecAssessment.objectClass.{field}", errors)
            if (
                isinstance(value, list)
                and all(isinstance(item, str) for item in value)
                and any(not item.strip() for item in value)
            ):
                errors.append(
                    f"preSpecAssessment.objectClass.{field} must contain non-empty descriptors"
                )
            if isinstance(value, list) and not value:
                warnings.append(f"quality: preSpecAssessment.objectClass.{field} is empty")
        notes = object_class.get("notes")
        if notes is not None and not isinstance(notes, str):
            errors.append("preSpecAssessment.objectClass.notes must be a string")
    visual_style = assessment.get("visualStyle")
    evidence_ids = {
        item.get("id")
        for item in spec.get("viewEvidence", [])
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].strip()
    }
    style_errors, style_warnings = validate_visual_style(
        visual_style,
        evidence_ids=evidence_ids,
    )
    errors.extend(style_errors)
    warnings.extend(style_warnings)
    complexity = assessment.get("complexity")
    if not isinstance(complexity, dict):
        errors.append("preSpecAssessment.complexity must be an object")
    else:
        status = complexity.get("status")
        scores = complexity.get("scores")
        modifiers = complexity.get("modifiers")
        tier = complexity.get("tier")

        is_stateful = is_stateful_complexity_contract(complexity)

        if is_stateful:
            if status not in {"unassessed", "assessed"}:
                errors.append("preSpecAssessment.complexity.status must be 'unassessed' or 'assessed'")
            if complexity.get("initialTierHint") not in TIER_RANKS:
                errors.append(
                    "preSpecAssessment.complexity.initialTierHint must be simple, moderate, complex, or ultra"
                )

            if not isinstance(scores, dict):
                errors.append("preSpecAssessment.complexity.scores must be an object")
            else:
                score_keys = set(scores.keys())
                expected_core = set(CORE_COMPLEXITY_AXES)
                if score_keys != expected_core:
                    missing = expected_core - score_keys
                    extra = score_keys - expected_core
                    if missing:
                        errors.append(f"preSpecAssessment.complexity.scores missing core axes: {', '.join(sorted(missing))}")
                    if extra:
                        errors.append(f"preSpecAssessment.complexity.scores has unexpected axes: {', '.join(sorted(extra))}")
                for key, value in scores.items():
                    if value is not None and (
                        not isinstance(value, int)
                        or isinstance(value, bool)
                        or value < 0
                        or value > 3
                    ):
                        errors.append(
                            f"preSpecAssessment.complexity.scores.{key} must be null or an integer from 0 to 3"
                        )

            if not isinstance(modifiers, dict):
                errors.append("preSpecAssessment.complexity.modifiers must be an object")
            else:
                mod_keys = set(modifiers.keys())
                expected_mod = set(MODIFIER_COMPLEXITY_AXES)
                if mod_keys != expected_mod:
                    missing = expected_mod - mod_keys
                    extra = mod_keys - expected_mod
                    if missing:
                        errors.append(f"preSpecAssessment.complexity.modifiers missing modifier axes: {', '.join(sorted(missing))}")
                    if extra:
                        errors.append(f"preSpecAssessment.complexity.modifiers has unexpected axes: {', '.join(sorted(extra))}")
                for key, value in modifiers.items():
                    if value is not None and (
                        not isinstance(value, int)
                        or isinstance(value, bool)
                        or value < 0
                        or value > 3
                    ):
                        errors.append(
                            f"preSpecAssessment.complexity.modifiers.{key} must be null or an integer from 0 to 3"
                        )

            evidence_refs = complexity.get("evidenceRefs")
            if not isinstance(evidence_refs, list) or any(
                not isinstance(ref, str) or not ref.strip()
                for ref in evidence_refs
            ):
                errors.append(
                    "preSpecAssessment.complexity.evidenceRefs must be an array of non-empty strings"
                )
            reasoning = complexity.get("reasoning")
            if not isinstance(reasoning, list) or any(
                not isinstance(reason, str) or not reason.strip()
                for reason in reasoning
            ):
                errors.append(
                    "preSpecAssessment.complexity.reasoning must be an array of non-empty strings"
                )

            if status == "unassessed":
                if tier != "unassessed":
                    errors.append("preSpecAssessment.complexity.tier must be 'unassessed' when status is 'unassessed'")
                warnings.append("quality: preSpecAssessment.complexity is unassessed")
            elif status == "assessed":
                if tier not in {"simple", "moderate", "complex", "ultra"}:
                    errors.append("preSpecAssessment.complexity.tier must be a valid tier (simple, moderate, complex, ultra) when assessed")

                if isinstance(scores, dict):
                    for k, v in scores.items():
                        if v is None:
                            errors.append(f"preSpecAssessment.complexity.scores.{k} cannot be null when status is 'assessed'")

                if isinstance(modifiers, dict):
                    for k, v in modifiers.items():
                        if v is None:
                            errors.append(f"preSpecAssessment.complexity.modifiers.{k} cannot be null when status is 'assessed'")

                if not isinstance(evidence_refs, list) or not any(isinstance(r, str) and r.strip() for r in evidence_refs):
                    errors.append("preSpecAssessment.complexity.evidenceRefs must be a non-empty list of string references when assessed")

                if not isinstance(reasoning, list) or not any(isinstance(r, str) and r.strip() and "initial estimate" not in r for r in reasoning):
                    errors.append("preSpecAssessment.complexity.reasoning must contain explicit specific observations when assessed")

                derivation = derive_complexity_tier(complexity)
                derived_tier = derivation.get("baseTier")
                if tier != derived_tier:
                    errors.append(f"preSpecAssessment.complexity.tier {tier!r} does not match derived tier {derived_tier!r}")

                derived_req_depth = derivation.get("requiredDepth")
                decision = assessment.get("specDepthDecision")
                if isinstance(decision, dict):
                    req = decision.get("requiredDepth")
                    if req in TIER_RANKS and derived_req_depth in TIER_RANKS:
                        if TIER_RANKS[req] < TIER_RANKS[derived_req_depth]:
                            errors.append(f"preSpecAssessment.specDepthDecision.requiredDepth {req!r} is lower than derived minimum required depth {derived_req_depth!r}")

                quality_contract = spec.get("qualityContract")
                if isinstance(quality_contract, dict) and derived_req_depth in TIER_RANKS:
                    min_depth = quality_contract.get("minimumSpecDepth")
                    if isinstance(min_depth, dict):
                        mins = complexity_minimums(derived_req_depth)
                        for field, key in (
                            ("macroComponents", "macroLayers"),
                            ("mesoComponents", "mesoLayers"),
                            ("microFeatureGroups", "microLayers"),
                            ("materials", "materials"),
                        ):
                            val = min_depth.get(field)
                            if isinstance(val, int) and val < mins[key]:
                                errors.append(f"qualityContract.minimumSpecDepth.{field} ({val}) is lower than derived minimum floor ({mins[key]}) for depth {derived_req_depth!r}")
                        repetition_floor = (
                            1
                            if derived_req_depth in {"complex", "ultra"}
                            or (
                                isinstance(decision, dict)
                                and decision.get("needsRepetitionSystems") is True
                            )
                            else 0
                        )
                        repetitions = min_depth.get("repetitionSystems")
                        if isinstance(repetitions, int) and repetitions < repetition_floor:
                            errors.append(
                                "qualityContract.minimumSpecDepth.repetitionSystems "
                                f"({repetitions}) is lower than derived minimum floor "
                                f"({repetition_floor})"
                            )

                if isinstance(modifiers, dict) and modifiers.get("occlusionRisk") == 3:
                    if spec.get("suitability") == "pass":
                        errors.append("suitability cannot be 'pass' when occlusionRisk is 3")

        else:
            warnings.append(
                "quality: preSpecAssessment.complexity uses the legacy flat shape; "
                "update to the current stateful contract when practical"
            )
            if tier not in VALID_COMPLEXITY_TIERS:
                errors.append(f"preSpecAssessment.complexity.tier must be one of: {', '.join(sorted(VALID_COMPLEXITY_TIERS))}")
            if tier == "unassessed":
                warnings.append("quality: preSpecAssessment.complexity.tier is unassessed")
            scores = complexity.get("scores")
            if not isinstance(scores, dict):
                errors.append("preSpecAssessment.complexity.scores must be an object")
            else:
                for key, value in scores.items():
                    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 3:
                        errors.append(
                            f"preSpecAssessment.complexity.scores.{key} must be an ordinal integer from 0 to 3"
                        )

        estimated = complexity.get("estimatedCounts")
        if not isinstance(estimated, dict):
            errors.append("preSpecAssessment.complexity.estimatedCounts must be an object")
        else:
            for field in ("macroComponents", "mesoComponents", "microFeatureGroups", "materialLayers", "repetitionSystems"):
                if field in estimated:
                    validate_nonnegative_int(estimated[field], f"preSpecAssessment.complexity.estimatedCounts.{field}", errors)
    decision = assessment.get("specDepthDecision")
    if not isinstance(decision, dict):
        errors.append("preSpecAssessment.specDepthDecision must be an object")
    else:
        required_depth = decision.get("requiredDepth")
        if required_depth not in VALID_COMPLEXITY_TIERS:
            errors.append("preSpecAssessment.specDepthDecision.requiredDepth must be a valid complexity tier")
        if required_depth == "unassessed":
            warnings.append("quality: preSpecAssessment.specDepthDecision.requiredDepth is unassessed")
        validate_string_array(decision.get("minimumComponentLevels"), "preSpecAssessment.specDepthDecision.minimumComponentLevels", errors)
        for field in (
            "needsRepetitionSystems",
            "needsMaterialLocalOverrides",
            "needsMultipleReviewViews",
            "needsActionReadyHierarchy",
        ):
            if field in decision and not isinstance(decision[field], bool):
                errors.append(f"preSpecAssessment.specDepthDecision.{field} must be boolean")
    unknowns = assessment.get("unknownsToResolveBeforeImplementation")
    validate_string_array(unknowns, "preSpecAssessment.unknownsToResolveBeforeImplementation", errors)
    if isinstance(unknowns, list) and unknowns:
        warnings.append(
            "quality: preSpecAssessment has unresolved unknowns; before implementation, "
            "resolve each item or convert it into a bounded assumptions[] record or a known risks[] record"
        )


def validate_terminology_profile(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    profile = spec.get("terminologyProfile")
    if profile is None:
        warnings.append("missing terminologyProfile; descriptions may drift into vague non-3D language")
        return
    if not isinstance(profile, dict):
        errors.append("terminologyProfile must be an object")
        return
    for field in TERMINOLOGY_LIST_FIELDS:
        value = profile.get(field)
        if value is None:
            warnings.append(f"terminologyProfile.{field} is missing")
            continue
        if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
            errors.append(f"terminologyProfile.{field} must be an array of non-empty strings")
    rule = profile.get("descriptionRule")
    if rule is not None and not isinstance(rule, str):
        errors.append("terminologyProfile.descriptionRule must be a string")


def validate_evidence(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> set[str]:
    refs: set[str] = set()
    evidence = spec.get("viewEvidence", [])
    if evidence is None:
        return refs
    if not isinstance(evidence, list):
        errors.append("viewEvidence must be an array when present")
        return refs
    for index, item in enumerate(evidence):
        if not isinstance(item, dict):
            errors.append(f"viewEvidence[{index}] must be an object")
            continue
        evidence_id = item.get("id")
        if not isinstance(evidence_id, str) or not evidence_id.strip():
            errors.append(f"viewEvidence[{index}].id is required")
            continue
        if evidence_id in refs:
            errors.append(f"duplicate viewEvidence id {evidence_id!r}")
        refs.add(evidence_id)
        confidence = item.get("confidence")
        if confidence is not None:
            validate_unit_interval(confidence, f"viewEvidence {evidence_id!r} confidence", errors)
        region = item.get("imageRegion")
        if region is not None:
            if not isinstance(region, dict):
                errors.append(f"viewEvidence {evidence_id!r} imageRegion must be an object")
            else:
                for key in ("x", "y", "width", "height"):
                    if key in region and not is_number(region[key]):
                        errors.append(f"viewEvidence {evidence_id!r} imageRegion.{key} must be numeric")
    if not refs:
        warnings.append("missing viewEvidence; local visual claims cannot be traced back to image regions")
    return refs


def validate_reference_preparation_v2(
    spec: dict[str, Any],
    preparation: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    source_image = spec.get("sourceImage")
    has_source = has_non_empty_detail(source_image)
    required_types = {
        "version": int,
        "subjectBackgroundSeparation": str,
        "preparationTrigger": str,
        "requiredSkill": str,
        "method": str,
        "imagegenMode": str,
        "outputImage": str,
        "outputBackground": str,
        "whiteBackgroundValidated": bool,
        "subjectContrastValidated": bool,
        "modificationPolicy": dict,
        "comparisonPolicy": dict,
        "usageRule": str,
    }
    for field, expected_type in required_types.items():
        value = preparation.get(field)
        if not isinstance(value, expected_type) or (
            expected_type is int and isinstance(value, bool)
        ):
            errors.append(f"referencePreparation.{field} must be {expected_type.__name__}")

    background = preparation.get("subjectBackgroundSeparation")
    if background not in {"not-applicable", "unassessed", "mixed", "clear", "absent"}:
        errors.append(
            "referencePreparation.subjectBackgroundSeparation must be not-applicable, "
            "unassessed, mixed, clear, or absent"
        )
        return
    if preparation.get("requiredSkill") != "imagegen":
        errors.append("referencePreparation.requiredSkill must be 'imagegen'")
    if preparation.get("outputImage") != (source_image or ""):
        errors.append("referencePreparation.outputImage must equal spec.sourceImage")

    comparison = preparation.get("comparisonPolicy")
    if comparison != {"reconstructionTarget": "sourceImage"}:
        errors.append(
            "referencePreparation.comparisonPolicy must use sourceImage as its sole "
            "reconstruction and acceptance target"
        )

    if not has_source:
        if (
            background != "not-applicable"
            or preparation.get("preparationTrigger") != "not-applicable"
            or preparation.get("method") != "not-required"
        ):
            errors.append(
                "referencePreparation must be not-applicable/not-required without sourceImage"
            )
        return

    if background == "unassessed":
        warnings.append(
            "quality: reference preparation is unassessed; classify both subject/background "
            "separation and whether source complexity/quality blocks practical reconstruction"
        )
        return
    if background == "not-applicable":
        errors.append(
            "referencePreparation.subjectBackgroundSeparation cannot be not-applicable when sourceImage is present"
        )
        return

    method = preparation.get("method")
    if method == "not-required":
        if background not in {"clear", "absent"}:
            errors.append(
                "a mixed subject/background reference must use an ImageGen prepared reference"
            )
        if preparation.get("preparationTrigger") != "not-required":
            errors.append(
                "referencePreparation.preparationTrigger must be 'not-required' when ImageGen is skipped"
            )
        if preparation.get("imagegenMode") != "not-applicable":
            errors.append(
                "referencePreparation.imagegenMode must be 'not-applicable' when ImageGen is skipped"
            )
        if preparation.get("outputBackground") != "original":
            errors.append(
                "referencePreparation.outputBackground must be 'original' when ImageGen is skipped"
            )
        policy = preparation.get("modificationPolicy")
        if isinstance(policy, dict) and policy.get("mode") != "none":
            errors.append(
                "referencePreparation.modificationPolicy.mode must be 'none' when ImageGen is skipped"
            )
        return

    if method != "imagegen-prepared-reference":
        errors.append(
            "referencePreparation.method must be 'not-required', 'unassessed', or "
            "'imagegen-prepared-reference'"
        )
        return
    trigger = preparation.get("preparationTrigger")
    valid_triggers = {
        "background-mixing",
        "excessive-complexity",
        "low-source-quality",
        "real-object-photo",
        "combined",
    }
    if trigger not in valid_triggers:
        errors.append(
            "referencePreparation.preparationTrigger must identify background-mixing, "
            "excessive-complexity, low-source-quality, real-object-photo, or combined"
        )
    mode = preparation.get("imagegenMode")
    if mode not in {
        "white-background-cleanup",
        "white-background-simplification",
    }:
        errors.append(
            "referencePreparation.imagegenMode must use a solid-white ImageGen preparation mode"
        )
    if trigger in {"excessive-complexity", "real-object-photo"} and mode != (
        "white-background-simplification"
    ):
        errors.append(
            f"referencePreparation trigger {trigger!r} requires "
            "white-background-simplification"
        )
    if preparation.get("outputBackground") != "solid-white":
        errors.append("referencePreparation.outputBackground must be 'solid-white'")
    for field in (
        "whiteBackgroundValidated",
        "subjectContrastValidated",
    ):
        if preparation.get(field) is not True:
            errors.append(
                f"referencePreparation.{field} must be true before using the ImageGen output"
            )

    policy = preparation.get("modificationPolicy")
    if not isinstance(policy, dict):
        return
    for field in ("allowedChanges", "protectedTraits", "declaredChanges"):
        validate_string_array(
            policy.get(field),
            f"referencePreparation.modificationPolicy.{field}",
            errors,
        )
    if not policy.get("protectedTraits"):
        errors.append(
            "referencePreparation.modificationPolicy.protectedTraits must preserve identity and macro form"
        )
    if mode == "white-background-simplification":
        if policy.get("mode") != "bounded-simplification":
            errors.append(
                "referencePreparation.modificationPolicy.mode must be 'bounded-simplification'"
            )
        if not policy.get("declaredChanges"):
            errors.append(
                "referencePreparation.modificationPolicy.declaredChanges must name every intentional simplification"
            )
    elif policy.get("mode") != "cleanup-only":
        errors.append("referencePreparation.modificationPolicy.mode must be 'cleanup-only'")


def validate_reference_preparation(
    spec: dict[str, Any], errors: list[str], warnings: list[str]
) -> None:
    source_image = spec.get("sourceImage")
    has_source = has_non_empty_detail(source_image)
    preparation = spec.get("referencePreparation")
    if not isinstance(preparation, dict):
        if has_source:
            warnings.append(
                "quality: sourceImage needs referencePreparation before implementation; "
                "classify whether the subject is clearly separated from its background"
            )
        return

    if preparation.get("version") == 2:
        validate_reference_preparation_v2(spec, preparation, errors, warnings)
        return

    required_types = {
        "version": int,
        "originalImage": str,
        "subjectBackgroundSeparation": str,
        "requiredSkill": str,
        "method": str,
        "imagegenMode": str,
        "outputImage": str,
        "backgroundRemoved": bool,
        "alphaValidated": bool,
        "subjectPreservationValidated": bool,
        "usageRule": str,
    }
    legacy_background = preparation.get("originalBackground")
    for field, expected_type in required_types.items():
        value = (
            preparation.get(field)
            if field != "subjectBackgroundSeparation" or field in preparation
            else legacy_background
        )
        if not isinstance(value, expected_type) or (
            expected_type is int and isinstance(value, bool)
        ):
            errors.append(
                f"referencePreparation.{field} must be {expected_type.__name__}"
            )

    background = preparation.get("subjectBackgroundSeparation", legacy_background)
    if background not in {
        "not-applicable",
        "unassessed",
        "mixed",
        "clear",
        "present",
        "absent",
    }:
        errors.append(
            "referencePreparation.subjectBackgroundSeparation must be not-applicable, "
            "unassessed, mixed, clear, present, or absent"
        )
        return
    if preparation.get("requiredSkill") != "imagegen":
        errors.append("referencePreparation.requiredSkill must be 'imagegen'")
    if preparation.get("outputImage") != (source_image or ""):
        errors.append("referencePreparation.outputImage must equal spec.sourceImage")

    if not has_source:
        if background != "not-applicable" or preparation.get("method") != "not-required":
            errors.append(
                "referencePreparation must be not-applicable/not-required without sourceImage"
            )
        return

    original = preparation.get("originalImage")
    if not isinstance(original, str) or not original.strip():
        errors.append("referencePreparation.originalImage is required when sourceImage is present")
    if background == "unassessed":
        warnings.append(
            "quality: reference subject/background separation is unassessed; classify it "
            "before any geometry, material, view generation, or review work"
        )
        return
    if background == "not-applicable":
        errors.append(
            "referencePreparation.subjectBackgroundSeparation cannot be not-applicable when sourceImage is present"
        )
        return
    if background in {"clear", "absent"}:
        if preparation.get("method") != "not-required":
            errors.append(
                "referencePreparation.method must be 'not-required' when the subject boundary is clear"
            )
        if original != source_image:
            errors.append(
                "sourceImage must equal referencePreparation.originalImage when no extraction is needed"
            )
        return

    if preparation.get("method") != "imagegen-background-extraction":
        errors.append(
            "a reference whose subject mixes with the background must use method "
            "'imagegen-background-extraction'"
        )
    if preparation.get("imagegenMode") not in {
        "built-in-chroma-key",
        "cli-native-transparency",
    }:
        errors.append(
            "referencePreparation.imagegenMode must record an approved ImageGen background-extraction path"
        )
    if original == source_image:
        errors.append(
            "sourceImage must be the background-free ImageGen output, not the original image"
        )
    for field in (
        "backgroundRemoved",
        "alphaValidated",
        "subjectPreservationValidated",
    ):
        if preparation.get(field) is not True:
            errors.append(
                f"referencePreparation.{field} must be true before using the cutout as sourceImage"
            )


def validate_view_hypothesis_policy(
    spec: dict[str, Any], errors: list[str], warnings: list[str]
) -> None:
    policy = spec.get("viewHypothesisPolicy")
    if policy is None:
        if has_non_empty_detail(spec.get("sourceImage")):
            warnings.append(
                "quality: source image has no viewHypothesisPolicy; front-only geometry cannot be vetoed reliably"
            )
        return
    if not isinstance(policy, dict):
        errors.append("viewHypothesisPolicy must be an object")
        return
    if not isinstance(policy.get("enabled"), bool):
        errors.append("viewHypothesisPolicy.enabled must be boolean")
    elif not has_non_empty_detail(spec.get("sourceImage")) and policy.get("enabled") is True:
        errors.append("viewHypothesisPolicy cannot be enabled without sourceImage")
    activation_mode = policy.get("activationMode")
    if activation_mode not in {
        None,
        "conditional-form-only",
        "default-form-unless-simple-symmetric",
        "pre-blockout-unless-simple-symmetric",
    }:
        errors.append(
            "viewHypothesisPolicy.activationMode must be "
            "'pre-blockout-unless-simple-symmetric' when present"
        )
    activation_phase = policy.get("activationPhase")
    if activation_phase not in {None, "blockout", "form"}:
        errors.append("viewHypothesisPolicy.activationPhase must be 'blockout' when present")
    decision = policy.get("decision")
    if decision not in {None, "pending", "required", "not-needed", "not-applicable"}:
        errors.append(
            "viewHypothesisPolicy.decision must be pending, required, not-needed, or not-applicable"
        )
    if decision == "required" and policy.get("enabled") is not True:
        errors.append("viewHypothesisPolicy.decision 'required' needs enabled=true")
    if decision in {"not-needed", "not-applicable"} and policy.get("enabled") is not False:
        errors.append(f"viewHypothesisPolicy.decision {decision!r} needs enabled=false")
    if policy.get("enabled") is True and decision in {"not-needed", "not-applicable"}:
        errors.append("enabled view hypotheses cannot be marked not-needed or not-applicable")
    if decision in {"required", "not-needed"}:
        reason = policy.get("decisionReason")
        if not isinstance(reason, str) or len(reason.strip()) < 8:
            errors.append(
                "viewHypothesisPolicy.decisionReason must explain the resolved turnaround decision"
            )
    if activation_mode in {
        "default-form-unless-simple-symmetric",
        "pre-blockout-unless-simple-symmetric",
    }:
        if policy.get("defaultDecision") != "required":
            errors.append("viewHypothesisPolicy.defaultDecision must be 'required'")
        if policy.get("skipEligibility") != "simple-and-symmetric-only":
            errors.append(
                "viewHypothesisPolicy.skipEligibility must be 'simple-and-symmetric-only'"
            )
        skip = policy.get("skipAssessment")
        if not isinstance(skip, dict):
            errors.append("viewHypothesisPolicy.skipAssessment must be an object")
        elif decision == "not-needed":
            errors.extend(
                f"viewHypothesisPolicy: {gap}"
                for gap in view_hypothesis_skip_gaps(spec)
            )
    criteria = policy.get("activationCriteria")
    if criteria is not None:
        validate_string_array(
            criteria,
            "viewHypothesisPolicy.activationCriteria",
            errors,
        )
    if policy.get("generator") != "built-in-imagegen":
        errors.append("viewHypothesisPolicy.generator must be 'built-in-imagegen'")
    if not isinstance(policy.get("promptVersion"), str) or not policy["promptVersion"].strip():
        errors.append("viewHypothesisPolicy.promptVersion is required")
    layout_id = policy.get("layoutId")
    supported_layout_ids = {
        "identity-turnaround-2x2-v1",
        "assembly-exploded-2x2-v1",
    }
    if layout_id not in {None, "", *supported_layout_ids}:
        errors.append(
            "viewHypothesisPolicy.layoutId must select a supported 2x2 planning layout"
        )
    first_view = "exploded" if layout_id == "assembly-exploded-2x2-v1" else "three-quarter"
    views = policy.get("requiredViews")
    if not isinstance(views, list) or not views or not all(
        isinstance(item, str) and item in {"three-quarter", "exploded", "side", "back"}
        for item in views
    ):
        errors.append(
            "viewHypothesisPolicy.requiredViews must contain exploded, three-quarter, side, or back"
        )
    elif len(set(views)) != len(views):
        errors.append("viewHypothesisPolicy.requiredViews contains duplicates")
    else:
        assessment = spec.get("preSpecAssessment")
        complexity = assessment.get("complexity") if isinstance(assessment, dict) else None
        derivation = (
            derive_complexity_tier(complexity)
            if isinstance(complexity, dict)
            else {}
        )
        tier = derivation.get("requiredDepth")
        if tier not in TIER_RANKS:
            tier = complexity.get("tier") if isinstance(complexity, dict) else "moderate"
        if first_view == "exploded" and str(tier) not in {"complex", "ultra"}:
            errors.append(
                "exploded planning sheets require a complex or ultra assembly"
            )
        minimum = set(
            adaptive_hypothesis_views(
                str(tier),
                str(spec.get("qualityProfile") or "balanced"),
                first_view,
            )
        )
        missing = minimum - set(views)
        if missing:
            errors.append(
                "viewHypothesisPolicy.requiredViews weakens the adaptive minimum: "
                + ", ".join(sorted(missing))
            )
    if policy.get("allowedUse") != "planning-veto":
        errors.append("viewHypothesisPolicy.allowedUse must be 'planning-veto'")
    if policy.get("acceptanceAuthority") is not False:
        errors.append("viewHypothesisPolicy.acceptanceAuthority must be false")
    manifest_path = policy.get("manifestPath")
    manifest_hash = policy.get("manifestSha256")
    cache_key = policy.get("cacheKey")
    if any(value for value in (manifest_path, manifest_hash, cache_key)) and not all(
        isinstance(value, str) and value.strip()
        for value in (manifest_path, manifest_hash, cache_key)
    ):
        errors.append(
            "viewHypothesisPolicy manifestPath, manifestSha256, and cacheKey must be recorded together"
        )
    if isinstance(manifest_hash, str) and manifest_hash and len(manifest_hash) != 64:
        errors.append("viewHypothesisPolicy.manifestSha256 must be a SHA-256 digest")
    if isinstance(cache_key, str) and cache_key and len(cache_key) != 64:
        errors.append("viewHypothesisPolicy.cacheKey must be a SHA-256 digest")


def validate_material_scalar_or_layer(value: Any, label: str, errors: list[str]) -> None:
    if value is None:
        return
    if is_number(value):
        return
    if not isinstance(value, dict):
        errors.append(f"{label} must be a number or object")
        return
    base = value.get("base")
    if base is not None and not is_number(base):
        errors.append(f"{label}.base must be numeric")
    variation = value.get("variation")
    if variation is not None and not is_number(variation):
        errors.append(f"{label}.variation must be numeric")


def validate_material_profile(
    material_id: str,
    material: dict[str, Any],
    errors: list[str],
) -> None:
    """Validate optional special-surface fields without changing legacy materials."""

    if "materialProfile" not in material:
        return
    profile = material.get("materialProfile")
    if not isinstance(profile, str) or profile not in VALID_MATERIAL_PROFILES:
        errors.append(
            f"material {material_id!r} materialProfile must be one of: "
            + ", ".join(sorted(VALID_MATERIAL_PROFILES))
        )

    def profile_number(
        value: Any,
        *,
        layer_keys: tuple[str, ...] = (),
    ) -> float | None:
        if is_number(value):
            return float(value)
        if layer_keys and isinstance(value, dict):
            for key in layer_keys:
                nested = value.get(key)
                if is_number(nested):
                    return float(nested)
        return None

    for field in PROFILE_UNIT_INTERVAL_FIELDS:
        if field not in material:
            continue
        value = profile_number(material[field], layer_keys=("base", "amount"))
        if value is None or not 0 <= value <= 1:
            errors.append(
                f"material {material_id!r} {field} must be a finite number from 0 to 1 "
                "or a layer object with base/amount in that range"
            )

    rotation = material.get("anisotropyRotation")
    if "anisotropyRotation" in material and profile_number(
        rotation, layer_keys=("base", "angle")
    ) is None:
        errors.append(
            f"material {material_id!r} anisotropyRotation must be a finite number "
            "or a layer object with finite base/angle"
        )

    ior = material.get("ior")
    parsed_ior = profile_number(ior, layer_keys=("base",))
    if "ior" in material and (parsed_ior is None or not 1 <= parsed_ior <= 2.333):
        errors.append(
            f"material {material_id!r} ior must be from 1 to 2.333 "
            "or a layer object with base in that range"
        )

    for field in PROFILE_NONNEGATIVE_FIELDS:
        if field not in material:
            continue
        layered = field in {"thickness", "dispersion", "emissiveIntensity"}
        value = profile_number(
            material[field],
            layer_keys=("base", "amount") if layered else (),
        )
        if value is None or value < 0:
            layer_note = " or a layer object with non-negative base/amount" if layered else ""
            errors.append(
                f"material {material_id!r} {field} must be a non-negative finite number"
                + layer_note
            )

    attenuation_distance = material.get("attenuationDistance")
    parsed_attenuation_distance = profile_number(
        attenuation_distance,
        layer_keys=("base",),
    )
    if "attenuationDistance" in material and (
        parsed_attenuation_distance is None or parsed_attenuation_distance <= 0
    ):
        errors.append(
            f"material {material_id!r} attenuationDistance must be a positive finite number "
            "or a layer object with a positive base"
        )

    for field in PROFILE_HEX_COLOR_FIELDS:
        if field not in material:
            continue
        value = material[field]
        if not isinstance(value, str) or HEX_COLOR_PATTERN.fullmatch(value) is None:
            errors.append(
                f"material {material_id!r} {field} must be #RGB or #RRGGBB"
            )

    for field in PROFILE_BOOLEAN_FIELDS:
        if field in material and not isinstance(material[field], bool):
            errors.append(f"material {material_id!r} {field} must be boolean")


def validate_special_material_compatibility(
    spec: dict[str, Any],
    warnings: list[str],
) -> None:
    """Keep form generation valid while routing appearance mismatches to lookdev."""

    materials = {
        item.get("id"): item
        for item in spec.get("materials", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict):
            continue
        primitive = component.get("primitive")
        expected = SPECIAL_PRIMITIVE_PROFILES.get(primitive)
        if expected is None:
            continue
        material_id = component.get("material")
        material = materials.get(material_id)
        if not isinstance(material, dict):
            continue
        actual = material.get("materialProfile", "standard")
        if (
            isinstance(actual, str)
            and actual in VALID_MATERIAL_PROFILES
            and actual != expected
        ):
            component_id = str(component.get("id") or "(unnamed)")
            warnings.append(
                f"quality: material {material_id!r} assigned to {primitive} {component_id!r} "
                f"should use materialProfile {expected!r} during lookdev"
            )


def validate_reference_pbr_map(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    has_locator = False
    for field in ("path", "url"):
        item = value.get(field)
        if item is not None:
            if not isinstance(item, str) or not item.strip():
                errors.append(f"{label}.{field} must be a non-empty string when present")
            else:
                has_locator = True
    if not has_locator:
        errors.append(f"{label} needs a path or url")
    channel = value.get("channel")
    if channel is not None and not isinstance(channel, str):
        errors.append(f"{label}.channel must be a string")
    tile_safe = value.get("tileSafe")
    if tile_safe is not None and not isinstance(tile_safe, bool):
        errors.append(f"{label}.tileSafe must be boolean")
    eligible = value.get("eligible")
    if eligible is not None and not isinstance(eligible, bool):
        errors.append(f"{label}.eligible must be boolean")


def validate_texture_set(
    material_id: str, value: Any, errors: list[str], warnings: list[str]
) -> None:
    """Validate an optional authored texture source; legacy referencePbr stays valid."""
    if value is None:
        return
    label = f"material {material_id!r} textureSet"
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    source_type = value.get("sourceType")
    if source_type not in TEXTURE_SOURCE_TYPES:
        errors.append(f"{label}.sourceType is unsupported")
    status = value.get("status")
    if status not in {"declared", "ready", "failed"}:
        errors.append(f"{label}.status must be declared, ready, or failed")
    channels = value.get("channels")
    if not isinstance(channels, dict):
        errors.append(f"{label}.channels must be an object")
        return
    unknown = sorted(set(channels) - TEXTURE_CHANNELS)
    if unknown:
        errors.append(f"{label}.channels contains unsupported channels: " + ", ".join(unknown))
    if source_type != "procedural" and "albedo" not in channels:
        errors.append(f"{label} requires an albedo channel")
    for channel, entry in channels.items():
        if channel not in TEXTURE_CHANNELS:
            continue
        validate_reference_pbr_map(entry, f"{label}.channels.{channel}", errors)
        if (
            status == "ready"
            and source_type != "procedural"
            and isinstance(entry, dict)
            and not (isinstance(entry.get("url"), str) and entry["url"].strip())
        ):
            errors.append(f"{label}.channels.{channel}.url is required at runtime")
    if source_type == "imagegen-authored":
        provenance = value.get("provenance")
        if not isinstance(provenance, dict) or provenance.get("tool") != "imagegen":
            errors.append(f"{label}.provenance.tool must be 'imagegen'")
        else:
            if not isinstance(provenance.get("prompt"), str) or not provenance["prompt"].strip():
                errors.append(f"{label}.provenance.prompt is required")
            digest = provenance.get("assetSha256")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-fA-F]{64}", digest) is None:
                errors.append(f"{label}.provenance.assetSha256 is required")
        checks = value.get("authoringChecks")
        if not isinstance(checks, dict) or any(
            checks.get(check) is not True for check in ("flatNeutralLighting", "bakedLightingFree")
        ):
            errors.append(f"{label} must pass flatNeutralLighting and bakedLightingFree checks")
        physical = sorted(set(channels) & {"roughness", "metalness", "height", "normal", "ao"})
        if physical:
            warnings.append(
                f"quality: {label} physical channels need independent authoring: " + ", ".join(physical)
            )
    if "sourceImage" in value or (
        isinstance(value.get("provenance"), dict)
        and value["provenance"].get("acceptanceAuthority") is True
    ):
        errors.append(f"{label} is an implementation asset, not sourceImage acceptance authority")


def validate_reference_pbr(material_id: str, value: Any, errors: list[str], warnings: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"material {material_id!r} referencePbr must be an object")
        return
    for field in ("version", "sourceImage", "extractor", "method", "verdict", "hardLimit"):
        item = value.get(field)
        if item is not None and not isinstance(item, str):
            errors.append(f"material {material_id!r} referencePbr.{field} must be a string")
    usable = value.get("usable")
    if usable is not None and not isinstance(usable, bool):
        errors.append(f"material {material_id!r} referencePbr.usable must be boolean")
    crop_confirmed = value.get("materialCropConfirmed")
    if crop_confirmed is not None and not isinstance(crop_confirmed, bool):
        errors.append(f"material {material_id!r} referencePbr.materialCropConfirmed must be boolean")
    for field in ("confidence", "extractionSuitability", "estimatedFidelity", "targetThreshold"):
        item = value.get(field)
        if item is not None:
            validate_unit_interval(item, f"material {material_id!r} referencePbr.{field}", errors)
    maps = value.get("maps")
    if maps is None:
        warnings.append(f"quality: material {material_id!r} referencePbr is missing maps")
        return
    if not isinstance(maps, dict):
        errors.append(f"material {material_id!r} referencePbr.maps must be an object")
        return
    assessments = value.get("channelAssessments")
    if assessments is not None and not isinstance(assessments, dict):
        errors.append(f"material {material_id!r} referencePbr.channelAssessments must be an object")
        assessments = None
    if isinstance(assessments, dict):
        for channel, assessment in assessments.items():
            label = f"material {material_id!r} referencePbr.channelAssessments.{channel}"
            if channel not in {"albedo", "roughness", "height", "normal", "ao"}:
                errors.append(f"{label} is unsupported")
            elif not isinstance(assessment, dict) or not isinstance(assessment.get("eligible"), bool):
                errors.append(f"{label}.eligible must be boolean")
            elif "confidence" in assessment:
                validate_unit_interval(assessment["confidence"], f"{label}.confidence", errors)
    required = ("albedo", "roughness", "height", "normal", "ao")
    for channel in required:
        assessment = assessments.get(channel) if isinstance(assessments, dict) else None
        if channel not in maps:
            if not (isinstance(assessment, dict) and assessment.get("eligible") is False):
                warnings.append(f"quality: material {material_id!r} referencePbr.maps missing {channel}")
        else:
            validate_reference_pbr_map(maps[channel], f"material {material_id!r} referencePbr.maps.{channel}", errors)
            if isinstance(assessment, dict) and assessment.get("eligible") is False:
                warnings.append(
                    f"quality: material {material_id!r} referencePbr.maps.{channel} is ineligible and will not execute"
                )


def _layer_value(value: Any, keys: tuple[str, ...] = ("base", "amount")) -> float | None:
    if is_number(value):
        return float(value)
    if isinstance(value, dict):
        for key in keys:
            nested = value.get(key)
            if is_number(nested):
                return float(nested)
    return None


def validate_surface_descriptor(
    material_id: str,
    material: dict[str, Any],
    evidence_ids: set[str] | None,
    errors: list[str],
    warnings: list[str],
    for_pass: str | None,
) -> None:
    """Keep physical rigidity, optical finish, and tactile relief explicit and distinct."""

    selected_pass = PASS_ALIASES.get(for_pass, for_pass)
    if selected_pass in {"blockout", "structure", "form"}:
        # Surface language is authored and enforced at lookdev. Early geometry
        # passes must stay cheap and cannot be blocked by unfinished appearance data.
        return
    value = material.get("surfaceDescriptor")
    lookdev_required = for_pass in LOOKDEV_SURFACE_PASSES
    if value is None:
        if lookdev_required and material.get("qualityTier") != "utility":
            warnings.append(
                f"quality: lookdev material {material_id!r} needs an assessed surfaceDescriptor"
            )
        return
    if not isinstance(value, dict):
        errors.append(f"material {material_id!r} surfaceDescriptor must be an object")
        return
    status = value.get("status")
    if status not in {"unassessed", "assessed"}:
        errors.append(
            f"material {material_id!r} surfaceDescriptor.status must be unassessed or assessed"
        )
        return
    if status == "unassessed":
        if lookdev_required and material.get("qualityTier") != "utility":
            warnings.append(
                f"quality: lookdev material {material_id!r} surfaceDescriptor is unassessed"
            )
        return

    evidence_refs = value.get("evidenceRefs")
    if not (
        isinstance(evidence_refs, list)
        and evidence_refs
        and all(isinstance(item, str) and item.strip() for item in evidence_refs)
    ):
        errors.append(
            f"material {material_id!r} surfaceDescriptor.evidenceRefs must contain evidence ids"
        )
    elif evidence_ids is not None:
        missing = sorted(set(evidence_refs) - evidence_ids)
        if missing:
            errors.append(
                f"material {material_id!r} surfaceDescriptor references missing evidence: "
                + ", ".join(missing)
            )

    def descriptor_entry(
        field: str,
        allowed: frozenset[str],
    ) -> dict[str, Any] | None:
        entry = value.get(field)
        label = f"material {material_id!r} surfaceDescriptor.{field}"
        if not isinstance(entry, dict):
            errors.append(f"{label} must be an object")
            return None
        selected = entry.get("value")
        if selected not in allowed:
            errors.append(
                f"{label}.value must be one of: " + ", ".join(sorted(allowed))
            )
        basis = entry.get("basis")
        if basis not in SURFACE_DESCRIPTOR_BASIS:
            errors.append(
                f"{label}.basis must be observed or inferred"
            )
        confidence = entry.get("confidence")
        if not is_number(confidence) or not 0 < float(confidence) <= 1:
            errors.append(f"{label}.confidence must be greater than 0 and at most 1")
        if field == "microRelief" and selected == "custom" and not (
            isinstance(entry.get("description"), str)
            and entry["description"].strip()
        ):
            errors.append(f"{label}.description is required when value is custom")
        return entry

    descriptor_entry("rigidity", SURFACE_DESCRIPTOR_RIGIDITY)
    finish = descriptor_entry("finish", SURFACE_DESCRIPTOR_FINISH)
    relief = descriptor_entry("microRelief", SURFACE_DESCRIPTOR_RELIEF)

    roughness = _layer_value(material.get("roughness"), ("base",))
    finish_value = finish.get("value") if isinstance(finish, dict) else None
    if roughness is None:
        errors.append(
            f"material {material_id!r} assessed surfaceDescriptor needs executable roughness.base"
        )
    elif finish_value == "mirror" and roughness > 0.15:
        errors.append(
            f"material {material_id!r} mirror finish contradicts roughness.base {roughness:g}"
        )
    elif finish_value == "glossy" and roughness > 0.4:
        errors.append(
            f"material {material_id!r} glossy finish contradicts roughness.base {roughness:g}"
        )
    elif finish_value == "satin" and not 0.25 <= roughness <= 0.7:
        errors.append(
            f"material {material_id!r} satin finish contradicts roughness.base {roughness:g}"
        )
    elif finish_value == "matte" and roughness < 0.5:
        errors.append(
            f"material {material_id!r} matte finish contradicts roughness.base {roughness:g}"
        )

    if isinstance(relief, dict):
        relief_value = relief.get("value")
        channel = relief.get("channel")
        if channel not in SURFACE_DESCRIPTOR_CHANNELS:
            errors.append(
                f"material {material_id!r} surfaceDescriptor.microRelief.channel must be one of: "
                + ", ".join(sorted(SURFACE_DESCRIPTOR_CHANNELS))
            )
            channel = None
        amplitudes = {
            "normal": _layer_value(material.get("normal"), ("strength", "amplitude")) or 0.0,
            "bump": _layer_value(material.get("bump"), ("amplitude", "strength")) or 0.0,
            "displacement": _layer_value(
                material.get("displacement"), ("amplitude", "strength")
            )
            or 0.0,
        }
        if relief_value == "smooth" and any(amount > 0 for amount in amplitudes.values()):
            errors.append(
                f"material {material_id!r} smooth microRelief contradicts non-zero normal/bump/displacement"
            )
        elif relief_value == "smooth" and channel not in {None, "none"}:
            errors.append(
                f"material {material_id!r} smooth microRelief must use channel 'none'"
            )
        elif relief_value in SURFACE_DESCRIPTOR_RELIEF - {"smooth"}:
            if channel == "none":
                errors.append(
                    f"material {material_id!r} non-smooth microRelief needs an executable channel"
                )
            elif channel in amplitudes and amplitudes[channel] <= 0:
                errors.append(
                    f"material {material_id!r} microRelief channel {channel!r} needs positive strength/amplitude"
                )


def validate_local_material_override(
    material_id: str,
    index: int,
    value: Any,
    errors: list[str],
    evidence_ids: set[str] | None = None,
) -> None:
    label = f"material {material_id!r} localOverrides[{index}]"
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    override_id = value.get("id")
    if not isinstance(override_id, str) or not override_id.strip():
        errors.append(f"{label}.id is required")
    layer_type = value.get("type")
    supported_types = EXECUTABLE_LOCAL_MATERIAL_TYPES | LOCAL_MATERIAL_METADATA_TYPES
    if not isinstance(layer_type, str) or layer_type not in supported_types:
        errors.append(
            f"{label}.type must be one of: " + ", ".join(sorted(supported_types))
        )
        return
    evidence_refs = value.get("evidenceRefs")
    if not (
        isinstance(evidence_refs, list)
        and evidence_refs
        and all(isinstance(item, str) and item.strip() for item in evidence_refs)
    ):
        errors.append(f"{label}.evidenceRefs must contain at least one evidence id")
    elif evidence_ids is not None:
        missing_evidence = sorted(
            {str(item) for item in evidence_refs if str(item) not in evidence_ids}
        )
        if missing_evidence:
            errors.append(
                f"{label}.evidenceRefs contains unknown evidence ids: "
                + ", ".join(missing_evidence)
            )
    if layer_type in LOCAL_MATERIAL_METADATA_TYPES:
        return
    amount = _layer_value(value.get("amount"))
    if amount is None or not 0 < amount <= 1:
        errors.append(f"{label}.amount must be greater than 0 and at most 1")
    color = value.get("color")
    if not isinstance(color, str) or HEX_COLOR_PATTERN.fullmatch(color) is None:
        errors.append(f"{label}.color must be #RGB or #RRGGBB")
    for field in ("roughnessDelta", "metalnessDelta"):
        field_value = _layer_value(value.get(field))
        if field_value is not None and not -1 <= field_value <= 1:
            errors.append(f"{label}.{field} must be from -1 to 1")
    height_delta = _layer_value(value.get("heightDelta"))
    if height_delta is not None and not -0.25 <= height_delta <= 0.25:
        errors.append(f"{label}.heightDelta must be from -0.25 to 0.25")
    mask = value.get("mask")
    if not isinstance(mask, dict):
        errors.append(f"{label}.mask must be an executable mask object")
        return
    pattern = mask.get("pattern")
    if not isinstance(pattern, str) or pattern not in VALID_LOCAL_MATERIAL_MASK_PATTERNS:
        errors.append(
            f"{label}.mask.pattern must be one of: "
            + ", ".join(sorted(VALID_LOCAL_MATERIAL_MASK_PATTERNS))
        )
    frequency = mask.get("frequency")
    if frequency is not None and (not is_number(frequency) or frequency <= 0):
        errors.append(f"{label}.mask.frequency must be a positive number")
    threshold = mask.get("threshold")
    if threshold is not None:
        validate_unit_interval(threshold, f"{label}.mask.threshold", errors)
    contrast = mask.get("contrast")
    if contrast is not None and (not is_number(contrast) or contrast <= 0):
        errors.append(f"{label}.mask.contrast must be a positive number")
    for field in ("cavityBias", "edgeBias"):
        if field in mask:
            validate_unit_interval(mask[field], f"{label}.mask.{field}", errors)
    vertical_bias = mask.get("verticalBias")
    if vertical_bias is not None and (
        not is_number(vertical_bias) or not -1 <= float(vertical_bias) <= 1
    ):
        errors.append(f"{label}.mask.verticalBias must be from -1 to 1")
    uv_center = mask.get("uvCenter")
    uv_scale = mask.get("uvScale")
    if (uv_center is None) != (uv_scale is None):
        errors.append(f"{label}.mask.uvCenter and uvScale must be provided together")
    if uv_center is not None and not (
        isinstance(uv_center, list)
        and len(uv_center) == 2
        and all(is_number(item) and 0 <= item <= 1 for item in uv_center)
    ):
        errors.append(f"{label}.mask.uvCenter must contain two numbers from 0 to 1")
    if uv_scale is not None and not (
        isinstance(uv_scale, list)
        and len(uv_scale) == 2
        and all(is_number(item) and item > 0 for item in uv_scale)
    ):
        errors.append(f"{label}.mask.uvScale must contain two positive numbers")
    feather = mask.get("feather")
    if feather is not None and (
        not is_number(feather) or not 0 < float(feather) <= 1
    ):
        errors.append(f"{label}.mask.feather must be greater than 0 and at most 1")
    seed = mask.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
        errors.append(f"{label}.mask.seed must be an integer")


def validate_material_surface_response(
    material_id: str,
    material: dict[str, Any],
    errors: list[str],
) -> None:
    specular_intensity = _layer_value(material.get("specularIntensity"))
    if "specularIntensity" in material and (
        specular_intensity is None or not 0 <= specular_intensity <= 1
    ):
        errors.append(
            f"material {material_id!r} specularIntensity must be from 0 to 1 "
            "or a layer object with base/amount in that range"
        )
    specular_color = material.get("specularColor")
    if "specularColor" in material and (
        not isinstance(specular_color, str)
        or HEX_COLOR_PATTERN.fullmatch(specular_color) is None
    ):
        errors.append(f"material {material_id!r} specularColor must be #RGB or #RRGGBB")
    env_intensity = _layer_value(material.get("envMapIntensity"))
    if "envMapIntensity" in material and (
        env_intensity is None or env_intensity < 0
    ):
        errors.append(
            f"material {material_id!r} envMapIntensity must be non-negative "
            "or a layer object with non-negative base/amount"
        )
    dirt = material.get("dirt")
    if isinstance(dirt, dict):
        for field in ("amount", "cavityBias"):
            if field in dirt:
                parsed = _layer_value(dirt[field])
                if parsed is None or not 0 <= parsed <= 1:
                    errors.append(f"material {material_id!r} dirt.{field} must be from 0 to 1")
        dirt_color = dirt.get("color")
        if dirt_color is not None and (
            not isinstance(dirt_color, str) or HEX_COLOR_PATTERN.fullmatch(dirt_color) is None
        ):
            errors.append(f"material {material_id!r} dirt.color must be #RGB or #RRGGBB")
    wear = material.get("wear")
    if isinstance(wear, dict):
        edge_wear = _layer_value(wear.get("edgeWear"))
        if "edgeWear" in wear and (edge_wear is None or not 0 <= edge_wear <= 1):
            errors.append(f"material {material_id!r} wear.edgeWear must be from 0 to 1")
        for field in ("scratches", "chips"):
            if field in wear and not isinstance(wear[field], list):
                errors.append(f"material {material_id!r} wear.{field} must be an array")


def validate_materials(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
    evidence_ids: set[str] | None = None,
    for_pass: str | None = None,
) -> set[str]:
    material_ids: set[str] = set()
    for index, material in enumerate(spec.get("materials", [])):
        if not isinstance(material, dict):
            errors.append(f"materials[{index}] must be an object")
            continue
        material_id = material.get("id")
        if not isinstance(material_id, str) or not material_id.strip():
            errors.append(f"materials[{index}].id is required")
            continue
        if material_id in material_ids:
            errors.append(f"duplicate material id {material_id!r}")
        material_ids.add(material_id)
        color = material.get("baseColor", material.get("color"))
        if color is not None and not (isinstance(color, str) and color.startswith("#") and len(color) in {4, 7}):
            errors.append(f"material {material_id!r} baseColor/color should be #RGB or #RRGGBB")
        for field in ("shaderModel", "type"):
            value = material.get(field)
            if value is not None and not isinstance(value, str):
                errors.append(f"material {material_id!r} {field} must be a string")
        for field in ("albedo", "ambientOcclusion"):
            value = material.get(field)
            if value is not None and not isinstance(value, dict):
                errors.append(f"material {material_id!r} {field} must be an object")
        validate_material_scalar_or_layer(material.get("roughness"), f"material {material_id!r} roughness", errors)
        validate_material_scalar_or_layer(material.get("metalness"), f"material {material_id!r} metalness", errors)
        for field in ("normal", "bump", "displacement", "wear", "dirt"):
            value = material.get(field)
            if value is not None and not isinstance(value, dict):
                errors.append(f"material {material_id!r} {field} must be an object")
        texture_resolution = material.get("textureResolution")
        if texture_resolution is not None and (
            not isinstance(texture_resolution, int)
            or isinstance(texture_resolution, bool)
            or texture_resolution < 64
            or texture_resolution > 4096
        ):
            errors.append(f"material {material_id!r} textureResolution must be an integer from 64 to 4096")
        projection = material.get("textureProjection")
        if projection is not None:
            if not isinstance(projection, dict):
                errors.append(f"material {material_id!r} textureProjection must be an object")
            else:
                mode = projection.get("mode")
                if mode is not None and not isinstance(mode, str):
                    errors.append(f"material {material_id!r} textureProjection.mode must be a string")
                elif isinstance(mode, str) and mode not in {
                    "uv",
                    "planar",
                    "cylindrical",
                    "spherical",
                }:
                    warnings.append(
                        f"quality: material {material_id!r} textureProjection.mode {mode!r} "
                        "is not emitted directly; provide UV-authored geometry or use a supported mode"
                    )
                axis = projection.get("axis")
                if axis is not None and axis not in {"x", "y", "z"}:
                    errors.append(
                        f"material {material_id!r} textureProjection.axis must be x, y, or z"
                    )
                repeat = projection.get("repeat")
                if repeat is not None and not (
                    isinstance(repeat, list)
                    and len(repeat) == 2
                    and all(is_number(item) and item > 0 for item in repeat)
                ):
                    errors.append(f"material {material_id!r} textureProjection.repeat must contain two positive numbers")
                anisotropy = projection.get("anisotropy")
                if anisotropy is not None and (not is_number(anisotropy) or anisotropy < 1):
                    errors.append(f"material {material_id!r} textureProjection.anisotropy must be >= 1")
        frequency_bands = material.get("surfaceFrequencyBands")
        if frequency_bands is not None:
            if not isinstance(frequency_bands, list):
                errors.append(f"material {material_id!r} surfaceFrequencyBands must be an array")
            else:
                seen_band_ids: set[str] = set()
                for band_index, band in enumerate(frequency_bands):
                    if not isinstance(band, dict):
                        errors.append(
                            f"material {material_id!r} surfaceFrequencyBands[{band_index}] must be an object"
                        )
                        continue
                    band_id = band.get("id")
                    if not isinstance(band_id, str) or not band_id.strip():
                        errors.append(
                            f"material {material_id!r} surfaceFrequencyBands[{band_index}].id is required"
                        )
                    elif band_id in seen_band_ids:
                        errors.append(f"material {material_id!r} has duplicate surface band {band_id!r}")
                    else:
                        seen_band_ids.add(band_id)
                    for field in ("frequency", "amplitude"):
                        value = band.get(field)
                        if not is_number(value) or value <= 0:
                            errors.append(
                                f"material {material_id!r} surfaceFrequencyBands[{band_index}].{field} "
                                "must be a positive number"
                            )
        local_overrides = material.get("localOverrides", [])
        if local_overrides is not None and not isinstance(local_overrides, list):
            errors.append(f"material {material_id!r} localOverrides must be an array")
        elif isinstance(local_overrides, list):
            if len(local_overrides) > 14:
                errors.append(
                    f"material {material_id!r} localOverrides supports at most 14 layers"
                )
            for override_index, override in enumerate(local_overrides):
                validate_local_material_override(
                    material_id,
                    override_index,
                    override,
                    errors,
                    evidence_ids,
                )
        shader_notes = material.get("shaderNotes")
        if shader_notes is not None:
            validate_string_array(shader_notes, f"material {material_id!r} shaderNotes", errors)
        validate_material_profile(material_id, material, errors)
        validate_material_surface_response(material_id, material, errors)
        validate_reference_pbr(material_id, material.get("referencePbr"), errors, warnings)
        validate_texture_set(material_id, material.get("textureSet"), errors, warnings)
        validate_surface_descriptor(
            material_id,
            material,
            evidence_ids,
            errors,
            warnings,
            for_pass,
        )
    if not material_ids:
        errors.append("at least one material is required")
    return material_ids


def validate_dimensions(component_id: str, dimensions: Any, errors: list[str]) -> None:
    if dimensions is None:
        return
    if not isinstance(dimensions, dict):
        errors.append(f"component {component_id!r} dimensions must be an object")
        return
    for field in ("width", "height", "depth", "radius", "length"):
        if field in dimensions and (
            not is_number(dimensions[field]) or float(dimensions[field]) <= 0
        ):
            errors.append(f"component {component_id!r} dimensions.{field} must be a positive finite number")
    confidence = dimensions.get("confidence")
    if confidence is not None:
        validate_unit_interval(confidence, f"component {component_id!r} dimensions.confidence", errors)


def validate_geometry_descriptor(component_id: str, descriptor: Any, errors: list[str]) -> None:
    if descriptor is None:
        return
    if not isinstance(descriptor, dict):
        errors.append(f"component {component_id!r} geometryDescriptor must be an object")
        return
    for field in ("topologyIntent", "uvStrategy", "normalStrategy"):
        value = descriptor.get(field)
        if value is not None and not isinstance(value, str):
            errors.append(f"component {component_id!r} geometryDescriptor.{field} must be a string")
    edge = descriptor.get("edgeTreatment")
    if edge is not None:
        if not isinstance(edge, dict):
            errors.append(f"component {component_id!r} geometryDescriptor.edgeTreatment must be an object")
        else:
            if "bevelRadius" in edge and not is_number(edge["bevelRadius"]):
                errors.append(f"component {component_id!r} edgeTreatment.bevelRadius must be numeric")
            if "segments" in edge and not isinstance(edge["segments"], int):
                errors.append(f"component {component_id!r} edgeTreatment.segments must be an integer")
    stack = descriptor.get("deformationStack")
    if stack is not None and not isinstance(stack, list):
        errors.append(f"component {component_id!r} geometryDescriptor.deformationStack must be an array")


def validate_bool_object(value: Any, label: str, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    for key, item in value.items():
        if not isinstance(key, str):
            errors.append(f"{label} keys must be strings")
        if not isinstance(item, bool):
            errors.append(f"{label}.{key} must be boolean")


def validate_action_profile(
    component_id: str,
    profile: Any,
    errors: list[str],
    warnings: list[str],
    required: bool,
) -> None:
    if profile is None:
        if required:
            warnings.append(
                f"quality: component {component_id!r} is missing actionProfile required by the motion contract"
            )
        return
    if not isinstance(profile, dict):
        errors.append(f"component {component_id!r} actionProfile must be an object")
        return
    role = profile.get("animationRole")
    if role is not None and not isinstance(role, str):
        errors.append(f"component {component_id!r} actionProfile.animationRole must be a string")
    pivot = profile.get("pivot")
    if pivot is not None:
        if not isinstance(pivot, dict):
            errors.append(f"component {component_id!r} actionProfile.pivot must be an object")
        else:
            mode = pivot.get("mode")
            if mode is not None and not isinstance(mode, str):
                errors.append(f"component {component_id!r} actionProfile.pivot.mode must be a string")
            for field in ("localPosition", "axis"):
                if field in pivot and not as_number_list(pivot[field], 3):
                    errors.append(f"component {component_id!r} actionProfile.pivot.{field} must be [number, number, number]")
            confidence = pivot.get("confidence")
            if confidence is not None:
                validate_unit_interval(confidence, f"component {component_id!r} actionProfile.pivot.confidence", errors)
    validate_bool_object(profile.get("transformChannels"), f"component {component_id!r} actionProfile.transformChannels", errors)
    sockets = profile.get("sockets")
    if sockets is not None:
        if not isinstance(sockets, list):
            errors.append(f"component {component_id!r} actionProfile.sockets must be an array")
        else:
            for socket_index, socket in enumerate(sockets):
                if not isinstance(socket, dict):
                    errors.append(f"component {component_id!r} actionProfile.sockets[{socket_index}] must be an object")
                    continue
                socket_id = socket.get("id")
                if socket_id is not None and not isinstance(socket_id, str):
                    errors.append(f"component {component_id!r} actionProfile.sockets[{socket_index}].id must be a string")
                for field in ("localPosition", "position", "localRotation", "rotation"):
                    if field in socket and not as_number_list(socket[field], 3):
                        errors.append(
                            f"component {component_id!r} actionProfile.sockets[{socket_index}].{field} must be [number, number, number]"
                        )
    collider = profile.get("collider")
    if collider is not None:
        if not isinstance(collider, dict):
            errors.append(f"component {component_id!r} actionProfile.collider must be an object")
        else:
            collider_type = collider.get("type")
            if collider_type is not None and not isinstance(collider_type, str):
                errors.append(f"component {component_id!r} actionProfile.collider.type must be a string")
            for field in ("offset", "scale"):
                if field in collider and not as_number_list(collider[field], 3):
                    errors.append(f"component {component_id!r} actionProfile.collider.{field} must be [number, number, number]")
            if "isTrigger" in collider and not isinstance(collider["isTrigger"], bool):
                errors.append(f"component {component_id!r} actionProfile.collider.isTrigger must be boolean")
    constraints = profile.get("constraints")
    if constraints is not None and not isinstance(constraints, list):
        errors.append(f"component {component_id!r} actionProfile.constraints must be an array")
    destruction = profile.get("destruction")
    if destruction is not None:
        if not isinstance(destruction, dict):
            errors.append(f"component {component_id!r} actionProfile.destruction must be an object")
        else:
            if "breakable" in destruction and not isinstance(destruction["breakable"], bool):
                errors.append(f"component {component_id!r} actionProfile.destruction.breakable must be boolean")
            if "breakImpulse" in destruction and not is_number(destruction["breakImpulse"]):
                errors.append(f"component {component_id!r} actionProfile.destruction.breakImpulse must be numeric")
            for field in ("fractureGroup", "debrisMaterial"):
                value = destruction.get(field)
                if value is not None and not isinstance(value, str):
                    errors.append(f"component {component_id!r} actionProfile.destruction.{field} must be a string")
            for field in ("seamRefs", "detachableFragments"):
                validate_string_array(destruction.get(field), f"component {component_id!r} actionProfile.destruction.{field}", errors)


def component_requires_attachment(component: dict[str, Any]) -> bool:
    if component_type(component) == "assembly" or not component.get("parent"):
        return False
    role = str(component.get("role") or "").lower()
    name = str(component.get("name") or component.get("id") or "").lower()
    primitive = str(component.get("primitive") or "").lower()
    profile = component.get("actionProfile") if isinstance(component.get("actionProfile"), dict) else {}
    animation_role = str(profile.get("animationRole") or "").lower()
    tokens = {role, animation_role} | set(re.findall(r"[a-z0-9]+", name))
    return bool(tokens & ATTACHMENT_ROLES) or primitive in ATTACHMENT_PRIMITIVES


def has_attachment_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def attachment_is_complete(attachment: dict[str, Any]) -> bool:
    has_endpoint = as_number_list(attachment.get("localStart"), 3) and as_number_list(attachment.get("localEnd"), 3)
    has_socket = isinstance(attachment.get("parentSocket"), str) and bool(attachment["parentSocket"].strip())
    has_parent_id = isinstance(attachment.get("parentId"), str) and bool(attachment["parentId"].strip())
    has_contact = isinstance(attachment.get("contactType"), str) and bool(attachment["contactType"].strip())
    has_overlap = (
        has_attachment_number(attachment.get("embedDepth"))
        and float(attachment["embedDepth"]) > 0
    ) or (
        has_attachment_number(attachment.get("overlap"))
        and float(attachment["overlap"]) > 0
    )
    has_tolerance = has_attachment_number(attachment.get("gapTolerance"))
    return has_endpoint and (has_socket or has_parent_id) and has_contact and has_overlap and has_tolerance


def validate_attachment(
    component_id: str,
    parent: str | None,
    attachment: Any,
    required: bool,
    errors: list[str],
    warnings: list[str],
) -> None:
    if attachment is None:
        if required:
            warnings.append(
                f"quality: component {component_id!r} requires attachment.parentSocket, localStart/localEnd, "
                "contactType, embedDepth or overlap, and gapTolerance"
            )
        return
    if not isinstance(attachment, dict):
        errors.append(f"component {component_id!r} attachment must be an object")
        return
    for field in ("parentId", "parentSocket", "contactType"):
        value = attachment.get(field)
        if value is not None and not isinstance(value, str):
            errors.append(f"component {component_id!r} attachment.{field} must be a string")
    if parent and isinstance(attachment.get("parentId"), str) and attachment["parentId"] != parent:
        warnings.append(
            f"quality: component {component_id!r} attachment.parentId {attachment['parentId']!r} "
            f"does not match parent {parent!r}"
        )
    for field in ("localStart", "localEnd", "contactNormal"):
        value = attachment.get(field)
        if value is not None and not as_number_list(value, 3):
            errors.append(f"component {component_id!r} attachment.{field} must be [number, number, number]")
    for field in ("embedDepth", "overlap", "gapTolerance", "baseRadius", "endRadius"):
        value = attachment.get(field)
        if value is not None and (not has_attachment_number(value) or float(value) < 0):
            errors.append(f"component {component_id!r} attachment.{field} must be a non-negative number")
    validate_string_array(attachment.get("evidenceRefs"), f"component {component_id!r} attachment.evidenceRefs", errors)
    if required and not attachment_is_complete(attachment):
        warnings.append(
            f"quality: component {component_id!r} requires attachment.parentSocket, localStart/localEnd, "
            "contactType, embedDepth or overlap, and gapTolerance"
        )


def validate_string_array(value: Any, label: str, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        errors.append(f"{label} must be an array of strings")


def component_semantic_name_failure(value: str) -> str | None:
    tokens = re.findall(r"[a-z0-9]+", value.lower())
    if not tokens:
        return "contains no semantic words"
    placeholders = sorted(set(tokens) & COMPONENT_PLACEHOLDER_TOKENS)
    if placeholders:
        return "contains placeholder token(s): " + ", ".join(placeholders)
    structural_tokens = [
        token
        for token in tokens
        if not token.isdigit()
        and token not in COMPONENT_GENERIC_TOKENS
        and token not in COMPONENT_QUALIFIER_TOKENS
    ]
    if not structural_tokens:
        return "contains only generic nouns, position qualifiers, or indices"
    return None


def validate_component_naming(
    component: dict[str, Any],
    index: int,
    errors: list[str],
) -> None:
    component_id = component.get("id")
    if not isinstance(component_id, str) or not component_id.strip():
        return
    is_root = component_id == "root" and component.get("parent") is None
    if not COMPONENT_ID_PATTERN.fullmatch(component_id):
        errors.append(
            f"component {component_id!r} id must use semantic kebab-case: "
            "<system>-<structural-part>[-<side|index|function>]"
        )
    if not is_root:
        id_failure = component_semantic_name_failure(component_id)
        if id_failure:
            errors.append(
                f"component {component_id!r} id is not construction-specific: {id_failure}; "
                "use a name such as 'main-rotor-blade-01' instead of 'part-01'"
            )
    name = component.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append(f"componentTree[{index}].name must be a non-empty structural name")
    elif not is_root:
        name_failure = component_semantic_name_failure(name)
        if name_failure:
            errors.append(
                f"component {component_id!r} name {name!r} is not construction-specific: "
                f"{name_failure}"
            )


def validate_uncertainty_contract(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    contracts = {
        "assumptions": ("id", "statement", "scope", "bounds", "impactIfWrong", "falsifyingCheck"),
        "risks": ("id", "statement", "scope", "impact", "mitigation"),
    }
    for field, required_fields in contracts.items():
        records = spec.get(field)
        if records is None:
            warnings.append(f"quality: missing {field}; uncertainty cannot be bounded explicitly")
            continue
        if not isinstance(records, list):
            errors.append(f"{field} must be an array")
            continue
        for index, record in enumerate(records):
            label = f"{field}[{index}]"
            if isinstance(record, str):
                warnings.append(
                    f"quality: {label} is an unbounded legacy string; use an object with "
                    + ", ".join(required_fields)
                )
                continue
            if not isinstance(record, dict):
                errors.append(f"{label} must be an object")
                continue
            for required_field in required_fields:
                value = record.get(required_field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(f"{label}.{required_field} must be a non-empty string")
            evidence_refs = record.get("evidenceRefs")
            if evidence_refs is not None:
                validate_string_array(evidence_refs, f"{label}.evidenceRefs", errors)


def validate_repetition_attachment_relations(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    systems = spec.get("repetitionSystems")
    if not isinstance(systems, list):
        return
    component_ids = {
        item.get("id")
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for index, system in enumerate(systems):
        if not isinstance(system, dict):
            continue
        label = f"repetitionSystems[{index}].attachmentRelation"
        relation = system.get("attachmentRelation")
        if relation is None:
            warnings.append(
                f"quality: {label} must declare contact, overlap, gap, or free so repeated parts cannot float ambiguously"
            )
            continue
        if not isinstance(relation, dict):
            errors.append(f"{label} must be an object")
            continue
        relation_type = relation.get("type")
        if relation_type not in VALID_REPETITION_ATTACHMENT_RELATIONS:
            errors.append(
                f"{label}.type must be one of: "
                + ", ".join(sorted(VALID_REPETITION_ATTACHMENT_RELATIONS))
            )
            continue
        if relation_type == "free":
            continue
        host_ref = relation.get("hostComponentRef")
        if not isinstance(host_ref, str) or not host_ref.strip():
            errors.append(f"{label}.hostComponentRef must be a non-empty component id")
        elif host_ref not in component_ids:
            errors.append(f"{label}.hostComponentRef references unknown component {host_ref!r}")
        gap_tolerance = relation.get("gapTolerance")
        if not is_number(gap_tolerance) or float(gap_tolerance) < 0:
            errors.append(f"{label}.gapTolerance must be a non-negative number")
        if relation_type == "overlap":
            overlap = relation.get("overlap")
            if not is_number(overlap) or float(overlap) <= 0:
                errors.append(f"{label}.overlap must be a positive number")
        if relation_type == "gap":
            gap = relation.get("gap")
            if not is_number(gap) or float(gap) < 0:
                errors.append(f"{label}.gap must be a non-negative number")


EMITTED_LOCAL_PATH_FEATURES = {"seam", "seam-line", "raised-ridge", "fabric-stitch"}
EMITTED_LOCAL_POINT_FEATURES = {"button", "rivet", "screw"}


def validate_local_features(
    component_id: str,
    value: Any,
    material_ids: set[str],
    errors: list[str],
) -> None:
    if value is None:
        return
    label = f"component {component_id!r} localFeatures"
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return
    seen: set[str] = set()
    for index, feature in enumerate(value):
        feature_label = f"{label}[{index}]"
        if not isinstance(feature, dict):
            errors.append(f"{feature_label} must be an object")
            continue
        feature_id = feature.get("id")
        if not isinstance(feature_id, str) or not feature_id.strip():
            errors.append(f"{feature_label}.id is required")
        elif feature_id in seen:
            errors.append(f"{label} has duplicate id {feature_id!r}")
        else:
            seen.add(feature_id)
        feature_type = feature.get("type")
        supported = EMITTED_LOCAL_PATH_FEATURES | EMITTED_LOCAL_POINT_FEATURES | {"decal"}
        if feature_type not in supported:
            errors.append(
                f"{feature_label}.type must be one of: " + ", ".join(sorted(supported))
            )
            continue
        material = feature.get("material")
        if material is not None and (
            not isinstance(material, str) or material not in material_ids
        ):
            errors.append(f"{feature_label}.material references unknown material {material!r}")
        for field in ("position", "rotation", "scale"):
            if field in feature and not as_number_list(feature[field], 3):
                errors.append(f"{feature_label}.{field} must be [number, number, number]")
        if feature_type in EMITTED_LOCAL_PATH_FEATURES:
            path = feature.get("path")
            if not isinstance(path, list) or len(path) < 2:
                errors.append(f"{feature_label}.path must contain at least two local 3D points")
            elif len(path) > 256:
                errors.append(f"{feature_label}.path must contain at most 256 points")
            else:
                for point_index, point in enumerate(path):
                    if not as_number_list(point, 3):
                        errors.append(
                            f"{feature_label}.path[{point_index}] must be [number, number, number]"
                        )
            radius = feature.get("radius")
            if not is_number(radius) or float(radius) <= 0:
                errors.append(f"{feature_label}.radius must be a positive finite number")
            segments = feature.get("segments")
            if segments is not None and (
                not isinstance(segments, int)
                or isinstance(segments, bool)
                or not 2 <= segments <= 512
            ):
                errors.append(f"{feature_label}.segments must be an integer from 2 to 512")
        elif feature_type in EMITTED_LOCAL_POINT_FEATURES:
            if not as_number_list(feature.get("position"), 3):
                errors.append(f"{feature_label}.position must be [number, number, number]")
            radius = feature.get("radius")
            if not is_number(radius) or float(radius) <= 0:
                errors.append(f"{feature_label}.radius must be a positive finite number")
        else:
            size = feature.get("size")
            if (
                not isinstance(size, list)
                or len(size) != 2
                or not all(is_number(item) and float(item) > 0 for item in size)
            ):
                errors.append(f"{feature_label}.size must be two positive numbers")


def validate_components(
    spec: dict[str, Any],
    material_ids: set[str],
    evidence_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    components = spec.get("componentTree", [])
    component_lookup = {
        str(item["id"]): item
        for item in components
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].strip()
    }
    ids: set[str] = set()
    parent_refs: list[tuple[str, str]] = []
    readiness = spec.get("actionReadiness")
    action_profile_required = isinstance(readiness, dict) and readiness.get("enabled") is True
    repetition_systems = spec.get("repetitionSystems", [])
    for index, component in enumerate(components):
        if not isinstance(component, dict):
            errors.append(f"componentTree[{index}] must be an object")
            continue
        component_id = component.get("id")
        if not isinstance(component_id, str) or not component_id.strip():
            errors.append(f"componentTree[{index}].id is required")
            continue
        if component_id in ids:
            errors.append(f"duplicate component id {component_id!r}")
        ids.add(component_id)
        validate_component_naming(component, index, errors)
        kind = component_type(component)
        if schema_at_least(spec, CURRENT_SCHEMA_VERSION):
            if "componentType" not in component:
                errors.append(f"component {component_id!r} missing core field 'componentType'")
            if kind not in COMPONENT_TYPES:
                errors.append(
                    f"component {component_id!r} componentType {kind!r} must be one of: "
                    + ", ".join(sorted(COMPONENT_TYPES))
                )
        if schema_at_least(spec, "3.0"):
            required_fields = ("transform",) if kind == "assembly" else (
                "primitive",
                "dimensions",
                "transform",
                "material",
            )
            for required_field in required_fields:
                if required_field not in component:
                    errors.append(
                        f"component {component_id!r} missing core field {required_field!r}"
                    )
        primitive = component.get("primitive")
        if kind == "assembly" and schema_at_least(spec, CURRENT_SCHEMA_VERSION):
            ignored_geometry = [
                field
                for field in ("primitive", "dimensions", "material", "geometryDescriptor")
                if field in component
            ]
            if ignored_geometry:
                errors.append(
                    f"assembly {component_id!r} must not define geometry-only fields: "
                    + ", ".join(ignored_geometry)
                )
        else:
            errors.extend(
                validate_geometry_component(
                    component,
                    repetition_systems,
                    component_lookup,
                )
            )
        level = component.get("level")
        if level is not None and level not in VALID_COMPONENT_LEVELS:
            errors.append(f"component {component_id!r} level must be macro, meso, or micro")
        for field in ("importance", "confidence"):
            value = component.get(field)
            if value is not None:
                validate_unit_interval(value, f"component {component_id!r} {field}", errors)
        parent = component.get("parent")
        if parent:
            if not isinstance(parent, str):
                errors.append(f"component {component_id!r} parent must be a string or null")
            else:
                parent_refs.append((component_id, parent))
        material = component.get("material")
        if material and material not in material_ids:
            errors.append(f"component {component_id!r} references unknown material {material!r}")
        if kind != "assembly":
            validate_geometry_descriptor(component_id, component.get("geometryDescriptor"), errors)
        material_layers = component.get("materialLayers")
        if material_layers is not None:
            validate_string_array(material_layers, f"component {component_id!r} materialLayers", errors)
            if isinstance(material_layers, list):
                for material_layer in material_layers:
                    if material_layer not in material_ids:
                        errors.append(
                            f"component {component_id!r} materialLayers references unknown material {material_layer!r}"
                        )
        if kind != "assembly":
            validate_dimensions(component_id, component.get("dimensions"), errors)
        transform = component.get("transform", {})
        if transform is not None and not isinstance(transform, dict):
            errors.append(f"component {component_id!r} transform must be an object")
        elif isinstance(transform, dict):
            for field in ("position", "rotation", "scale"):
                if field in transform and not as_number_list(transform[field], 3):
                    errors.append(f"component {component_id!r} transform.{field} must be [number, number, number]")
        validate_action_profile(
            component_id,
            component.get("actionProfile"),
            errors,
            warnings,
            action_profile_required,
        )
        validate_attachment(
            component_id,
            parent if isinstance(parent, str) else None,
            component.get("attachment"),
            component_requires_attachment(component),
            errors,
            warnings,
        )
        for field in ("deformations", "joints", "seams"):
            value = component.get(field)
            if value is not None and not isinstance(value, list):
                errors.append(f"component {component_id!r} {field} must be an array")
        validate_local_features(
            component_id,
            component.get("localFeatures"),
            material_ids,
            errors,
        )
        surface = component.get("surfaceDetail")
        if surface is not None:
            if not isinstance(surface, dict):
                errors.append(f"component {component_id!r} surfaceDetail must be an object")
            else:
                for field in ("macroRoughness", "microRoughness", "bumpAmplitude"):
                    if field in surface and not is_number(surface[field]):
                        errors.append(f"component {component_id!r} surfaceDetail.{field} must be numeric")
        evidence_refs = component.get("evidenceRefs")
        if evidence_refs is not None:
            validate_string_array(evidence_refs, f"component {component_id!r} evidenceRefs", errors)
            if isinstance(evidence_refs, list):
                for evidence_ref in evidence_refs:
                    if evidence_ids and evidence_ref not in evidence_ids:
                        errors.append(f"component {component_id!r} references missing evidence {evidence_ref!r}")
    for component_id, parent in parent_refs:
        if parent not in ids:
            errors.append(f"component {component_id!r} references missing parent {parent!r}")
    parent_by_id = {component_id: parent for component_id, parent in parent_refs if parent in ids}
    for component_id in ids:
        chain: list[str] = []
        current = component_id
        while current in parent_by_id:
            if current in chain:
                cycle = chain[chain.index(current) :] + [current]
                message = "component parent cycle: " + " -> ".join(cycle)
                if message not in errors:
                    errors.append(message)
                break
            chain.append(current)
            current = parent_by_id[current]
    if not ids:
        errors.append("at least one component is required")
    root_ids = [
        str(component.get("id"))
        for component in components
        if isinstance(component, dict)
        and isinstance(component.get("id"), str)
        and component.get("parent") is None
    ]
    if ids and len(root_ids) != 1:
        errors.append(f"componentTree must have exactly one root component; found {len(root_ids)}")
    if isinstance(repetition_systems, list):
        for index, system in enumerate(repetition_systems):
            if not isinstance(system, dict):
                continue
            component_ref = system.get("componentRef")
            if component_ref is not None and (
                not isinstance(component_ref, str) or component_ref not in ids
            ):
                errors.append(
                    f"repetitionSystems[{index}].componentRef references unknown component "
                    f"{component_ref!r}"
                )
    assessment = spec.get("preSpecAssessment")
    complexity_block = assessment.get("complexity") if isinstance(assessment, dict) else None
    complexity = complexity_block.get("tier") if isinstance(complexity_block, dict) else None
    if len(ids) == 1 and complexity != "simple":
        warnings.append("only one component found; this is likely still blockout quality")
    if schema_at_least(spec, CURRENT_SCHEMA_VERSION):
        reviewed_refs: set[str] = set()
        for collection_name in ("featureReviewTargets", "buildPasses"):
            for item in spec.get(collection_name, []):
                if not isinstance(item, dict) or not isinstance(item.get("componentRefs"), list):
                    continue
                reviewed_refs.update(
                    value for value in item["componentRefs"] if isinstance(value, str)
                )
        for component in components:
            if not isinstance(component, dict) or component_type(component) != "assembly":
                continue
            assembly_id = component.get("id")
            importance = component.get("importance", 0)
            if (
                isinstance(assembly_id, str)
                and is_number(importance)
                and float(importance) >= 0.75
                and assembly_id not in reviewed_refs
            ):
                warnings.append(
                    f"quality: important assembly {assembly_id!r} is not covered by any "
                    "build pass or semantic feature review target"
                )


def _detail_parameter_exists(component: dict[str, Any], path: str) -> bool:
    current: Any = component
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return False
        current = current[segment]
    return is_number(current) or (
        isinstance(current, list) and current and all(is_number(item) for item in current)
    )


def _executable_geometry_feature_ids(component: dict[str, Any]) -> set[str]:
    """Index named records only from registered, generator-consumed collections."""

    feature_ids: set[str] = set()
    descriptor = component.get("geometryDescriptor")
    parameters = descriptor.get("parameters") if isinstance(descriptor, dict) else None
    named_collections = {"openings", "nodes", "sources", "surfaceModifiers"}

    def visit_parameters(value: Any) -> None:
        if not isinstance(value, dict):
            return
        for collection_name in named_collections:
            collection = value.get(collection_name)
            if not isinstance(collection, list):
                continue
            for item in collection:
                if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]:
                    feature_ids.add(item["id"])
        # Instanced/scattered primitives may embed another registered primitive.
        for nested_name in ("baseParameters", "sourceParameters"):
            visit_parameters(value.get(nested_name))

    visit_parameters(parameters)
    return feature_ids


def validate_detail_decomposition(
    spec: dict[str, Any],
    material_ids: set[str],
    evidence_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    """Require complex components to expose executable, reviewable sub-detail."""

    contract = spec.get("detailDecompositionContract")
    if contract is None:
        warnings.append(
            "quality: missing detailDecompositionContract; complex components may collapse into one vague block"
        )
        contract_planned = False
    elif not isinstance(contract, dict):
        errors.append("detailDecompositionContract must be an object")
        contract_planned = False
    else:
        if contract.get("version") != 1:
            errors.append("detailDecompositionContract.version must be integer 1")
        status = contract.get("status")
        if status not in VALID_DETAIL_CONTRACT_STATUSES:
            errors.append("detailDecompositionContract.status must be unassessed or planned")
        contract_planned = status == "planned"
        rules = contract.get("rules")
        validate_string_array(rules, "detailDecompositionContract.rules", errors)
        if isinstance(rules, list) and not any(item.strip() for item in rules):
            warnings.append("quality: detailDecompositionContract.rules is empty")
        if status == "unassessed":
            warnings.append(
                "quality: detailDecompositionContract is unassessed; inventory visible sub-detail before geometry generation"
            )

    components = [item for item in spec.get("componentTree", []) if isinstance(item, dict)]
    component_lookup = {
        str(item["id"]): item
        for item in components
        if isinstance(item.get("id"), str) and item["id"].strip()
    }
    children_by_parent: dict[str, set[str]] = {}
    for item in components:
        item_id = item.get("id")
        parent = item.get("parent")
        if isinstance(item_id, str) and isinstance(parent, str):
            children_by_parent.setdefault(parent, set()).add(item_id)
    repetition_ids = {
        str(item["id"])
        for item in spec.get("repetitionSystems", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    topology = spec.get("surfaceTopologyPlan")
    raw_topology_groups = (
        topology.get("groups", [])
        if isinstance(topology, dict) and isinstance(topology.get("groups"), list)
        else []
    )
    topology_groups = {
        str(item["id"]): item
        for item in raw_topology_groups
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
    }
    feature_ids: set[str] = set()

    for component in components:
        component_id = component.get("id")
        if not isinstance(component_id, str) or not component_id:
            continue
        if component_type(component) == "assembly":
            continue
        label = f"component {component_id!r} detailPlan"
        plan = component.get("detailPlan")
        if plan is None:
            message = f"{label} is required to prevent an undifferentiated component"
            if contract_planned:
                errors.append(message)
            else:
                warnings.append(f"quality: {message}")
            continue
        if not isinstance(plan, dict):
            errors.append(f"{label} must be an object")
            continue
        status = plan.get("status")
        if status not in VALID_DETAIL_CONTRACT_STATUSES:
            errors.append(f"{label}.status must be unassessed or planned")
            continue
        if status != "planned":
            message = f"{label} must be planned before this component can be generated"
            if contract_planned:
                errors.append(message)
            else:
                warnings.append(f"quality: {message}")
            continue

        complexity = plan.get("observedComplexity")
        if complexity not in VALID_DETAIL_COMPLEXITIES - {"unassessed"}:
            errors.append(f"{label}.observedComplexity must be simple, compound, or complex")
        mode = plan.get("decompositionMode")
        if mode not in VALID_DETAIL_DECOMPOSITION_MODES - {"unassessed"}:
            errors.append(
                f"{label}.decompositionMode must be atomic, children, features, or hybrid"
            )
        declared_children = plan.get("childComponentIds")
        validate_string_array(declared_children, f"{label}.childComponentIds", errors)
        if not isinstance(declared_children, list):
            declared_children = []
        elif len(set(declared_children)) != len(declared_children):
            errors.append(f"{label}.childComponentIds contains duplicates")
        declared_child_set = {item for item in declared_children if isinstance(item, str)}
        owner_module_id = component.get("moduleId")
        actual_children = {
            child_id
            for child_id in children_by_parent.get(component_id, set())
            if component_lookup.get(child_id, {}).get("moduleId") == owner_module_id
        }
        if declared_child_set != actual_children:
            missing = sorted(actual_children - declared_child_set)
            extra = sorted(declared_child_set - actual_children)
            errors.append(
                f"{label}.childComponentIds must exactly match direct component children; "
                f"missing={missing}, extra={extra}"
            )
        features = plan.get("features")
        if not isinstance(features, list):
            errors.append(f"{label}.features must be an array")
            features = []
        evidence_refs = plan.get("evidenceRefs")
        validate_string_array(evidence_refs, f"{label}.evidenceRefs", errors)
        if not isinstance(evidence_refs, list) or not evidence_refs:
            errors.append(f"{label}.evidenceRefs must contain at least one evidence id")
        else:
            for evidence_ref in evidence_refs:
                if evidence_ids and evidence_ref not in evidence_ids:
                    errors.append(f"{label}.evidenceRefs references missing evidence {evidence_ref!r}")
        coverage_notes = plan.get("coverageNotes")
        if not isinstance(coverage_notes, str) or not coverage_notes.strip():
            errors.append(
                f"{label}.coverageNotes must state which visible boundaries and internal details were inventoried"
            )
        atomicity_reason = plan.get("atomicityReason")
        if mode == "atomic":
            if complexity in {"compound", "complex"}:
                errors.append(
                    f"{label} cannot be atomic when observedComplexity is {complexity!r}"
                )
            if actual_children or features:
                errors.append(f"{label} atomic mode cannot declare children or features")
            if not isinstance(atomicity_reason, str) or not atomicity_reason.strip():
                errors.append(
                    f"{label}.atomicityReason must explain why one undivided form is sufficient"
                )
        elif mode == "children":
            if not actual_children:
                errors.append(f"{label} children mode requires at least one direct child component")
            if features:
                errors.append(f"{label} children mode cannot contain features; use hybrid")
        elif mode == "features":
            if not features:
                errors.append(f"{label} features mode requires at least one inventoried feature")
            if actual_children:
                errors.append(f"{label} features mode cannot have child components; use hybrid")
        elif mode == "hybrid":
            if not actual_children or not features:
                errors.append(f"{label} hybrid mode requires both child components and features")
        local_feature_ids = {
            str(item["id"])
            for item in component.get("localFeatures", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        geometry_feature_ids = _executable_geometry_feature_ids(component)
        for index, feature in enumerate(features):
            feature_label = f"{label}.features[{index}]"
            if not isinstance(feature, dict):
                errors.append(f"{feature_label} must be an object")
                continue
            feature_id = feature.get("id")
            if not isinstance(feature_id, str) or not feature_id.strip():
                errors.append(f"{feature_label}.id is required")
            else:
                if not COMPONENT_ID_PATTERN.fullmatch(feature_id):
                    errors.append(f"{feature_label}.id must use semantic kebab-case")
                naming_failure = component_semantic_name_failure(feature_id)
                if naming_failure:
                    errors.append(
                        f"{feature_label}.id is not construction-specific: {naming_failure}"
                    )
                if feature_id in feature_ids:
                    errors.append(f"duplicate detail feature id {feature_id!r}")
                feature_ids.add(feature_id)
            name = feature.get("name")
            if not isinstance(name, str) or not name.strip():
                errors.append(f"{feature_label}.name must be a non-empty construction name")
            else:
                naming_failure = component_semantic_name_failure(name)
                if naming_failure:
                    errors.append(
                        f"{feature_label}.name is not construction-specific: {naming_failure}"
                    )
            if feature.get("hostComponentId") != component_id:
                errors.append(f"{feature_label}.hostComponentId must equal {component_id!r}")
            if feature.get("scaleBand") not in VALID_DETAIL_SCALE_BANDS:
                errors.append(f"{feature_label}.scaleBand must be macro, meso, or micro")
            feature_class = feature.get("featureClass")
            if feature_class not in VALID_DETAIL_FEATURE_CLASSES:
                errors.append(
                    f"{feature_label}.featureClass must be one of: "
                    + ", ".join(sorted(VALID_DETAIL_FEATURE_CLASSES))
                )
            geometry_effect = feature.get("geometryEffect")
            if geometry_effect not in VALID_DETAIL_GEOMETRY_EFFECTS:
                errors.append(
                    f"{feature_label}.geometryEffect must be silhouette, surface, cutout, or none"
                )
            placement = feature.get("placement")
            if not isinstance(placement, dict):
                errors.append(f"{feature_label}.placement must be an object")
            else:
                if placement.get("referenceFrame") != "host-local":
                    errors.append(f"{feature_label}.placement.referenceFrame must be 'host-local'")
                for field in ("position", "rotation"):
                    if not as_number_list(placement.get(field), 3):
                        errors.append(f"{feature_label}.placement.{field} must be three numbers")
                size = placement.get("size")
                if not as_number_list(size, 3) or any(float(item) <= 0 for item in size or []):
                    errors.append(f"{feature_label}.placement.size must be three positive numbers")
                if placement.get("units") not in {
                    "relative", "meters", "centimeters", "millimeters"
                }:
                    errors.append(f"{feature_label}.placement.units is invalid")
            realization = feature.get("realization")
            if not isinstance(realization, dict):
                errors.append(f"{feature_label}.realization must be an object")
                realization = {}
            realization_mode = realization.get("mode")
            target_id = realization.get("targetId")
            if realization_mode not in VALID_DETAIL_REALIZATION_MODES:
                errors.append(
                    f"{feature_label}.realization.mode must be one of: "
                    + ", ".join(sorted(VALID_DETAIL_REALIZATION_MODES))
                )
            if not isinstance(target_id, str) or not target_id:
                errors.append(f"{feature_label}.realization.targetId is required")
            elif realization_mode == "component" and target_id not in declared_child_set:
                errors.append(
                    f"{feature_label}.realization.targetId must name a declared direct child component"
                )
            elif realization_mode == "local-feature" and target_id not in local_feature_ids:
                errors.append(
                    f"{feature_label}.realization.targetId references unknown local feature {target_id!r}"
                )
            elif realization_mode == "topology-group":
                group = topology_groups.get(target_id)
                if group is None:
                    errors.append(
                        f"{feature_label}.realization.targetId references unknown topology group {target_id!r}"
                    )
                elif component_id not in group.get("componentRefs", []):
                    errors.append(
                        f"{feature_label} topology group {target_id!r} does not include host {component_id!r}"
                    )
                implementation_id = realization.get("implementationId")
                if not isinstance(implementation_id, str) or implementation_id not in geometry_feature_ids:
                    errors.append(
                        f"{feature_label} topology-group realization needs implementationId for an exact named host geometry feature"
                    )
            elif realization_mode == "repetition-system" and target_id not in repetition_ids:
                errors.append(
                    f"{feature_label}.realization.targetId references unknown repetition system {target_id!r}"
                )
            elif realization_mode == "material" and target_id not in material_ids:
                errors.append(
                    f"{feature_label}.realization.targetId references unknown material {target_id!r}"
                )
            elif realization_mode == "geometry-feature" and target_id not in geometry_feature_ids:
                errors.append(
                    f"{feature_label}.realization.targetId references unknown named host geometry feature {target_id!r}"
                )
            elif realization_mode == "geometry-parameter":
                parameter_path = realization.get("parameterPath")
                if target_id != component_id:
                    errors.append(
                        f"{feature_label} geometry-parameter realization must target its host component"
                    )
                if (
                    not isinstance(parameter_path, str)
                    or not DETAIL_PARAMETER_PATH_PATTERN.fullmatch(parameter_path)
                    or not parameter_path.startswith(
                        ("geometryDescriptor.", "dimensions.", "transform.", "surfaceDetail.")
                    )
                ):
                    errors.append(
                        f"{feature_label}.realization.parameterPath must name an executable host geometry field"
                    )
                elif not _detail_parameter_exists(component, parameter_path):
                    errors.append(
                        f"{feature_label}.realization.parameterPath {parameter_path!r} does not exist or is not numeric"
                    )
            if feature_class == "structural-part" and realization_mode != "component":
                errors.append(f"{feature_label} structural-part must realize as a child component")
            if feature_class == "repetition" and realization_mode != "repetition-system":
                errors.append(f"{feature_label} repetition must realize as a repetition-system")
            if feature_class == "material-detail" and realization_mode != "material":
                errors.append(f"{feature_label} material-detail must realize as a material")
            if realization_mode == "material" and geometry_effect != "none":
                errors.append(
                    f"{feature_label} material realization cannot claim silhouette, surface, or cutout geometry"
                )
            material_refs = feature.get("materialRefs")
            validate_string_array(material_refs, f"{feature_label}.materialRefs", errors)
            if isinstance(material_refs, list):
                for material_ref in material_refs:
                    if material_ref not in material_ids:
                        errors.append(
                            f"{feature_label}.materialRefs references unknown material {material_ref!r}"
                        )
            feature_evidence = feature.get("evidenceRefs")
            validate_string_array(feature_evidence, f"{feature_label}.evidenceRefs", errors)
            if not isinstance(feature_evidence, list) or not feature_evidence:
                errors.append(f"{feature_label}.evidenceRefs must not be empty")
            elif evidence_ids:
                for evidence_ref in feature_evidence:
                    if evidence_ref not in evidence_ids:
                        errors.append(
                            f"{feature_label}.evidenceRefs references missing evidence {evidence_ref!r}"
                        )
            validate_unit_interval(feature.get("confidence"), f"{feature_label}.confidence", errors)
            acceptance = feature.get("acceptance")
            if not isinstance(acceptance, dict):
                errors.append(f"{feature_label}.acceptance must be an object")
            else:
                for field in ("evidenceRefs", "criteria"):
                    value = acceptance.get(field)
                    validate_string_array(value, f"{feature_label}.acceptance.{field}", errors)
                    if not isinstance(value, list) or not value or not any(item.strip() for item in value):
                        errors.append(f"{feature_label}.acceptance.{field} must not be empty")
                for evidence_ref in acceptance.get("evidenceRefs", []):
                    if evidence_ids and evidence_ref not in evidence_ids:
                        errors.append(
                            f"{feature_label}.acceptance.evidenceRefs references missing evidence {evidence_ref!r}"
                        )


def validate_quality_targets(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    targets = spec.get("qualityTargets")
    if targets is None:
        warnings.append("missing qualityTargets; self-correction loop has no explicit fidelity bar")
        return
    if not isinstance(targets, dict):
        errors.append("qualityTargets must be an object")
        return
    target_fidelity = targets.get("targetFidelity")
    if target_fidelity is not None:
        validate_unit_interval(target_fidelity, "qualityTargets.targetFidelity", errors)
    for field in ("mustMatch", "niceToHave", "reviewViewpoints"):
        validate_string_array(targets.get(field), f"qualityTargets.{field}", errors)
    diagnostics = targets.get("diagnosticTargets")
    if diagnostics is not None:
        if not isinstance(diagnostics, dict):
            errors.append("qualityTargets.diagnosticTargets must be an object")
        else:
            if "silhouetteIou" in diagnostics:
                errors.append(
                    "qualityTargets.diagnosticTargets.silhouetteIou has been removed"
                )
            for field in (
                "maximumCentroidDelta",
                "maximumAspectRatioDelta",
                "minimumDetailEnergyRatio",
                "minimumEdgeDensityRatio",
                "minimumHistogramIntersection",
                "maximumMeanColorDelta",
                "minimumHighlightCoverageRatio",
                "minimumHighlightEnergyRatio",
            ):
                if field in diagnostics:
                    validate_unit_interval(
                        diagnostics[field],
                        f"qualityTargets.diagnosticTargets.{field}",
                        errors,
                    )
            authority = diagnostics.get("acceptanceAuthority")
            if authority is not None and not isinstance(authority, bool):
                errors.append(
                    "qualityTargets.diagnosticTargets.acceptanceAuthority must be boolean"
                )
            elif authority is True:
                warnings.append(
                    "quality: diagnostic image metrics cannot be the visual acceptance authority"
                )


def validate_quality_contract(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    contract = spec.get("qualityContract")
    if contract is None:
        errors.append("qualityContract is required")
        return
    if not isinstance(contract, dict):
        errors.append("qualityContract must be an object")
        return
    allowed_fields = {"minimumSpecDepth", "requiredReviewViewIds"}
    unknown_fields = sorted(set(contract) - allowed_fields)
    if unknown_fields:
        errors.append(
            "qualityContract has unsupported duplicate or non-operational fields: "
            + ", ".join(unknown_fields)
        )
    minimums = contract.get("minimumSpecDepth")
    if not isinstance(minimums, dict):
        errors.append("qualityContract.minimumSpecDepth must be an object")
    else:
        required_depth_fields = (
            "macroComponents",
            "mesoComponents",
            "microFeatureGroups",
            "materials",
            "repetitionSystems",
        )
        unknown_depth_fields = sorted(set(minimums) - set(required_depth_fields))
        if unknown_depth_fields:
            errors.append(
                "qualityContract.minimumSpecDepth has unsupported fields: "
                + ", ".join(unknown_depth_fields)
            )
        for field in required_depth_fields:
            if field not in minimums:
                errors.append(
                    f"qualityContract.minimumSpecDepth.{field} is required"
                )
            else:
                validate_nonnegative_int(
                    minimums[field],
                    f"qualityContract.minimumSpecDepth.{field}",
                    errors,
                )
    required_views = contract.get("requiredReviewViewIds")
    validate_string_array(
        required_views,
        "qualityContract.requiredReviewViewIds",
        errors,
    )
    if not isinstance(required_views, list) or not required_views:
        errors.append("qualityContract.requiredReviewViewIds must be a non-empty array")
    else:
        if not all(
            isinstance(item, str) and item.strip() for item in required_views
        ):
            errors.append(
                "qualityContract.requiredReviewViewIds must contain non-empty strings"
            )
        normalized = [
            item for item in required_views if isinstance(item, str) and item.strip()
        ]
        if len(set(normalized)) != len(normalized):
            errors.append("qualityContract.requiredReviewViewIds contains duplicates")
        evidence_ids = {
            item.get("id")
            for item in spec.get("viewEvidence", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        missing = sorted(set(normalized) - evidence_ids)
        if missing:
            errors.append(
                "qualityContract.requiredReviewViewIds references missing viewEvidence: "
                + ", ".join(missing)
            )


def validate_review_governance(
    spec: dict[str, Any],
    errors: list[str],
) -> None:
    """Require one canonical independent-review authority for v4 workflows."""

    if phase_execution_version(spec) < 4:
        return
    governance = spec.get("reviewGovernance")
    if not isinstance(governance, dict):
        errors.append("reviewGovernance must be an object for phaseExecutionContract version 4")
        return
    expected = review_governance_contract()
    unexpected = sorted(set(governance) - set(expected))
    if unexpected:
        errors.append(
            "reviewGovernance contains unsupported fields: " + ", ".join(unexpected)
        )
    for field, value in expected.items():
        if governance.get(field) != value:
            errors.append(f"reviewGovernance.{field} must be {value!r}")


def validate_phase_execution_contract(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    contract = spec.get("phaseExecutionContract")
    if contract is None:
        warnings.append(
            "quality: missing phaseExecutionContract; the LLM may front-load unrelated spec and validation work"
        )
        return
    if not isinstance(contract, dict):
        errors.append("phaseExecutionContract must be an object")
        return
    version = contract.get("version")
    if version not in {1, 2, 3, 4}:
        errors.append("phaseExecutionContract.version must be integer 1, 2, 3, or 4")
    if contract.get("mode") != "progressive-visual-loop":
        errors.append("phaseExecutionContract.mode must be 'progressive-visual-loop'")
    if contract.get("phaseOrder") != ["blockout", "form", "lookdev", "interaction"]:
        errors.append(
            "phaseExecutionContract.phaseOrder must be blockout, form, lookdev, interaction"
        )
    if contract.get("specStrategy") != "stable-core-plus-phase-delta":
        errors.append(
            "phaseExecutionContract.specStrategy must be 'stable-core-plus-phase-delta'"
        )
    validate_string_array(
        contract.get("stableCoreFields"),
        "phaseExecutionContract.stableCoreFields",
        errors,
    )
    owned = contract.get("phaseOwnedFields")
    if not isinstance(owned, dict):
        errors.append("phaseExecutionContract.phaseOwnedFields must be an object")
    else:
        for phase in ("blockout", "form", "lookdev", "interaction"):
            validate_string_array(
                owned.get(phase),
                f"phaseExecutionContract.phaseOwnedFields.{phase}",
                errors,
            )
    authority = contract.get("correctionAuthority")
    if version == 4:
        if not isinstance(authority, dict):
            warnings.append(
                "quality: phaseExecutionContract.correctionAuthority is missing; "
                "sync the pipeline to enable cumulative prior-phase repair"
            )
        else:
            if authority.get("mode") != "cumulative-prior-phase-repair":
                errors.append(
                    "phaseExecutionContract.correctionAuthority.mode must be "
                    "'cumulative-prior-phase-repair'"
                )
            for field in (
                "laterPhaseMayRepairEarlierPhase",
                "futurePhaseEditsForbidden",
                "impactAssessmentRequired",
                "challengerOnly",
                "previousRenderComparisonRequired",
                "protectedPhaseRegressionVeto",
                "priorPhaseReviewRequired",
                "priorPhaseImprovementAllowed",
                "priorPhaseIsNotFrozen",
            ):
                if authority.get(field) is not True:
                    errors.append(
                        f"phaseExecutionContract.correctionAuthority.{field} must be true"
                    )
            if not isinstance(authority.get("rule"), str) or len(
                authority.get("rule", "").strip()
            ) < 24:
                errors.append(
                    "phaseExecutionContract.correctionAuthority.rule must be concrete"
                )
    cycle = contract.get("cycle")
    if not isinstance(cycle, dict):
        errors.append("phaseExecutionContract.cycle must be an object")
    else:
        expected_steps = (
            [
                "spec-delta",
                "build-render",
                "reference-comparison",
                "independent-review",
                "promote-or-rollback",
            ]
            if version == 1
            else [
                "spec-delta",
                "build-render",
                "reference-comparison",
                "blind-visual-scout",
                "independent-review",
                    *(
                        ["promote-or-rollback"]
                        if version == 2
                        else ["system-promote-or-rollback", "user-approval"]
                    ),
            ]
        )
        if cycle.get("steps") != expected_steps:
            errors.append(
                "phaseExecutionContract.cycle.steps must be the canonical visual loop "
                "for its contract version"
            )
        if cycle.get("maximumNonVisualOperationsBeforeRender") != 2:
            errors.append(
                "phaseExecutionContract.cycle.maximumNonVisualOperationsBeforeRender must be 2"
            )
        if cycle.get("visualProgressRequired") is not True:
            errors.append("phaseExecutionContract.cycle.visualProgressRequired must be true")
        if cycle.get("comparisonRequired") is not True:
            errors.append("phaseExecutionContract.cycle.comparisonRequired must be true")
        comparison_authority = cycle.get("comparisonAuthority")
        accepted_authorities = (
            {
                "observed-reference",
                "prepared-target-with-original-identity-guardrail",
                "source-image-only",
            }
            if version == 1
            else {"source-image-only"}
        )
        if comparison_authority not in accepted_authorities:
            errors.append(
                "phaseExecutionContract.cycle.comparisonAuthority must be "
                "'source-image-only' "
                "(legacy version 1 may use 'observed-reference')"
            )
        if cycle.get("maximumConsecutiveNonImprovements") != 3:
            errors.append(
                "phaseExecutionContract.cycle.maximumConsecutiveNonImprovements must be 3"
            )
    visual_scout = contract.get("visualScout")
    if version == 1:
        warnings.append(
            "quality: phaseExecutionContract version 1 has no blind visual scout; "
            "regenerate or upgrade the phase contract"
        )
    elif not isinstance(visual_scout, dict):
        errors.append("phaseExecutionContract.visualScout must be an object")
    else:
        phase_inputs = [] if version in {2, 3} else ["phaseId", "phaseRubric"]
        accepted_allowlists = [[
            "sourceImage",
            "currentRender",
            "previousRender",
            "sideBySideComparison",
            *phase_inputs,
        ]]
        required_denials = {
            "spec",
            "phasePacket",
            "componentIds",
            "parameters",
            "scores",
            "builderDefense",
            "primaryVerdict",
        }
        if visual_scout.get("required") is not True:
            errors.append("phaseExecutionContract.visualScout.required must be true")
        if visual_scout.get("role") != "blind-visual-scout":
            errors.append(
                "phaseExecutionContract.visualScout.role must be 'blind-visual-scout'"
            )
        if visual_scout.get("execution") != "parallel-with-primary-reviewer":
            errors.append(
                "phaseExecutionContract.visualScout.execution must be "
                "'parallel-with-primary-reviewer'"
            )
        if visual_scout.get("inputAllowlist") not in accepted_allowlists:
            errors.append(
                "phaseExecutionContract.visualScout.inputAllowlist must contain only "
                "sourceImage and the canonical image inputs"
                + (
                    ""
                    if version in {2, 3}
                    else " plus phaseId and phaseRubric"
                )
            )
        denylist = visual_scout.get("inputDenylist")
        if not isinstance(denylist, list) or not required_denials.issubset(
            {item for item in denylist if isinstance(item, str)}
        ):
            errors.append(
                "phaseExecutionContract.visualScout.inputDenylist must exclude spec, "
                "IDs, parameters, scores, builder defense, and primary verdict"
            )
        if version == 4:
            canonical_scout = blind_scout_execution_contract()
            for field in ("inputRule", "approvalRule"):
                if visual_scout.get(field) != canonical_scout[field]:
                    errors.append(
                        f"phaseExecutionContract.visualScout.{field} must match the canonical blind-input contract"
                    )
        output = visual_scout.get("output")
        if not isinstance(output, dict):
            errors.append("phaseExecutionContract.visualScout.output must be an object")
        else:
            if version in {2, 3}:
                for field in (
                    "advisoryOnly",
                    "scoresForbidden",
                    "verdictForbidden",
                    "numericFixesForbidden",
                ):
                    if output.get(field) is not True:
                        errors.append(
                            f"phaseExecutionContract.visualScout.output.{field} must be true"
                        )
                if output.get("gateAuthority") is not False:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.gateAuthority must be false"
                    )
                expected_scan_fields = ["visualRegion", "status", "observation"]
            else:
                if visual_scout.get("phaseRubrics") != blind_scout_phase_rubrics():
                    errors.append(
                        "phaseExecutionContract.visualScout.phaseRubrics must define "
                        "the canonical phase-scoped review categories"
                    )
                if output.get("artifactVersion") != BLIND_SCOUT_ARTIFACT_VERSION:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.artifactVersion "
                        f"must be {BLIND_SCOUT_ARTIFACT_VERSION}"
                    )
                if output.get("advisoryOnly") is not False:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.advisoryOnly must be false"
                    )
                if output.get("gateAuthority") is not True:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.gateAuthority must be true"
                    )
                for field in ("scoresForbidden", "numericFixesForbidden"):
                    if output.get(field) is not True:
                        errors.append(
                            f"phaseExecutionContract.visualScout.output.{field} must be true"
                        )
                if output.get("verdictForbidden") is not False:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.verdictForbidden must be false"
                    )
                if output.get("decisionValues") != ["approve", "reject"]:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.decisionValues must be approve, reject"
                    )
                if output.get("maxObservations") != MAX_BLIND_SCOUT_OBSERVATIONS:
                    errors.append(
                        "phaseExecutionContract.visualScout.output.maxObservations must be 7"
                    )
                if (
                    output.get("mainAgentMapping")
                    != blind_scout_execution_contract()["output"]["mainAgentMapping"]
                ):
                    errors.append(
                        "phaseExecutionContract.visualScout.output.mainAgentMapping "
                        "must match the canonical main-agent mapping contract"
                    )
                expected_scan_fields = [
                    "visualRegion",
                    "severity",
                    "category",
                    "phaseScope",
                    "direction",
                    "viewIds",
                ]
            expected_priority_fields = [
                "visualRegion",
                "category",
                *([] if version in {2, 3} else ["phaseScope"]),
                *([] if version in {2, 3} else ["severity"]),
                "direction",
                "viewIds",
            ]
            if output.get("componentScanFields") != expected_scan_fields:
                errors.append(
                    "phaseExecutionContract.visualScout.output.componentScanFields "
                    "must contain only the canonical blind-scout observation fields"
                )
            if output.get("priorityDirectionFields") != expected_priority_fields:
                errors.append(
                    "phaseExecutionContract.visualScout.output.priorityDirectionFields "
                    "must contain only the canonical blind-scout direction fields"
                )
    quality_gate = contract.get("qualityGate")
    if version == 4:
        if not isinstance(quality_gate, dict):
            errors.append("phaseExecutionContract.qualityGate must be an object")
        else:
            if "iouFloor" in quality_gate:
                errors.append(
                    "phaseExecutionContract.qualityGate.iouFloor has been removed"
                )
            if quality_gate.get("mode") != "ai-scout-human":
                errors.append(
                    "phaseExecutionContract.qualityGate.mode must be 'ai-scout-human'"
                )
            if quality_gate.get("aiOverallFloor") != SIMPLIFIED_AI_OVERALL_FLOOR:
                errors.append(
                    "phaseExecutionContract.qualityGate.aiOverallFloor must be 0.7"
                )
            if quality_gate.get("blindScoutDecisions") != ["approve", "reject"]:
                errors.append(
                    "phaseExecutionContract.qualityGate.blindScoutDecisions must be approve, reject"
                )
            if quality_gate.get("maxBlindScoutObservations") != MAX_BLIND_SCOUT_OBSERVATIONS:
                errors.append(
                    "phaseExecutionContract.qualityGate.maxBlindScoutObservations must be 7"
                )
    human_approval = contract.get("humanApproval")
    if version in {1, 2}:
        warnings.append(
            f"quality: phaseExecutionContract version {version} has no mandatory "
            "post-system user approval gate"
        )
    elif not isinstance(human_approval, dict):
        errors.append("phaseExecutionContract.humanApproval must be an object")
    else:
        perceptual = spec.get("perceptualContract")
        approval_mode = (
            perceptual.get("approvalMode")
            if isinstance(perceptual, dict)
            else "phase-by-phase"
        )
        expected_human_approval = human_approval_contract(
            str(approval_mode or "phase-by-phase")
        )
        if human_approval != expected_human_approval:
            errors.append(
                "phaseExecutionContract.humanApproval must match "
                f"perceptualContract.approvalMode={approval_mode!r}"
            )
    approvals = spec.get("userPhaseApprovals")
    if version in {3, 4} and not isinstance(approvals, list):
        errors.append("userPhaseApprovals must be an array")
    elif isinstance(approvals, list):
        valid_passes = set(canonical_pass_order(spec))
        for index, approval in enumerate(approvals):
            label = f"userPhaseApprovals[{index}]"
            if not isinstance(approval, dict):
                errors.append(f"{label} must be an object")
                continue
            if approval.get("passId") not in valid_passes:
                errors.append(f"{label}.passId must name an active phase")
            if approval.get("decision") not in {"approved", "changes-requested"}:
                errors.append(
                    f"{label}.decision must be approved or changes-requested"
                )
            review_key = approval.get("reviewKey")
            if not isinstance(review_key, str) or len(review_key) != 64:
                errors.append(f"{label}.reviewKey must be a SHA-256 digest")
            if not isinstance(approval.get("specHash"), str) or not approval["specHash"]:
                errors.append(f"{label}.specHash is required")
            if not isinstance(approval.get("reviewedArtifactSha256"), str):
                errors.append(f"{label}.reviewedArtifactSha256 must be a string")
            if not isinstance(approval.get("userStatement"), str) or not approval[
                "userStatement"
            ].strip():
                errors.append(f"{label}.userStatement is required")
            if not isinstance(approval.get("recordedAt"), str) or not approval[
                "recordedAt"
            ].strip():
                errors.append(f"{label}.recordedAt is required")
            feedback = approval.get("feedback")
            if not isinstance(feedback, list):
                errors.append(f"{label}.feedback must be an array")
                continue
            if approval.get("decision") == "approved" and feedback:
                errors.append(f"{label}.feedback must be empty for approved")
            if approval.get("decision") == "changes-requested" and not feedback:
                errors.append(f"{label}.feedback is required for changes-requested")
            for feedback_index, item in enumerate(feedback):
                feedback_label = f"{label}.feedback[{feedback_index}]"
                if not isinstance(item, dict):
                    errors.append(f"{feedback_label} must be an object")
                    continue
                for field in ("visualRegion", "problem", "expectedDirection"):
                    if not isinstance(item.get(field), str) or not item[field].strip():
                        errors.append(f"{feedback_label}.{field} is required")
    deferred = contract.get("deferredWork")
    if not isinstance(deferred, dict):
        errors.append("phaseExecutionContract.deferredWork must be an object")
    else:
        for phase in ("form", "lookdev", "interaction", "finalization"):
            validate_string_array(
                deferred.get(phase),
                f"phaseExecutionContract.deferredWork.{phase}",
                errors,
            )


def validate_quality_depth(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
    for_pass: str | None = None,
) -> None:
    if for_pass is not None:
        return
    contract = spec.get("qualityContract")
    if not isinstance(contract, dict) or not isinstance(contract.get("minimumSpecDepth"), dict):
        return
    minimums = contract["minimumSpecDepth"]
    components = [
        item
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and component_type(item) != "assembly"
    ]
    level_counts = {
        "macroComponents": sum(1 for item in components if item.get("level") == "macro"),
        "mesoComponents": sum(1 for item in components if item.get("level") == "meso"),
        "microFeatureGroups": detail_feature_count(spec),
        "materials": len([item for item in spec.get("materials", []) if isinstance(item, dict)]),
        "repetitionSystems": len([item for item in spec.get("repetitionSystems", []) if isinstance(item, dict)]),
    }
    for field, actual in level_counts.items():
        required = minimums.get(field)
        if isinstance(required, int) and actual < required:
            warnings.append(
                f"quality: qualityContract {field} minimum is not met ({actual} < {required})"
            )


def validate_action_readiness(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    readiness = spec.get("actionReadiness")
    if readiness is None:
        warnings.append("missing actionReadiness; generated model may not be ready for animation/transformation/destruction")
        return
    if not isinstance(readiness, dict):
        errors.append("actionReadiness must be an object")
        return
    for field in ("contract", "defaultRigType", "rootMotionNode"):
        value = readiness.get(field)
        if value is not None and not isinstance(value, str):
            errors.append(f"actionReadiness.{field} must be a string")
    for field in ("requiredComponentFields", "transformChannels", "authoringRules"):
        validate_string_array(readiness.get(field), f"actionReadiness.{field}", errors)
    policy = readiness.get("destructionPolicy")
    if policy is not None and not isinstance(policy, dict):
        errors.append("actionReadiness.destructionPolicy must be an object")


def validate_interaction_contract(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    contract = spec.get("interactionContract")
    if not schema_at_least(spec, "3.2") and contract is None:
        return
    if not isinstance(contract, dict):
        errors.append("interactionContract must be an object")
        return
    status = contract.get("status")
    if status not in {"unassessed", "not-required", "required"}:
        errors.append(
            "interactionContract.status must be unassessed, not-required, or required"
        )
    elif status == "unassessed":
        warnings.append(
            "quality: interactionContract is unassessed; resolve it in the interaction phase"
        )
    elif not isinstance(contract.get("assessmentReason"), str) or len(
        contract.get("assessmentReason", "").strip()
    ) < 8:
        errors.append(
            "interactionContract.assessmentReason is required once motion is assessed"
        )
    if contract.get("policy") != "auto-infer":
        errors.append("interactionContract.policy must be 'auto-infer'")
    threshold = contract.get("activationThreshold")
    validate_unit_interval(
        threshold,
        "interactionContract.activationThreshold",
        errors,
    )
    validate_string_array(contract.get("rules"), "interactionContract.rules", errors)
    affordances = contract.get("motionAffordances")
    if not isinstance(affordances, list):
        errors.append("interactionContract.motionAffordances must be an array")
        return
    component_ids = {
        item.get("id")
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    evidence_ids = {
        item.get("id")
        for item in spec.get("viewEvidence", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    known_ids: set[str] = set()
    active = 0
    for index, affordance in enumerate(affordances):
        label = f"interactionContract.motionAffordances[{index}]"
        if not isinstance(affordance, dict):
            errors.append(f"{label} must be an object")
            continue
        affordance_id = affordance.get("id")
        if not isinstance(affordance_id, str) or not affordance_id.strip():
            errors.append(f"{label}.id is required")
        elif affordance_id in known_ids:
            errors.append(f"duplicate motion affordance id {affordance_id!r}")
        else:
            known_ids.add(affordance_id)
        component_id = affordance.get("componentId")
        if not isinstance(component_id, str) or component_id not in component_ids:
            errors.append(f"{label}.componentId must reference an existing component id")
        if affordance.get("behavior") not in {
            "continuous-rotation",
            "hinge",
            "translation",
            "oscillation",
            "articulation",
            "deformation",
            "detach",
        }:
            errors.append(f"{label}.behavior is invalid")
        for field in ("pivot", "axis"):
            if not as_number_list(affordance.get(field), 3):
                errors.append(f"{label}.{field} must be [number, number, number]")
        source = affordance.get("source")
        if source not in {"observed", "domain-prior", "user"}:
            errors.append(f"{label}.source must be observed, domain-prior, or user")
        confidence = affordance.get("confidence")
        validate_unit_interval(confidence, f"{label}.confidence", errors)
        refs = affordance.get("evidenceRefs")
        validate_string_array(refs, f"{label}.evidenceRefs", errors)
        if isinstance(refs, list):
            missing = sorted(set(refs) - evidence_ids)
            if missing:
                errors.append(
                    f"{label}.evidenceRefs references missing evidence: "
                    + ", ".join(missing)
                )
        enabled = affordance.get("enabledByDefault")
        if not isinstance(enabled, bool):
            errors.append(f"{label}.enabledByDefault must be boolean")
        elif enabled:
            active += 1
            if source != "user" and is_number(confidence) and is_number(threshold) and float(confidence) < float(threshold):
                errors.append(
                    f"{label} cannot auto-activate below interactionContract.activationThreshold"
                )
        if not any(field in affordance for field in ("rate", "limits")):
            errors.append(f"{label} needs numeric rate or limits")
        if "rate" in affordance and not is_number(affordance.get("rate")):
            errors.append(f"{label}.rate must be a finite number")
        limits = affordance.get("limits")
        if limits is not None and not (
            isinstance(limits, list)
            and len(limits) == 2
            and all(is_number(item) for item in limits)
            and float(limits[0]) <= float(limits[1])
        ):
            errors.append(f"{label}.limits must be [minimum, maximum]")
    if status == "required" and active == 0:
        warnings.append(
            "quality: interactionContract.status is required but no motion affordance is enabled"
        )
    if status == "not-required" and active:
        errors.append(
            "interactionContract.status not-required cannot contain enabled motion affordances"
        )
    readiness = spec.get("actionReadiness")
    if isinstance(readiness, dict) and readiness.get("enabled") is not (status == "required"):
        errors.append(
            "actionReadiness.enabled must match interactionContract.status == 'required'"
        )


def validate_self_correct_loop(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    loop = spec.get("selfCorrectLoop")
    if loop is None:
        warnings.append("missing selfCorrectLoop; construction may not review/refine after each pass")
        return
    if not isinstance(loop, dict):
        errors.append("selfCorrectLoop must be an object")
        return
    enabled = loop.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        errors.append("selfCorrectLoop.enabled must be boolean")
    for field in ("reviewAfterPasses", "allowedActions", "specRefineTriggers", "codeRefineTriggers", "stopCriteria"):
        validate_string_array(loop.get(field), f"selfCorrectLoop.{field}", errors)
    actions = loop.get("allowedActions", [])
    if isinstance(actions, list):
        for action in actions:
            if action not in VALID_REVIEW_ACTIONS:
                errors.append(f"selfCorrectLoop.allowedActions contains invalid action {action!r}")
    visual_acceptance = loop.get("visualAcceptance")
    if visual_acceptance is None:
        warnings.append("quality: selfCorrectLoop.visualAcceptance is missing; AI vision cannot enforce visual fidelity")
    elif not isinstance(visual_acceptance, dict):
        errors.append("selfCorrectLoop.visualAcceptance must be an object")
    else:
        reviewer = visual_acceptance.get("reviewer")
        if reviewer is not None and not isinstance(reviewer, str):
            errors.append("selfCorrectLoop.visualAcceptance.reviewer must be a string")
        target_fidelity = (
            spec.get("qualityTargets", {}).get("targetFidelity")
            if isinstance(spec.get("qualityTargets"), dict)
            else None
        )
        for field in ("threshold", "minimumAiVisionScore"):
            value = visual_acceptance.get(field)
            if value is None:
                warnings.append(f"quality: selfCorrectLoop.visualAcceptance.{field} is missing")
                continue
            validate_unit_interval(value, f"selfCorrectLoop.visualAcceptance.{field}", errors)
            if (
                phase_execution_version(spec) < 4
                and is_number(value)
                and is_number(target_fidelity)
                and float(value) < float(target_fidelity)
            ):
                errors.append(
                    f"selfCorrectLoop.visualAcceptance.{field} cannot be below "
                    "qualityTargets.targetFidelity"
                )
        for field in (
            "comparisonArtifactRequired",
            "layerScoresRequired",
            "codePixelDiffIsAcceptanceAuthority",
        ):
            value = visual_acceptance.get(field)
            if value is not None and not isinstance(value, bool):
                errors.append(f"selfCorrectLoop.visualAcceptance.{field} must be boolean")
        scoring_rule = visual_acceptance.get("scoringRule")
        if scoring_rule is not None and not isinstance(scoring_rule, str):
            errors.append("selfCorrectLoop.visualAcceptance.scoringRule must be a string")
        validate_string_array(
            visual_acceptance.get("requiredLayerScores"),
            "selfCorrectLoop.visualAcceptance.requiredLayerScores",
            errors,
        )
        feature_policy = visual_acceptance.get("featureReviewPolicy")
        if feature_policy is None:
            if phase_execution_version(spec) >= 4:
                errors.append(
                    "selfCorrectLoop.visualAcceptance.featureReviewPolicy is required "
                    "for phaseExecutionContract version 4"
                )
            else:
                warnings.append("quality: visualAcceptance.featureReviewPolicy is missing")
        elif not isinstance(feature_policy, dict):
            errors.append("selfCorrectLoop.visualAcceptance.featureReviewPolicy must be an object")
        else:
            if (
                phase_execution_version(spec) >= 4
                and feature_policy.get("enabled") is not True
            ):
                errors.append(
                    "selfCorrectLoop.visualAcceptance.featureReviewPolicy.enabled "
                    "must be true for phaseExecutionContract version 4"
                )
            for field in (
                "enabled",
                "adaptiveEscalation",
                "singleImagePairOnly",
            ):
                value = feature_policy.get(field)
                if value is not None and not isinstance(value, bool):
                    errors.append(
                        f"selfCorrectLoop.visualAcceptance.featureReviewPolicy.{field} must be boolean"
                    )
            for field in ("maxCriticalFeaturesPerPass", "maxImportantFeaturesPerPass"):
                value = feature_policy.get(field)
                if value is not None:
                    validate_nonnegative_int(
                        value,
                        f"selfCorrectLoop.visualAcceptance.featureReviewPolicy.{field}",
                        errors,
                    )
            for field in ("criticalDefaultThreshold", "importantAverageThreshold"):
                value = feature_policy.get(field)
                if value is not None:
                    validate_unit_interval(
                        value,
                        f"selfCorrectLoop.visualAcceptance.featureReviewPolicy.{field}",
                        errors,
                    )
            for field in ("reviewUnit", "selectionRule"):
                value = feature_policy.get(field)
                if value is not None and not isinstance(value, str):
                    errors.append(
                        f"selfCorrectLoop.visualAcceptance.featureReviewPolicy.{field} must be a string"
                    )
    sanity = loop.get("visualSanity")
    if schema_at_least(spec, "3.2"):
        if not isinstance(sanity, dict):
            errors.append("selfCorrectLoop.visualSanity must be an object for schema 3.2")
        else:
            if sanity.get("enabled") is not True:
                errors.append("selfCorrectLoop.visualSanity.enabled must be true")
            if sanity.get("obviousErrorVeto") is not True:
                errors.append(
                    "selfCorrectLoop.visualSanity.obviousErrorVeto must be true"
                )
            validate_string_array(
                sanity.get("categories"),
                "selfCorrectLoop.visualSanity.categories",
                errors,
            )
            if sanity.get("requiredVerdictField") != "sanityChecks":
                errors.append(
                    "selfCorrectLoop.visualSanity.requiredVerdictField must be 'sanityChecks'"
                )
    policy = loop.get("screenshotPolicy")
    if policy is None:
        warnings.append("selfCorrectLoop.screenshotPolicy is missing; visual review may drift without screenshots")
    elif not isinstance(policy, dict):
        errors.append("selfCorrectLoop.screenshotPolicy must be an object")
    else:
        validate_string_array(policy.get("requiredForPasses"), "selfCorrectLoop.screenshotPolicy.requiredForPasses", errors)
        for field in (
            "preferredCapture",
            "fallbackCapture",
            "minimumEvidence",
            "reviewPairRule",
            "acceptanceAuthority",
        ):
            value = policy.get(field)
            if value is not None and not isinstance(value, str):
                errors.append(f"selfCorrectLoop.screenshotPolicy.{field} must be a string")


def validate_visual_evidence_item(item: Any, label: str, errors: list[str]) -> None:
    if not isinstance(item, dict):
        errors.append(f"{label} must be an object")
        return
    for field in (
        "passId",
        "referenceScreenshot",
        "renderScreenshot",
        "comparisonImage",
        "cameraView",
        "notes",
        "aiVisionNotes",
    ):
        value = item.get(field)
        if value is not None and not isinstance(value, str):
            errors.append(f"{label}.{field} must be a string")
    fidelity = item.get("estimatedFidelity")
    if fidelity is not None:
        validate_unit_interval(fidelity, f"{label}.estimatedFidelity", errors)
    score = item.get("aiVisionScore")
    if score is not None:
        validate_unit_interval(score, f"{label}.aiVisionScore", errors)
    threshold = item.get("visualAcceptanceThreshold")
    if threshold is not None:
        validate_unit_interval(threshold, f"{label}.visualAcceptanceThreshold", errors)
    layer_scores = item.get("layerScores")
    if layer_scores is not None:
        if not isinstance(layer_scores, dict):
            errors.append(f"{label}.layerScores must be an object")
        else:
            for key, value in layer_scores.items():
                if not isinstance(key, str):
                    errors.append(f"{label}.layerScores keys must be strings")
                if not is_number(value) or value < 0 or value > 1:
                    errors.append(f"{label}.layerScores.{key} must be a number from 0 to 1")


def validate_fit_diagnostics(value: Any, label: str, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    if value.get("acceptanceAuthority") is not False:
        errors.append(f"{label}.acceptanceAuthority must be false")
    for field in (
        "centroidDelta",
        "aspectRatioDelta",
        "normalizedContourDistance",
    ):
        if field in value:
            validate_unit_interval(value[field], f"{label}.{field}", errors)
    appearance = value.get("appearance")
    if appearance is not None:
        if not isinstance(appearance, dict):
            errors.append(f"{label}.appearance must be an object")
        else:
            for field in (
                "detailEnergyRatio",
                "edgeDensityRatio",
                "foregroundHistogramIntersection",
                "foregroundMeanColorDelta",
                "highlightCoverageRatio",
                "highlightEnergyRatio",
            ):
                if field in appearance:
                    validate_unit_interval(
                        appearance[field], f"{label}.appearance.{field}", errors
                    )


def validate_feature_review_targets(
    spec: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    targets = spec.get("featureReviewTargets")
    policy = feature_review_policy(spec)
    if targets is None:
        if policy.get("enabled") is True:
            errors.append("featureReviewTargets must be an array when feature review is enabled")
        else:
            warnings.append("quality: featureReviewTargets is missing; feature-level visual gating is disabled")
        return
    if not isinstance(targets, list):
        errors.append("featureReviewTargets must be an array")
        return
    if not targets:
        warnings.append("quality: featureReviewTargets is empty; component-level visual gaps can hide in the overall score")
        return
    ids: set[str] = set()
    critical_by_pass: dict[str, int] = {}
    important_by_pass: dict[str, int] = {}
    known_passes = set(canonical_pass_order(spec))
    known_components = {
        item.get("id")
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    known_evidence = {
        item.get("id")
        for item in spec.get("viewEvidence", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for index, target in enumerate(targets):
        label = f"featureReviewTargets[{index}]"
        if not isinstance(target, dict):
            errors.append(f"{label} must be an object")
            continue
        target_id = target.get("id")
        if not isinstance(target_id, str) or not target_id.strip():
            errors.append(f"{label}.id is required")
        elif target_id in ids:
            errors.append(f"duplicate feature review target id {target_id!r}")
        else:
            ids.add(target_id)
        if not isinstance(target.get("name"), str) or not target["name"].strip():
            errors.append(f"{label}.name is required")
        tier = target.get("tier")
        if tier not in {"critical", "important", "detail"}:
            errors.append(f"{label}.tier must be critical, important, or detail")
        validate_string_array(target.get("passIds"), f"{label}.passIds", errors)
        validate_string_array(target.get("componentRefs"), f"{label}.componentRefs", errors)
        validate_string_array(target.get("evidenceRefs"), f"{label}.evidenceRefs", errors)
        validate_string_array(target.get("reviewViewIds"), f"{label}.reviewViewIds", errors)
        validate_string_array(target.get("criteria"), f"{label}.criteria", errors)
        for pass_id in target.get("passIds", []) if isinstance(target.get("passIds"), list) else []:
            if isinstance(pass_id, str) and pass_id not in known_passes:
                errors.append(f"{label}.passIds references unknown pass {pass_id!r}")
        for component_id in target.get("componentRefs", []) if isinstance(target.get("componentRefs"), list) else []:
            if isinstance(component_id, str) and component_id not in known_components:
                errors.append(f"{label}.componentRefs references unknown component {component_id!r}")
        for evidence_id in target.get("evidenceRefs", []) if isinstance(target.get("evidenceRefs"), list) else []:
            if isinstance(evidence_id, str) and evidence_id not in known_evidence:
                errors.append(f"{label}.evidenceRefs references unknown evidence {evidence_id!r}")
        for view_id in target.get("reviewViewIds", []) if isinstance(target.get("reviewViewIds"), list) else []:
            if isinstance(view_id, str) and view_id not in known_evidence:
                errors.append(f"{label}.reviewViewIds references unknown evidence {view_id!r}")
        minimum = target.get("minimumScore")
        if minimum is not None:
            validate_unit_interval(minimum, f"{label}.minimumScore", errors)
        for field in ("mustPass", "requiresDedicatedEvidence"):
            value = target.get(field)
            if value is not None and not isinstance(value, bool):
                errors.append(f"{label}.{field} must be boolean")
        if target.get("requiresDedicatedEvidence") is True and not target.get("reviewViewIds"):
            errors.append(f"{label}.reviewViewIds is required for dedicated evidence")
        if tier == "critical" or target.get("mustPass") is True:
            pass_ids = target.get("passIds", [])
            if isinstance(pass_ids, list):
                for pass_id in pass_ids:
                    if isinstance(pass_id, str):
                        critical_by_pass[pass_id] = critical_by_pass.get(pass_id, 0) + 1
        elif tier == "important":
            pass_ids = target.get("passIds", [])
            if isinstance(pass_ids, list):
                for pass_id in pass_ids:
                    if isinstance(pass_id, str):
                        important_by_pass[pass_id] = important_by_pass.get(pass_id, 0) + 1
    maximum = policy.get("maxCriticalFeaturesPerPass", 5)
    if is_number(maximum):
        for pass_id, count in critical_by_pass.items():
            if count > int(maximum):
                errors.append(
                    f"pass {pass_id!r} has {count} critical feature targets; "
                    f"maximum is {int(maximum)}"
                )
    important_maximum = policy.get("maxImportantFeaturesPerPass", 3)
    if is_number(important_maximum):
        for pass_id, count in important_by_pass.items():
            if count > int(important_maximum):
                errors.append(
                    f"pass {pass_id!r} has {count} important feature targets; "
                    f"maximum is {int(important_maximum)}"
                )
    if feature_targets_are_generic(spec):
        warnings.append(
            "quality: replace generic starter featureReviewTargets with object-specific "
            "identity-defining semantic systems before strict validation"
        )


def validate_feature_reviews(
    entry: dict[str, Any],
    label: str,
    errors: list[str],
) -> None:
    reviews = entry.get("featureReviews")
    if reviews is None:
        return
    if not isinstance(reviews, list):
        errors.append(f"{label}.featureReviews must be an array")
        return
    ids: set[str] = set()
    for index, review in enumerate(reviews):
        item_label = f"{label}.featureReviews[{index}]"
        if not isinstance(review, dict):
            errors.append(f"{item_label} must be an object")
            continue
        feature_id = review.get("id")
        if not isinstance(feature_id, str) or not feature_id.strip():
            errors.append(f"{item_label}.id is required")
        elif feature_id in ids:
            errors.append(f"{label}.featureReviews has duplicate id {feature_id!r}")
        else:
            ids.add(feature_id)
        score = review.get("score")
        if score is not None:
            validate_unit_interval(score, f"{item_label}.score", errors)
        for field in ("notes",):
            value = review.get(field)
            if value is not None and not isinstance(value, str):
                errors.append(f"{item_label}.{field} must be a string")
        visible = review.get("visible")
        if visible is not None and not isinstance(visible, bool):
            errors.append(f"{item_label}.visible must be boolean")
        validate_string_array(review.get("viewIds"), f"{item_label}.viewIds", errors)


def validate_review_history(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    history = spec.get("reviewHistory", [])
    if history is None:
        return
    if not isinstance(history, list):
        errors.append("reviewHistory must be an array")
        return
    for index, entry in enumerate(history):
        label = f"reviewHistory[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{label} must be an object")
            continue
        pass_id = entry.get("passId")
        if not isinstance(pass_id, str) or not pass_id.strip():
            errors.append(f"{label}.passId is required")
        action = entry.get("action")
        if action not in VALID_REVIEW_ACTIONS:
            errors.append(f"{label}.action is invalid")
        if schema_at_least(spec, "3.0"):
            review_hash = entry.get("specHash")
            if not isinstance(review_hash, str) or not review_hash:
                errors.append(f"{label}.specHash is required for schema 3")
            if not isinstance(entry.get("summary"), str) or not entry["summary"].strip():
                errors.append(f"{label}.summary is required for schema 3")
        fidelity = entry.get("estimatedFidelity")
        if fidelity is not None:
            validate_unit_interval(fidelity, f"{label}.estimatedFidelity", errors)
        for field in ("matched", "mismatches", "specFixes", "codeFixes", "extraEvidence"):
            validate_string_array(entry.get(field), f"{label}.{field}", errors)
        root_cause = entry.get("rootCause")
        if root_cause is not None and root_cause not in VALID_REVIEW_ROOT_CAUSES:
            errors.append(f"{label}.rootCause is invalid")
        correction_plan = entry.get("correctionPlan")
        if correction_plan is not None:
            if not isinstance(correction_plan, list):
                errors.append(f"{label}.correctionPlan must be an array")
            else:
                for correction_index, correction in enumerate(correction_plan):
                    correction_label = f"{label}.correctionPlan[{correction_index}]"
                    if not isinstance(correction, dict):
                        errors.append(f"{correction_label} must be an object")
                        continue
                    if "operation" in correction or "targetType" in correction:
                        for field in (
                            "targetType",
                            "target",
                            "parameterPath",
                            "operation",
                            "unit",
                            "reason",
                        ):
                            if not isinstance(correction.get(field), str) or not correction[field].strip():
                                errors.append(f"{correction_label}.{field} is required")
                        for field in ("beforeValue", "value", "expectedValue"):
                            if field not in correction:
                                errors.append(f"{correction_label}.{field} is required")
                        if not isinstance(correction.get("expectedDelta"), dict):
                            errors.append(f"{correction_label}.expectedDelta must be an object")
                    else:
                        for field in ("target", "parameterPath", "action", "reason"):
                            if not isinstance(correction.get(field), str) or not correction[field].strip():
                                errors.append(f"{correction_label}.{field} is required")
                        if correction.get("action") not in VALID_CORRECTION_ACTIONS:
                            errors.append(
                                f"{correction_label}.action must be one of: "
                                + ", ".join(sorted(VALID_CORRECTION_ACTIONS))
                            )
        correction_batch = entry.get("correctionBatch")
        if correction_batch is not None:
            if not isinstance(correction_batch, dict):
                errors.append(f"{label}.correctionBatch must be an object")
            else:
                if correction_batch.get("artifactType") != "threejs-sculpt-correction-batch":
                    errors.append(f"{label}.correctionBatch artifactType is invalid")
                batch_version = correction_batch.get("version")
                if batch_version not in {1, 2}:
                    errors.append(f"{label}.correctionBatch version must be 1 or 2")
                if correction_batch.get("atomic") is not True:
                    errors.append(f"{label}.correctionBatch.atomic must be true")
                batch_corrections = correction_batch.get("corrections")
                if not isinstance(batch_corrections, list) or not batch_corrections:
                    errors.append(f"{label}.correctionBatch.corrections must be non-empty")
                elif batch_version == 2:
                    for batch_index, correction in enumerate(batch_corrections):
                        correction_label = (
                            f"{label}.correctionBatch.corrections[{batch_index}]"
                        )
                        if not isinstance(correction, dict):
                            errors.append(f"{correction_label} must be an object")
                            continue
                        for field in (
                            "issueId",
                            "scope",
                            "targetType",
                            "target",
                            "parameterPath",
                            "operation",
                            "unit",
                            "change",
                        ):
                            if not isinstance(correction.get(field), str) or not correction[field].strip():
                                errors.append(f"{correction_label}.{field} is required")
                        for field in ("beforeValue", "value", "expectedValue"):
                            if field not in correction:
                                errors.append(f"{correction_label}.{field} is required")
                        expected_delta = correction.get("expectedDelta")
                        if not isinstance(expected_delta, dict):
                            errors.append(f"{correction_label}.expectedDelta must be an object")
                scopes = correction_batch.get("scopes")
                if (
                    not isinstance(scopes, list)
                    or not scopes
                    or any(scope not in {"spec", "code"} for scope in scopes)
                ):
                    errors.append(f"{label}.correctionBatch.scopes must contain spec and/or code")
        if (
            spec.get("qualityProfile") == "reference-fidelity"
            and action in {"refine-spec", "refine-code", "refine-batch"}
        ):
            if root_cause in {None, ""}:
                warnings.append(f"quality: {label} refinement needs a classified rootCause")
            if not correction_plan and not isinstance(correction_batch, dict):
                warnings.append(f"quality: {label} refinement needs a structured correctionPlan")
        legacy_visual = entry.get("visualEvidence")
        if legacy_visual is not None:
            validate_visual_evidence_item(legacy_visual, f"{label}.visualEvidence", errors)
        evidence = entry.get("evidence")
        if evidence is not None:
            if isinstance(evidence, list) and not schema_at_least(spec, "3.0"):
                validate_string_array(evidence, f"{label}.evidence", errors)
            elif not isinstance(evidence, dict):
                errors.append(f"{label}.evidence must be an object")
            elif evidence.get("type") == "visual":
                views = evidence.get("views")
                if not isinstance(views, list) or not views:
                    errors.append(f"{label}.evidence.views must be a non-empty array")
                else:
                    for view_index, view in enumerate(views):
                        view_label = f"{label}.evidence.views[{view_index}]"
                        if not isinstance(view, dict):
                            errors.append(f"{view_label} must be an object")
                            continue
                        for field in ("viewId", "referenceImage", "renderScreenshot", "comparisonImage"):
                            if not isinstance(view.get(field), str) or not view[field].strip():
                                errors.append(f"{view_label}.{field} is required")
                        validate_fit_diagnostics(
                            view.get("fitDiagnostics"),
                            f"{view_label}.fitDiagnostics",
                            errors,
                        )
                        overlay = view.get("diagnosticOverlay")
                        if overlay is not None and (
                            not isinstance(overlay, str) or not overlay.strip()
                        ):
                            errors.append(f"{view_label}.diagnosticOverlay must be a string")
                for field in (
                    "artifactType",
                    "generator",
                    "manifestSha256",
                    "comparisonImage",
                    "comparisonSha256",
                ):
                    value = evidence.get(field)
                    if value is not None and (not isinstance(value, str) or not value.strip()):
                        errors.append(f"{label}.evidence.{field} must be a non-empty string")
                manifest_version = evidence.get("manifestVersion")
                if manifest_version is not None and (
                    not isinstance(manifest_version, int) or isinstance(manifest_version, bool)
                ):
                    errors.append(f"{label}.evidence.manifestVersion must be an integer")
        reviewer = entry.get("reviewerEvidence")
        if reviewer is not None:
            if not isinstance(reviewer, dict):
                errors.append(f"{label}.reviewerEvidence must be an object")
            else:
                for field in ("type", "model", "reviewedArtifactSha256", "reviewedAt"):
                    if not isinstance(reviewer.get(field), str) or not reviewer[field].strip():
                        errors.append(f"{label}.reviewerEvidence.{field} is required")
        validate_feature_reviews(entry, label, errors)
        runtime_checks = entry.get("runtimeChecks")
        if runtime_checks is not None and (
            not isinstance(runtime_checks, dict)
            or not all(isinstance(value, bool) for value in runtime_checks.values())
        ):
            errors.append(f"{label}.runtimeChecks must contain boolean values")
        metrics = entry.get("metrics")
        if metrics is not None and (
            not isinstance(metrics, dict)
            or not all(is_number(value) for value in metrics.values())
        ):
            errors.append(f"{label}.metrics must contain finite numeric values")
        artifacts = entry.get("artifacts")
        if artifacts is not None and (
            not isinstance(artifacts, dict)
            or not all(isinstance(value, str) and value.strip() for value in artifacts.values())
        ):
            errors.append(f"{label}.artifacts must contain non-empty path or URL strings")
        if (
            action == "continue"
            and entry.get("accepted") is not False
            and isinstance(pass_id, str)
        ):
            for failure in review_failures(spec, entry, pass_id):
                warnings.append(f"quality: {label} gate failed: {failure}")


def validate_visual_evidence_history(spec: dict[str, Any], errors: list[str]) -> None:
    visual_history = spec.get("visualEvidence", [])
    if visual_history is None:
        return
    if not isinstance(visual_history, list):
        errors.append("visualEvidence must be an array")
        return
    for index, item in enumerate(visual_history):
        validate_visual_evidence_item(item, f"visualEvidence[{index}]", errors)


def validate_build_passes(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> list[str]:
    build_passes = spec.get("buildPasses")
    if build_passes is None:
        warnings.append("quality: missing buildPasses; model construction can skip blockout/structural/material gates")
        return []
    if not isinstance(build_passes, list):
        errors.append("buildPasses must be an array")
        return []
    ids: list[str] = []
    known_components = {
        item.get("id")
        for item in spec.get("componentTree", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for index, item in enumerate(build_passes):
        if not isinstance(item, dict):
            errors.append(f"buildPasses[{index}] must be an object")
            continue
        pass_id = item.get("id")
        if not isinstance(pass_id, str) or not pass_id.strip():
            errors.append(f"buildPasses[{index}].id is required")
            continue
        if pass_id in ids:
            errors.append(f"duplicate buildPasses id {pass_id!r}")
        ids.append(pass_id)
        for field in ("goal", "label", "objective"):
            value = item.get(field)
            if value is not None and not isinstance(value, str):
                errors.append(f"buildPasses[{index}].{field} must be a string")
        validate_string_array(item.get("componentRefs"), f"buildPasses[{index}].componentRefs", errors)
        validate_string_array(item.get("acceptance"), f"buildPasses[{index}].acceptance", errors)
        if isinstance(item.get("componentRefs"), list):
            for component_id in item["componentRefs"]:
                if isinstance(component_id, str) and component_id not in known_components:
                    errors.append(
                        f"buildPasses[{index}].componentRefs references unknown component {component_id!r}"
                    )
        evidence_kind = item.get("evidenceType")
        if evidence_kind is not None and evidence_kind not in {"visual", "runtime", "metrics"}:
            errors.append(f"buildPasses[{index}].evidenceType must be visual, runtime, or metrics")
        if schema_at_least(spec, "3.0") and evidence_kind is None:
            errors.append(f"buildPasses[{index}].evidenceType is required for schema 3")
        validate_string_array(item.get("requiredViews"), f"buildPasses[{index}].requiredViews", errors)
        validate_string_array(
            item.get("diagnosticViews"),
            f"buildPasses[{index}].diagnosticViews",
            errors,
        )
        validate_string_array(
            item.get("requiredRuntimeChecks"),
            f"buildPasses[{index}].requiredRuntimeChecks",
            errors,
        )
        validate_string_array(
            item.get("requiredMetrics"),
            f"buildPasses[{index}].requiredMetrics",
            errors,
        )
        validate_string_array(
            item.get("requiredArtifacts"),
            f"buildPasses[{index}].requiredArtifacts",
            errors,
        )
        layer_targets = item.get("requiredLayerScores")
        if layer_targets is not None and (
            not isinstance(layer_targets, dict)
            or not all(is_number(value) and 0 <= float(value) <= 1 for value in layer_targets.values())
        ):
            errors.append(f"buildPasses[{index}].requiredLayerScores must contain scores from 0 to 1")
        if schema_at_least(spec, "3.2") and evidence_kind == "visual":
            sanity = item.get("visualSanity")
            if not isinstance(sanity, dict):
                errors.append(f"buildPasses[{index}].visualSanity must be an object")
            else:
                if sanity.get("obviousErrorVeto") is not True:
                    errors.append(
                        f"buildPasses[{index}].visualSanity.obviousErrorVeto must be true"
                    )
                categories = sanity.get("requiredCategories")
                validate_string_array(
                    categories,
                    f"buildPasses[{index}].visualSanity.requiredCategories",
                    errors,
                )
                if (
                    phase_execution_version(spec) < 4
                    and isinstance(categories, list)
                    and isinstance(layer_targets, dict)
                ):
                    missing_scores = sorted(set(categories) - set(layer_targets))
                    if missing_scores:
                        errors.append(
                            f"buildPasses[{index}] visual sanity categories need layer-score floors: "
                            + ", ".join(missing_scores)
                        )
        metric_targets = item.get("metricTargets")
        if metric_targets is not None:
            if not isinstance(metric_targets, dict):
                errors.append(f"buildPasses[{index}].metricTargets must be an object")
            else:
                for metric, target in metric_targets.items():
                    if not isinstance(target, dict) or not any(is_number(target.get(bound)) for bound in ("min", "max")):
                        errors.append(
                            f"buildPasses[{index}].metricTargets.{metric} needs a finite min or max"
                        )
        if schema_at_least(spec, "3.0"):
            if evidence_kind == "visual" and (
                not item.get("requiredViews")
                or (
                    phase_execution_version(spec) < 4
                    and not item.get("requiredLayerScores")
                )
            ):
                errors.append(
                    f"buildPasses[{index}] visual evidence needs requiredViews and requiredLayerScores"
                )
            if evidence_kind == "runtime" and not item.get("requiredRuntimeChecks"):
                errors.append(
                    f"buildPasses[{index}] runtime evidence needs requiredRuntimeChecks"
                )
            if evidence_kind == "metrics" and (
                not item.get("requiredMetrics") or not item.get("requiredArtifacts")
            ):
                errors.append(
                    f"buildPasses[{index}] metrics evidence needs requiredMetrics and requiredArtifacts"
                )
            if item.get("requiredPostOptimizationVisualReview") is not None and not isinstance(
                item.get("requiredPostOptimizationVisualReview"), bool
            ):
                errors.append(
                    f"buildPasses[{index}].requiredPostOptimizationVisualReview must be boolean"
                )
            if item.get("maximumVisualRegression") is not None:
                validate_unit_interval(
                    item["maximumVisualRegression"],
                    f"buildPasses[{index}].maximumVisualRegression",
                    errors,
                )
            if "maximumSilhouetteIouRegression" in item:
                errors.append(
                    f"buildPasses[{index}].maximumSilhouetteIouRegression has been removed"
                )
    if ids:
        if schema_at_least(spec, "3.2"):
            interaction = spec.get("interactionContract")
            expected = ["blockout", "form", "lookdev"]
            if isinstance(interaction, dict) and interaction.get("status") != "not-required":
                expected.append("interaction")
            if ids != expected:
                errors.append(
                    "schema 3.2 buildPasses must be exactly blockout, form, lookdev, "
                    "plus interaction while motion is unassessed or required"
                )
        if ids[0] != "blockout":
            warnings.append("quality: first build pass should be blockout")
        if not ({"form", "form-refinement"} & set(ids)):
            warnings.append("quality: missing form pass; shape refinement may be skipped")
        if not ({"lookdev", "material-pass"} & set(ids)):
            warnings.append("quality: missing lookdev/material pass; model may stay as flat geometry")
        if not schema_at_least(spec, "3.2") and spec.get("intendedUse") in {"browser-prop", "game-prop", "playable", "destructible"}:
            optimization = next(
                (
                    item
                    for item in build_passes
                    if isinstance(item, dict) and item.get("id") in {"optimization", "optimization-pass"}
                ),
                None,
            )
            if not isinstance(optimization, dict) or optimization.get(
                "requiredPostOptimizationVisualReview"
            ) is not True:
                warnings.append(
                    "quality: real-time optimization needs a fresh visual review and no-regression gate"
                )
    return ids


def validate_sculpt_pipeline(
    spec: dict[str, Any],
    build_pass_ids: list[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    pipeline = spec.get("sculptPipeline")
    if pipeline is None:
        warnings.append("quality: missing sculptPipeline; run the status/sync command")
        return
    if not isinstance(pipeline, dict):
        errors.append("sculptPipeline must be an object")
        return
    pass_order = pipeline.get("passOrder")
    if pass_order is None:
        warnings.append("quality: sculptPipeline.passOrder is missing")
        pass_order_ids = build_pass_ids
    else:
        validate_string_array(pass_order, "sculptPipeline.passOrder", errors)
        pass_order_ids = [str(value) for value in pass_order] if isinstance(pass_order, list) else build_pass_ids
    if build_pass_ids and pass_order_ids and pass_order_ids != build_pass_ids:
        warnings.append("sculptPipeline.passOrder differs from buildPasses order; sync the pipeline before generation")
    current = pipeline.get("currentPass")
    if current is not None and current != "complete" and current not in (pass_order_ids or build_pass_ids):
        errors.append("sculptPipeline.currentPass must be a known build pass or complete")
    completed = pipeline.get("completedPasses", [])
    validate_string_array(completed, "sculptPipeline.completedPasses", errors)
    if isinstance(completed, list):
        expected_status = pipeline_status(spec)
        expected = expected_status["completedPasses"]
        if list(completed) != expected:
            warnings.append("sculptPipeline.completedPasses is out of sync; run `sculpt status --sync`")
        for pass_id in completed:
            if pass_id not in (pass_order_ids or build_pass_ids):
                errors.append(f"sculptPipeline.completedPasses contains unknown pass {pass_id!r}")
    gate_mode = pipeline.get("passGateMode")
    if gate_mode not in {"adaptive-sequential", "locked-sequential"}:
        warnings.append("quality: sculptPipeline.passGateMode should be adaptive-sequential")
    validate_string_array(pipeline.get("nextRequiredEvidence"), "sculptPipeline.nextRequiredEvidence", errors)


def has_non_empty_detail(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() not in {"none", "unassessed", "n/a"}
    if isinstance(value, list):
        return any(has_non_empty_detail(item) for item in value)
    if isinstance(value, dict):
        return any(has_non_empty_detail(item) for item in value.values())
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return abs(float(value)) > 0
    return False


def layer_number(value: Any, keys: tuple[str, ...]) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, dict):
        for key in keys:
            item = value.get(key)
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                return float(item)
    return 0.0


def reference_pbr_usable(material: dict[str, Any], threshold: float) -> tuple[bool, str]:
    reference = material.get("referencePbr")
    material_id = str(material.get("id") or "(unnamed)")
    if not isinstance(reference, dict):
        return False, f"material {material_id!r} needs usable referencePbr extracted from source pixels"
    if reference.get("usable") is not True:
        return False, f"material {material_id!r} referencePbr.usable must be true"
    if reference.get("materialCropConfirmed") is not True:
        return False, f"material {material_id!r} referencePbr must come from a confirmed material crop"
    confidence = reference.get(
        "extractionSuitability",
        reference.get("confidence", reference.get("estimatedFidelity")),
    )
    if not is_number(confidence) or float(confidence) < threshold:
        return False, f"material {material_id!r} referencePbr confidence must be >= {threshold}"
    maps = reference.get("maps")
    if not isinstance(maps, dict):
        return False, f"material {material_id!r} referencePbr needs maps"
    assessments = reference.get("channelAssessments")
    required = ["albedo", "roughness", "height", "normal", "ao"]
    if isinstance(assessments, dict):
        required = [
            channel
            for channel in required
            if channel == "albedo" or not (
                isinstance(assessments.get(channel), dict)
                and assessments[channel].get("eligible") is False
            )
        ]
        albedo = assessments.get("albedo")
        if isinstance(albedo, dict) and albedo.get("eligible") is False:
            return False, f"material {material_id!r} referencePbr albedo is ineligible"
    for channel in required:
        entry = maps.get(channel)
        if not isinstance(entry, dict) or not has_non_empty_detail(entry.get("url")):
            return False, f"material {material_id!r} referencePbr missing browser URL for {channel}"
    return True, ""


def authored_texture_set_usable(material: dict[str, Any]) -> bool:
    value = material.get("textureSet")
    channels = value.get("channels") if isinstance(value, dict) else None
    albedo = channels.get("albedo") if isinstance(channels, dict) else None
    return bool(
        isinstance(value, dict)
        and value.get("sourceType") in {"imagegen-authored", "external-authored"}
        and value.get("status") == "ready"
        and isinstance(albedo, dict)
        and isinstance(albedo.get("url"), str)
        and albedo["url"].strip()
    )


def validate_look_dev_targets(spec: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    targets = spec.get("lookDevTargets")
    if targets is None:
        warnings.append("quality: missing lookDevTargets; material/color/lighting passes may stay flat")
    elif not isinstance(targets, dict):
        errors.append("lookDevTargets must be an object")
    materials = [item for item in spec.get("materials", []) if isinstance(item, dict)]
    if materials:
        warnings.extend(f"quality: {gap}" for gap in material_gaps(spec))
        warnings.extend(f"quality: {gap}" for gap in surface_gaps(spec))
        has_palette = any(
            has_non_empty_detail(item.get("colorVariation"))
            or has_non_empty_detail(item.get("albedo", {}).get("secondary") if isinstance(item.get("albedo"), dict) else None)
            for item in materials
        )
        has_response = any(
            layer_number(item.get("roughness"), ("variation", "base")) > 0
            or layer_number(item.get("normal"), ("strength", "amplitude")) > 0
            or layer_number(item.get("bump"), ("amplitude", "strength")) > 0
            or layer_number(item.get("displacement"), ("amplitude", "strength")) > 0
            for item in materials
        )
        has_locality = any(
            any(
                isinstance(override, dict)
                and override.get("type") in EXECUTABLE_LOCAL_MATERIAL_TYPES
                and (_layer_value(override.get("amount")) or 0) > 0
                and isinstance(override.get("mask"), dict)
                for override in (
                    item.get("localOverrides")
                    if isinstance(item.get("localOverrides"), list)
                    else []
                )
            )
            or has_non_empty_detail(item.get("ambientOcclusion"))
            or (
                isinstance(item.get("wear"), dict)
                and (
                    layer_number(item["wear"].get("edgeWear"), ("base", "amount")) > 0
                )
            )
            or (
                isinstance(item.get("dirt"), dict)
                and (
                    layer_number(item["dirt"].get("amount"), ("base", "amount")) > 0
                    or layer_number(item["dirt"].get("cavityBias"), ("base", "amount")) > 0
                )
            )
            for item in materials
        )
        if not has_palette:
            warnings.append("quality: lookdev needs a reference-derived albedo palette or secondary/accent color zones")
        if not has_response:
            warnings.append("quality: lookdev needs roughness variation or normal/bump/displacement response")
        if not has_locality:
            warnings.append("quality: lookdev needs local overrides, AO, dirt, wear, stains, moss, chips, scratches, or equivalent masks")
        quality_first = isinstance(targets, dict) and targets.get("qualityPriority") == "reference-fidelity"
        if quality_first:
            material_targets = targets.get("materialPass", {})
            if not isinstance(material_targets, dict):
                warnings.append("quality: quality-first lookDevTargets.materialPass must be an object")
                material_targets = {}
            minimum_resolution = material_targets.get("minimumTextureResolution", 1024)
            if not isinstance(minimum_resolution, int) or isinstance(minimum_resolution, bool):
                warnings.append("quality: minimumTextureResolution must be an integer")
                minimum_resolution = 1024
            required_channels = {
                str(item).lower()
                for item in material_targets.get("independentMapChannels", [])
                if isinstance(item, str)
            }
            extraction_targets = material_targets.get("referencePbrExtraction", {})
            if not isinstance(extraction_targets, dict):
                extraction_targets = {}
            pbr_required = (
                extraction_targets.get("requiredWhenSourceImagePresent") is True
                and has_non_empty_detail(spec.get("sourceImage"))
            )
            pbr_threshold = extraction_targets.get("targetThreshold", 0.7)
            if not is_number(pbr_threshold):
                pbr_threshold = 0.7
            expected_channels = {"albedo", "roughness", "height", "normal", "ambient-occlusion"}
            if not expected_channels.issubset(required_channels):
                warnings.append(
                    "quality: quality-first materialPass must require independent albedo, roughness, "
                    "height, normal, and ambient-occlusion channels"
                )
            for material in materials:
                if material.get("qualityTier") == "utility":
                    continue
                material_id = str(material.get("id") or "(unnamed)")
                resolution = material.get("textureResolution")
                if not isinstance(resolution, int) or isinstance(resolution, bool) or resolution < minimum_resolution:
                    warnings.append(
                        f"quality: material {material_id!r} textureResolution must be >= {minimum_resolution}"
                    )
                projection = material.get("textureProjection")
                if not isinstance(projection, dict) or not has_non_empty_detail(projection.get("mode")):
                    warnings.append(
                        f"quality: material {material_id!r} needs textureProjection.mode and texel-density intent"
                    )
                bands = material.get("surfaceFrequencyBands")
                band_ids = {
                    str(item.get("id")).lower()
                    for item in bands
                    if isinstance(item, dict) and has_non_empty_detail(item.get("id"))
                } if isinstance(bands, list) else set()
                missing_bands = {"macro", "meso", "micro"} - band_ids
                if missing_bands:
                    warnings.append(
                        f"quality: material {material_id!r} missing surface frequency bands: "
                        + ", ".join(sorted(missing_bands))
                    )
                roughness = material.get("roughness")
                roughness_map = roughness.get("map") if isinstance(roughness, dict) else None
                if not has_non_empty_detail(roughness_map) or "albedo" in str(roughness_map).lower():
                    warnings.append(f"quality: material {material_id!r} needs an independent roughness map")
                if not has_non_empty_detail(material.get("ambientOcclusion")):
                    warnings.append(
                        f"quality: material {material_id!r} needs an independent ambient-occlusion response"
                    )
                if pbr_required:
                    ok, message = reference_pbr_usable(material, float(pbr_threshold))
                    if not ok and not authored_texture_set_usable(material):
                        warnings.append(f"quality: {message}")
    lighting = spec.get("lightingFromPhoto", [])
    if not isinstance(lighting, list):
        errors.append("lightingFromPhoto must be an array")
    else:
        meaningful = [item for item in lighting if has_non_empty_detail(item)]
        if len(meaningful) < 3:
            warnings.append("quality: lookdev needs concrete key/fill/rim or environment light entries")
        lighting_text = " ".join(str(item).lower() for item in meaningful)
        if meaningful and not any(term in lighting_text for term in ("exposure", "tone", "aces", "filmic")):
            warnings.append("quality: lookdev needs exposure and tone mapping intent")
        if meaningful and not any(term in lighting_text for term in ("contact shadow", "ground shadow", "ambient occlusion", "ao")):
            warnings.append("quality: lookdev needs contact shadow or ground shadow behavior")


def validate_spec(
    spec: dict[str, Any],
    for_pass: str | None = None,
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    schema_version = spec.get("schemaVersion")
    try:
        parsed_schema_version = parse_schema_version(schema_version)
    except ValueError as exc:
        parsed_schema_version = None
        errors.append(str(exc))
    if parsed_schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        errors.append("schemaVersion must be '2.0', '3.0', '3.1', or '3.2'")
    if parsed_schema_version is not None and parsed_schema_version >= (3, 0, 0):
        required_v3 = {
            "specRevision": int,
            "qualityProfile": str,
            "preSpecAssessment": dict,
            "qualityContract": dict,
            "qualityTargets": dict,
            "selfCorrectLoop": dict,
            "actionReadiness": dict,
            "viewEvidence": list,
            "buildPasses": list,
            "reviewHistory": list,
        }
        for key, expected_type in required_v3.items():
            if key not in spec:
                errors.append(f"missing schema 3 field {key!r}")
            elif not isinstance(spec[key], expected_type) or (
                expected_type is int and isinstance(spec[key], bool)
            ):
                errors.append(f"schema 3 field {key!r} must be {expected_type.__name__}")
        if parsed_schema_version < (3, 2, 0):
            if not isinstance(spec.get("intendedUse"), str):
                errors.append("missing schema 3 field 'intendedUse'")
            elif spec.get("intendedUse") not in {
                "static-render", "browser-prop", "game-prop", "animated", "playable", "destructible"
            }:
                errors.append("intendedUse is invalid")
        elif "intendedUse" in spec:
            errors.append(
                "schema 3.2 removes intendedUse; preserve it under legacyIntent during migration"
            )
        if spec.get("qualityProfile") not in {"balanced", "reference-fidelity"}:
            errors.append("qualityProfile must be balanced or reference-fidelity")
        if isinstance(spec.get("specRevision"), int) and not isinstance(spec.get("specRevision"), bool) and spec["specRevision"] < 1:
            errors.append("specRevision must be a positive integer")
    for key, expected_type in REQUIRED_TOP_LEVEL.items():
        if key not in spec:
            errors.append(f"missing top-level field {key!r}")
        elif not isinstance(spec[key], expected_type):
            errors.append(f"field {key!r} must be {expected_type.__name__}")
    suitability = spec.get("suitability")
    if suitability not in VALID_SUITABILITY:
        errors.append("suitability must be pass, conditional, or reject")
    validate_pre_spec_assessment(spec, errors, warnings)
    validate_shading_execution(spec, errors, warnings, for_pass)
    validate_uncertainty_contract(spec, errors, warnings)
    validate_terminology_profile(spec, errors, warnings)
    validate_score_block(spec, errors, warnings)
    validate_quality_targets(spec, errors, warnings)
    validate_quality_contract(spec, errors, warnings)
    validate_phase_execution_contract(spec, errors, warnings)
    validate_review_governance(spec, errors)
    validate_action_readiness(spec, errors, warnings)
    validate_interaction_contract(spec, errors, warnings)
    validate_reference_preparation(spec, errors, warnings)
    validate_view_hypothesis_policy(spec, errors, warnings)
    errors.extend(validate_perceptual_contract(spec))
    errors.extend(validate_capability_plan(spec))
    validate_self_correct_loop(spec, errors, warnings)
    validate_feature_review_targets(spec, errors, warnings)
    validate_specialized_regions(spec, errors, warnings)
    validate_review_history(spec, errors, warnings)
    validate_visual_evidence_history(spec, errors)
    build_pass_ids = validate_build_passes(spec, errors, warnings)
    validate_sculpt_pipeline(spec, build_pass_ids, errors, warnings)
    validate_look_dev_targets(spec, errors, warnings)
    evidence_ids = validate_evidence(spec, errors, warnings)
    material_ids = validate_materials(
        spec,
        errors,
        warnings,
        evidence_ids,
        for_pass,
    )
    errors.extend(validate_repetition_systems(spec.get("repetitionSystems", [])))
    validate_repetition_attachment_relations(spec, errors, warnings)
    validate_components(spec, material_ids, evidence_ids, errors, warnings)
    selected_pass = PASS_ALIASES.get(for_pass, for_pass)
    if selected_pass != "blockout":
        topology_errors, topology_warnings = validate_surface_topology_plan(
            spec.get("surfaceTopologyPlan"),
            spec.get("componentTree", []),
            spec.get("materials", []),
        )
        errors.extend(topology_errors)
        warnings.extend(topology_warnings)
    # Blockout intentionally carries only the stable macro contract. Recursive
    # component/detail planning is promoted into the spec immediately before
    # Form, where it has an implementation consumer and can be reviewed without
    # flooding the first visual cycle with speculative detail.
    if selected_pass != "blockout":
        validate_detail_decomposition(spec, material_ids, evidence_ids, errors, warnings)
    validate_special_material_compatibility(spec, warnings)
    lod_plan = spec.get("lodPlan")
    if lod_plan is not None and not isinstance(lod_plan, list):
        errors.append("lodPlan must be an array")
    performance = spec.get("performanceBudget")
    has_metrics_pass = any(
        isinstance(item, dict) and item.get("evidenceType") == "metrics"
        for item in spec.get("buildPasses", [])
    )
    if schema_at_least(spec, "3.0") and has_metrics_pass and performance is None:
        errors.append("performanceBudget is required when a metrics pass is active")
    if performance is not None and not isinstance(performance, dict):
        errors.append("performanceBudget must be an object")
    elif isinstance(performance, dict):
        for field in ("targetTriangles", "maxDrawCalls", "textureSize", "fpsTarget"):
            if has_metrics_pass and field in {"targetTriangles", "maxDrawCalls", "fpsTarget"} and field not in performance:
                errors.append(f"performanceBudget.{field} is required by the metrics pass")
                continue
            if field in performance and (
                not is_number(performance[field]) or float(performance[field]) <= 0
            ):
                errors.append(f"performanceBudget.{field} must be a positive finite number")
    audit = spec.get("performanceAudit")
    if schema_at_least(spec, "3.2"):
        if not isinstance(audit, dict):
            errors.append("performanceAudit must be an object for schema 3.2")
        else:
            for field in ("enabled", "blocking"):
                if not isinstance(audit.get(field), bool):
                    errors.append(f"performanceAudit.{field} must be boolean")
            if audit.get("blocking") is True and audit.get("enabled") is not True:
                errors.append("performanceAudit.blocking requires performanceAudit.enabled")
            if audit.get("activation") != "explicit-user-budget-only":
                errors.append(
                    "performanceAudit.activation must be 'explicit-user-budget-only'"
                )
            validate_unit_interval(
                audit.get("maximumVisualRegression"),
                "performanceAudit.maximumVisualRegression",
                errors,
            )
            if audit.get("maximumVisualRegression") != 0:
                errors.append("performanceAudit.maximumVisualRegression must be 0")
    validate_quality_depth(spec, errors, warnings, for_pass)
    if for_pass is not None:
        ids = canonical_pass_order(spec)
        if for_pass not in ids:
            errors.append(f"unknown --for-pass {for_pass!r}; expected one of: {', '.join(ids)}")
        else:
            errors.extend(
                f"pass {for_pass!r} readiness: {gap}"
                for gap in pass_specific_gaps(spec, for_pass)
            )
    if suitability == "pass" and spec.get("risks"):
        warnings.append("suitability is pass but risks are present; confirm they are acceptable")
    return list(dict.fromkeys(errors)), list(dict.fromkeys(warnings))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument(
        "--for-pass",
        help="Validate core schema plus readiness rules relevant to one build pass.",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable result")
    parser.add_argument(
        "--strict-quality",
        action="store_true",
        help="Treat quality warnings as validation errors before implementation/generation",
    )
    args = parser.parse_args(argv)

    manifest_gate_errors: list[str] = []
    try:
        from sculpt_modules import is_module_manifest, module_status, read_raw_spec

        raw_spec = read_raw_spec(args.spec)
        if is_module_manifest(raw_spec):
            modular_status = module_status(args.spec, raw_spec)
            manifest_gate_errors.extend(modular_status["errors"])
            if not modular_status["assemblyReady"]:
                current = modular_status.get("currentModule") or "none"
                manifest_gate_errors.append(
                    "modular assembly is not ready: every required module must have a current "
                    f"hash-bound acceptance; current module is {current!r}"
                )
        spec = load_spec(args.spec)
        errors, warnings = validate_spec(spec, args.for_pass)
    except ValueError as exc:
        errors, warnings = [str(exc)], []

    errors.extend(manifest_gate_errors)

    warnings = [
        warning for warning in warnings if warning_applies_to_pass(warning, args.for_pass)
    ]

    if args.strict_quality:
        errors.extend(
            f"strict quality failure: {warning.removeprefix('quality: ').strip()}"
            for warning in warnings
            if warning.startswith("quality:")
        )

    ok = not errors
    result = {
        "ok": ok,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "targetName": spec.get("targetName") if "spec" in locals() else None,
            "suitability": spec.get("suitability") if "spec" in locals() else None,
            "components": len(spec.get("componentTree", [])) if "spec" in locals() else 0,
            "materials": len(spec.get("materials", [])) if "spec" in locals() else 0,
        },
    }
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print("PASS" if ok else "FAIL")
        for warning in warnings:
            print(f"warning: {warning}")
        for error in errors:
            print(f"error: {error}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
