from __future__ import annotations

import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from append_sculpt_review import (  # noqa: E402
    _pending_pass_batch_failures,
    _pass_refinement_progress_failures,
    main as append_review,
)
from extract_reference_pbr import make_tileable_rgb  # noqa: E402
from generate_threejs_factory import generate, scale_vector  # noqa: E402
from make_visual_comparison_sheet import (  # noqa: E402
    appearance_diagnostics,
    create_sheet_pairs,
    main as comparison_main,
    read_png,
    resize_contain,
    write_png_rgb,
)
from new_sculpt_spec import make_spec  # noqa: E402
from sculpt_contract import (  # noqa: E402
    blind_scout_entry_failures,
    blind_scout_mapping_failures,
    build_pass_plan,
    correction_batch_from_verdict,
    effective_pass_config,
    file_sha256,
    generation_validation_hash,
    phase_work_packet,
    pipeline_status,
    phase_review_key,
    quality_candidate_disposition,
    refinement_budget,
    record_user_phase_decision,
    review_target_catalog,
    review_failures,
    review_spec_hash,
    sculpt_representation_signature,
    sync_pipeline,
    visual_evidence_integrity_failures,
    visual_evidence_authority_failures,
    visual_evidence_manifest_sha256,
    write_spec_atomic,
)
from sculpt_pass_orchestrator import context_payload, pass_specific_gaps  # noqa: E402
from sculpt_view_hypotheses import register_views  # noqa: E402
from validate_sculpt_spec import load_spec, validate_spec  # noqa: E402
from tests.style_helpers import make_assessed_visual_style  # noqa: E402


def downstream_impact(phase: str = "finalization") -> list[dict[str, str]]:
    return [
        {
            "phase": phase,
            "prediction": "The correction may affect the later integrated artifact.",
            "currentMitigation": "Keep the edit inside the declared targets and paths.",
            "futureVerification": "Run the later phase build and regression checks.",
        }
    ]


