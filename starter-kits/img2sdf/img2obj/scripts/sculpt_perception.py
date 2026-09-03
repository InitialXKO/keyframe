#!/usr/bin/env python3
"""Perceptual reconstruction contracts shared by planning and review.

The contract deliberately describes the image result that must survive, not a
preferred topology.  Geometry, cards, decals, material response, and hybrid
representations remain implementation choices bounded by the viewing contract.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Mapping


PERCEPTUAL_CONTRACT_VERSION = 1
VIEWING_CONTRACT_VERSION = 2
SUPPORTED_VIEWING_CONTRACT_VERSIONS = frozenset({1, VIEWING_CONTRACT_VERSION})
RENDER_PIPELINE_CONTRACT_VERSION = 1
RENDER_PIPELINE_MODES = frozenset(
    {"auto", "native-msaa", "smaa", "fxaa", "off"}
)
RENDER_PIPELINE_QUALITY_PRESETS = frozenset({"quality", "performance"})
VISUAL_IDENTITY_VERSION = 1
EVIDENCE_ROLES = frozenset({"acceptance-target", "planning-veto"})
REPRESENTATION_MODES = frozenset(
    {
        "true-geometry",
        "proxy-geometry",
        "card",
        "decal",
        "material-response",
        "procedural-effect",
        "hybrid",
    }
)


def make_perceptual_fields(
    source_image: str = "",
    reference_preparation: Mapping[str, Any] | None = None,
    quality_profile: str = "reference-fidelity",
    approval_mode: str = "phase-by-phase",
    enforcement_mode: str = "advisory",
) -> dict[str, Any]:
    preparation = (
        copy.deepcopy(dict(reference_preparation))
        if isinstance(reference_preparation, Mapping)
        else {}
    )
    prepared = str(preparation.get("method") or "").startswith("imagegen-prepared")
    render_quality = "quality" if quality_profile == "reference-fidelity" else "performance"
    return {
        "perceptualContract": {
            "version": PERCEPTUAL_CONTRACT_VERSION,
            "objective": "viewing-contract-indistinguishable",
            "qualityProfile": quality_profile,
            "structurePolicy": (
                "Structural and physical correctness are required only where they affect "
                "the declared views, lighting response, shadows, parallax, or interaction states."
            ),
            "representationPolicy": (
                "Choose the cheapest stable representation that preserves human-visible identity "
                "inside viewingContract; never use implementation correctness as visual evidence."
            ),
            "reviewPolicy": {
                "mode": "salience-blocker-driven",
                "maximumActiveBlockers": 3,
                "numericScores": "trend-only",
                "passCondition": (
                    "No unresolved major or critical salience blocker inside viewingContract, "
                    "no acceptance-reference drift, and no visible champion regression."
                ),
                "capabilityGapFailsClosed": True,
            },
            "approvalMode": approval_mode,
            "enforcementMode": enforcement_mode,
        },
        "viewingContract": {
            "version": VIEWING_CONTRACT_VERSION,
            "status": "unassessed",
            "primaryViewId": "reference",
            "requiredViewIds": ["reference"],
            "allowedViewConeDegrees": 0.0,
            "targetResolution": {"width": 0, "height": 0},
            "displayScale": "reference-native",
            "backgroundMode": "match-reference",
            "lightingMode": "match-reference-response",
            "interactionStates": ["rest"],
            "outOfContractDisclosureRequired": True,
            "renderPipeline": {
                "version": RENDER_PIPELINE_CONTRACT_VERSION,
                "status": "required",
                "backend": "webgl",
                "antiAliasing": {
                    "mode": "auto",
                    "qualityPreset": render_quality,
                    "fallbackOrder": (
                        ["smaa", "fxaa"]
                        if render_quality == "quality"
                        else ["fxaa", "smaa"]
                    ),
                },
                "maxPixelRatio": 2.0,
                "fallbackPolicy": "fail-closed",
            },
        },
        "evidenceAuthority": {
            "version": 2,
            "acceptanceTarget": {
                "role": "acceptance-target",
                "path": source_image,
                "prepared": prepared,
            },
            "syntheticTurnaround": {
                "role": "planning-veto",
                "source": "viewHypothesisPolicy",
                "mayApproveFidelity": False,
            },
        },
        "visualIdentitySpec": {
            "version": VISUAL_IDENTITY_VERSION,
            "status": "unassessed",
            "primarySilhouette": [],
            "negativeSpaces": [],
            "signatureFeatures": [],
            "dominantMaterialZones": [],
            "protectedTraits": [
                "object-class",
                "recognizable-identity",
                "primary-silhouette",
                "macro-proportions",
                "major-component-layout",
                "signature-features",
                "dominant-material-zones",
            ],
            "salienceGraph": {
                "nodes": [],
                "edges": [],
                "rankingRule": (
                    "Rank by identity impact at target display size, not by geometric complexity."
                ),
            },
        },
        "representationPlan": {
            "version": 1,
            "status": "unassessed",
            "componentStrategies": [],
            "allowedModes": sorted(REPRESENTATION_MODES),
            "selectionRule": (
                "Use visual cheats only when their failure mode is outside viewingContract "
                "and that limitation is disclosed."
            ),
        },
        "capabilityPlan": {
            "version": 1,
            "status": "unassessed",
            "activePacks": [],
            "componentRoutes": [],
            "globalRoutes": [],
            "capabilityGaps": [],
            "routingPolicy": "composable-component-packs-lazy-expanded-by-active-blocker",
        },
    }


def render_pipeline_contract(spec: Mapping[str, Any]) -> dict[str, Any] | None:
    viewing = spec.get("viewingContract")
    pipeline = viewing.get("renderPipeline") if isinstance(viewing, Mapping) else None
    return copy.deepcopy(dict(pipeline)) if isinstance(pipeline, Mapping) else None


def render_pipeline_contract_sha256(spec: Mapping[str, Any]) -> str:
    pipeline = render_pipeline_contract(spec)
    if pipeline is None:
        return ""

    def normalize_json_number(value: Any) -> Any:
        """Match ECMAScript JSON number spelling for cross-runtime receipts."""
        if isinstance(value, Mapping):
            return {
                str(key): normalize_json_number(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [normalize_json_number(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    encoded = json.dumps(
        normalize_json_number(pipeline),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def render_pipeline_contract_failures(pipeline: Any) -> list[str]:
    if not isinstance(pipeline, Mapping):
        return ["viewingContract.renderPipeline must be an object"]
    failures: list[str] = []
    if pipeline.get("version") != RENDER_PIPELINE_CONTRACT_VERSION:
        failures.append(
            "viewingContract.renderPipeline.version must be "
            f"{RENDER_PIPELINE_CONTRACT_VERSION}"
        )
    status = pipeline.get("status")
    if status not in {"required", "not-required"}:
        failures.append(
            "viewingContract.renderPipeline.status must be required or not-required"
        )
    if pipeline.get("backend") != "webgl":
        failures.append(
            "viewingContract.renderPipeline.backend must be webgl in contract version 1"
        )
    anti_aliasing = pipeline.get("antiAliasing")
    if not isinstance(anti_aliasing, Mapping):
        failures.append(
            "viewingContract.renderPipeline.antiAliasing must be an object"
        )
    else:
        mode = anti_aliasing.get("mode")
        if mode not in RENDER_PIPELINE_MODES:
            failures.append(
                "viewingContract.renderPipeline.antiAliasing.mode is unsupported"
            )
        if status == "required" and mode == "off":
            failures.append(
                "required renderPipeline cannot disable anti-aliasing"
            )
        if anti_aliasing.get("qualityPreset") not in RENDER_PIPELINE_QUALITY_PRESETS:
            failures.append(
                "viewingContract.renderPipeline.antiAliasing.qualityPreset "
                "must be quality or performance"
            )
        fallback_order = anti_aliasing.get("fallbackOrder")
        if (
            not isinstance(fallback_order, list)
            or not fallback_order
            or len(fallback_order) != len(set(fallback_order))
            or any(item not in {"smaa", "fxaa"} for item in fallback_order)
        ):
            failures.append(
                "viewingContract.renderPipeline.antiAliasing.fallbackOrder must "
                "contain unique smaa/fxaa modes"
            )
    max_pixel_ratio = pipeline.get("maxPixelRatio")
    if (
        not isinstance(max_pixel_ratio, (int, float))
        or isinstance(max_pixel_ratio, bool)
        or not 1 <= float(max_pixel_ratio) <= 4
    ):
        failures.append(
            "viewingContract.renderPipeline.maxPixelRatio must be within 1..4"
        )
    if pipeline.get("fallbackPolicy") != "fail-closed":
        failures.append(
            "viewingContract.renderPipeline.fallbackPolicy must be fail-closed"
        )
    return failures


def render_pipeline_receipt_failures(
    spec: Mapping[str, Any],
    receipt: Any,
) -> list[str]:
    pipeline = render_pipeline_contract(spec)
    if pipeline is None or pipeline.get("status") != "required":
        return []
    if not isinstance(receipt, Mapping):
        return ["required render pipeline has no hash-bound runtime receipt"]
    failures: list[str] = []
    if receipt.get("artifactType") != "threejs-sculpt-render-receipt":
        failures.append("render receipt artifactType is invalid")
    if receipt.get("version") != 1:
        failures.append("render receipt version must be 1")
    if receipt.get("backend") != "webgl":
        failures.append("render receipt backend must be webgl")
    if receipt.get("contractSha256") != render_pipeline_contract_sha256(spec):
        failures.append("render receipt does not match viewingContract.renderPipeline")
    anti_aliasing = pipeline.get("antiAliasing")
    requested_mode = (
        anti_aliasing.get("mode") if isinstance(anti_aliasing, Mapping) else None
    )
    if receipt.get("requestedMode") != requested_mode:
        failures.append("render receipt requestedMode does not match the contract")
    resolved_mode = receipt.get("resolvedMode")
    if resolved_mode not in {"native-msaa", "smaa", "fxaa"}:
        failures.append("required render receipt did not resolve an anti-aliasing mode")
    if receipt.get("antialiasVerified") is not True:
        failures.append("render receipt did not verify active anti-aliasing")
    frame_count = receipt.get("frameCount")
    if (
        not isinstance(frame_count, int)
        or isinstance(frame_count, bool)
        or frame_count < 1
    ):
        failures.append("render receipt must prove at least one pipeline-rendered frame")
    if receipt.get("disposed") is not False:
        failures.append("render receipt must prove an active, non-disposed pipeline")
    if requested_mode in {"native-msaa", "smaa", "fxaa"} and (
        resolved_mode != requested_mode
    ):
        failures.append(
            "explicit render receipt requestedMode must equal resolvedMode"
        )
    pass_chain = receipt.get("passChain")
    expected_chain = {
        "native-msaa": ["renderer"],
        "smaa": ["RenderPass", "SMAAPass", "OutputPass"],
        "fxaa": ["RenderPass", "OutputPass", "FXAAPass"],
    }.get(str(resolved_mode))
    if expected_chain is not None and pass_chain != expected_chain:
        failures.append("render receipt passChain does not match the resolved AA mode")
    expected_output_owner = (
        "renderer" if resolved_mode == "native-msaa" else "OutputPass"
    )
    if receipt.get("outputTransformOwner") != expected_output_owner:
        failures.append(
            "render receipt outputTransformOwner does not match the resolved AA mode"
        )
    if resolved_mode == "native-msaa" and (
        receipt.get("contextAntialias") is not True
        or not isinstance(receipt.get("defaultFramebufferSamples"), int)
        or isinstance(receipt.get("defaultFramebufferSamples"), bool)
        or receipt.get("defaultFramebufferSamples", 0) < 1
    ):
        failures.append("native-msaa receipt has no verified default-framebuffer samples")
    for field in ("logicalWidth", "logicalHeight"):
        value = receipt.get(field)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value <= 0
        ):
            failures.append(f"render receipt {field} must be positive")
    pixel_ratio = receipt.get("pixelRatio")
    if (
        not isinstance(pixel_ratio, (int, float))
        or isinstance(pixel_ratio, bool)
        or not 1 <= float(pixel_ratio) <= float(pipeline.get("maxPixelRatio", 0))
    ):
        failures.append("render receipt pixelRatio is outside the contract")
    if not isinstance(receipt.get("threeRevision"), str) or not receipt.get(
        "threeRevision"
    ):
        failures.append("render receipt must identify the Three.js revision")
    return failures


def ensure_perceptual_fields(spec: dict[str, Any]) -> int:
    defaults = make_perceptual_fields(
        str(spec.get("sourceImage") or ""),
        spec.get("referencePreparation")
        if isinstance(spec.get("referencePreparation"), Mapping)
        else None,
        str(spec.get("qualityProfile") or "reference-fidelity"),
    )
    changed = 0
    for field, value in defaults.items():
        if not isinstance(spec.get(field), dict):
            spec[field] = value
            changed += 1
    viewing = spec.get("viewingContract")
    default_viewing = defaults["viewingContract"]
    if isinstance(viewing, dict) and (
        viewing.get("version") == 1 or not isinstance(viewing.get("renderPipeline"), dict)
    ):
        viewing["version"] = VIEWING_CONTRACT_VERSION
        viewing["renderPipeline"] = copy.deepcopy(default_viewing["renderPipeline"])
        changed += 1
    plan = spec.get("capabilityPlan")
    if isinstance(plan, dict) and not isinstance(plan.get("globalRoutes"), list):
        plan["globalRoutes"] = []
        changed += 1
    return changed


def validate_perceptual_contract(spec: Mapping[str, Any]) -> list[str]:
    """Validate only present perceptual fields so legacy specs stay readable."""

    if "perceptualContract" not in spec:
        return []
    failures: list[str] = []
    contract = spec.get("perceptualContract")
    if not isinstance(contract, Mapping):
        return ["perceptualContract must be an object"]
    if contract.get("version") != PERCEPTUAL_CONTRACT_VERSION:
        failures.append(
            f"perceptualContract.version must be {PERCEPTUAL_CONTRACT_VERSION}"
        )
    if contract.get("objective") != "viewing-contract-indistinguishable":
        failures.append(
            "perceptualContract.objective must be viewing-contract-indistinguishable"
        )
    review = contract.get("reviewPolicy")
    if not isinstance(review, Mapping):
        failures.append("perceptualContract.reviewPolicy must be an object")
    elif review.get("maximumActiveBlockers") != 3:
        failures.append(
            "perceptualContract.reviewPolicy.maximumActiveBlockers must be 3"
        )
    if contract.get("approvalMode") not in {"phase-by-phase", "final-only"}:
        failures.append(
            "perceptualContract.approvalMode must be phase-by-phase or final-only"
        )
    if contract.get("enforcementMode") not in {"advisory", "strict"}:
        failures.append(
            "perceptualContract.enforcementMode must be advisory or strict"
        )
    if (
        contract.get("enforcementMode") == "strict"
        and not str(spec.get("sourceImage") or "").strip()
    ):
        failures.append("strict perceptual enforcement requires a non-empty sourceImage")

    viewing = spec.get("viewingContract")
    if not isinstance(viewing, Mapping):
        failures.append("viewingContract must be an object")
    else:
        viewing_version = viewing.get("version")
        if viewing_version not in SUPPORTED_VIEWING_CONTRACT_VERSIONS:
            failures.append(
                "viewingContract.version must be one of "
                + ", ".join(str(item) for item in sorted(SUPPORTED_VIEWING_CONTRACT_VERSIONS))
            )
        if viewing_version == VIEWING_CONTRACT_VERSION:
            failures.extend(
                render_pipeline_contract_failures(viewing.get("renderPipeline"))
            )
        required_views = viewing.get("requiredViewIds")
        if (
            not isinstance(required_views, list)
            or not required_views
            or not all(isinstance(item, str) and item for item in required_views)
        ):
            failures.append("viewingContract.requiredViewIds must be a non-empty string array")
        cone = viewing.get("allowedViewConeDegrees")
        if (
            not isinstance(cone, (int, float))
            or isinstance(cone, bool)
            or not 0 <= float(cone) <= 180
        ):
            failures.append("viewingContract.allowedViewConeDegrees must be within 0..180")

    authority = spec.get("evidenceAuthority")
    if not isinstance(authority, Mapping):
        failures.append("evidenceAuthority must be an object")
    else:
        authority_version = authority.get("version")
        if authority_version not in {1, 2}:
            failures.append("evidenceAuthority.version must be 1 or 2")
        roles = {
            entry.get("role")
            for entry in authority.values()
            if isinstance(entry, Mapping) and "role" in entry
        }
        required_roles = (
            {"acceptance-target", "identity-veto", "planning-veto"}
            if authority_version == 1
            else EVIDENCE_ROLES
        )
        if not required_roles <= roles:
            failures.append(
                "evidenceAuthority must declare the roles required by its version"
            )
        synthetic = authority.get("syntheticTurnaround")
        if (
            not isinstance(synthetic, Mapping)
            or synthetic.get("mayApproveFidelity") is not False
        ):
            failures.append(
                "evidenceAuthority.syntheticTurnaround.mayApproveFidelity must be false"
            )
        acceptance = authority.get("acceptanceTarget")
        identity = authority.get("identityGuardrail")
        source_image = str(spec.get("sourceImage") or "")
        preparation = spec.get("referencePreparation")
        preparation = preparation if isinstance(preparation, Mapping) else {}
        if not isinstance(acceptance, Mapping) or acceptance.get("path") != source_image:
            failures.append(
                "evidenceAuthority.acceptanceTarget.path must equal sourceImage"
            )
        if authority_version == 1:
            original_image = str(preparation.get("originalImage") or source_image)
            if not isinstance(identity, Mapping) or identity.get("path") != original_image:
                failures.append(
                    "legacy evidenceAuthority.identityGuardrail.path must equal "
                    "referencePreparation.originalImage"
                )
        elif isinstance(identity, Mapping):
            failures.append(
                "evidenceAuthority version 2 uses sourceImage as the sole acceptance reference"
            )
        prepared = str(preparation.get("method") or "").startswith("imagegen-prepared")
        if prepared:
            if preparation.get("outputImage") != source_image:
                failures.append(
                    "ImageGen preparation outputImage must equal the acceptance sourceImage"
                )

    identity = spec.get("visualIdentitySpec")
    if not isinstance(identity, Mapping):
        failures.append("visualIdentitySpec must be an object")
    elif not isinstance(identity.get("salienceGraph"), Mapping):
        failures.append("visualIdentitySpec.salienceGraph must be an object")

    representation = spec.get("representationPlan")
    if not isinstance(representation, Mapping):
        failures.append("representationPlan must be an object")
    else:
        modes = representation.get("allowedModes")
        if not isinstance(modes, list) or set(modes) != REPRESENTATION_MODES:
            failures.append(
                "representationPlan.allowedModes must declare every supported representation mode"
            )
    return failures


def perceptual_review_failures(
    spec: Mapping[str, Any],
    entry: Mapping[str, Any],
) -> list[str]:
    contract = spec.get("perceptualContract")
    if (
        not isinstance(contract, Mapping)
        or contract.get("enforcementMode") != "strict"
    ):
        return []
    failures = validate_perceptual_contract(spec)
    viewing = spec.get("viewingContract")
    viewing = viewing if isinstance(viewing, Mapping) else {}
    if viewing.get("status") != "assessed":
        failures.append("viewingContract must be assessed before perceptual review")
    resolution = viewing.get("targetResolution")
    if not isinstance(resolution, Mapping) or any(
        not isinstance(resolution.get(axis), int)
        or isinstance(resolution.get(axis), bool)
        or resolution.get(axis, 0) <= 0
        for axis in ("width", "height")
    ):
        failures.append(
            "viewingContract.targetResolution must contain positive integer width and height"
        )
    evidence = entry.get("evidence")
    evidence = evidence if isinstance(evidence, Mapping) else {}
    observed_views = {
        str(view.get("viewId"))
        for view in evidence.get("views", [])
        if isinstance(view, Mapping) and isinstance(view.get("viewId"), str)
    }
    required_views = {
        str(view_id)
        for view_id in viewing.get("requiredViewIds", [])
        if isinstance(view_id, str)
    }
    missing = sorted(required_views - observed_views)
    if missing:
        failures.append(
            "review evidence is missing ViewingContract views: " + ", ".join(missing)
        )
    plan = spec.get("capabilityPlan")
    gaps = plan.get("capabilityGaps", []) if isinstance(plan, Mapping) else []
    unresolved = [
        gap
        for gap in gaps
        if isinstance(gap, Mapping)
        and gap.get("status") not in {"resolved", "out-of-contract"}
    ]
    if unresolved:
        failures.append("unresolved in-contract capability-gap blocks promotion")
    render_provenance = (
        evidence.get("renderProvenance")
        if isinstance(evidence.get("renderProvenance"), Mapping)
        else {}
    )
    runtime_receipt = (
        render_provenance.get("runtimeReceipt")
        if isinstance(render_provenance, Mapping)
        else None
    )
    render_receipt = (
        render_provenance.get("renderReceipt")
        if isinstance(render_provenance, Mapping)
        else None
    )
    if render_receipt is None and isinstance(runtime_receipt, Mapping):
        render_receipt = runtime_receipt.get("renderPipeline")
    failures.extend(render_pipeline_receipt_failures(spec, render_receipt))
    corrections = entry.get("reviewCorrections", [])
    for index, correction in enumerate(corrections if isinstance(corrections, list) else []):
        if not isinstance(correction, Mapping):
            continue
        if not isinstance(correction.get("packId"), str) or not isinstance(
            correction.get("operatorId"), str
        ):
            failures.append(
                f"reviewCorrections[{index}] must use a registered packId/operatorId"
            )
    batch = entry.get("correctionBatch")
    if isinstance(batch, Mapping) and batch:
        # Imported lazily after sculpt_contract initialization, avoiding a
        # module-load cycle while keeping review and execution on one validator.
        from sculpt_corrections import correction_failures

        failures.extend(
            correction_failures(
                spec,
                batch,
                active_phase=str(entry.get("passId") or ""),
            )
        )
    return list(dict.fromkeys(failures))


def perceptual_context(spec: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "perceptualContract": copy.deepcopy(spec.get("perceptualContract", {})),
        "viewingContract": copy.deepcopy(spec.get("viewingContract", {})),
        "evidenceAuthority": copy.deepcopy(spec.get("evidenceAuthority", {})),
        "visualIdentitySpec": copy.deepcopy(spec.get("visualIdentitySpec", {})),
        "representationPlan": copy.deepcopy(spec.get("representationPlan", {})),
        "capabilityPlan": copy.deepcopy(spec.get("capabilityPlan", {})),
    }
