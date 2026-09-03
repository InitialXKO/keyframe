#!/usr/bin/env python3
"""Create one concise ObjectSculptSpec with integrated pre-spec planning."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from sculpt_contract import (
    CURRENT_SCHEMA_VERSION,
    blind_scout_execution_contract,
    build_pass_plan,
    complexity_minimums,
    human_approval_contract,
    parse_json,
    primary_feature_review_policy,
    review_governance_contract,
    sync_pipeline,
    write_spec_atomic,
)
from sculpt_perception import make_perceptual_fields
from sculpt_style import make_unassessed_visual_style
from sculpt_view_hypotheses import make_view_hypothesis_policy


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "object"


def make_pre_spec_assessment(
    target_name: str,
    complexity: str = "moderate",
    intended_use: str | None = None,
) -> dict[str, Any]:
    minimums = complexity_minimums(complexity)
    return {
        "objectClass": {
            "primaryType": "unassessed",
            "representationKind": [],
            "formLanguage": [],
            "structureKind": [],
            "motionPotential": [],
            "materialFamilies": [],
            "notes": "",
        },
        "visualStyle": make_unassessed_visual_style(),
        "complexity": {
            "status": "unassessed",
            "initialTierHint": complexity,
            "tier": "unassessed",
            "scoreScale": {
                "type": "integer-ordinal",
                "minimum": 0,
                "maximum": 3,
                "meaning": "Complexity magnitude: 0 is lowest/none and 3 is highest; higher does not mean better quality.",
                "conversionRule": "Never convert normalized 0-to-1 review quality scores into this scale.",
            },
            "scores": {
                "silhouetteComplexity": None,
                "formTopologyComplexity": None,
                "componentCount": None,
                "hierarchyDepth": None,
                "repetitionDensity": None,
                "materialLayerCount": None,
                "localDetailDensity": None,
                "representationComplexity": None,
            },
            "modifiers": {
                "occlusionRisk": None,
                "actionReadinessNeed": None,
            },
            "evidenceRefs": [],
            "reasoning": [
                f"{complexity!r} is only the initial estimate for {target_name!r}; revise it after visual inspection."
            ],
            "derivation": {
                "baseTier": "unassessed",
                "requiredDepth": complexity,
                "activeOverrides": [],
            },
            "estimatedCounts": {
                "macroComponents": minimums["macroLayers"],
                "mesoComponents": minimums["mesoLayers"],
                "microFeatureGroups": minimums["microLayers"],
                "materialLayers": minimums["materials"],
                "repetitionSystems": 1 if complexity in {"complex", "ultra"} else 0,
            },
        },
        "specDepthDecision": {
            "requiredDepth": complexity,
            "minimumComponentLevels": [
                level
                for level, count in (
                    ("macro", minimums["macroLayers"]),
                    ("meso", minimums["mesoLayers"]),
                    ("micro", minimums["microLayers"]),
                )
                if count > 0
            ],
            "needsRepetitionSystems": complexity in {"complex", "ultra"},
            "needsMaterialLocalOverrides": complexity != "simple",
            "needsMultipleReviewViews": False,
            "needsActionReadyHierarchy": intended_use in {"animated", "playable", "destructible"},
            "rationale": (
                "Use only the depth needed to preserve visible identity. Assess motion affordances "
                "before form even when the user did not request interaction."
            ),
        },
        "specializedRegions": {
            "status": "unassessed",
            "notes": (
                "Inspect for identity-critical faces and hands. Declare each visible region, "
                "or set status to none with a reason before strict validation."
            ),
            "regions": [],
        },
        "unknownsToResolveBeforeImplementation": [],
    }


def make_quality_contract(
    complexity: str = "moderate",
) -> dict[str, Any]:
    """Create measurable floors; object-specific criteria live in featureReviewTargets."""

    minimums = complexity_minimums(complexity)
    return {
        "minimumSpecDepth": {
            "macroComponents": minimums["macroLayers"],
            "mesoComponents": minimums["mesoLayers"],
            "microFeatureGroups": minimums["microLayers"],
            "materials": minimums["materials"],
            "repetitionSystems": 1 if complexity in {"complex", "ultra"} else 0,
        },
        "requiredReviewViewIds": ["full-object"],
    }


def make_phase_execution_contract(
    approval_mode: str = "phase-by-phase",
) -> dict[str, Any]:
    """Describe the lean LLM-facing path and its three-signal visual gate."""

    return {
        "version": 4,
        "mode": "progressive-visual-loop",
        "phaseOrder": ["blockout", "form", "lookdev", "interaction"],
        "specStrategy": "stable-core-plus-phase-delta",
        "stableCoreFields": [
            "targetName",
            "sourceImage",
            "referencePreparation",
            "perceptualContract",
            "viewingContract",
            "evidenceAuthority",
            "visualIdentitySpec",
            "representationPlan",
            "capabilityPlan",
            "coordinateFrame",
            "silhouette",
            "viewEvidence",
            "componentNamingContract",
            "assumptions",
            "risks",
        ],
        "phaseOwnedFields": {
            "blockout": [
                "preSpecAssessment.objectClass",
                "preSpecAssessment.visualStyle",
                "preSpecAssessment.complexity",
                "qualityContract",
                "featureReviewTargets",
                "componentTree[macro]",
                "qualityTargets",
                "viewingContract",
                "visualIdentitySpec",
                "representationPlan",
            ],
            "form": [
                "componentTree",
                "surfaceTopologyPlan",
                "detailDecompositionContract",
                "repetitionSystems",
                "viewHypothesisPolicy",
                "capabilityPlan",
                "representationPlan",
            ],
            "lookdev": [
                "materials",
                "lookDevTargets",
                "lightingFromPhoto",
            ],
            "interaction": [
                "interactionContract",
                "actionReadiness",
                "componentTree[*].actionProfile",
            ],
        },
        "correctionAuthority": {
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
                "quality, and may improve any earlier phase when evidence exposes a "
                "defect or clear opportunity. Assess impact first, edit only a "
                "challenger, record predicted effects and mitigations for affected "
                "later phases, and promote only when the whole cumulative result is "
                "better or unchanged; rollback only when the challenger visibly regresses."
            ),
        },
        "cycle": {
            "steps": [
                "spec-delta",
                "build-render",
                "reference-comparison",
                "blind-visual-scout",
                "independent-review",
                "system-promote-or-rollback",
                "user-approval",
            ],
            "maximumNonVisualOperationsBeforeRender": 2,
            "visualProgressRequired": True,
            "comparisonRequired": True,
            "comparisonAuthority": "source-image-only",
            "maximumConsecutiveNonImprovements": 3,
            "rollbackTarget": "highest-scoring-compatible-champion",
            "strategyChangeAfterExhaustion": True,
        },
        "visualScout": blind_scout_execution_contract(),
        "qualityGate": {
            "mode": "ai-scout-human",
            "signals": [
                "aiOverallScore>=0.70",
                "blindScoutDecision=approve",
                "humanApproval=approved",
            ],
            "aiOverallFloor": 0.70,
            "blindScoutDecisions": ["approve", "reject"],
            "maxBlindScoutObservations": 7,
            "centroidAndAspect": "diagnostic-only",
            "humanApprovalAfterSystemPass": True,
        },
        "humanApproval": human_approval_contract(approval_mode),
        "deferredWork": {
            "form": ["recursive detail plans", "attachments", "default 2x2 turnaround"],
            "lookdev": ["PBR extraction", "surface descriptors", "lighting refinement"],
            "interaction": ["motion pivots", "runtime receipts", "motion clearance"],
            "finalization": ["full project typecheck", "final provenance audit"],
        },
        "progressRule": (
            "Count accepted phase gates and visible score deltas, never raw commands, schema fixes, "
            "receipts, screenshots, or reviewer setup as modeling progress."
        ),
    }


def make_interaction_contract(intended_use: str | None = None) -> dict[str, Any]:
    legacy_required = intended_use in {"animated", "playable", "destructible"}
    return {
        "version": 1,
        "status": "required" if legacy_required else "unassessed",
        "assessmentReason": (
            "Legacy user intent requires interaction; identify exact moving components before form."
            if legacy_required
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
        "legacyIntentHint": intended_use or "",
    }


def make_base_material(quality_profile: str = "balanced") -> dict[str, Any]:
    texture_resolution = 2048 if quality_profile == "reference-fidelity" else 1024
    return {
        "id": "base",
        "name": "Replace with observed material",
        "type": "standard",
        "shaderModel": "MeshStandardMaterial",
        "baseColor": "#8A7A5F",
        "surfaceDescriptor": {
            "status": "unassessed",
            "evidenceRefs": ["full-object"],
        },
        "albedo": {
            "dominant": "#8A7A5F",
            "secondary": ["#6E614B", "#A08F70"],
            "samplingNotes": "Replace with color zones sampled from the reference.",
        },
        "colorVariation": {
            "palette": ["#8A7A5F", "#6E614B", "#A08F70"],
            "pattern": "mottled",
            "amplitude": 0.12,
            "heightCorrelation": 0.2,
        },
        "textureResolution": texture_resolution,
        "textureProjection": {
            "mode": "uv",
            "repeat": [2.0, 2.0],
            "anisotropy": 8,
            "texelDensityIntent": "Keep visible detail at a stable object-space scale.",
        },
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 2.0, "amplitude": 0.35, "role": "broad variation"},
            {"id": "meso", "frequency": 12.0, "amplitude": 0.18, "role": "visible relief"},
            {"id": "micro", "frequency": 56.0, "amplitude": 0.06, "role": "highlight breakup"},
        ],
        "roughness": {"base": 0.75, "variation": 0.12, "map": "independent-procedural-field"},
        "metalness": {"base": 0.0, "variation": 0.0},
        "specularIntensity": 0.5,
        "specularColor": "#FFFFFF",
        "envMapIntensity": 0.8,
        "normal": {"pattern": "independent-height-field", "strength": 0.25, "scale": 24.0},
        "bump": {"pattern": "none", "amplitude": 0.0},
        "displacement": {"pattern": "none", "amplitude": 0.0, "silhouetteAffects": False},
        "ambientOcclusion": {"cavityStrength": 0.2, "contactShadowBias": 0.3},
        "wear": {"edgeWear": 0.0, "scratches": [], "chips": []},
        "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"},
        "localOverrides": [],
        "shaderNotes": [
            "Replace generic values with observed evidence before lookdev review.",
            "Never reuse albedo as roughness, height, normal, or AO.",
        ],
    }


def make_detail_plan() -> dict[str, Any]:
    """Return an explicit, fail-closed detail plan for one component.

    A component may remain one continuous mesh, but it may not remain one
    undifferentiated idea.  Every visible sub-detail must eventually be mapped
    to executable geometry, topology, repetition, or material data.
    """

    return {
        "status": "unassessed",
        "observedComplexity": "unassessed",
        "decompositionMode": "unassessed",
        "atomicityReason": "",
        "childComponentIds": [],
        "features": [],
        "evidenceRefs": ["full-object"],
        "coverageNotes": "",
    }


def make_detail_decomposition_contract() -> dict[str, Any]:
    return {
        "version": 1,
        "status": "unassessed",
        "rules": [
            "Inventory every visible macro, meso, and identity-critical micro detail before form generation.",
            "A compound or complex component may not use atomic decomposition.",
            "Every inventoried feature must name its host component and map to an executable target id.",
            "One continuous mesh may contain many named features; mesh count is never a substitute for detail coverage.",
            "Reviewer corrections must target the exact component id or detail-feature id and give numeric actions.",
        ],
    }


def make_root_component(target_name: str, interactive: bool = False) -> dict[str, Any]:
    component = {
        "id": "root",
        "name": target_name,
        "componentType": "part",
        "level": "macro",
        "role": "body",
        "importance": 1.0,
        "confidence": 0.5,
        "primitive": "box",
        "geometryDescriptor": {
            "parameters": {},
            "topologyIntent": "blockout primitive; replace from reference",
            "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
            "deformationStack": [],
            "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "generated vertex normals",
        },
        "parent": None,
        "attachment": None,
        "dimensions": {
            "width": 1.0,
            "height": 1.0,
            "depth": 1.0,
            "units": "relative",
            "confidence": 0.5,
        },
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]},
        "actionProfile": {
            "animationRole": "root",
            "pivot": {
                "mode": "center",
                "localPosition": [0, 0, 0],
                "axis": [0, 1, 0],
                "confidence": 0.5,
            },
            "transformChannels": {
                "translate": True,
                "rotate": True,
                "scale": True,
                "bend": False,
                "twist": False,
                "detach": False,
                "visibility": True,
                "materialState": True,
            },
            "sockets": [],
            "collider": {
                "type": "box",
                "offset": [0, 0, 0],
                "scale": [1, 1, 1],
                "isTrigger": False,
            },
            "constraints": [],
            "destruction": {
                "breakable": False,
                "fractureGroup": "root",
                "seamRefs": [],
                "detachableFragments": [],
                "breakImpulse": 0.0,
                "debrisMaterial": "base",
            },
        },
        "material": "base",
        "materialLayers": ["base"],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": [],
        "detailPlan": make_detail_plan(),
        "surfaceDetail": {
            "macroRoughness": 0.0,
            "microRoughness": 0.0,
            "bumpAmplitude": 0.0,
            "normalPattern": "",
            "displacementPattern": "",
            "occlusionPattern": "",
            "edgeWearPattern": "",
            "notes": "Fill before lookdev if the surface is not intentionally smooth.",
        },
        "evidenceRefs": ["full-object"],
        "details": [],
        "fidelityTier": "blockout",
    }
    if not interactive:
        component["actionProfile"].pop("collider", None)
        component["actionProfile"].pop("destruction", None)
        component["actionProfile"]["transformChannels"] = {
            "translate": True,
            "rotate": True,
            "scale": True,
            "visibility": True,
        }
    return component


def load_assessment(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    payload = parse_json(path.expanduser().read_text(encoding="utf-8"), "assessment JSON")
    if not isinstance(payload, dict):
        raise ValueError("assessment must be a JSON object")
    return payload


def make_spec(
    target_name: str,
    image: str | None,
    assessment_payload: dict[str, Any] | None = None,
    complexity: str = "moderate",
    intended_use: str | None = None,
    quality_profile: str = "balanced",
    reference_background: str = "unassessed",
    background_removal_mode: str | None = None,
    imagegen_trigger: str | None = None,
    declared_simplifications: list[str] | None = None,
    approval_mode: str = "phase-by-phase",
    perceptual_enforcement: str = "advisory",
    planning_sheet_layout: str = "standard",
) -> dict[str, Any]:
    if planning_sheet_layout not in {"standard", "exploded"}:
        raise ValueError("planning_sheet_layout must be standard or exploded")
    if planning_sheet_layout == "exploded" and complexity not in {"complex", "ultra"}:
        raise ValueError(
            "exploded planning sheets are only supported for complex or ultra assemblies"
        )
    hypothesis_first_view = (
        "exploded" if planning_sheet_layout == "exploded" else "three-quarter"
    )
    pre_spec = make_pre_spec_assessment(target_name, complexity, intended_use)
    quality_contract = make_quality_contract(complexity)
    detail_decomposition_contract = make_detail_decomposition_contract()
    surface_topology_plan: dict[str, Any] = {
        "status": "unassessed",
        "reason": "",
        "decisionRule": (
            "Classify each visible system as continuous sculpt, intentional assembly, "
            "conforming shell, embedded relief, host-bound fiber, or material-only before modules."
        ),
        "groups": [],
    }
    if assessment_payload:
        if isinstance(assessment_payload.get("preSpecAssessment"), dict):
            pre_spec = assessment_payload["preSpecAssessment"]
        if isinstance(assessment_payload.get("qualityContract"), dict):
            quality_contract = assessment_payload["qualityContract"]
        if isinstance(assessment_payload.get("surfaceTopologyPlan"), dict):
            surface_topology_plan = assessment_payload["surfaceTopologyPlan"]
        if isinstance(assessment_payload.get("detailDecompositionContract"), dict):
            detail_decomposition_contract = assessment_payload["detailDecompositionContract"]
        if not image and isinstance(assessment_payload.get("sourceImage"), str):
            image = assessment_payload["sourceImage"]
    pre_spec.setdefault("visualStyle", make_unassessed_visual_style())

    interactive = intended_use in {"animated", "playable", "destructible"}
    interaction_contract = make_interaction_contract(intended_use)
    passes = build_pass_plan(
        complexity,
        intended_use,
        quality_profile,
        interaction_required=interactive,
        hypothesis_first_view=hypothesis_first_view,
    )
    pass_ids = [item["id"] for item in passes]
    visual_pass_ids = [item["id"] for item in passes if item["evidenceType"] == "visual"]
    review_views = ["neutral", "grazing", "reference"] if quality_profile == "reference-fidelity" else ["reference"]
    reference_fidelity = quality_profile == "reference-fidelity"
    visual_threshold = 0.85 if reference_fidelity else 0.7
    critical_threshold = 0.85 if reference_fidelity else 0.8
    important_threshold = 0.78 if reference_fidelity else 0.65
    lookdev_feature_threshold = 0.85 if reference_fidelity else 0.75
    pbr_threshold = 0.75 if reference_fidelity else 0.7
    if isinstance(pre_spec.get("specDepthDecision"), dict):
        pre_spec["specDepthDecision"]["needsMultipleReviewViews"] = (
            quality_profile == "reference-fidelity"
        )
    target_id = slugify(target_name)

    declared_simplifications = [
        item.strip()
        for item in (declared_simplifications or [])
        if isinstance(item, str) and item.strip()
    ]
    if not image:
        if (
            reference_background != "unassessed"
            or background_removal_mode
            or imagegen_trigger
            or declared_simplifications
        ):
            raise ValueError(
                "reference preparation options require --image"
            )
        reference_preparation = {
            "version": 2,
            "subjectBackgroundSeparation": "not-applicable",
            "preparationTrigger": "not-applicable",
            "requiredSkill": "imagegen",
            "method": "not-required",
            "imagegenMode": "not-applicable",
            "outputImage": "",
            "outputBackground": "not-applicable",
            "whiteBackgroundValidated": False,
            "subjectContrastValidated": False,
            "modificationPolicy": {
                "mode": "none",
                "allowedChanges": [],
                "protectedTraits": [],
                "declaredChanges": [],
            },
            "comparisonPolicy": {
                "reconstructionTarget": "sourceImage",
            },
            "usageRule": "No reference image is available.",
        }
    else:
        if reference_background not in {
            "unassessed",
            "mixed",
            "clear",
            "present",
            "absent",
        }:
            raise ValueError(
                "reference_background must be unassessed, mixed, clear, present, or absent"
            )
        if reference_background == "present":
            reference_background = "mixed"
        approved_modes = {
            "white-background-cleanup",
            "white-background-simplification",
        }
        if background_removal_mode in {
            "built-in-chroma-key",
            "cli-native-transparency",
        }:
            raise ValueError(
                "transparent ImageGen output is unsupported; use "
                "background_removal_mode='white-background-cleanup' or "
                "'white-background-simplification'"
            )
        if background_removal_mode and background_removal_mode not in approved_modes:
            raise ValueError(
                "background_removal_mode must be white-background-cleanup or "
                "white-background-simplification"
            )
        valid_triggers = {
            "background-mixing",
            "excessive-complexity",
            "low-source-quality",
            "real-object-photo",
            "combined",
        }
        if imagegen_trigger and imagegen_trigger not in valid_triggers:
            raise ValueError(
                "imagegen_trigger must be background-mixing, excessive-complexity, "
                "low-source-quality, real-object-photo, or combined"
            )

        imagegen_requested = background_removal_mode is not None
        if reference_background == "mixed":
            if not imagegen_requested:
                raise ValueError(
                    "background_removal_mode is required when subject and background are mixed"
                )
            if imagegen_trigger is None:
                imagegen_trigger = "background-mixing"
            if background_removal_mode == "white-background-simplification":
                imagegen_trigger = "combined"
        if imagegen_trigger and not imagegen_requested:
            raise ValueError("imagegen_trigger requires an ImageGen preparation mode")

        if imagegen_requested:
            if imagegen_trigger is None:
                raise ValueError(
                    "imagegen_trigger is required when a clear-background reference is regenerated"
                )
            if (
                background_removal_mode == "white-background-cleanup"
                and imagegen_trigger in {"excessive-complexity", "real-object-photo"}
            ):
                raise ValueError(
                    f"{imagegen_trigger} requires white-background-simplification"
                )
            if (
                background_removal_mode == "white-background-simplification"
                and not declared_simplifications
            ):
                raise ValueError(
                    "white-background-simplification requires at least one declared simplification"
                )
            method = "imagegen-prepared-reference"
            mode = background_removal_mode
            prepared = True
        elif reference_background in {"clear", "absent"}:
            method = "not-required"
            mode = "not-applicable"
            prepared = False
        else:
            if background_removal_mode:
                raise ValueError(
                    "background_removal_mode requires reference_background='mixed'"
                )
            method = "unassessed"
            mode = "unassessed"
            prepared = False
        simplification = mode == "white-background-simplification"
        reference_preparation = {
            "version": 2,
            "subjectBackgroundSeparation": reference_background,
            "preparationTrigger": imagegen_trigger or (
                "unassessed" if reference_background == "unassessed" else "not-required"
            ),
            "requiredSkill": "imagegen",
            "method": method,
            "imagegenMode": mode,
            "outputImage": image,
            "outputBackground": "solid-white" if prepared else (
                "unassessed" if reference_background == "unassessed" else "original"
            ),
            "whiteBackgroundValidated": prepared,
            "subjectContrastValidated": prepared,
            "modificationPolicy": {
                "mode": "bounded-simplification" if simplification else (
                    "cleanup-only" if prepared else "none"
                ),
                "allowedChanges": (
                    [
                        "remove background artifacts and clarify ambiguous edges",
                        "reduce compression noise and non-signature surface noise",
                        "merge or omit tiny repeated details that do not affect silhouette or material zones",
                        "regularize ambiguous minor geometry for practical procedural construction",
                        "convert difficult real-world surface variation into clean buildable 3D masses",
                    ]
                    if simplification
                    else (
                        [
                            "remove background artifacts and clarify ambiguous edges",
                            "clean minor compression or surface noise without changing recognizable form",
                        ]
                        if prepared
                        else []
                    )
                ),
                "protectedTraits": (
                    [
                        "object class and recognizable identity",
                        "primary silhouette and macro proportions",
                        "major component count, placement, and attachment relationships",
                        "signature features and dominant material/color zones",
                        "primary viewpoint, pose, and framing",
                    ]
                    if prepared
                    else []
                ),
                "declaredChanges": declared_simplifications,
            },
            "comparisonPolicy": {
                "reconstructionTarget": "sourceImage",
            },
            "usageRule": (
                "Use the original directly when its subject boundary is clear, including a "
                "white or strongly contrasting background, and reconstruction is manageable. "
                "Use ImageGen with a solid white output when the subject mixes with the background, "
                "the source is too poor, the object is impractically complex, or a real-object "
                "photo needs a buildable 3D-style simplification. sourceImage is the sole "
                "reconstruction and acceptance target."
            ),
        }

    spec: dict[str, Any] = {
        "targetName": target_name,
        "targetId": target_id,
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "specRevision": 1,
        "qualityProfile": quality_profile,
        "sourceImage": image or "",
        "referencePreparation": reference_preparation,
        "viewHypothesisPolicy": make_view_hypothesis_policy(
            complexity,
            quality_profile,
            image,
            planning_sheet_layout,
        ),
        "suitability": "conditional",
        "scoreScale": {
            "type": "integer-ordinal",
            "minimum": 0,
            "maximum": 3,
            "meaning": "Suitability evidence strength is field-specific; occlusion_risk is the only inverse/risk axis.",
            "higherIsBetter": [
                "object_isolation",
                "silhouette_readability",
                "depth_inference",
                "primitive_decomposition",
                "material_procedurality",
                "interaction_fit",
            ],
            "higherIsWorse": ["occlusion_risk"],
            "conversionRule": "Never place decimal 0-to-1 review quality scores in scores.*.",
        },
        "scores": {
            "object_isolation": 0,
            "silhouette_readability": 0,
            "depth_inference": 0,
            "primitive_decomposition": 0,
            "material_procedurality": 0,
            "occlusion_risk": 0,
            "interaction_fit": 0,
        },
        "preSpecAssessment": pre_spec,
        "surfaceTopologyPlan": surface_topology_plan,
        "detailDecompositionContract": detail_decomposition_contract,
        "qualityContract": quality_contract,
        "phaseExecutionContract": make_phase_execution_contract(approval_mode),
        "reviewGovernance": review_governance_contract(),
        "terminologyProfile": {
            "domain": "real-time procedural Three.js asset",
            "geometryTerms": ["silhouette", "proportion", "primitive", "bevel", "taper", "attachment"],
            "materialTerms": ["albedo", "roughness", "metalness", "normal", "ambient occlusion"],
            "lightingTerms": ["key light", "fill light", "environment light", "contact shadow"],
            "descriptionRule": "Pair plain-language observations with measurable geometry, material, or light parameters.",
        },
        "qualityTargets": {
            "targetFidelity": visual_threshold,
            "mustMatch": ["silhouette", "primary proportions", "recognizable structure", "material response"],
            "niceToHave": ["micro wear", "secondary lighting match"],
            "reviewViewpoints": review_views,
            "diagnosticTargets": {
                "maximumCentroidDelta": 0.02 if reference_fidelity else 0.05,
                "maximumAspectRatioDelta": 0.03 if reference_fidelity else 0.08,
                "minimumDetailEnergyRatio": 0.75 if reference_fidelity else 0.65,
                "minimumEdgeDensityRatio": 0.35 if reference_fidelity else 0.20,
                "minimumHistogramIntersection": 0.35 if reference_fidelity else 0.25,
                "maximumMeanColorDelta": 0.40 if reference_fidelity else 0.55,
                "minimumHighlightCoverageRatio": 0.10 if reference_fidelity else 0.05,
                "minimumHighlightEnergyRatio": 0.10 if reference_fidelity else 0.05,
                "acceptanceAuthority": False,
                "guardrailMode": "advisory-only",
            },
        },
        "selfCorrectLoop": {
            "enabled": True,
            "reviewAfterPasses": pass_ids,
            "allowedActions": [
                "continue",
                "refine-spec",
                "refine-code",
                "refine-batch",
                "request-input",
                "stop",
            ],
            "specRefineTriggers": ["missing part", "wrong primitive", "wrong proportions", "reference ambiguity"],
            "codeRefineTriggers": ["render mismatch", "runtime failure", "performance budget exceeded"],
            "stopCriteria": ["quality target reached", "remaining gap needs a better reference or manual art"],
            "visualAcceptance": {
                "reviewer": "ai-vision",
                # Profile fidelity remains useful for prioritisation, but v4
                # promotion deliberately uses the lighter explicit phase gate.
                "threshold": 0.70,
                "minimumAiVisionScore": 0.70,
                "comparisonArtifactRequired": True,
                "layerScoresRequired": False,
                "codePixelDiffIsAcceptanceAuthority": False,
                "requiredLayerScores": [],
                "scoringRule": (
                    "The primary independent reviewer returns one composite 0-to-1 score, "
                    "reviews every critical or mustPass feature target, and supplies concrete "
                    "corrections; the blind visual scout supplies only the independent binary "
                    "visual gate."
                ),
                "featureReviewPolicy": primary_feature_review_policy(quality_profile),
            },
            "visualSanity": {
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
                    "A critical or major wrong placement, imbalance, wrong shape, implausible material, "
                    "or identity-detail defect blocks acceptance regardless of average score."
                ),
            },
            "screenshotPolicy": {
                "requiredForPasses": visual_pass_ids,
                "preferredCapture": "in-app-browser-screenshot",
                "fallbackCapture": "user-supplied-screenshot-path",
                "minimumEvidence": "Required reference/render views, one combined sheet, AI scores, and critique.",
                "reviewPairRule": "Use matching camera and framing whenever possible.",
                "acceptanceAuthority": "AI vision plus pass-specific semantic gates.",
            },
        },
        "featureReviewTargets": [
            {
                "id": "overall-silhouette",
                "name": "Overall silhouette and proportions",
                "tier": "critical",
                "passIds": [
                    pass_id
                    for pass_id in ("blockout", "form")
                    if pass_id in pass_ids
                ],
                "minimumScore": critical_threshold,
                "mustPass": True,
                "componentRefs": ["root"],
                "evidenceRefs": ["full-object"],
                "criteria": [
                    "Replace this starter criterion with the source-specific silhouette, negative spaces, and primary proportions."
                ],
            },
            {
                "id": "primary-structure",
                "name": "Primary structure and attachment system",
                "tier": "critical",
                "passIds": [
                    pass_id
                    for pass_id in ("form",)
                    if pass_id in pass_ids
                ],
                "minimumScore": critical_threshold,
                "mustPass": True,
                "componentRefs": ["root"],
                "evidenceRefs": ["full-object"],
                "criteria": [
                    "Replace this starter criterion with the source-specific major parts, hierarchy, attachments, and contacts."
                ],
            },
            {
                "id": "reference-lookdev",
                "name": "Reference material and lighting response",
                "tier": "critical",
                "passIds": [
                    pass_id for pass_id in ("lookdev",) if pass_id in pass_ids
                ],
                "minimumScore": lookdev_feature_threshold,
                "mustPass": True,
                "componentRefs": ["root"],
                "evidenceRefs": ["full-object"],
                "criteria": [
                    "Replace this starter criterion with the source-specific material zones, surface response, lighting, and grounding."
                ],
            },
        ],
        "actionReadiness": {
            "enabled": interactive,
            "contract": (
                "Use stable named pivot nodes for assessed motion affordances; add sockets, colliders, "
                "or destruction data only when explicitly required."
            ),
            "defaultRigType": "action-ready-rig" if interactive else "stable-static-root",
            "rootMotionNode": "root",
            "requiredComponentFields": ["id", "parent", "transform", "actionProfile"],
            "transformChannels": ["translate", "rotate", "scale", "visibility"],
            "authoringRules": ["Do not merge independently movable parts."],
            "destructionPolicy": {"defaultBreakable": False},
        },
        "interactionContract": interaction_contract,
        "uncertaintyContract": {
            "rule": (
                "Before implementation, resolve every preSpecAssessment unknown or move it into exactly one "
                "bounded assumptions[] or known risks[] record. Plain strings are not sufficient."
            ),
            "assumptionRequiredFields": [
                "id", "statement", "scope", "bounds", "impactIfWrong", "falsifyingCheck"
            ],
            "riskRequiredFields": ["id", "statement", "scope", "impact", "mitigation"],
        },
        "assumptions": [],
        "risks": [],
        "coordinateFrame": {
            "front": "camera-facing side in the reference",
            "up": "image up",
            "scaleReference": "relative unit scale until first render review",
        },
        "silhouette": {
            "boundingShape": "",
            "aspectRatios": [],
            "symmetry": "",
            "dominantCurves": [],
            "negativeSpaces": [],
            "landmarks": [],
        },
        "viewEvidence": [
            {
                "id": "full-object",
                "view": "primary",
                "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
                "observations": [],
                "confidence": 0.5,
            }
        ],
        "componentNamingContract": {
            "idFormat": "<system>-<structural-part>[-<side|index|function>]",
            "nameRule": (
                "Name the observed construction part or assembly, not its primitive, material, implementation class, "
                "or an arbitrary sequence number."
            ),
            "forbiddenExamples": [
                "part-01", "mesh-a", "component-2", "body", "object", "placeholder-wing"
            ],
            "validExamples": [
                "fuselage-cockpit-shell", "main-rotor-blade-01", "left-landing-gear-strut", "rocket-pod-tube-bank"
            ],
            "rootException": "The one parentless global root may use id 'root'.",
        },
        "componentTree": [make_root_component(target_name, interactive)],
        "materials": [make_base_material(quality_profile)],
        "repetitionSystems": [],
        "buildPasses": passes,
        "lookDevTargets": {
            "qualityPriority": quality_profile,
            "materialPass": {
                "minimumTextureResolution": 1024,
                "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"],
                "referencePbrExtraction": {
                    "requiredWhenSourceImagePresent": quality_profile == "reference-fidelity",
                    "targetThreshold": pbr_threshold,
                    "stopOnLowConfidence": True,
                    "acceptedLimitation": "Single-image maps are inferred material evidence, not photogrammetry.",
                },
            },
            "lightingPass": {"requiredTerms": ["key/fill/environment", "exposure/tone", "contact shadow"]},
            "screenshotReview": review_views,
        },
        "reviewHistory": [],
        "userPhaseApprovals": [],
        "lodPlan": [
            {"tier": "near", "distance": 0, "strategy": "full accepted model"},
            {"tier": "far", "distance": 30, "strategy": "merge static parts and reduce non-silhouette detail"},
        ],
        "performanceAudit": {
            "enabled": False,
            "blocking": False,
            "activation": "explicit-user-budget-only",
            "maximumVisualRegression": 0.0,
            "policy": (
                "Run only after lookdev acceptance. Reject and restore the visual champion if any "
                "protected visual score decreases."
            ),
        },
        "lightingFromPhoto": [],
        "proceduralStrategy": [
            "Match silhouette and proportions.",
            "Resolve hierarchy, attachment, balance, and local form together in the form phase.",
            "Validate material, surface, lighting, and contact shadow together.",
            "Assess motion automatically; run interaction only for approved affordances.",
            "Run performance as an optional post-quality audit, never as a modeling target.",
        ],
    }
    spec.update(
        make_perceptual_fields(
            image or "",
            reference_preparation,
            quality_profile,
            approval_mode,
            perceptual_enforcement,
        )
    )
    if intended_use:
        spec["legacyIntent"] = {
            "value": intended_use,
            "deprecated": True,
            "rule": "Migration hint only; it does not select quality or performance passes.",
        }
    sync_pipeline(spec)
    return spec


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target_name")
    parser.add_argument("--image", required=True)
    parser.add_argument(
        "--reference-separation",
        "--reference-background",
        dest="reference_background",
        choices=("unassessed", "mixed", "clear", "present", "absent"),
        default="unassessed",
        help=(
            "Classify subject/background separation. Use clear for white or contrasting "
            "backgrounds; mixed requires an ImageGen white-background output. present is a legacy alias for mixed."
        ),
    )
    parser.add_argument(
        "--imagegen-preparation-mode",
        "--background-removal-mode",
        dest="background_removal_mode",
        choices=("white-background-cleanup", "white-background-simplification"),
        help=(
            "Create a solid-white ImageGen reference. Simplification may remove only declared, "
            "non-identity detail. The older option name remains as a CLI alias."
        ),
    )
    parser.add_argument(
        "--imagegen-trigger",
        choices=(
            "background-mixing",
            "excessive-complexity",
            "low-source-quality",
            "real-object-photo",
            "combined",
        ),
        help=(
            "Why ImageGen preparation is required; real-object-photo selects a "
            "buildable 3D-style simplification."
        ),
    )
    parser.add_argument(
        "--declared-simplification",
        action="append",
        default=[],
        help="Repeat for each bounded detail family intentionally simplified in the generated reference.",
    )
    parser.add_argument(
        "--complexity",
        choices=("simple", "moderate", "complex", "ultra"),
        default="moderate",
    )
    parser.add_argument(
        "--planning-sheet-layout",
        choices=("standard", "exploded"),
        default="standard",
        help=(
            "Use exploded only for complex/ultra assemblies whose internal or separable "
            "parts are easier to reconstruct when shown apart."
        ),
    )
    parser.add_argument(
        "--intended-use",
        choices=("static-render", "browser-prop", "game-prop", "animated", "playable", "destructible"),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--quality-profile",
        choices=("balanced", "reference-fidelity"),
        default="reference-fidelity",
        help="Defaults to reference-fidelity so new reconstructions do not silently downgrade quality.",
    )
    parser.add_argument(
        "--approval-mode",
        choices=("final-only", "phase-by-phase"),
        default="final-only",
        help=(
            "Defaults to final-only for the fast perceptual workflow. Use phase-by-phase "
            "when every intermediate artifact needs explicit approval."
        ),
    )
    parser.add_argument(
        "--perceptual-enforcement",
        choices=("strict", "advisory"),
        default="strict",
        help="Strict mode binds review and promotion to ViewingContract and capability coverage.",
    )
    parser.add_argument(
        "--assessment",
        type=Path,
        help="Optional legacy assessment JSON; pre-spec is already included by this command.",
    )
    parser.add_argument(
        "--layout",
        choices=("modular", "monolithic"),
        default="monolithic",
        help=(
            "monolithic is the default progressive four-phase fast path. Use modular only "
            "for independently isolatable subsystems with valid module-local reference evidence."
        ),
    )
    parser.add_argument("--out", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    try:
        spec = make_spec(
            args.target_name,
            args.image,
            load_assessment(args.assessment),
            args.complexity,
            args.intended_use,
            args.quality_profile,
            args.reference_background,
            args.background_removal_mode,
            args.imagegen_trigger,
            args.declared_simplification,
            args.approval_mode,
            args.perceptual_enforcement,
            args.planning_sheet_layout,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    if args.layout == "modular":
        from sculpt_modules import make_manifest

        payload_object = make_manifest(spec)
    else:
        payload_object = spec
    payload = json.dumps(payload_object, indent=2, ensure_ascii=False) + "\n"
    if not args.out:
        print(payload, end="")
        return 0
    output = args.out.expanduser().resolve()
    if output.exists() and not args.force:
        parser.error(f"{output} already exists; use --force to overwrite")
    write_spec_atomic(output, payload_object)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