def fill_pre_spec(spec: dict) -> None:
    object_class = spec["preSpecAssessment"]["objectClass"]
    object_class.update(
        {
            "primaryType": "test prop",
            "representationKind": ["solid mesh"],
            "formLanguage": ["hard-surface"],
            "structureKind": ["single body"],
            "motionPotential": ["static prop"],
            "materialFamilies": ["painted wood"],
        }
    )
    spec["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style()
    spec["preSpecAssessment"]["complexity"].update(
        {
            "status": "assessed",
            "tier": spec["preSpecAssessment"]["complexity"].get("initialTierHint") or "moderate",
            "scores": {
                "silhouetteComplexity": 0,
                "formTopologyComplexity": 0,
                "componentCount": 0,
                "hierarchyDepth": 0,
                "repetitionDensity": 0,
                "materialLayerCount": 0,
                "localDetailDensity": 0,
                "representationComplexity": 0,
            },
            "modifiers": {
                "occlusionRisk": 0,
                "actionReadinessNeed": 0,
            },
            "evidenceRefs": ["test://ref.png"],
            "reasoning": ["Pre-spec test assessment completed."],
        }
    )
    spec["silhouette"].update(
        {
            "boundingShape": "tall rounded rectangle",
            "aspectRatios": ["width:height=1:2"],
            "dominantCurves": ["rounded upper contour"],
        }
    )
    spec["interactionContract"].update(
        {
            "status": "not-required",
            "assessmentReason": "The static test prop has no observed or inferred moving parts.",
        }
    )
    spec["viewHypothesisPolicy"].update(
        {
            "enabled": False,
            "decision": "not-needed",
            "decisionReason": "The synthetic test fixture is simple and symmetric in depth.",
            "skipAssessment": {
                "objectIsSimple": True,
                "symmetry": "bilateral",
                "confidence": 0.95,
                "evidenceRefs": ["full-object"],
                "reason": "The observed fixture has one simple mirrored continuous volume.",
            },
        }
    )
    spec["detailDecompositionContract"]["status"] = "planned"
    for target in spec.get("featureReviewTargets", []):
        if isinstance(target, dict):
            target["criteria"] = [
                f"Match the observed test prop {str(target.get('name') or target.get('id')).lower()}."
            ]
    for component in spec.get("componentTree", []):
        if not isinstance(component, dict):
            continue
        component["detailPlan"].update(
            {
                "status": "planned",
                "observedComplexity": "simple",
                "decompositionMode": "atomic",
                "atomicityReason": "The synthetic test fixture is one continuous simple volume.",
                "coverageNotes": "The full outline and the intentionally featureless test surface were checked.",
            }
        )
    for material in spec.get("materials", []):
        material["surfaceDescriptor"] = {
            "status": "assessed",
            "rigidity": {
                "value": "rigid",
                "basis": "inferred",
                "confidence": 0.8,
            },
            "finish": {
                "value": "matte",
                "basis": "observed",
                "confidence": 0.8,
            },
            "microRelief": {
                "value": "pebbled",
                "channel": "normal",
                "basis": "observed",
                "confidence": 0.75,
            },
            "evidenceRefs": ["full-object"],
        }


def comparison_manifest(root: Path, label: str, view_id: str = "primary") -> dict:
    reference = root / f"{label}-reference.png"
    render = root / f"{label}-render.png"
    sheet = root / f"{label}-comparison.png"
    background = (4, 6, 10)
    reference_pixels = [background] * (32 * 32)
    render_pixels = [background] * (32 * 32)
    for y in range(7, 26):
        for x in range(9, 24):
            variation = 8 if (x + y) % 2 else 0
            reference_pixels[y * 32 + x] = (55 + variation, 115 + variation, 190)
            render_pixels[y * 32 + x] = (58 + variation, 118 + variation, 188)
    write_png_rgb(reference, 32, 32, reference_pixels)
    write_png_rgb(render, 32, 32, render_pixels)
    pairs = [{"viewId": view_id, "referenceImage": reference, "renderScreenshot": render}]
    if view_id != "side":
        pairs.append(
            {
                "viewId": "side",
                "referenceImage": reference,
                "renderScreenshot": render,
                "referenceProvenance": {
                    "origin": "synthetic-hypothesis",
                    "allowedUse": "planning-veto",
                    "source": "test-turnaround",
                },
            }
        )
    payload = create_sheet_pairs(
        pairs,
        sheet,
        128,
        128,
        6,
    )
    return {key: value for key, value in payload.items() if key != "evidenceSet"}


def independent_pass_verdict(
    spec: dict,
    pass_id: str,
    evidence: dict,
    review_id: str,
    *,
    overall_score: float = 0.84,
    layer_scores: dict | None = None,
    feature_ids: list[str] | None = None,
) -> dict:
    view_ids = [
        view["viewId"]
        for view in evidence.get("views", [])
        if isinstance(view, dict)
        and isinstance(view.get("viewId"), str)
        and view["viewId"]
    ]
    primary_view = view_ids[0] if view_ids else "primary"
    config = effective_pass_config(spec, pass_id)
    sanity = config.get("visualSanity")
    sanity_categories = (
        sanity.get("requiredCategories", []) if isinstance(sanity, dict) else []
    )
    scores = dict(layer_scores or {})
    for category in sanity_categories:
        scores.setdefault(category, overall_score)
    selected_features = feature_ids
    if selected_features is None:
        selected_features = [
            target["id"]
            for target in spec.get("featureReviewTargets", [])
            if isinstance(target, dict)
            and isinstance(target.get("id"), str)
            and pass_id in target.get("passIds", [])
        ]
    return {
        "artifactType": "threejs-sculpt-pass-review",
        "version": 1,
        "reviewId": review_id,
        "passId": pass_id,
        "specHash": review_spec_hash(spec, pass_id),
        "action": "continue",
        "builder": {"contextId": f"test-builder-{review_id}"},
        "reviewer": {
            "contextId": f"test-reviewer-{review_id}",
            "role": "independent-reviewer",
            "model": "test-vision-model",
        },
        "comparisonSha256": evidence["comparisonSha256"],
        "overallScore": overall_score,
        "layerScores": scores,
        "sanityChecks": {
            category: {
                "status": "pass",
                "summary": f"The {category} check passed in the reviewed evidence.",
                "componentIds": ["root"],
                "viewIds": [primary_view],
            }
            for category in sanity_categories
        },
        "featureReviews": [
            {
                "id": feature_id,
                "score": max(overall_score, 0.86),
                "visible": True,
                "viewIds": [primary_view],
            }
            for feature_id in selected_features
        ],
        "issues": [],
        "corrections": [],
        "resolvedIssueIds": [],
        "resolvedRootCauseKeys": [],
        "blindScout": {
            "artifactType": "threejs-sculpt-blind-scout",
            "version": 2,
            "phaseId": pass_id,
            "decision": "approve",
            "comparisonSha256": evidence["comparisonSha256"],
            "reviewedAt": "2026-07-15T00:00:00+00:00",
            "reviewer": {
                "role": "blind-visual-scout",
                "contextId": f"test-scout-{review_id}",
                "model": "test-blind-scout",
            },
            "observations": [],
        },
        "blindScoutMapping": {
            "artifactType": "threejs-sculpt-blind-scout-mapping",
            "version": 1,
            "mapper": {
                "role": "main-agent",
                "contextId": f"test-builder-{review_id}",
            },
            "items": [],
        },
        "summary": f"Independent reviewer verified the {pass_id} comparison evidence.",
    }


def visual_entry(spec: dict, pass_id: str, root: Path, view_id: str = "primary") -> dict:
    feature_ids = [
        target["id"]
        for target in spec["featureReviewTargets"]
        if pass_id in target["passIds"]
    ]
    layers = {
        "blockout": {
            "silhouette": 0.82,
            "assemblyCorrectness": 0.82,
            "proportionBalance": 0.82,
            "shapeSilhouette": 0.82,
        },
        "form": {
            "silhouette": 0.83,
            "structure": 0.81,
            "formDetail": 0.78,
            "assemblyCorrectness": 0.82,
            "proportionBalance": 0.82,
            "shapeSilhouette": 0.82,
            "signatureDetail": 0.78,
        },
        "structure": {"silhouette": 0.82, "structure": 0.82},
        "lookdev": {
            "silhouette": 0.83,
            "structure": 0.81,
            "formDetail": 0.78,
            "assemblyCorrectness": 0.82,
            "proportionBalance": 0.82,
            "shapeSilhouette": 0.82,
            "signatureDetail": 0.78,
            "material": 0.81,
            "lighting": 0.78,
            "materialPlausibility": 0.81,
            "surfaceQuality": 0.78,
        },
        "optimization": {
            "silhouette": 0.83,
            "structure": 0.81,
            "formDetail": 0.78,
            "material": 0.81,
            "lighting": 0.78,
        },
    }[pass_id]
    evidence = comparison_manifest(root, pass_id, view_id)
    evidence["type"] = "visual"
    review_id = f"{pass_id}-{view_id}-{review_spec_hash(spec, pass_id)[:12]}"
    verdict = independent_pass_verdict(
        spec,
        pass_id,
        evidence,
        review_id,
        layer_scores=layers,
        feature_ids=feature_ids,
    )
    verdict_path = root / f"{review_id}-verdict.json"
    write_spec_atomic(verdict_path, verdict)
    return {
        "reviewId": review_id,
        "passId": pass_id,
        "action": "continue",
        "specHash": review_spec_hash(spec, pass_id),
        "summary": f"{pass_id} visual test passed",
        "aiVisionScore": 0.84,
        "visualAcceptanceThreshold": 0.7,
        "layerScores": layers,
        "featureReviews": [
            {"id": feature_id, "score": 0.86, "visible": True}
            for feature_id in feature_ids
        ],
        "evidence": evidence,
        "reviewerEvidence": {
            "type": "ai-vision",
            "model": "test-vision-model",
            "reviewedArtifactSha256": evidence["comparisonSha256"],
            "reviewedAt": "2026-07-15T00:00:00+00:00",
            "builderContextId": verdict["builder"]["contextId"],
            "reviewerContextId": verdict["reviewer"]["contextId"],
            "role": "independent-reviewer",
            "reviewVerdict": str(verdict_path),
            "reviewVerdictSha256": file_sha256(verdict_path),
        },
        "blindScout": {
            "artifactType": "threejs-sculpt-blind-scout",
            "version": 2,
            "phaseId": pass_id,
            "decision": "approve",
            "comparisonSha256": evidence["comparisonSha256"],
            "reviewedAt": "2026-07-15T00:00:00+00:00",
            "reviewer": {
                "role": "blind-visual-scout",
                "contextId": f"test-scout-{pass_id}-{view_id}",
                "model": "test-blind-scout",
            },
            "observations": [],
        },
        "blindScoutMapping": copy.deepcopy(verdict["blindScoutMapping"]),
        "aiVisionNotes": "Synthetic evidence matches the expected test silhouette.",
    }


def approve_current_phase(spec: dict, pass_id: str) -> dict:
    return record_user_phase_decision(
        spec,
        pass_id,
        "approved",
        user_statement=f"User explicitly approved {pass_id}.",
        recorded_at="2026-01-01T00:00:00+00:00",
    )


class PassPlanTests(unittest.TestCase):
    def test_pass_plan_is_adaptive(self) -> None:
        simple_static = [
            item["id"]
            for item in build_pass_plan("simple", "static-render", "balanced")
        ]
        complex_playable = [
            item["id"]
            for item in build_pass_plan("complex", "playable", "reference-fidelity")
        ]
        self.assertEqual(simple_static, ["blockout", "form", "lookdev"])
        self.assertEqual(
            complex_playable,
            ["blockout", "form", "lookdev", "interaction"],
        )
        lookdev = next(
            item
            for item in build_pass_plan("complex", "playable", "reference-fidelity")
            if item["id"] == "lookdev"
        )
        self.assertEqual(lookdev["requiredViews"], ["neutral", "grazing", "reference"])
        self.assertEqual(lookdev["requiredLayerScores"]["material"], 0.85)
        form = next(
            item
            for item in build_pass_plan("complex", "playable", "reference-fidelity")
            if item["id"] == "form"
        )
        self.assertEqual(form["requiredLayerScores"]["formDetail"], 0.82)
        self.assertEqual(form["visualBaselinePassId"], "blockout")
        self.assertIn("assemblyCorrectness", form["requiredLayerScores"])
        self.assertTrue(form["visualSanity"]["obviousErrorVeto"])

    def test_reference_fidelity_raises_visual_bar_without_changing_balanced(self) -> None:
        balanced = make_spec(
            "Balanced",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="balanced",
        )
        quality = make_spec(
            "Quality",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="reference-fidelity",
        )

        self.assertEqual(balanced["qualityTargets"]["targetFidelity"], 0.7)
        self.assertEqual(quality["qualityTargets"]["targetFidelity"], 0.85)
        self.assertEqual(balanced["materials"][0]["textureResolution"], 1024)
        self.assertEqual(quality["materials"][0]["textureResolution"], 2048)
        self.assertFalse(
            quality["qualityTargets"]["diagnosticTargets"]["acceptanceAuthority"]
        )

    def test_init_integrates_pre_spec_and_separates_performance_audit(self) -> None:
        spec = make_spec("Test", None, complexity="simple", intended_use="browser-prop")
        self.assertEqual(spec["schemaVersion"], "3.2")
        self.assertIn("preSpecAssessment", spec)
        self.assertEqual(
            spec["preSpecAssessment"]["objectClass"]["representationKind"],
            [],
        )
        self.assertNotIn("visualEvidence", spec)
        self.assertNotIn("intendedUse", spec)
        self.assertNotIn("fpsTarget", spec["qualityTargets"])
        self.assertFalse(spec["performanceAudit"]["enabled"])
        self.assertEqual(spec["sculptPipeline"]["passGateMode"], "adaptive-sequential")
        progress = spec["sculptPipeline"]["userProgress"]
        self.assertTrue(progress["reportRequired"])
        self.assertEqual(progress["completedGates"], 0)
        self.assertEqual(progress["totalGates"], 4)
        self.assertEqual(progress["currentStep"], "blockout")
        self.assertTrue(progress["eta"]["recalculateAfterEveryStep"])

    def test_representation_kind_is_open_and_legacy_optional(self) -> None:
        spec = make_spec("Hybrid Study", None, complexity="moderate")
        self.assertIn(
            "objectClass.representationKind",
            "\n".join(pass_specific_gaps(spec, "blockout")),
        )

        object_class = spec["preSpecAssessment"]["objectClass"]
        object_class["representationKind"] = ["solid mesh", "custom surfel field"]
        errors, warnings = validate_spec(spec)
        self.assertFalse(
            [item for item in [*errors, *warnings] if "representationKind" in item],
            [*errors, *warnings],
        )
        self.assertNotIn(
            "objectClass.representationKind",
            "\n".join(pass_specific_gaps(spec, "blockout")),
        )

        invalid = copy.deepcopy(spec)
        invalid["preSpecAssessment"]["objectClass"]["representationKind"] = "solid mesh"
        errors, _ = validate_spec(invalid)
        self.assertTrue(
            any(
                "objectClass.representationKind must be an array of strings" in item
                for item in errors
            ),
            errors,
        )

        for field in (
            "representationKind",
            "formLanguage",
            "structureKind",
            "motionPotential",
            "materialFamilies",
        ):
            with self.subTest(field=field):
                invalid = copy.deepcopy(spec)
                invalid["preSpecAssessment"]["objectClass"][field] = [" "]
                errors, _ = validate_spec(invalid)
                self.assertTrue(
                    any(
                        f"objectClass.{field} must contain non-empty descriptors"
                        in item
                        for item in errors
                    ),
                    errors,
                )

        invalid_notes = copy.deepcopy(spec)
        invalid_notes["preSpecAssessment"]["objectClass"]["notes"] = []
        errors, _ = validate_spec(invalid_notes)
        self.assertTrue(
            any("objectClass.notes must be a string" in item for item in errors),
            errors,
        )

        legacy = copy.deepcopy(spec)
        legacy["preSpecAssessment"]["objectClass"].pop("representationKind")
        errors, warnings = validate_spec(legacy)
        self.assertFalse(
            [item for item in [*errors, *warnings] if "representationKind" in item],
            [*errors, *warnings],
        )
        self.assertNotIn(
            "objectClass.representationKind",
            "\n".join(pass_specific_gaps(legacy, "blockout")),
        )

    def test_interaction_is_added_from_motion_contract_not_intended_use(self) -> None:
        spec = make_spec("Fan", None, complexity="simple", quality_profile="balanced")
        self.assertEqual(
            [item["id"] for item in spec["buildPasses"]],
            ["blockout", "form", "lookdev", "interaction"],
        )

        spec["interactionContract"].update(
            {
                "status": "required",
                "assessmentReason": "The observed fan blades rotate around the central hub.",
                "motionAffordances": [
                    {
                        "id": "fan-blade-spin",
                        "componentId": "root",
                        "behavior": "continuous-rotation",
                        "pivot": [0, 0, 0],
                        "axis": [0, 0, 1],
                        "rate": 6.0,
                        "source": "domain-prior",
                        "confidence": 0.95,
                        "evidenceRefs": ["full-object"],
                        "enabledByDefault": True,
                    }
                ],
            }
        )
        spec["actionReadiness"]["enabled"] = True
        sync_pipeline(spec)
        self.assertEqual(
            [item["id"] for item in spec["buildPasses"]],
            ["blockout", "form", "lookdev", "interaction"],
        )

        spec["interactionContract"].update(
            {
                "status": "not-required",
                "assessmentReason": "This static housing has no meaningful object-specific motion.",
                "motionAffordances": [],
            }
        )
        spec["actionReadiness"]["enabled"] = False
        sync_pipeline(spec)
        self.assertEqual(
            [item["id"] for item in spec["buildPasses"]],
            ["blockout", "form", "lookdev"],
        )

    def test_blockout_context_defers_future_phase_spec(self) -> None:
        spec = make_spec(
            "Helicopter",
            "helicopter.png",
            complexity="complex",
            quality_profile="reference-fidelity",
            reference_background="clear",
        )
        packet = phase_work_packet(spec, "blockout")
        projection = packet["contextProjection"]

        self.assertEqual(spec["phaseExecutionContract"]["mode"], "progressive-visual-loop")
        self.assertEqual(spec["phaseExecutionContract"]["version"], 4)
        form_packet = phase_work_packet(spec, "form")
        lookdev_packet = phase_work_packet(spec, "lookdev")
        interaction_packet = phase_work_packet(spec, "interaction")
        self.assertNotIn("maximumSilhouetteIouRegression", packet)
        self.assertNotIn("maximumSilhouetteIouRegression", form_packet)
        self.assertEqual(
            lookdev_packet["specDeltaContract"]["activePhaseOwnedPaths"],
            ["materials", "lookDevTargets", "lightingFromPhoto"],
        )
        self.assertIn(
            "componentTree",
            lookdev_packet["specDeltaContract"]["repairablePriorPhasePaths"],
        )
        self.assertIn(
            "componentTree",
            lookdev_packet["specDeltaContract"]["editablePaths"],
        )
        self.assertIn(
            "materials",
            interaction_packet["specDeltaContract"]["repairablePriorPhasePaths"],
        )
        self.assertEqual(lookdev_packet["editableComponentIds"], ["root"])
        self.assertEqual(interaction_packet["editableMaterialIds"], ["base"])
        authority = lookdev_packet["specDeltaContract"]["correctionAuthority"]
        self.assertEqual(authority["mode"], "cumulative-prior-phase-repair")
        self.assertTrue(authority["impactAssessmentRequired"])
        self.assertTrue(authority["challengerOnly"])
        self.assertTrue(authority["protectedPhaseRegressionVeto"])
        self.assertTrue(authority["priorPhaseReviewRequired"])
        self.assertTrue(authority["priorPhaseImprovementAllowed"])
        self.assertTrue(authority["priorPhaseIsNotFrozen"])
        self.assertIn("blind-visual-scout", form_packet["visualCycle"]["steps"])
        scout = form_packet["visualScout"]
        self.assertEqual(
            scout["inputAllowlist"],
            [
                "sourceImage",
                "currentRender",
                "previousRender",
                "sideBySideComparison",
                "phaseId",
                "phaseRubric",
            ],
        )
        self.assertIn("spec", scout["inputDenylist"])
        self.assertFalse(scout["output"]["advisoryOnly"])
        self.assertTrue(scout["output"]["gateAuthority"])
        self.assertEqual(scout["output"]["decisionValues"], ["approve", "reject"])
        self.assertEqual(scout["output"]["maxObservations"], 7)
        self.assertEqual(scout["output"]["artifactVersion"], 2)
        mapping_contract = scout["output"]["mainAgentMapping"]
        self.assertEqual(mapping_contract["storageField"], "blindScoutMapping")
        self.assertEqual(mapping_contract["mapperRole"], "main-agent")
        self.assertTrue(mapping_contract["oneItemPerObservation"])
        self.assertTrue(mapping_contract["preserveScoutVerdictAndSeverity"])
        self.assertTrue(scout["output"]["priorPhaseReviewRequired"])
        self.assertTrue(scout["output"]["priorPhaseImprovementAllowed"])
        self.assertTrue(scout["output"]["priorPhaseIsNotFrozen"])
        active_input = scout["activePhaseInput"]
        self.assertEqual(set(active_input), {"phaseId", "phaseRubric"})
        self.assertEqual(active_input["phaseId"], "form")
        blockout_active_input = context_payload(spec)["workPacket"]["visualScout"][
            "activePhaseInput"
        ]
        self.assertEqual(set(blockout_active_input), {"phaseId", "phaseRubric"})
        self.assertEqual(blockout_active_input["phaseId"], "blockout")
        self.assertNotIn("qualityContract", active_input)
        self.assertNotIn("requiredFeatureTargets", active_input)
        active_rubric = active_input["phaseRubric"]
        self.assertEqual(
            active_rubric["reviewOrder"],
            ["prior-phase-quality-sweep", "current-phase-review"],
        )
        form_checks = {
            item["category"]: item for item in active_rubric["mandatoryChecks"]
        }
        self.assertIn("socket", form_checks["attachment"]["inspection"])
        self.assertIn("asymmetry", form_checks["balance"]["inspection"])
        self.assertIn("invented", form_checks["signature-detail"]["inspection"])
        self.assertIn("seven highest-impact", active_rubric["coverageRule"])
        self.assertIn(
            "generic realism preferences",
            active_rubric["referenceComparisonRule"],
        )
        self.assertIn("critical", active_rubric["severityPolicy"])
        lookdev_checks = {
            item["category"]: item
            for item in lookdev_packet["visualScout"]["activePhaseInput"][
                "phaseRubric"
            ]["mandatoryChecks"]
        }
        self.assertEqual(lookdev_checks["attachment"]["phaseScope"], "protected")
        self.assertEqual(lookdev_checks["material"]["phaseScope"], "current")
        self.assertIn(
            "visibly poorer than",
            lookdev_checks["material"]["inspection"],
        )
        self.assertIn("silhouette", active_rubric["priorPhaseCategories"])
        self.assertEqual(
            scout["phaseRubrics"]["blockout"]["currentPhaseCategories"],
            ["silhouette", "framing", "proportion", "major-part", "assembly"],
        )
        self.assertEqual(
            packet["visualScout"]["activePhaseInput"]["phaseId"],
            "blockout",
        )
        self.assertTrue(scout["output"]["scoresForbidden"])
        self.assertFalse(scout["output"]["verdictForbidden"])
        self.assertTrue(scout["output"]["numericFixesForbidden"])
        self.assertEqual(packet["qualityGate"]["mode"], "ai-scout-human")
        self.assertNotIn("iouFloor", packet["qualityGate"])
        self.assertNotIn("silhouetteIou", json.dumps(spec))
        self.assertNotIn("maximumSilhouetteIouRegression", json.dumps(spec))
        self.assertEqual(packet["qualityGate"]["aiOverallFloor"], 0.70)
        self.assertEqual(
            spec["phaseExecutionContract"]["cycle"]["steps"][-2:],
            ["system-promote-or-rollback", "user-approval"],
        )
        self.assertTrue(spec["phaseExecutionContract"]["humanApproval"]["required"])
        invalid_scout = copy.deepcopy(spec)
        invalid_scout["phaseExecutionContract"]["visualScout"]["output"][
            "componentScanFields"
        ].append("score")
        errors, _ = validate_spec(invalid_scout)
        self.assertTrue(
            any("componentScanFields must contain only" in error for error in errors)
        )
        incomplete_rubric = copy.deepcopy(spec)
        incomplete_rubric["phaseExecutionContract"]["visualScout"][
            "phaseRubrics"
        ]["form"].pop("mandatoryChecks")
        errors, _ = validate_spec(incomplete_rubric)
        self.assertTrue(
            any(
                "canonical phase-scoped review categories" in error
                for error in errors
            )
        )
        invalid_mapping = copy.deepcopy(spec)
        invalid_mapping["phaseExecutionContract"]["visualScout"]["output"][
            "mainAgentMapping"
        ]["mapperRole"] = "primary-reviewer"
        errors, _ = validate_spec(invalid_mapping)
        self.assertTrue(
            any("canonical main-agent mapping contract" in error for error in errors)
        )

        legacy = copy.deepcopy(spec)
        legacy_contract = legacy["phaseExecutionContract"]
        legacy_contract["version"] = 1
        legacy_contract.pop("visualScout")
        legacy_contract.pop("humanApproval")
        legacy_contract["cycle"]["steps"] = [
            "spec-delta",
            "build-render",
            "reference-comparison",
            "independent-review",
            "promote-or-rollback",
        ]
        legacy_contract["cycle"]["comparisonAuthority"] = "observed-reference"
        errors, warnings = validate_spec(legacy)
        self.assertFalse(
            [error for error in errors if "phaseExecutionContract" in error],
            errors,
        )
        self.assertTrue(any("version 1 has no blind visual scout" in item for item in warnings))
        self.assertNotIn("materials", projection)
        self.assertNotIn("interactionContract", projection)
        self.assertNotIn("detailDecompositionContract", projection)
        self.assertNotIn(
            "materialFamilies",
            projection["preSpecAssessment"]["objectClass"],
        )
        self.assertNotIn(
            "motionPotential",
            projection["preSpecAssessment"]["objectClass"],
        )
        self.assertEqual(
            projection["preSpecAssessment"]["objectClass"]["representationKind"],
            [],
        )
        self.assertEqual(spec["viewHypothesisPolicy"]["decision"], "pending")
        self.assertFalse(spec["viewHypothesisPolicy"]["enabled"])
        self.assertEqual(
            projection["viewHypothesisPolicy"]["activationPhase"],
            "blockout",
        )
        self.assertTrue(
            any(
                "invoke imagegen" in gap
                for gap in pass_specific_gaps(spec, "blockout")
            )
        )
        self.assertEqual(spec["buildPasses"][0]["diagnosticViews"], [])
        self.assertFalse(
            [
                gap
                for gap in pass_specific_gaps(spec, "blockout")
                if any(token in gap.lower() for token in ("detail", "topology", "material", "interaction"))
            ]
        )
        self.assertEqual(
            packet["visualCycle"]["maximumNonVisualOperationsBeforeRender"],
            2,
        )
        form_components = phase_work_packet(spec, "form")["contextProjection"][
            "componentTree"
        ]
        self.assertTrue(form_components)
        self.assertTrue(
            all(
                "material" not in component
                and "materialLayers" not in component
                and "actionProfile" not in component
                for component in form_components
            )
        )
        spec["viewHypothesisPolicy"].update(
            {
                "decision": "not-needed",
                "decisionReason": "The observed object is symmetric enough for bounded form inference.",
            }
        )
        self.assertEqual(effective_pass_config(spec, "form")["diagnosticViews"], [])
        spec["viewHypothesisPolicy"].update(
            {
                "enabled": True,
                "decision": "required",
                "decisionReason": "The hidden attachment layout can change the form implementation.",
            }
        )
        self.assertEqual(
            effective_pass_config(spec, "form")["diagnosticViews"],
            ["three-quarter", "side", "back"],
        )

    def test_blockout_hashes_ignore_future_phase_only_edits(self) -> None:
        spec = make_spec(
            "Helicopter",
            "helicopter.png",
            complexity="complex",
            quality_profile="reference-fidelity",
            reference_background="clear",
        )
        generation_hash = generation_validation_hash(spec, "blockout")
        review_hash = review_spec_hash(spec, "blockout")

        future = copy.deepcopy(spec)
        future["materials"][0]["roughness"] = 0.17
        future["componentTree"][0]["actionProfile"] = {
            "mode": "rotate",
            "axis": [0, 1, 0],
        }
        future["componentTree"][0]["detailPlan"] = {
            "decompositionMode": "compound",
            "featureGroups": [{"id": "future-rivets"}],
        }
        future["repetitionSystems"] = [
            {"id": "future-rivets", "type": "grid", "counts": [2, 2, 1]}
        ]
        future["featureReviewTargets"][-1]["criteria"] = [
            "A future Lookdev-only criterion changed."
        ]
        future["qualityTargets"]["mustMatch"][-1] = "updated material response"
        future["qualityTargets"]["niceToHave"] = ["revised micro wear"]
        future["qualityTargets"]["reviewViewpoints"] = ["revised grazing"]
        future["qualityTargets"]["diagnosticTargets"][
            "minimumHighlightEnergyRatio"
        ] = 0.45
        self.assertEqual(
            generation_validation_hash(future, "blockout"),
            generation_hash,
        )
        self.assertEqual(review_spec_hash(future, "blockout"), review_hash)

        blockout_targets = phase_work_packet(future, "blockout")[
            "contextProjection"
        ]["qualityTargets"]
        self.assertNotIn("niceToHave", blockout_targets)
        self.assertNotIn("reviewViewpoints", blockout_targets)
        self.assertNotIn("minimumHighlightEnergyRatio", blockout_targets["diagnosticTargets"])
        self.assertFalse(
            any("material" in item.lower() for item in blockout_targets["mustMatch"])
        )

        relevant = copy.deepcopy(spec)
        relevant["qualityTargets"]["mustMatch"][0] = "silhouette with exact negative space"
        self.assertNotEqual(review_spec_hash(relevant, "blockout"), review_hash)

        represented_differently = copy.deepcopy(spec)
        represented_differently["preSpecAssessment"]["objectClass"][
            "representationKind"
        ] = ["curve or strand network"]
        self.assertEqual(
            generation_validation_hash(represented_differently, "blockout"),
            generation_hash,
        )
        self.assertNotEqual(
            review_spec_hash(represented_differently, "blockout"),
            review_hash,
        )

        future["componentTree"][0]["transform"]["scale"] = [1.2, 1.0, 1.0]
        self.assertNotEqual(
            generation_validation_hash(future, "blockout"),
            generation_hash,
        )
        self.assertNotEqual(review_spec_hash(future, "blockout"), review_hash)

    def test_monolithic_turnaround_registration_is_allowed_during_blockout_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            turnaround = root / "turnaround-2x2.png"
            write_png_rgb(source, 8, 8, [(40, 90, 180)] * 64)
            write_png_rgb(turnaround, 16, 16, [(55, 105, 190)] * 256)
            spec_path = root / "spec.json"
            spec = make_spec(
                "Blockout-prepared views",
                str(source),
                complexity="complex",
                reference_background="clear",
            )
            write_spec_atomic(spec_path, spec)
            result = register_views(spec_path, [], sheet_path=turnaround)
            self.assertTrue(result["ok"])
            registered = load_spec(spec_path)["viewHypothesisPolicy"]
            self.assertEqual(registered["activationPhase"], "blockout")
            self.assertEqual(registered["decision"], "required")
            self.assertTrue(registered["enabled"])

    def test_complex_assembly_can_register_exploded_planning_sheet(self) -> None:
        with self.assertRaisesRegex(ValueError, "complex or ultra"):
            make_spec(
                "Simple prop",
                "source.png",
                complexity="simple",
                reference_background="clear",
                planning_sheet_layout="exploded",
            )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            sheet = root / "assembly-planning-2x2.png"
            write_png_rgb(source, 8, 8, [(40, 90, 180)] * 64)
            write_png_rgb(sheet, 16, 16, [(55, 105, 190)] * 256)
            spec_path = root / "spec.json"
            spec = make_spec(
                "Layered machine",
                str(source),
                complexity="complex",
                reference_background="clear",
                planning_sheet_layout="exploded",
            )
            write_spec_atomic(spec_path, spec)

            result = register_views(spec_path, [], sheet_path=sheet)

            self.assertTrue(result["ok"])
            self.assertEqual(result["layoutId"], "assembly-exploded-2x2-v1")
            manifest = json.loads(
                Path(result["manifest"]).read_text(encoding="utf-8")
            )
            self.assertEqual(
                {view["viewId"] for view in manifest["views"]},
                {"exploded", "side", "back", "front"},
            )
            registered = load_spec(spec_path)
            self.assertIn(
                "exploded",
                registered["viewHypothesisPolicy"]["requiredViews"],
            )
            form = next(
                item for item in registered["buildPasses"] if item["id"] == "form"
            )
            self.assertIn("exploded", form["diagnosticViews"])
            self.assertNotIn("three-quarter", form["diagnosticViews"])

    def test_small_score_regression_requires_blind_scout_visual_regression(self) -> None:
        baseline = {
            "overallScore": 0.80,
            "layerScores": {"silhouette": 0.80},
            "diagnosticScores": {},
        }
        candidate = {
            "overallScore": 0.79,
            "layerScores": {"silhouette": 0.79},
            "diagnosticScores": {},
        }
        approved = quality_candidate_disposition(
            baseline,
            candidate,
            owned_layers=["silhouette"],
            maximum_regression=0.0,
            blind_scout_decision="approve",
        )
        self.assertEqual(approved["disposition"], "gate-pass")
        self.assertTrue(approved["regressionAcceptedByBlindScout"])

        rejected = quality_candidate_disposition(
            baseline,
            candidate,
            owned_layers=["silhouette"],
            maximum_regression=0.0,
            blind_scout_decision="reject",
        )
        self.assertEqual(rejected["disposition"], "rejected-regression")

    def test_imagegen_prepares_white_background_for_mixed_or_impractical_references(self) -> None:
        unassessed = make_spec("Reference", "original.png", complexity="simple")
        errors, warnings = validate_spec(unassessed)
        self.assertFalse(
            [item for item in errors if "referencePreparation" in item]
        )
        self.assertTrue(
            any("reference preparation is unassessed" in item for item in warnings)
        )

        clear = make_spec(
            "Reference",
            "white-background.png",
            complexity="simple",
            reference_background="clear",
        )
        errors, warnings = validate_spec(clear)
        self.assertFalse(
            [item for item in errors if "referencePreparation" in item]
        )
        self.assertFalse(
            [item for item in warnings if "subject/background separation" in item]
        )
        self.assertEqual(clear["sourceImage"], "white-background.png")
        self.assertEqual(
            clear["referencePreparation"]["subjectBackgroundSeparation"],
            "clear",
        )

        prepared = make_spec(
            "Reference",
            "prepared-white.png",
            complexity="simple",
            reference_background="mixed",
            background_removal_mode="white-background-cleanup",
        )
        errors, warnings = validate_spec(prepared)
        self.assertFalse(
            [item for item in errors if "referencePreparation" in item]
        )
        self.assertFalse(
            [item for item in warnings if "subject/background separation" in item]
        )

        self.assertEqual(
            prepared["referencePreparation"]["outputBackground"],
            "solid-white",
        )
        prepared["referencePreparation"]["whiteBackgroundValidated"] = False
        errors, _ = validate_spec(prepared)
        self.assertTrue(
            any("whiteBackgroundValidated must be true" in item for item in errors)
        )

        simplified = make_spec(
            "Dense vehicle",
            "simplified-white.png",
            complexity="ultra",
            reference_background="clear",
            background_removal_mode="white-background-simplification",
            imagegen_trigger="excessive-complexity",
            declared_simplifications=[
                "merge non-signature rivet rows into material detail",
            ],
        )
        errors, _ = validate_spec(simplified)
        self.assertFalse(
            [item for item in errors if "referencePreparation" in item],
            errors,
        )
        self.assertEqual(simplified["sourceImage"], "simplified-white.png")
        self.assertEqual(
            simplified["referencePreparation"]["modificationPolicy"]["mode"],
            "bounded-simplification",
        )
        self.assertEqual(
            simplified["referencePreparation"]["comparisonPolicy"],
            {"reconstructionTarget": "sourceImage"},
        )
        self.assertNotIn("originalImage", simplified["referencePreparation"])

        real_photo = make_spec(
            "Organic chair",
            "buildable-chair.png",
            complexity="complex",
            reference_background="clear",
            background_removal_mode="white-background-simplification",
            imagegen_trigger="real-object-photo",
            declared_simplifications=[
                "regularize irregular upholstery into buildable cushion masses",
            ],
        )
        errors, _ = validate_spec(real_photo)
        self.assertFalse(
            [item for item in errors if "referencePreparation" in item],
            errors,
        )
        self.assertNotIn("originalImage", real_photo["referencePreparation"])
        self.assertNotIn("identityGuardrail", real_photo["evidenceAuthority"])
        with self.assertRaisesRegex(
            ValueError,
            "real-object-photo requires white-background-simplification",
        ):
            make_spec(
                "Organic chair",
                "cleanup-only.png",
                complexity="complex",
                reference_background="clear",
                background_removal_mode="white-background-cleanup",
                imagegen_trigger="real-object-photo",
            )
        self.assertEqual(
            visual_evidence_authority_failures(
                {
                    "views": [
                        {
                            "viewId": "primary",
                            "referenceProvenance": {
                                "origin": "prepared-reference",
                                "allowedUse": "acceptance",
                            },
                        }
                    ]
                }
            ),
            [],
        )


class StateContractTests(unittest.TestCase):
    def test_system_pass_waits_for_user_and_change_feedback_reopens_phase(self) -> None:
        spec = make_spec("Human Gate", None, complexity="simple")
        fill_pre_spec(spec)
        blockout = visual_entry(spec, "blockout", self.evidence_root)
        spec["reviewHistory"] = [blockout]

        waiting = pipeline_status(spec)
        self.assertEqual(waiting["state"], "awaiting-user-approval")
        self.assertEqual(waiting["currentPass"], "blockout")
        self.assertEqual(waiting["completedPasses"], [])
        self.assertTrue(waiting["pendingUserApproval"]["systemPassed"])
        self.assertEqual(
            waiting["pendingUserApproval"]["reviewKey"],
            phase_review_key(blockout),
        )

        feedback = [
            {
                "visualRegion": "upper housing",
                "problem": "The housing is too narrow and sits too far back.",
                "expectedDirection": "Widen it and move it forward to match the reference.",
            }
        ]
        record_user_phase_decision(
            spec,
            "blockout",
            "changes-requested",
            user_statement="The upper housing still looks wrong.",
            feedback=feedback,
            recorded_at="2026-01-01T00:00:00+00:00",
        )
        rejected = pipeline_status(spec)
        self.assertEqual(rejected["state"], "needs-user-refinement")
        self.assertEqual(rejected["userFeedback"], feedback)

        spec["silhouette"]["boundingShape"] = "wider upper housing shifted forward"
        reopened = pipeline_status(spec)
        self.assertEqual(reopened["state"], "ready")
        self.assertEqual(reopened["currentPass"], "blockout")
        self.assertEqual(reopened["userFeedback"], feedback)

        revised = visual_entry(spec, "blockout", self.evidence_root)
        spec["reviewHistory"].append(revised)
        self.assertEqual(
            pipeline_status(spec)["state"],
            "awaiting-user-approval",
        )
        approve_current_phase(spec, "blockout")
        promoted = pipeline_status(spec)
        self.assertEqual(promoted["completedPasses"], ["blockout"])
        self.assertEqual(promoted["currentPass"], "form")

    def test_user_decision_cannot_be_recorded_before_system_pass(self) -> None:
        spec = make_spec("No Premature Approval", None, complexity="simple")
        fill_pre_spec(spec)
        with self.assertRaisesRegex(ValueError, "only after"):
            record_user_phase_decision(
                spec,
                "blockout",
                "approved",
                user_statement="Approve without evidence.",
            )
        spec["reviewHistory"] = [visual_entry(spec, "blockout", self.evidence_root)]
        with self.assertRaisesRegex(ValueError, "requires feedback items"):
            record_user_phase_decision(
                spec,
                "blockout",
                "changes-requested",
                user_statement="It is wrong.",
                feedback=[],
            )

    def test_default_2x2_can_be_skipped_only_for_simple_symmetric_objects(self) -> None:
        complex_spec = make_spec(
            "Complex Vehicle",
            "vehicle.png",
            complexity="complex",
            reference_background="clear",
        )
        policy = complex_spec["viewHypothesisPolicy"]
        self.assertEqual(policy["defaultDecision"], "required")
        self.assertEqual(
            policy["activationMode"],
            "pre-blockout-unless-simple-symmetric",
        )
        self.assertEqual(policy["activationPhase"], "blockout")
        self.assertTrue(
            any(
                "before the first Blockout build" in gap
                for gap in pass_specific_gaps(complex_spec, "blockout")
            )
        )
        policy.update(
            {
                "decision": "not-needed",
                "decisionReason": "Try to skip the turnaround despite complexity.",
                "skipAssessment": {
                    "objectIsSimple": True,
                    "symmetry": "bilateral",
                    "confidence": 0.95,
                    "evidenceRefs": ["full-object"],
                    "reason": "The visible front appears approximately mirrored.",
                },
            }
        )
        self.assertTrue(
            any(
                "complexity.tier is simple" in gap
                for gap in pass_specific_gaps(complex_spec, "form")
            )
        )
        errors, _ = validate_spec(complex_spec)
        self.assertTrue(
            any("complexity.tier is simple" in error for error in errors)
        )

        simple_spec = make_spec(
            "Simple Symmetric Knob",
            "knob.png",
            complexity="simple",
            reference_background="clear",
        )
        fill_pre_spec(simple_spec)
        self.assertFalse(
            [
                gap
                for gap in pass_specific_gaps(simple_spec, "blockout")
                if "2x2" in gap or "skipAssessment" in gap
            ]
        )

    def test_champion_policy_rejects_any_regression_and_stops_after_three_misses(self) -> None:
        baseline = {
            "overallScore": 0.90,
            "layerScores": {"silhouette": 0.80, "formDetail": 0.76},
        }
        promoted = quality_candidate_disposition(
            baseline,
            {
                "overallScore": 0.91,
                "layerScores": {"silhouette": 0.80, "formDetail": 0.79},
            },
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
            required_layers={"formDetail": 0.72},
        )
        self.assertEqual(promoted["disposition"], "promoted")
        regressed = quality_candidate_disposition(
            baseline,
            {
                "overallScore": 0.92,
                "layerScores": {"silhouette": 0.79, "formDetail": 0.82},
            },
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
            required_layers={"formDetail": 0.72},
        )
        self.assertEqual(regressed["disposition"], "rejected-regression")
        overall_regressed = quality_candidate_disposition(
            baseline,
            {
                "overallScore": 0.60,
                "layerScores": {"silhouette": 0.80, "formDetail": 0.82},
            },
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
            required_layers={"formDetail": 0.72},
        )
        self.assertEqual(overall_regressed["disposition"], "rejected-regression")
        self.assertIn("overallScore", overall_regressed["regressedLayers"])
        unrelated_layer_regressed = quality_candidate_disposition(
            {
                **baseline,
                "layerScores": {
                    **baseline["layerScores"],
                    "identity": 0.90,
                },
            },
            {
                "overallScore": 0.92,
                "layerScores": {
                    "silhouette": 0.80,
                    "formDetail": 0.82,
                    "identity": 0.10,
                },
            },
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
        )
        self.assertEqual(unrelated_layer_regressed["disposition"], "rejected-regression")
        self.assertIn("identity", unrelated_layer_regressed["regressedLayers"])
        incomplete_seed = quality_candidate_disposition(
            None,
            {"overallScore": 0.90, "layerScores": {}},
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
        )
        self.assertEqual(incomplete_seed["disposition"], "rejected-incomplete")
        self.assertEqual(
            set(incomplete_seed["missingLayers"]),
            {"formDetail", "silhouette"},
        )
        repaired_legacy_seed = quality_candidate_disposition(
            {"overallScore": 0.90, "layerScores": {}},
            {
                "overallScore": 0.91,
                "layerScores": {"formDetail": 0.80, "silhouette": 0.82},
            },
            owned_layers=["formDetail"],
            protected_layers=["silhouette"],
        )
        self.assertEqual(repaired_legacy_seed["disposition"], "seed")
        budget = refinement_budget(
            [
                {"action": "refine-code", "candidateDisposition": "seed"},
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
                {"action": "refine-code", "candidateDisposition": "rejected-regression"},
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
            ]
        )
        self.assertTrue(budget["exhausted"])
        self.assertEqual(budget["exhaustedReason"], "three-consecutive-non-improvements")
        recovered = refinement_budget(
            [
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
                {"action": "refine-code", "candidateDisposition": "promoted"},
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
            ]
        )
        self.assertFalse(recovered["exhausted"])
        self.assertEqual(recovered["consecutiveNonImprovements"], 1)
        rejected_continues = refinement_budget(
            [
                {
                    "action": "continue",
                    "accepted": False,
                    "candidateDisposition": "rejected-regression",
                }
                for _ in range(3)
            ]
        )
        self.assertEqual(rejected_continues["usedAttempts"], 3)
        self.assertEqual(rejected_continues["consecutiveNonImprovements"], 3)
        self.assertTrue(rejected_continues["exhausted"])

    def test_v4_later_phase_does_not_require_duplicate_protected_layers(self) -> None:
        self.spec["reviewHistory"] = [
            visual_entry(self.spec, "form", self.evidence_root)
        ]
        lookdev = visual_entry(self.spec, "lookdev", self.evidence_root, "reference")
        lookdev["layerScores"].pop("structure")

        failures = review_failures(self.spec, lookdev, "lookdev")

        self.assertFalse(
            any("protected layer" in item for item in failures),
            failures,
        )

    def test_second_independent_pass_batch_requires_progress_and_closed_blockers(self) -> None:
        spec = {"reviewHistory": [
            {
                "passId": "blockout",
                "action": "refine-code",
                "aiVisionScore": 0.80,
                "layerScores": {"silhouette": 0.80},
                "reviewIssues": [
                    {
                        "id": "silhouette-width",
                        "rootCauseKey": "silhouette-width",
                        "severity": "major",
                        "status": "open",
                    }
                ],
            }
        ]}
        stalled = {
            "overallScore": 0.80,
            "layerScores": {"silhouette": 0.80},
            "resolvedIssueIds": ["silhouette-width"],
            "resolvedRootCauseKeys": ["silhouette-width"],
        }
        self.assertTrue(
            any(
                "did not improve" in item
                for item in _pass_refinement_progress_failures(spec, "blockout", stalled)
            )
        )
        unresolved = {
            "overallScore": 0.82,
            "layerScores": {"silhouette": 0.82},
            "resolvedIssueIds": [],
            "resolvedRootCauseKeys": [],
        }
        self.assertTrue(
            any(
                "not explicitly resolved" in item
                for item in _pass_refinement_progress_failures(spec, "blockout", unresolved)
            )
        )
        progressed = {
            **unresolved,
            "resolvedIssueIds": ["silhouette-width"],
            "resolvedRootCauseKeys": ["silhouette-width"],
        }
        self.assertEqual(
            _pass_refinement_progress_failures(spec, "blockout", progressed),
            [],
        )

    def test_assembled_pass_rejects_relabeling_and_cosmetic_strategy_reset(self) -> None:
        spec = make_spec("Assembled", None, complexity="simple")
        previous = {
            "passId": "blockout",
            "action": "refine-code",
            "aiVisionScore": 0.80,
            "layerScores": {"silhouette": 0.80},
            "reviewIssues": [
                {
                    "id": "old-name",
                    "rootCauseKey": "stable-old-root",
                    "severity": "major",
                    "status": "open",
                }
            ],
        }
        spec["reviewHistory"] = [previous]
        relabeled = {
            "overallScore": 0.82,
            "layerScores": {"silhouette": 0.82},
            "resolvedRootCauseKeys": ["stable-old-root"],
            "issues": [
                {
                    "id": "new-name",
                    "rootCauseKey": "laundered-new-root",
                    "severity": "minor",
                    "status": "open",
                }
            ],
        }
        self.assertTrue(
            any(
                "canonical issue lineage" in item
                for item in _pass_refinement_progress_failures(spec, "blockout", relabeled)
            )
        )

        current_signature = sculpt_representation_signature(spec)
        spec["reviewHistory"] = [
            {
                "passId": "blockout",
                "action": "strategy-reset",
                "representationSignature": current_signature,
                "evidence": {"comparisonSha256": "old", "views": []},
            }
        ]
        evidence = {"comparisonSha256": "new", "views": []}
        self.assertTrue(
            any(
                "different topology/geometry" in item
                for item in _pending_pass_batch_failures(
                    spec,
                    "blockout",
                    evidence,
                    {},
                )
            )
        )
        tuned = copy.deepcopy(spec)
        tuned["componentTree"][0]["dimensions"]["width"] = 1.25
        tuned["componentTree"][0]["geometryDescriptor"]["topologyIntent"] = (
            "A newly worded but still purely descriptive topology sentence."
        )
        self.assertEqual(
            sculpt_representation_signature(tuned),
            sculpt_representation_signature(spec),
        )
        changed = copy.deepcopy(spec)
        changed["componentTree"][0]["primitive"] = "sphere"
        self.assertNotEqual(
            sculpt_representation_signature(changed),
            sculpt_representation_signature(spec),
        )

    def test_reference_refinement_records_root_cause_and_corrections(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spec_path = Path(directory) / "spec.json"
            spec = make_spec(
                "Correction",
                None,
                complexity="simple",
                intended_use="static-render",
                quality_profile="reference-fidelity",
            )
            fill_pre_spec(spec)
            write_spec_atomic(spec_path, spec)
            corrections = json.dumps(
                [
                    {
                        "targetType": "component",
                        "target": "root",
                        "parameterPath": "implementation.transform.scale",
                        "operation": "scale",
                        "beforeValue": [1.0, 1.0, 1.0],
                        "value": [1.08, 1.08, 1.08],
                        "expectedValue": [1.08, 1.08, 1.08],
                        "unit": "relative-scale",
                        "reason": "silhouette is too small in frame",
                        "expectedDelta": {
                            "metric": "silhouetteCoverage",
                            "from": 0.72,
                            "to": 0.78,
                            "tolerance": 0.02,
                            "unit": "ratio",
                            "viewIds": ["reference"],
                        },
                    }
                ]
            )
            self.assertEqual(
                append_review(
                    [
                        str(spec_path),
                        "--pass-id",
                        "blockout",
                        "--action",
                        "refine-code",
                        "--summary",
                        "Correct framing before form work.",
                        "--root-cause",
                        "camera-framing",
                        "--correction-plan-json",
                        corrections,
                        "--impact-assessment-json",
                        json.dumps(
                            {
                                "activePhase": "blockout",
                                "targetIds": ["root"],
                                "allowedPaths": ["implementation.transform.scale"],
                                "protectedComponentIds": [],
                                "expectedEffect": "Increase only the root framing scale.",
                                "possibleSideEffects": ["Frame-edge clearance may tighten."],
                                "downstreamImpact": downstream_impact("form"),
                                "structuralInvariants": [
                                    "Component hierarchy and local proportions remain unchanged."
                                ],
                                "risk": "low",
                                "rollbackCheckpoint": "Current blockout champion.",
                                "strategyChange": False,
                                "verdict": "safe-to-apply",
                            }
                        ),
                        "--in-place",
                    ]
                ),
                0,
            )
            updated = load_spec(spec_path)
            entry = updated["reviewHistory"][-1]
            self.assertEqual(entry["rootCause"], "camera-framing")
            self.assertEqual(entry["correctionPlan"][0]["operation"], "scale")
            self.assertTrue(entry["correctionBatch"]["atomic"])
            self.assertEqual(entry["correctionBatch"]["correctionCount"], 1)
            second_args = [
                str(spec_path),
                "--pass-id",
                "blockout",
                "--action",
                "refine-code",
                "--summary",
                "Apply the final consolidated correction batch.",
                "--root-cause",
                "camera-framing",
                "--correction-plan-json",
                corrections,
                "--impact-assessment-json",
                json.dumps(
                    {
                        "activePhase": "blockout",
                        "targetIds": ["root"],
                        "allowedPaths": ["implementation.transform.scale"],
                        "protectedComponentIds": [],
                        "expectedEffect": "Increase only the root framing scale.",
                        "possibleSideEffects": ["Frame-edge clearance may tighten."],
                        "downstreamImpact": downstream_impact("form"),
                        "structuralInvariants": [
                            "Component hierarchy and local proportions remain unchanged."
                        ],
                        "risk": "low",
                        "rollbackCheckpoint": "Current blockout champion.",
                        "strategyChange": False,
                        "verdict": "safe-to-apply",
                    }
                ),
                "--in-place",
            ]
            for _ in range(5):
                self.assertEqual(append_review(second_args), 0)
            self.assertTrue(
                pipeline_status(load_spec(spec_path))["refinementBudget"]["exhausted"]
            )
            with self.assertRaisesRegex(ValueError, "refinement budget is exhausted"):
                append_review(second_args)
            errors, warnings = validate_spec(updated)
            self.assertEqual(errors, [], errors)
            self.assertFalse(any("structured correctionPlan" in item for item in warnings))

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.evidence_root = Path(temporary.name)
        self.spec = make_spec("State Test", None, complexity="simple", intended_use="static-render")
        fill_pre_spec(self.spec)

    def test_future_review_cannot_unlock_later(self) -> None:
        form = visual_entry(self.spec, "form", self.evidence_root)
        blockout = visual_entry(self.spec, "blockout", self.evidence_root)
        self.spec["reviewHistory"] = [form, blockout]
        approve_current_phase(self.spec, "blockout")
        status = pipeline_status(self.spec)
        self.assertEqual(status["completedPasses"], ["blockout"])
        self.assertEqual(status["currentPass"], "form")

    def test_review_protocol_change_stales_system_and_user_approval(self) -> None:
        self.spec["reviewHistory"] = [
            visual_entry(self.spec, "blockout", self.evidence_root)
        ]
        approve_current_phase(self.spec, "blockout")
        self.assertEqual(pipeline_status(self.spec)["currentPass"], "form")

        self.spec["phaseExecutionContract"]["visualScout"]["inputRule"] += (
            " Changed protocol."
        )

        status = pipeline_status(self.spec)
        self.assertEqual(status["currentPass"], "blockout")
        self.assertNotIn("blockout", status["completedPasses"])

    def test_latest_refinement_invalidates_older_continue(self) -> None:
        refine_verdict = {
            "reviewId": "blockout-refine",
            "action": "refine-code",
            "issues": [
                {
                    "id": "shape",
                    "rootCauseKey": "root-silhouette-width",
                    "failureClass": "proportion",
                    "severity": "major",
                    "status": "open",
                    "targetType": "component",
                    "target": "root",
                    "reason": "The silhouette is too wide.",
                    "observedMismatch": {
                        "parameterPath": "implementation.geometryDescriptor.parameters.profile",
                        "actual": 0.92,
                        "expected": 0.82,
                        "unit": "width-ratio",
                        "tolerance": 0.02,
                        "viewIds": ["reference"],
                    },
                    "evidenceCheck": "Measure the root silhouette width in the reference view.",
                }
            ],
            "corrections": [
                {
                    "issueId": "shape",
                    "scope": "code",
                    "targetType": "component",
                    "target": "root",
                    "parameterPath": "implementation.geometryDescriptor.parameters.profile",
                    "operation": "replace",
                    "beforeValue": "wide-profile",
                    "value": "narrow-profile",
                    "expectedValue": "narrow-profile",
                    "unit": "implementation-state",
                    "change": "Narrow the executable profile.",
                    "expectedDelta": {
                        "metric": "silhouette-width-ratio",
                        "from": 0.92,
                        "to": 0.82,
                        "tolerance": 0.02,
                        "unit": "ratio",
                        "viewIds": ["reference"],
                    },
                }
            ],
        }
        self.spec["reviewHistory"] = [
            visual_entry(self.spec, "blockout", self.evidence_root),
            {
                "passId": "blockout",
                "action": "refine-code",
                "specHash": review_spec_hash(self.spec, "blockout"),
                "reviewId": "blockout-refine",
                "reviewIssues": refine_verdict["issues"],
                "reviewCorrections": refine_verdict["corrections"],
                "correctionBatch": correction_batch_from_verdict(refine_verdict),
            },
        ]
        status = pipeline_status(self.spec)
        self.assertEqual(status["currentPass"], "blockout")
        self.assertEqual(status["state"], "needs-refinement")
        self.assertEqual(status["pendingCorrectionBatch"]["correctionCount"], 1)

        self.spec["silhouette"]["boundingShape"] = "narrower edited silhouette"
        stale_status = pipeline_status(self.spec)
        self.assertEqual(stale_status["state"], "needs-refinement")
        self.assertEqual(stale_status["pendingCorrectionBatch"]["issueIds"], ["shape"])

    def test_relevant_edit_stales_review_but_lookdev_edit_does_not_stale_shape(self) -> None:
        self.spec["reviewHistory"] = [visual_entry(self.spec, "blockout", self.evidence_root)]
        self.spec["silhouette"]["boundingShape"] = "changed shape"
        self.assertEqual(pipeline_status(self.spec)["currentPass"], "blockout")

        stable = make_spec("Scoped Test", None, complexity="simple", intended_use="static-render")
        fill_pre_spec(stable)
        stable["reviewHistory"] = [
            visual_entry(stable, "blockout", self.evidence_root),
            visual_entry(stable, "form", self.evidence_root),
        ]
        approve_current_phase(stable, "blockout")
        approve_current_phase(stable, "form")
        stable["lightingFromPhoto"] = ["new lookdev-only light"]
        self.assertEqual(pipeline_status(stable)["currentPass"], "lookdev")

    def test_performance_is_not_a_quality_pass(self) -> None:
        spec = make_spec("Metrics", None, complexity="simple", intended_use="browser-prop")
        self.assertNotIn(
            "optimization",
            [item["id"] for item in spec["buildPasses"]],
        )
        self.assertFalse(spec["performanceAudit"]["enabled"])
        self.assertFalse(spec["performanceAudit"]["blocking"])
        self.assertEqual(spec["performanceAudit"]["maximumVisualRegression"], 0.0)

    def test_runtime_pass_requires_named_boolean_checks(self) -> None:
        spec = make_spec("Runtime", None, complexity="simple", intended_use="animated")
        entry = {
            "passId": "interaction",
            "action": "continue",
            "specHash": review_spec_hash(spec, "interaction"),
            "runtimeChecks": {"loads": True, "transforms": True, "interaction": False},
        }
        self.assertTrue(any("interaction" in failure for failure in review_failures(spec, entry, "interaction")))
        entry["runtimeChecks"]["interaction"] = True
        entry["runtimeChecks"]["motion-clearance"] = True
        entry["runtimeChecks"]["visual-no-regression"] = True
        self.assertEqual(review_failures(spec, entry, "interaction"), [])

    def test_reference_pbr_needs_confirmed_crop_and_browser_urls(self) -> None:
        spec = make_spec(
            "PBR",
            "reference.png",
            complexity="simple",
            intended_use="static-render",
            quality_profile="reference-fidelity",
        )
        fill_pre_spec(spec)
        spec["componentTree"][0]["surfaceDetail"]["notes"] = "intentionally smooth surface"
        spec["lightingFromPhoto"] = [
            "key light",
            "environment fill",
            "tone mapping and contact shadow",
        ]
        maps = {
            channel: {"url": f"/maps/{channel}.png"}
            for channel in ("albedo", "roughness", "height", "normal", "ao")
        }
        spec["materials"][0]["referencePbr"] = {
            "usable": True,
            "materialCropConfirmed": False,
            "maps": maps,
        }
        self.assertTrue(any("confirmed material-crop" in gap for gap in pass_specific_gaps(spec, "lookdev")))
        spec["materials"][0]["referencePbr"]["materialCropConfirmed"] = True
        self.assertEqual(pass_specific_gaps(spec, "lookdev"), [])


class GeneratorAndValidatorTests(unittest.TestCase):
    @staticmethod
    def detail_feature(target_id: str = "cockpit-frame-rivet") -> dict:
        return {
            "id": "cockpit-frame-fastener",
            "name": "Cockpit frame fastener",
            "hostComponentId": "root",
            "scaleBand": "micro",
            "featureClass": "fastener",
            "geometryEffect": "surface",
            "placement": {
                "referenceFrame": "host-local",
                "position": [0.2, 0.25, 0.51],
                "rotation": [0, 0, 0],
                "size": [0.03, 0.03, 0.015],
                "units": "relative",
            },
            "realization": {"mode": "local-feature", "targetId": target_id},
            "materialRefs": ["base"],
            "evidenceRefs": ["full-object"],
            "confidence": 0.9,
            "acceptance": {
                "evidenceRefs": ["full-object"],
                "criteria": ["Fastener is visible on the cockpit frame at the declared local position."],
            },
        }

    def test_complex_component_cannot_be_declared_atomic(self) -> None:
        spec = make_spec("Complex Hull", None, complexity="simple")
        fill_pre_spec(spec)
        spec["componentTree"][0]["detailPlan"]["observedComplexity"] = "complex"
        errors, _ = validate_spec(spec)
        self.assertTrue(any("cannot be atomic" in item for item in errors), errors)

    def test_detail_inventory_maps_to_executable_target_and_review_id(self) -> None:
        spec = make_spec("Detailed Hull", None, complexity="simple")
        fill_pre_spec(spec)
        component = spec["componentTree"][0]
        component["localFeatures"] = [
            {
                "id": "cockpit-frame-rivet",
                "type": "rivet",
                "position": [0.2, 0.25, 0.51],
                "radius": 0.015,
            }
        ]
        component["detailPlan"].update(
            {
                "observedComplexity": "compound",
                "decompositionMode": "features",
                "atomicityReason": "",
                "features": [self.detail_feature()],
                "coverageNotes": "The cockpit frame fastener and surrounding shell boundary were inventoried.",
            }
        )
        errors, _ = validate_spec(spec)
        self.assertFalse([item for item in errors if "detailPlan" in item], errors)
        self.assertIn(
            "cockpit-frame-fastener",
            review_target_catalog(spec)["detail-feature"],
        )

    def test_detail_inventory_rejects_unknown_realization_target(self) -> None:
        spec = make_spec("Detailed Hull", None, complexity="simple")
        fill_pre_spec(spec)
        component = spec["componentTree"][0]
        component["detailPlan"].update(
            {
                "observedComplexity": "compound",
                "decompositionMode": "features",
                "features": [self.detail_feature("missing-rivet")],
                "coverageNotes": "The cockpit frame fastener and surrounding shell boundary were inventoried.",
            }
        )
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("references unknown local feature 'missing-rivet'" in item for item in errors),
            errors,
        )

    def test_detail_inventory_rejects_id_from_ignored_geometry_metadata(self) -> None:
        spec = make_spec("Detailed Hull", None, complexity="simple")
        fill_pre_spec(spec)
        component = spec["componentTree"][0]
        component["geometryDescriptor"]["ignoredMetadata"] = {"id": "fake-ridge"}
        feature = self.detail_feature()
        feature["realization"] = {"mode": "geometry-feature", "targetId": "fake-ridge"}
        component["detailPlan"].update(
            {
                "observedComplexity": "compound",
                "decompositionMode": "features",
                "features": [feature],
                "coverageNotes": "The claimed ridge and surrounding shell boundary were inventoried.",
            }
        )
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("unknown named host geometry feature 'fake-ridge'" in item for item in errors),
            errors,
        )

    def test_dimensions_and_transform_scale_are_multiplied(self) -> None:
        value = scale_vector(
            {"dimensions": {"width": 2, "height": 3, "depth": 4}},
            {"scale": [0.5, 2, 1]},
        )
        self.assertEqual(value, "1.0, 6.0, 4.0")
        sphere = scale_vector(
            {"primitive": "sphere", "dimensions": {"radius": 2}},
            {"scale": [1, 1, 1]},
        )
        self.assertEqual(sphere, "4.0, 4.0, 4.0")

    def test_generated_root_key_is_reserved_and_blockout_is_cheap(self) -> None:
        spec = make_spec("Generated", None, complexity="simple", intended_use="static-render")
        fill_pre_spec(spec)
        output = generate(spec, "blockout")
        self.assertIn("{ '$root': root }", output)
        self.assertIn("@generated by threejs-object-sculptor", output)
        self.assertIn(
            'materialMap["__phase-neutral__"] = new THREE.MeshStandardMaterial',
            output,
        )
        self.assertIn("wireframe: options.wireframe ?? false });", output)
        self.assertNotIn("wireframe: options.wireframe ?? false }});", output)
        self.assertNotIn("Record<string, any>", output)

    def test_quality_generator_bounds_runtime_maps_and_exports_review_rig(self) -> None:
        spec = make_spec(
            "Quality Rig",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="reference-fidelity",
        )
        fill_pre_spec(spec)
        output = generate(spec, "lookdev")
        self.assertIn("Math.min(1024", output)
        self.assertIn("minimumRuntimeSize = qualityFirst ? 1024 : 256", output)
        self.assertIn("applyProfileSurface", output)
        self.assertIn("componentSurfaceMaterial", output)
        self.assertIn(".castShadow = true;", output)
        self.assertIn("object-sculpt-3.2/evidence-v1", output)
        self.assertIn("configureQualityRigLookDevRenderer", output)
        self.assertIn("frameQualityRigForReview", output)
        self.assertIn("createQualityRigContactShadow", output)

    def test_local_surface_layers_are_executable_and_validated(self) -> None:
        spec = make_spec(
            "Layered Material",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="reference-fidelity",
        )
        fill_pre_spec(spec)
        material = spec["materials"][0]
        material["dirt"] = {
            "amount": 0.24,
            "cavityBias": 0.85,
            "color": "#302820",
        }
        material["wear"] = {"edgeWear": 0.18, "scratches": [], "chips": []}
        material["specularIntensity"] = 0.42
        material["specularColor"] = "#F3EBDD"
        material["envMapIntensity"] = 0.7
        material["localOverrides"] = [
            {
                "id": "observed-cuff-dust",
                "type": "dust",
                "amount": 0.35,
                "color": "#817666",
                "roughnessDelta": 0.2,
                "heightDelta": 0.01,
                "evidenceRefs": ["full-object"],
                "mask": {
                    "pattern": "cavity",
                    "frequency": 24,
                    "threshold": 0.55,
                    "contrast": 3.5,
                    "cavityBias": 0.9,
                    "uvCenter": [0.32, 0.7],
                    "uvScale": [0.2, 0.15],
                    "feather": 0.3,
                    "seed": 17,
                },
            }
        ]
        output = generate(spec, "lookdev")
        self.assertIn("function materialLocalLayers", output)
        self.assertIn("sampleLocalLayerMask", output)
        self.assertIn("heightDeltaField", output)
        self.assertIn("material.metalnessMap = textures.metalness", output)
        self.assertIn("material.specularIntensity", output)
        self.assertIn("localMaterialLayerCount", output)
        errors, _ = validate_spec(spec)
        self.assertFalse(any("localOverrides" in error for error in errors), errors)

    def test_hard_surface_materials_emit_environment_projection_and_corrosion(self) -> None:
        spec = make_spec(
            "Reflective Machine",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="reference-fidelity",
        )
        fill_pre_spec(spec)
        material = spec["materials"][0]
        material.update(
            {
                "materialProfile": "standard",
                "metalness": {"base": 0.92, "variation": 0.04},
                "roughness": {
                    "base": 0.28,
                    "variation": 0.16,
                    "map": "independent-procedural-field",
                },
                "anisotropy": {"amount": 0.68},
                "anisotropyRotation": {"angle": 0.4},
                "textureProjection": {
                    "mode": "cylindrical",
                    "axis": "y",
                    "repeat": [3.0, 2.0],
                    "anisotropy": 8,
                    "texelDensityIntent": "Stable around the observed housing.",
                },
                "localOverrides": [
                    {
                        "id": "observed-rust",
                        "type": "rust",
                        "amount": 0.55,
                        "color": "#8C3F1F",
                        "evidenceRefs": ["full-object"],
                        "mask": {
                            "pattern": "cavity",
                            "frequency": 20,
                            "cavityBias": 0.9,
                        },
                    }
                ],
            }
        )

        output = generate(spec, "lookdev")

        self.assertIn("applySculptMaterialProjectionToGeometry", output)
        self.assertIn("if (mode === 'uv') return;", output)
        self.assertIn("mode !== 'planar'", output)
        self.assertIn("mode === 'cylindrical'", output)
        self.assertIn("type === 'rust'", output)
        self.assertIn("spec.anisotropy !== undefined", output)
        self.assertIn("new THREE.PMREMGenerator(renderer)", output)
        self.assertIn("pmrem.fromEquirectangular(source)", output)
        self.assertIn("pmrem.fromScene(studio", output)
        self.assertIn("scene.environment = target.texture", output)
        self.assertIn("configureReflectiveMachineLookDevEnvironment", output)
        errors, _ = validate_spec(spec)
        self.assertFalse(any("localOverrides" in error for error in errors), errors)
        invalid = copy.deepcopy(spec)
        invalid["materials"][0]["localOverrides"][0]["evidenceRefs"] = [
            "missing-material-evidence"
        ]
        invalid_errors, _ = validate_spec(invalid)
        self.assertTrue(
            any("unknown evidence ids" in error for error in invalid_errors),
            invalid_errors,
        )
        invalid_axis = copy.deepcopy(spec)
        invalid_axis["materials"][0]["textureProjection"]["axis"] = "diagonal"
        axis_errors, _ = validate_spec(invalid_axis)
        self.assertTrue(
            any("textureProjection.axis" in error for error in axis_errors),
            axis_errors,
        )

        invalid = copy.deepcopy(spec)
        invalid["materials"][0]["localOverrides"][0].pop("mask")
        errors, _ = validate_spec(invalid)
        self.assertTrue(
            any("mask must be an executable mask object" in error for error in errors),
            errors,
        )

    def test_material_map_evidence_is_valid_metadata_but_not_an_executable_layer(self) -> None:
        spec = make_spec("Material Evidence", None, complexity="simple", intended_use="static-render")
        fill_pre_spec(spec)
        spec["materials"][0]["localOverrides"] = [
            {
                "id": "pbr-provenance",
                "type": "material-map-evidence",
                "evidenceRefs": ["full-object"],
                "channels": ["albedo", "roughness", "normal"],
            }
        ]
        errors, _ = validate_spec(spec)
        self.assertFalse(any("localOverrides" in error for error in errors), errors)
        output = generate(spec, "lookdev")
        self.assertIn("if (type === 'material-map-evidence') return", output)

    def test_offline_pbr_border_blend_is_tile_safe(self) -> None:
        size = 8
        pixels = bytearray()
        for y in range(size):
            for x in range(size):
                pixels.extend((x * 30, y * 30, (x + y) * 12))
        blended = make_tileable_rgb(bytes(pixels), size, 0.25)
        for y in range(size):
            left = (y * size) * 3
            right = (y * size + size - 1) * 3
            self.assertEqual(blended[left : left + 3], blended[right : right + 3])
        for x in range(size):
            top = x * 3
            bottom = ((size - 1) * size + x) * 3
            self.assertEqual(blended[top : top + 3], blended[bottom : bottom + 3])

    def test_validator_detects_missing_core_field_and_parent_cycle(self) -> None:
        spec = make_spec("Cycle", None, complexity="simple", intended_use="static-render")
        child = copy.deepcopy(spec["componentTree"][0])
        child["id"] = "child"
        child["parent"] = "root"
        spec["componentTree"][0]["parent"] = "child"
        del child["dimensions"]
        spec["componentTree"].append(child)
        errors, _ = validate_spec(spec)
        self.assertTrue(any("parent cycle" in error for error in errors))
        self.assertTrue(any("missing core field 'dimensions'" in error for error in errors))

    def test_json_loader_rejects_nan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text('{"value": NaN}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_spec(path)

    def test_atomic_writer_rejects_nan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            with self.assertRaises(ValueError):
                write_spec_atomic(path, {"value": float("nan")})
            self.assertFalse(path.exists())


class ComparisonTests(unittest.TestCase):
    def test_highlight_diagnostics_detect_missing_surface_response(self) -> None:
        size = 16
        reference_pixels = [
            (245, 245, 245, 255) if index % 4 == 0 else (70, 80, 95, 255)
            for index in range(size * size)
        ]
        render_pixels = [(90, 100, 115, 255)] * (size * size)
        mask = [True] * (size * size)
        diagnostics = appearance_diagnostics(
            (size, size, reference_pixels, mask),
            (size, size, render_pixels, mask),
        )
        self.assertEqual(diagnostics["highlightCoverageRatio"], 0.0)
        self.assertEqual(diagnostics["highlightEnergyRatio"], 0.0)

    def test_pairs_help_documents_reference_provenance_shape(self) -> None:
        output = io.StringIO()
        with self.assertRaises(SystemExit) as raised, redirect_stdout(output):
            comparison_main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        help_text = output.getvalue()
        self.assertIn("referenceProvenance={origin: observed|prepared-", help_text)
        self.assertIn("reference|synthetic-hypothesis", help_text)
        self.assertIn("hypothesis", help_text)
        self.assertIn("allowedUse:", help_text)
        self.assertIn("acceptance|planning-veto", help_text)
        self.assertIn("--render-receipt", help_text)

    def test_standalone_render_receipt_is_bound_into_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference.png"
            render = root / "render.png"
            comparison = root / "comparison.png"
            manifest = root / "evidence.json"
            receipt_path = root / "render-receipt.json"
            pixels = [(80, 110, 140)] * 16
            write_png_rgb(reference, 4, 4, pixels)
            write_png_rgb(render, 4, 4, pixels)
            receipt = {
                "artifactType": "threejs-sculpt-render-receipt",
                "version": 1,
                "contractSha256": "test-contract",
                "resolvedMode": "native-msaa",
                "antialiasVerified": True,
                "frameCount": 1,
                "disposed": False,
                "passChain": ["renderer"],
            }
            write_spec_atomic(receipt_path, receipt)

            output = io.StringIO()
            with redirect_stdout(output):
                result = comparison_main(
                    [
                        "--reference",
                        str(reference),
                        "--render",
                        str(render),
                        "--render-receipt",
                        str(receipt_path),
                        "--out",
                        str(comparison),
                        "--manifest-out",
                        str(manifest),
                        "--json",
                    ]
                )

            self.assertEqual(result, 0)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            provenance = payload["renderProvenance"]
            self.assertEqual(provenance["version"], 3)
            self.assertEqual(provenance["renderReceipt"], receipt)
            self.assertEqual(
                provenance["renderReceiptSha256"],
                file_sha256(receipt_path),
            )

    def test_contain_preserves_wide_image_edges(self) -> None:
        pixels = [
            (255, 0, 0, 255),
            (10, 10, 10, 255),
            (20, 20, 20, 255),
            (0, 0, 255, 255),
            (255, 0, 0, 255),
            (10, 10, 10, 255),
            (20, 20, 20, 255),
            (0, 0, 255, 255),
        ]
        result = resize_contain(4, 2, pixels, 4, 4)
        self.assertEqual(result[4], (255, 0, 0))
        self.assertEqual(result[7], (0, 0, 255))
        self.assertNotEqual(result[0], (255, 0, 0))

    def test_multi_view_sheet_returns_one_evidence_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference.png"
            render = root / "render.png"
            out = root / "sheet.png"
            rgb = [(40, 80, 120)] * 16
            write_png_rgb(reference, 4, 4, rgb)
            write_png_rgb(render, 4, 4, rgb)
            payload = create_sheet_pairs(
                [
                    {"viewId": "front", "referenceImage": reference, "renderScreenshot": render},
                    {"viewId": "side", "referenceImage": reference, "renderScreenshot": render},
                    {"viewId": "back", "referenceImage": reference, "renderScreenshot": render},
                    {
                        "viewId": "three-quarter",
                        "referenceImage": reference,
                        "renderScreenshot": render,
                    },
                ],
                out,
                128,
                128,
                6,
            )
            self.assertTrue(out.exists())
            self.assertEqual(len(payload["evidenceSet"]), 4)
            self.assertTrue(all(item["comparisonImage"] == str(out.resolve()) for item in payload["evidenceSet"]))
            self.assertTrue(
                all(item["fitDiagnostics"]["acceptanceAuthority"] is False for item in payload["evidenceSet"])
            )
            self.assertEqual(payload["layoutMode"], "grid-2x2")
            presentation = payload["userPresentation"]
            self.assertTrue(presentation["displayRequired"])
            self.assertTrue(presentation["displayBeforeNextStep"])
            self.assertEqual(presentation["renderOutputs"], [str(render.resolve())])
            self.assertEqual(presentation["sideBySideComparison"], str(out.resolve()))
            self.assertIn("Markdown images", presentation["markdownRule"])
            self.assertEqual(
                len({tuple(item["comparisonRegion"].values()) for item in payload["evidenceSet"]}),
                4,
            )
            self.assertTrue(
                all(
                    item["referenceDimensions"] == {"width": 4, "height": 4}
                    and item["renderDimensions"] == {"width": 4, "height": 4}
                    for item in payload["evidenceSet"]
                )
            )
            appearance = payload["evidenceSet"][0]["fitDiagnostics"]["appearance"]
            self.assertIn("highlightCoverageRatio", appearance)
            self.assertIn("highlightEnergyRatio", appearance)
            self.assertIn("edgeDensityRatio", appearance)
            self.assertIn("foregroundHistogramIntersection", appearance)
            width, height, _ = read_png(out)
            self.assertEqual(width, (128 * 2 + 6 * 3) * 2)
            self.assertGreater(height, 128 * 2)

    def test_silhouette_diagnostics_expose_alignment_without_approving(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference.png"
            render = root / "render.png"
            out = root / "sheet.png"
            diagnostics_dir = root / "diagnostics"
            reference_pixels = [(0, 0, 0)] * (32 * 32)
            render_pixels = [(0, 0, 0)] * (32 * 32)
            for y in range(8, 25):
                for x in range(9, 23):
                    reference_pixels[y * 32 + x] = (240, 240, 240)
                    shifted_x = min(31, x + 3)
                    render_pixels[y * 32 + shifted_x] = (240, 240, 240)
            write_png_rgb(reference, 32, 32, reference_pixels)
            write_png_rgb(render, 32, 32, render_pixels)

            payload = create_sheet_pairs(
                [{"viewId": "front", "referenceImage": reference, "renderScreenshot": render}],
                out,
                128,
                128,
                6,
                diagnostics_dir,
            )
            evidence = payload["evidenceSet"][0]
            diagnostics = evidence["fitDiagnostics"]
            self.assertFalse(diagnostics["acceptanceAuthority"])
            self.assertNotIn("silhouetteIou", diagnostics)
            self.assertLess(diagnostics["alignmentHints"]["translateX"], 0.0)
            self.assertTrue(Path(evidence["diagnosticOverlay"]).exists())


class SurfaceDescriptorTests(unittest.TestCase):
    def make_spec(self) -> dict:
        spec = make_spec(
            "Surface Contract",
            None,
            complexity="simple",
            intended_use="static-render",
            quality_profile="balanced",
        )
        fill_pre_spec(spec)
        return spec

    def test_unassessed_surface_descriptor_blocks_lookdev_not_blockout(self) -> None:
        spec = self.make_spec()
        spec["materials"][0]["surfaceDescriptor"] = {
            "status": "unassessed",
            "evidenceRefs": ["full-object"],
        }
        blockout_errors, blockout_warnings = validate_spec(spec, "blockout")
        self.assertFalse(
            any("surfaceDescriptor" in item for item in [*blockout_errors, *blockout_warnings]),
            [*blockout_errors, *blockout_warnings],
        )
        lookdev_errors, lookdev_warnings = validate_spec(spec, "lookdev")
        self.assertTrue(
            any("surfaceDescriptor" in item for item in [*lookdev_errors, *lookdev_warnings]),
            [*lookdev_errors, *lookdev_warnings],
        )

    def test_surface_descriptor_rejects_finish_and_relief_contradictions(self) -> None:
        spec = self.make_spec()
        material = spec["materials"][0]
        material["roughness"]["base"] = 0.1
        material["surfaceDescriptor"]["microRelief"] = {
            "value": "smooth",
            "channel": "none",
            "basis": "observed",
            "confidence": 0.8,
        }
        blockout_errors, _ = validate_spec(spec, "blockout")
        self.assertFalse(
            any("surfaceDescriptor" in item or "finish contradicts" in item for item in blockout_errors),
            blockout_errors,
        )
        errors, _ = validate_spec(spec)
        self.assertTrue(any("matte finish contradicts" in item for item in errors), errors)
        self.assertTrue(any("smooth microRelief contradicts" in item for item in errors), errors)

    def test_surface_descriptor_requires_traceable_evidence(self) -> None:
        spec = self.make_spec()
        spec["materials"][0]["surfaceDescriptor"]["evidenceRefs"] = ["missing-crop"]
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("surfaceDescriptor references missing evidence" in item for item in errors),
            errors,
        )

        spec["viewEvidence"] = []
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("surfaceDescriptor references missing evidence" in item for item in errors),
            errors,
        )

    def test_custom_surface_relief_requires_an_executable_description(self) -> None:
        spec = self.make_spec()
        spec["materials"][0]["surfaceDescriptor"]["microRelief"] = {
            "value": "custom",
            "channel": "normal",
            "basis": "observed",
            "confidence": 0.8,
        }
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("description is required when value is custom" in item for item in errors),
            errors,
        )


class QualityGateRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.spec = make_spec(
            "Regression",
            None,
            complexity="simple",
            intended_use="static-render",
        )
        fill_pre_spec(self.spec)

    def test_manifest_rejects_non_image_same_content_and_tampering(self) -> None:
        manifest = comparison_manifest(self.root, "integrity")
        manifest["type"] = "visual"
        self.assertEqual(visual_evidence_integrity_failures(manifest), [])

        same = copy.deepcopy(manifest)
        view = same["views"][0]
        view["renderScreenshot"] = view["referenceImage"]
        view["renderSha256"] = view["referenceSha256"]
        view["renderDimensions"] = view["referenceDimensions"]
        same["manifestSha256"] = visual_evidence_manifest_sha256(same)
        self.assertTrue(
            any("same image content" in item for item in visual_evidence_integrity_failures(same))
        )

        not_image = copy.deepcopy(manifest)
        not_image_view = not_image["views"][0]
        not_image_view["referenceImage"] = "/etc/hosts"
        not_image_view["referenceSha256"] = file_sha256(Path("/etc/hosts"))
        not_image_view["referenceDimensions"] = {"width": 1, "height": 1}
        not_image["manifestSha256"] = visual_evidence_manifest_sha256(not_image)
        self.assertTrue(
            any("not valid image evidence" in item for item in visual_evidence_integrity_failures(not_image))
        )

        render_path = Path(manifest["views"][0]["renderScreenshot"])
        write_png_rgb(render_path, 2, 2, [(255, 0, 0)] * 4)
        self.assertTrue(
            any("changed after comparison" in item for item in visual_evidence_integrity_failures(manifest))
        )

    def test_review_cannot_lower_threshold_or_forge_low_diagnostics(self) -> None:
        entry = visual_entry(self.spec, "blockout", self.root)
        entry["visualAcceptanceThreshold"] = 0.0
        entry["aiVisionScore"] = 0.1
        failures = review_failures(self.spec, entry, "blockout")
        self.assertTrue(any("cannot be below" in item for item in failures))
        self.assertTrue(any("aiVisionScore" in item for item in failures))

        entry = visual_entry(self.spec, "lookdev", self.root, "reference")
        entry["evidence"]["views"][0]["fitDiagnostics"]["appearance"][
            "detailEnergyRatio"
        ] = 0.1
        entry["evidence"]["manifestSha256"] = visual_evidence_manifest_sha256(
            entry["evidence"]
        )
        failures = review_failures(self.spec, entry, "lookdev")
        self.assertFalse(any("detailEnergyRatio" in item for item in failures))

        entry = visual_entry(self.spec, "lookdev", self.root, "reference")
        entry["evidence"]["views"][0]["fitDiagnostics"]["appearance"][
            "highlightEnergyRatio"
        ] = 0.01
        entry["evidence"]["manifestSha256"] = visual_evidence_manifest_sha256(
            entry["evidence"]
        )
        failures = review_failures(self.spec, entry, "lookdev")
        self.assertFalse(any("highlightEnergyRatio" in item for item in failures))

    def test_blind_scout_is_a_hash_bound_binary_gate(self) -> None:
        entry = visual_entry(self.spec, "blockout", self.root)
        self.assertEqual(
            blind_scout_entry_failures(
                self.spec,
                entry,
                "blockout",
                require_approve=True,
            ),
            [],
        )

        minor_observation = {
            "visualRegion": "upper housing",
            "category": "proportion",
            "phaseScope": "current",
            "direction": "slightly narrow",
            "severity": "minor",
            "viewIds": ["primary"],
        }
        at_limit = copy.deepcopy(entry)
        at_limit["blindScout"]["observations"] = [
            copy.deepcopy(minor_observation) for _ in range(7)
        ]
        self.assertEqual(
            blind_scout_entry_failures(self.spec, at_limit, "blockout"),
            [],
        )
        over_limit = copy.deepcopy(at_limit)
        over_limit["blindScout"]["observations"].append(
            copy.deepcopy(minor_observation)
        )
        self.assertTrue(
            any(
                "at most 7 items" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    over_limit,
                    "blockout",
                )
            )
        )

        missing = copy.deepcopy(entry)
        missing.pop("blindScout")
        self.assertTrue(
            any(
                "blindScout is required" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    missing,
                    "blockout",
                    require_approve=True,
                )
            )
        )

        rejected = copy.deepcopy(entry)
        rejected["blindScout"]["decision"] = "reject"
        rejected["blindScout"]["observations"] = [
            {
                "visualRegion": "upper housing",
                "category": "proportion",
                "phaseScope": "current",
                "direction": "too narrow",
                "severity": "major",
                "viewIds": ["primary"],
            }
        ]
        self.assertEqual(
            blind_scout_entry_failures(self.spec, rejected, "blockout"),
            [],
        )
        self.assertTrue(
            any(
                "must be approve before phase promotion" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    rejected,
                    "blockout",
                    require_approve=True,
                )
            )
        )

        deferred_material = copy.deepcopy(entry)
        deferred_material["blindScout"]["observations"] = [
            {
                "visualRegion": "main body paint",
                "category": "material",
                "phaseScope": "deferred",
                "direction": "surface appears too glossy",
                "severity": "major",
                "viewIds": ["primary"],
            }
        ]
        self.assertEqual(
            blind_scout_entry_failures(
                self.spec,
                deferred_material,
                "blockout",
                require_approve=True,
            ),
            [],
        )

        wrong_scope = copy.deepcopy(deferred_material)
        wrong_scope["blindScout"]["observations"][0]["phaseScope"] = "current"
        self.assertTrue(
            any(
                "phaseScope must be 'deferred'" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    wrong_scope,
                    "blockout",
                )
            )
        )

        deferred_reject = copy.deepcopy(deferred_material)
        deferred_reject["blindScout"]["decision"] = "reject"
        self.assertTrue(
            any(
                "requires at least one current/protected" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    deferred_reject,
                    "blockout",
                )
            )
        )

        lookdev_material = visual_entry(self.spec, "lookdev", self.root, "reference")
        lookdev_material["blindScout"]["decision"] = "reject"
        lookdev_material["blindScout"]["observations"] = [
            {
                "visualRegion": "main body paint",
                "category": "material",
                "phaseScope": "current",
                "direction": "surface appears too glossy",
                "severity": "major",
                "viewIds": ["reference"],
            }
        ]
        self.assertEqual(
            blind_scout_entry_failures(
                self.spec,
                lookdev_material,
                "lookdev",
            ),
            [],
        )

        lookdev_form_regression = visual_entry(
            self.spec,
            "lookdev",
            self.root,
            "reference",
        )
        lookdev_form_regression["blindScout"]["decision"] = "reject"
        lookdev_form_regression["blindScout"]["observations"] = [
            {
                "visualRegion": "main body profile",
                "category": "shape",
                "phaseScope": "protected",
                "direction": "accepted form has become distorted",
                "severity": "major",
                "viewIds": ["reference"],
            }
        ]
        self.assertEqual(
            blind_scout_entry_failures(
                self.spec,
                lookdev_form_regression,
                "lookdev",
            ),
            [],
        )

        tampered = copy.deepcopy(entry)
        tampered["blindScout"]["comparisonSha256"] = "0" * 64
        self.assertTrue(
            any(
                "not bound to the comparison hash" in failure
                for failure in blind_scout_entry_failures(
                    self.spec,
                    tampered,
                    "blockout",
                    require_approve=True,
                )
            )
        )

        contaminated = copy.deepcopy(entry)
        contaminated["blindScout"]["spec"] = {"componentTree": []}
        contaminated["blindScout"]["observations"] = [
            {
                "visualRegion": "main body",
                "category": "proportion",
                "direction": "increase width by 0.2",
                "severity": "minor",
                "viewIds": ["primary"],
                "componentId": "body",
            }
        ]
        contaminated_failures = blind_scout_entry_failures(
            self.spec,
            contaminated,
            "blockout",
        )
        self.assertTrue(
            any("contains forbidden fields" in failure for failure in contaminated_failures)
        )
        self.assertTrue(
            any("must not contain a numeric fix" in failure for failure in contaminated_failures)
        )

        advisory_primary_issue = copy.deepcopy(entry)
        advisory_primary_issue["reviewIssues"] = [
            {
                "id": "primary-direction",
                "severity": "major",
                "status": "open",
            }
        ]
        self.assertFalse(
            any(
                "blocking primary-review issue" in failure
                for failure in review_failures(
                    self.spec,
                    advisory_primary_issue,
                    "blockout",
                )
            )
        )

    def test_blind_scout_rejects_reference_visible_construction_and_material_defects(
        self,
    ) -> None:
        cases = [
            (
                "blockout",
                "assembly",
                "current",
                "support and housing are visibly detached",
            ),
            (
                "form",
                "attachment",
                "current",
                "joint is off-center and penetrates its socket",
            ),
            (
                "form",
                "balance",
                "current",
                "left and right supports lose the reference balance",
            ),
            (
                "form",
                "signature-detail",
                "current",
                "reference-defining fastener is malformed and misplaced",
            ),
            (
                "lookdev",
                "material",
                "current",
                "layered metal response is reduced to a flat uniform surface",
            ),
            (
                "lookdev",
                "attachment",
                "protected",
                "accepted handle connection has shifted away from its mount",
            ),
            (
                "lookdev",
                "proportion",
                "protected",
                "main housing is visibly too wide relative to the reference",
            ),
        ]
        for phase_id, category, phase_scope, direction in cases:
            with self.subTest(phase_id=phase_id, category=category):
                view_id = "reference" if phase_id == "lookdev" else "primary"
                entry = visual_entry(self.spec, phase_id, self.root, view_id)
                entry["blindScout"]["decision"] = "reject"
                entry["blindScout"]["observations"] = [
                    {
                        "visualRegion": "visible object region",
                        "category": category,
                        "phaseScope": phase_scope,
                        "direction": direction,
                        "severity": "major",
                        "viewIds": [view_id],
                    }
                ]
                self.assertEqual(
                    blind_scout_entry_failures(self.spec, entry, phase_id),
                    [],
                )

        minor = visual_entry(self.spec, "form", self.root)
        minor["blindScout"]["observations"] = [
            {
                "visualRegion": "small lower seam",
                "category": "attachment",
                "phaseScope": "current",
                "direction": "contact edge could align more cleanly",
                "severity": "minor",
                "viewIds": ["primary"],
            }
        ]
        self.assertEqual(
            blind_scout_entry_failures(
                self.spec,
                minor,
                "form",
                require_approve=True,
            ),
            [],
        )

    def test_main_agent_mapping_is_separate_one_to_one_and_blocking(self) -> None:
        entry = visual_entry(self.spec, "blockout", self.root)
        entry["blindScout"]["decision"] = "reject"
        entry["blindScout"]["observations"] = [
            {
                "visualRegion": "upper housing",
                "category": "proportion",
                "phaseScope": "current",
                "direction": "housing is too narrow",
                "severity": "major",
                "viewIds": ["primary"],
            },
            {
                "visualRegion": "small lower seam",
                "category": "material",
                "phaseScope": "deferred",
                "direction": "inspect the seam during lookdev",
                "severity": "minor",
                "viewIds": ["primary"],
            },
        ]
        mapping = entry["blindScoutMapping"]
        mapping["items"] = [
            {
                "observationIndex": 0,
                "status": "unmapped",
                "targets": [],
                "reason": "The target has not been identified.",
            }
        ]
        failures = blind_scout_mapping_failures(
            entry["blindScout"],
            mapping,
            review_target_catalog(self.spec),
            main_agent_context=entry["reviewerEvidence"]["builderContextId"],
        )
        self.assertTrue(
            any("exactly one item" in failure for failure in failures),
            failures,
        )
        self.assertTrue(
            any("major observation" in failure for failure in failures),
            failures,
        )

        mapping["items"] = [
            {
                "observationIndex": 0,
                "status": "mapped",
                "targets": [{"targetType": "component", "target": "root"}],
            },
            {
                "observationIndex": 1,
                "status": "deferred",
                "targets": [],
            },
        ]
        self.assertEqual(
            blind_scout_mapping_failures(
                entry["blindScout"],
                mapping,
                review_target_catalog(self.spec),
                main_agent_context=entry["reviewerEvidence"]["builderContextId"],
            ),
            [],
        )

        foreign_mapper = copy.deepcopy(mapping)
        foreign_mapper["mapper"]["contextId"] = "primary-reviewer-context"
        self.assertTrue(
            any(
                "must match the main agent" in failure
                for failure in blind_scout_mapping_failures(
                    entry["blindScout"],
                    foreign_mapper,
                    review_target_catalog(self.spec),
                    main_agent_context=entry["reviewerEvidence"]["builderContextId"],
                )
            )
        )

        missing = visual_entry(self.spec, "blockout", self.root)
        missing.pop("blindScoutMapping")
        self.assertTrue(
            any(
                "blindScoutMapping is required" in failure
                for failure in review_failures(self.spec, missing, "blockout")
            )
        )

    def test_v4_primary_reviewer_must_cover_critical_features(self) -> None:
        entry = visual_entry(self.spec, "blockout", self.root)
        entry["featureReviews"] = []

        failures = review_failures(self.spec, entry, "blockout")

        self.assertIn(
            "critical feature 'overall-silhouette' has no AI vision review",
            failures,
        )

    def test_synthetic_side_material_is_not_treated_as_observed_truth(self) -> None:
        entry = visual_entry(self.spec, "lookdev", self.root, "reference")
        side = next(view for view in entry["evidence"]["views"] if view["viewId"] == "side")
        side["fitDiagnostics"]["appearance"].update(
            {
                "detailEnergyRatio": 0.0,
                "edgeDensityRatio": 0.0,
                "foregroundHistogramIntersection": 0.0,
                "foregroundMeanColorDelta": 1.0,
                "highlightCoverageRatio": 0.0,
                "highlightEnergyRatio": 0.0,
            }
        )
        entry["evidence"]["manifestSha256"] = visual_evidence_manifest_sha256(
            entry["evidence"]
        )
        failures = review_failures(self.spec, entry, "lookdev")
        self.assertFalse(
            any("visual view 'side'" in item and "Ratio" in item for item in failures),
            failures,
        )

    def test_append_cli_rejects_downward_threshold_override(self) -> None:
        spec_path = self.root / "spec.json"
        manifest_path = self.root / "manifest.json"
        write_spec_atomic(spec_path, self.spec)
        evidence = comparison_manifest(self.root, "cli")
        manifest_path.write_text(json.dumps(evidence), encoding="utf-8")
        manual_args = [
            str(spec_path),
            "--pass-id", "blockout",
            "--action", "continue",
            "--summary", "Attempt manual visual approval.",
            "--evidence-set-json", str(manifest_path),
            "--ai-vision-score", "0.9",
            "--reviewer-model", "test-vision-model",
            "--ai-vision-notes", "The comparison was inspected for this regression test.",
            "--layer-scores-json", '{"silhouette":0.9}',
            "--feature-reviews-json", '[{"id":"overall-silhouette","score":0.9,"visible":true}]',
        ]
        with self.assertRaisesRegex(ValueError, "fresh independent reviewer"):
            append_review(manual_args)

        verdict = independent_pass_verdict(
            self.spec,
            "blockout",
            evidence,
            "threshold-review",
            overall_score=0.9,
            layer_scores={"silhouette": 0.9},
            feature_ids=["overall-silhouette"],
        )
        verdict_path = self.root / "threshold-verdict.json"
        write_spec_atomic(verdict_path, verdict)
        with self.assertRaisesRegex(ValueError, "cannot lower"):
            append_review(
                [
                    str(spec_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(manifest_path),
                    "--verdict-json", str(verdict_path),
                    "--visual-threshold", "0.1",
                ]
            )

    def test_each_hero_material_must_have_executable_evidence(self) -> None:
        weak = copy.deepcopy(self.spec["materials"][0])
        weak["id"] = "weak-hero"
        weak["name"] = "Weak hero material"
        weak["colorVariation"] = {"palette": ["#777777"], "amplitude": 0}
        weak["albedo"] = {"dominant": "#777777", "secondary": []}
        weak["roughness"] = {"base": 0.8, "variation": 0}
        weak["normal"] = {"strength": 0}
        weak["bump"] = {"amplitude": 0}
        weak["displacement"] = {"amplitude": 0}
        weak["ambientOcclusion"] = {"cavityStrength": 0}
        weak["shaderNotes"] = []
        self.spec["materials"].append(weak)
        self.spec["componentTree"][0]["material"] = "weak-hero"
        gaps = pass_specific_gaps(self.spec, "lookdev")
        self.assertTrue(any("weak-hero" in item and "palette" in item for item in gaps))
        self.assertTrue(any("weak-hero" in item and "roughness" in item for item in gaps))


class EndToEndReviewTests(unittest.TestCase):
    def test_simple_static_pipeline_keeps_all_visual_gates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec_path = root / "spec.json"
            spec = make_spec("End To End", None, complexity="simple", intended_use="static-render")
            fill_pre_spec(spec)
            spec_path.write_text(json.dumps(spec), encoding="utf-8")

            def record(pass_id: str, view_id: str, layers: dict, features: list[str]) -> None:
                current_spec = load_spec(spec_path)
                config = effective_pass_config(current_spec, pass_id)
                for layer in [
                    *config.get("requiredLayerScores", {}),
                    *config.get("preserveLayers", []),
                ]:
                    layers.setdefault(layer, 0.84)
                evidence = json.dumps(comparison_manifest(root, pass_id, view_id))
                evidence_manifest = json.loads(evidence)
                verdict = independent_pass_verdict(
                    current_spec,
                    pass_id,
                    evidence_manifest,
                    f"e2e-{pass_id}-{view_id}",
                    overall_score=0.84,
                    layer_scores=layers,
                    feature_ids=features,
                )
                verdict_path = root / f"{pass_id}-verdict.json"
                write_spec_atomic(verdict_path, verdict)
                argv = [
                    str(spec_path),
                    "--pass-id", pass_id,
                    "--evidence-set-json", evidence,
                    "--verdict-json", str(verdict_path),
                    "--in-place",
                ]
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(append_review(argv), 0)
                approved = load_spec(spec_path)
                self.assertEqual(
                    pipeline_status(approved)["state"],
                    "awaiting-user-approval",
                )
                approve_current_phase(approved, pass_id)
                write_spec_atomic(spec_path, approved)

            record("blockout", "primary", {"silhouette": 0.8}, ["overall-silhouette"])
            self.assertEqual(pipeline_status(load_spec(spec_path))["currentPass"], "form")
            record(
                "form",
                "primary",
                {"silhouette": 0.82, "structure": 0.8, "formDetail": 0.78},
                ["overall-silhouette", "primary-structure"],
            )

            updated = load_spec(spec_path)
            updated["componentTree"][0]["surfaceDetail"].update(
                {"bumpAmplitude": 0.2, "normalPattern": "fine grain"}
            )
            updated["lightingFromPhoto"] = [
                "soft key light from upper left",
                "cool fill and environment reflection",
                "ACES tone mapping, exposure 1.0, and soft contact shadow",
            ]
            spec_path.write_text(json.dumps(updated), encoding="utf-8")
            self.assertEqual(pipeline_status(load_spec(spec_path))["currentPass"], "lookdev")
            record(
                "lookdev",
                "reference",
                {
                    "silhouette": 0.82,
                    "structure": 0.8,
                    "formDetail": 0.78,
                    "material": 0.8,
                    "lighting": 0.75,
                },
                ["reference-lookdev"],
            )
            status = pipeline_status(load_spec(spec_path))
            self.assertEqual(status["state"], "complete")
            self.assertEqual(status["completedPasses"], ["blockout", "form", "lookdev"])


if __name__ == "__main__":
    unittest.main()
