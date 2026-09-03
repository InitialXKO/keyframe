from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from new_sculpt_spec import make_spec  # noqa: E402
from sculpt_capabilities import capability_report, registry_failures  # noqa: E402
from generate_threejs_factory import generate  # noqa: E402
from sculpt_corrections import (  # noqa: E402
    ARTIFACT_TYPE,
    apply_correction_batch,
    correction_failures,
)
from sculpt_perception import (  # noqa: E402
    ensure_perceptual_fields,
    perceptual_review_failures,
    render_pipeline_contract_sha256,
    render_pipeline_receipt_failures,
    validate_perceptual_contract,
)
from sculpt_contract import (  # noqa: E402
    correction_batch_from_verdict,
    generation_validation_hash,
    human_approval_contract,
    human_phase_approval_required,
    pass_order,
    review_governance_contract,
)
from validate_sculpt_spec import validate_spec  # noqa: E402


def downstream_impact(phase: str = "finalization") -> list[dict[str, str]]:
    return [
        {
            "phase": phase,
            "prediction": "The correction may affect the later integrated artifact.",
            "currentMitigation": "Keep the edit inside the declared targets and paths.",
            "futureVerification": "Run the later phase build and regression checks.",
        }
    ]


class PerceptualPipelineTests(unittest.TestCase):
    def test_new_spec_declares_perceptual_objective_and_evidence_authority(self) -> None:
        spec = make_spec("Glass Machine", None, complexity="simple")

        self.assertEqual(
            spec["perceptualContract"]["objective"],
            "viewing-contract-indistinguishable",
        )
        self.assertEqual(
            spec["evidenceAuthority"]["syntheticTurnaround"]["role"],
            "planning-veto",
        )
        self.assertFalse(
            spec["evidenceAuthority"]["syntheticTurnaround"]["mayApproveFidelity"]
        )
        self.assertEqual(spec["reviewGovernance"], review_governance_contract())
        self.assertEqual(validate_perceptual_contract(spec), [])

    def test_v4_review_governance_is_required_and_canonical(self) -> None:
        spec = make_spec("Governed Prop", None, complexity="simple")
        missing = copy.deepcopy(spec)
        missing.pop("reviewGovernance")
        errors, _ = validate_spec(missing)
        self.assertTrue(any("reviewGovernance must be an object" in item for item in errors))

        tampered = copy.deepcopy(spec)
        tampered["reviewGovernance"]["builderMayNotOverrideVerdict"] = False
        errors, _ = validate_spec(tampered)
        self.assertTrue(
            any("builderMayNotOverrideVerdict must be True" in item for item in errors)
        )

    def test_imagegen_prepared_target_uses_source_as_sole_authority(self) -> None:
        spec = make_spec(
            "Prepared Machine",
            "prepared.png",
            complexity="complex",
            reference_background="clear",
            background_removal_mode="white-background-simplification",
            imagegen_trigger="excessive-complexity",
            declared_simplifications=["non-signature micro bolts"],
        )

        authority = spec["evidenceAuthority"]
        self.assertEqual(authority["version"], 2)
        self.assertEqual(authority["acceptanceTarget"]["path"], "prepared.png")
        self.assertTrue(authority["acceptanceTarget"]["prepared"])
        self.assertNotIn("identityGuardrail", authority)
        self.assertNotIn("originalImage", spec["referencePreparation"])

    def test_v2_reference_preparation_rejects_original_identity_guardrail(self) -> None:
        spec = make_spec(
            "Prepared authority",
            "prepared.png",
            complexity="simple",
            reference_background="clear",
        )
        spec["referencePreparation"]["comparisonPolicy"] = {
            "reconstructionTarget": "sourceImage",
            "identityGuardrail": "originalImage",
        }

        errors, _ = validate_spec(spec)

        self.assertTrue(
            any("sole reconstruction and acceptance target" in item for item in errors),
            errors,
        )

    def test_legacy_identity_guardrail_contract_remains_readable(self) -> None:
        spec = make_spec(
            "Legacy prepared machine",
            "prepared.png",
            complexity="complex",
            reference_background="clear",
            background_removal_mode="white-background-simplification",
            imagegen_trigger="excessive-complexity",
            declared_simplifications=["micro detail"],
        )
        spec["referencePreparation"].update(
            {
                "originalImage": "original.png",
                "identityGuardrailValidated": True,
                "comparisonPolicy": {
                    "reconstructionTarget": "sourceImage",
                    "identityGuardrail": "originalImage",
                },
            }
        )
        spec["evidenceAuthority"] = {
            "version": 1,
            "acceptanceTarget": {
                "role": "acceptance-target",
                "path": "prepared.png",
                "prepared": True,
            },
            "identityGuardrail": {
                "role": "identity-veto",
                "path": "original.png",
            },
            "syntheticTurnaround": {
                "role": "planning-veto",
                "source": "viewHypothesisPolicy",
                "mayApproveFidelity": False,
            },
        }

        self.assertEqual(validate_perceptual_contract(spec), [])

    def test_capability_packs_compose_on_one_component(self) -> None:
        spec = make_spec("Composite Prop", None, complexity="simple")
        root = spec["componentTree"][0]
        root["name"] = "glass machine hinge housing"
        root["role"] = "transparent mechanical hinge"

        report = capability_report(spec)

        self.assertEqual(
            set(report["componentRoutes"][0]["packIds"]),
            {
                "hard-surface-machinery",
                "transmissive-surfaces",
                "procedural-motion",
            },
        )
        self.assertEqual(registry_failures(), [])

    def test_review_render_pipeline_is_global_and_versioned(self) -> None:
        spec = make_spec(
            "Reference Prop",
            None,
            complexity="simple",
            quality_profile="reference-fidelity",
        )

        viewing = spec["viewingContract"]
        pipeline = viewing["renderPipeline"]
        report = capability_report(spec)

        self.assertEqual(viewing["version"], 2)
        self.assertEqual(pipeline["antiAliasing"]["mode"], "auto")
        self.assertEqual(pipeline["antiAliasing"]["qualityPreset"], "quality")
        self.assertIn("review-render-quality", report["activePacks"])
        self.assertEqual(
            report["globalRoutes"],
            [
                {
                    "targetType": "global",
                    "targetId": "render-pipeline",
                    "packIds": ["review-render-quality"],
                }
            ],
        )
        self.assertEqual(validate_perceptual_contract(spec), [])

    def test_legacy_viewing_contract_remains_readable(self) -> None:
        spec = make_spec("Legacy Prop", None, complexity="simple")
        spec["viewingContract"]["version"] = 1
        spec["viewingContract"].pop("renderPipeline")

        self.assertEqual(validate_perceptual_contract(spec), [])

    def test_migration_upgrades_legacy_viewing_contract_without_losing_fields(self) -> None:
        spec = make_spec("Legacy Migration", None, complexity="simple")
        spec["viewingContract"]["version"] = 1
        spec["viewingContract"].pop("renderPipeline")
        spec["viewingContract"]["backgroundMode"] = "custom-legacy-background"

        updates = ensure_perceptual_fields(spec)

        self.assertGreater(updates, 0)
        self.assertEqual(spec["viewingContract"]["version"], 2)
        self.assertEqual(
            spec["viewingContract"]["backgroundMode"],
            "custom-legacy-background",
        )
        self.assertEqual(
            spec["viewingContract"]["renderPipeline"]["antiAliasing"]["mode"],
            "auto",
        )

    def test_render_receipt_is_bound_to_contract_and_pass_order(self) -> None:
        spec = make_spec("Receipt Prop", None, complexity="simple")
        contract_sha256 = render_pipeline_contract_sha256(spec)
        integral_ratio = copy.deepcopy(spec)
        integral_ratio["viewingContract"]["renderPipeline"]["maxPixelRatio"] = 2
        self.assertEqual(
            render_pipeline_contract_sha256(integral_ratio),
            contract_sha256,
        )
        receipt = {
            "artifactType": "threejs-sculpt-render-receipt",
            "version": 1,
            "contractSha256": contract_sha256,
            "backend": "webgl",
            "requestedMode": "auto",
            "resolvedMode": "smaa",
            "antialiasVerified": True,
            "frameCount": 1,
            "disposed": False,
            "passChain": ["RenderPass", "SMAAPass", "OutputPass"],
            "outputTransformOwner": "OutputPass",
            "logicalWidth": 640,
            "logicalHeight": 480,
            "pixelRatio": 1,
            "threeRevision": "178",
        }

        self.assertEqual(render_pipeline_receipt_failures(spec, receipt), [])
        wrong_order = copy.deepcopy(receipt)
        wrong_order["passChain"] = ["RenderPass", "OutputPass", "SMAAPass"]
        self.assertTrue(
            any(
                "passChain" in failure
                for failure in render_pipeline_receipt_failures(spec, wrong_order)
            )
        )
        missing_disposed = copy.deepcopy(receipt)
        missing_disposed.pop("disposed")
        self.assertTrue(
            any(
                "non-disposed" in failure
                for failure in render_pipeline_receipt_failures(spec, missing_disposed)
            )
        )
        explicit = copy.deepcopy(spec)
        explicit["viewingContract"]["renderPipeline"]["antiAliasing"]["mode"] = "smaa"
        mismatched_resolution = copy.deepcopy(receipt)
        mismatched_resolution["contractSha256"] = render_pipeline_contract_sha256(
            explicit
        )
        mismatched_resolution["requestedMode"] = "smaa"
        mismatched_resolution["resolvedMode"] = "fxaa"
        mismatched_resolution["passChain"] = [
            "RenderPass",
            "OutputPass",
            "FXAAPass",
        ]
        self.assertTrue(
            any(
                "must equal resolvedMode" in failure
                for failure in render_pipeline_receipt_failures(
                    explicit,
                    mismatched_resolution,
                )
            )
        )
        changed = copy.deepcopy(spec)
        changed["viewingContract"]["renderPipeline"]["maxPixelRatio"] = 1.5
        self.assertEqual(
            generation_validation_hash(changed, "blockout"),
            generation_validation_hash(spec, "blockout"),
        )
        self.assertNotEqual(
            render_pipeline_contract_sha256(changed),
            contract_sha256,
        )
        self.assertTrue(
            any(
                "does not match" in failure
                for failure in render_pipeline_receipt_failures(changed, receipt)
            )
        )

    def test_render_quality_correction_targets_global_pipeline(self) -> None:
        spec = make_spec("Correction Prop", None, complexity="simple")
        batch = {
            "artifactType": ARTIFACT_TYPE,
            "version": 1,
            "batchId": "prefer-smaa",
            "impactAssessment": {
                "activePhase": "blockout",
                "targetIds": ["render-pipeline"],
                "allowedPaths": ["antiAliasing.mode"],
                "protectedComponentIds": [],
                "expectedEffect": "Use the quality AA path for review renders.",
                "possibleSideEffects": ["GPU frame time may increase."],
                "downstreamImpact": downstream_impact("lookdev"),
                "structuralInvariants": ["Object geometry and hierarchy remain unchanged."],
                "risk": "low",
                "rollbackCheckpoint": "Restore the active render contract.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "corrections": [
                {
                    "issueId": "visible-edge-aliasing",
                    "packId": "review-render-quality",
                    "operatorId": "retune-render-quality",
                    "targetType": "global",
                    "target": "render-pipeline",
                    "parameterPath": "antiAliasing.mode",
                    "operation": "set",
                    "beforeValue": "auto",
                    "value": "smaa",
                    "expectedVisualEffect": "Reduce staircase edges without changing form.",
                    "falsifyingView": "reference",
                }
            ],
        }

        challenger = apply_correction_batch(spec, batch)

        self.assertEqual(
            challenger["viewingContract"]["renderPipeline"]["antiAliasing"]["mode"],
            "smaa",
        )
        self.assertEqual(
            spec["viewingContract"]["renderPipeline"]["antiAliasing"]["mode"],
            "auto",
        )

    def test_generated_factory_exports_host_owned_review_pipeline(self) -> None:
        spec = make_spec(
            "AA Rig",
            None,
            complexity="simple",
            quality_profile="reference-fidelity",
        )

        output = generate(spec, "blockout")

        self.assertIn("createSculptReviewPipeline", output)
        self.assertIn("recommendedSculptRendererOptions", output)
        self.assertIn("Promise<SculptReviewPipelineController>", output)
        self.assertIn("['RenderPass', 'SMAAPass', 'OutputPass']", output)
        self.assertIn("['RenderPass', 'OutputPass', 'FXAAPass']", output)
        self.assertIn("scene already has an active sculpt review pipeline", output)
        self.assertIn("sculptRenderPipelineReservations", output)
        self.assertIn("sculptRenderContractSha256(contract)", output)
        self.assertIn("contractSha256: effectiveContractSha256", output)
        self.assertIn("renderPipeline: scene ? sculptSceneRenderReceipt(scene)", output)

        legacy = copy.deepcopy(spec)
        legacy["viewingContract"]["version"] = 1
        legacy["viewingContract"].pop("renderPipeline")
        legacy_output = generate(legacy, "blockout")
        self.assertNotIn("createSculptReviewPipeline", legacy_output)
        self.assertNotIn("three/addons/postprocessing", legacy_output)

    def test_typed_correction_applies_to_separate_challenger(self) -> None:
        spec = make_spec("Machine", None, complexity="simple")
        root = spec["componentTree"][0]
        root["name"] = "machine housing"
        before = copy.deepcopy(spec)
        batch = {
            "artifactType": ARTIFACT_TYPE,
            "version": 1,
            "batchId": "wider-housing",
            "impactAssessment": {
                "activePhase": "form",
                "targetIds": [root["id"]],
                "allowedPaths": ["transform.scale[0]"],
                "protectedComponentIds": [],
                "expectedEffect": "Widen only the primary machine housing silhouette.",
                "possibleSideEffects": ["The housing contact spacing may change."],
                "downstreamImpact": downstream_impact("interaction"),
                "structuralInvariants": ["Hierarchy and attachments remain unchanged."],
                "risk": "medium",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "corrections": [
                {
                    "issueId": "housing-too-narrow",
                    "packId": "hard-surface-machinery",
                    "operatorId": "retune-panel-proportion",
                    "targetType": "component",
                    "target": root["id"],
                    "parameterPath": "transform.scale[0]",
                    "operation": "scale",
                    "beforeValue": root["transform"]["scale"][0],
                    "value": 1.1,
                    "expectedVisualEffect": "Widen the primary silhouette.",
                    "falsifyingView": "reference",
                }
            ],
        }

        challenger = apply_correction_batch(spec, batch)

        self.assertEqual(spec, before)
        self.assertAlmostEqual(
            challenger["componentTree"][0]["transform"]["scale"][0],
            before["componentTree"][0]["transform"]["scale"][0] * 1.1,
        )
        self.assertEqual(challenger["specRevision"], before["specRevision"] + 1)

    def test_hard_surface_pack_can_retune_material_response(self) -> None:
        spec = make_spec("Machine", None, complexity="simple")
        root = spec["componentTree"][0]
        root["name"] = "metal machine housing"
        material = spec["materials"][0]
        batch = {
            "artifactType": ARTIFACT_TYPE,
            "version": 1,
            "batchId": "rougher-metal",
            "impactAssessment": {
                "activePhase": "lookdev",
                "targetIds": [material["id"]],
                "allowedPaths": ["roughness.base"],
                "protectedComponentIds": [root["id"]],
                "expectedEffect": "Reduce the overly mirror-like metal highlight.",
                "possibleSideEffects": ["Reflection contrast may decrease."],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": ["Geometry and attachments remain unchanged."],
                "risk": "low",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "corrections": [
                {
                    "issueId": "metal-too-mirror-like",
                    "packId": "hard-surface-machinery",
                    "operatorId": "retune-hard-surface-material",
                    "targetType": "material",
                    "target": material["id"],
                    "parameterPath": "roughness.base",
                    "operation": "set",
                    "beforeValue": material["roughness"]["base"],
                    "value": 0.42,
                    "expectedVisualEffect": "Broaden the metal highlight.",
                    "falsifyingView": "grazing",
                }
            ],
        }

        challenger = apply_correction_batch(spec, batch)

        self.assertEqual(challenger["materials"][0]["roughness"]["base"], 0.42)
        self.assertNotEqual(spec["materials"][0]["roughness"]["base"], 0.42)

    def test_unknown_operator_fails_as_capability_gap(self) -> None:
        spec = make_spec("Machine", None, complexity="simple")
        root = spec["componentTree"][0]
        batch = {
            "artifactType": ARTIFACT_TYPE,
            "version": 1,
            "impactAssessment": {
                "activePhase": "form",
                "targetIds": [root["id"]],
                "allowedPaths": ["transform.scale[0]"],
                "protectedComponentIds": [],
                "expectedEffect": "Attempt the declared unsupported correction.",
                "possibleSideEffects": [],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": ["Hierarchy remains unchanged."],
                "risk": "medium",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "corrections": [
                {
                    "issueId": "unsupported",
                    "packId": "hard-surface-machinery",
                    "operatorId": "invent-unknown-shader",
                    "targetType": "component",
                    "target": root["id"],
                    "parameterPath": "transform.scale[0]",
                    "operation": "set",
                    "value": 1,
                    "expectedVisualEffect": "Unknown.",
                    "falsifyingView": "reference",
                }
            ],
        }

        self.assertTrue(
            any("capability-gap" in failure for failure in correction_failures(spec, batch))
        )

    def test_final_only_mode_skips_intermediate_human_gates(self) -> None:
        spec = make_spec(
            "Fast Perceptual Prop",
            None,
            complexity="simple",
            approval_mode="final-only",
        )
        phases = pass_order(spec)

        self.assertFalse(human_phase_approval_required(spec, phases[0]))
        self.assertTrue(human_phase_approval_required(spec, phases[-1]))
        self.assertEqual(
            spec["phaseExecutionContract"]["humanApproval"],
            human_approval_contract("final-only"),
        )

        phase_by_phase = make_spec(
            "Phase-gated Prop",
            None,
            complexity="simple",
            approval_mode="phase-by-phase",
        )
        self.assertEqual(
            phase_by_phase["phaseExecutionContract"]["humanApproval"],
            human_approval_contract("phase-by-phase"),
        )

    def test_wrong_domain_operator_cannot_edit_machine_component(self) -> None:
        spec = make_spec("Machine", None, complexity="simple")
        root = spec["componentTree"][0]
        root["name"] = "machine housing"
        batch = {
            "artifactType": ARTIFACT_TYPE,
            "version": 1,
            "impactAssessment": {
                "activePhase": "form",
                "targetIds": [root["id"]],
                "allowedPaths": ["transform.rotation[0]"],
                "protectedComponentIds": [],
                "expectedEffect": "Incorrectly attempt to rotate a machine as an eye.",
                "possibleSideEffects": [],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": ["Hierarchy remains unchanged."],
                "risk": "medium",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "corrections": [
                {
                    "issueId": "wrong-domain",
                    "packId": "organic-skin-eyes",
                    "operatorId": "repair-gaze",
                    "targetType": "component",
                    "target": root["id"],
                    "parameterPath": "transform.rotation[0]",
                    "operation": "set",
                    "value": 123,
                    "expectedVisualEffect": "This must be rejected.",
                    "falsifyingView": "reference",
                }
            ],
        }

        failures = correction_failures(spec, batch)
        self.assertTrue(any("not routed" in failure for failure in failures), failures)

    def test_tampered_reference_authority_fails_validation(self) -> None:
        spec = make_spec(
            "Prepared",
            "prepared.png",
            complexity="complex",
            reference_background="clear",
            background_removal_mode="white-background-simplification",
            imagegen_trigger="excessive-complexity",
            declared_simplifications=["micro detail"],
        )
        spec["evidenceAuthority"]["acceptanceTarget"]["path"] = "synthetic.png"
        spec["evidenceAuthority"]["syntheticTurnaround"]["mayApproveFidelity"] = True

        failures = validate_perceptual_contract(spec)
        self.assertTrue(any("acceptanceTarget.path" in item for item in failures))
        self.assertTrue(any("mayApproveFidelity" in item for item in failures))

    def test_strict_perceptual_contract_requires_source_image(self) -> None:
        spec = make_spec(
            "Strict source",
            None,
            complexity="simple",
            perceptual_enforcement="strict",
        )

        failures = validate_perceptual_contract(spec)

        self.assertTrue(any("non-empty sourceImage" in item for item in failures))

    def test_strict_review_requires_assessed_viewing_contract(self) -> None:
        spec = make_spec(
            "Strict Prop",
            None,
            complexity="simple",
            perceptual_enforcement="strict",
        )
        entry = {"evidence": {"views": [{"viewId": "reference"}]}}

        failures = perceptual_review_failures(spec, entry)

        self.assertTrue(any("must be assessed" in item for item in failures))
        self.assertTrue(any("positive integer" in item for item in failures))

    def test_reviewer_batch_preserves_typed_ids_and_is_executable(self) -> None:
        spec = make_spec("Machine", None, complexity="simple")
        root = spec["componentTree"][0]
        root["name"] = "machine housing"
        correction = {
            "issueId": "housing-too-narrow",
            "packId": "hard-surface-machinery",
            "operatorId": "retune-panel-proportion",
            "targetType": "component",
            "target": root["id"],
            "parameterPath": "transform.scale[0]",
            "operation": "scale",
            "beforeValue": 1,
            "value": 1.1,
            "expectedValue": 1.1,
            "unit": "ratio",
            "change": "Widen the housing.",
            "expectedDelta": {},
            "expectedVisualEffect": "Widen the primary silhouette.",
            "falsifyingView": "reference",
        }
        assessment = {
            "activePhase": "form",
            "targetIds": [root["id"]],
            "allowedPaths": ["transform.scale[0]"],
            "protectedComponentIds": [],
            "expectedEffect": "Widen only the primary machine housing silhouette.",
            "possibleSideEffects": ["The housing contact spacing may change."],
            "downstreamImpact": downstream_impact("interaction"),
            "structuralInvariants": ["Hierarchy and attachments remain unchanged."],
            "risk": "medium",
            "rollbackCheckpoint": "Restore the active phase champion.",
            "strategyChange": False,
            "verdict": "safe-to-apply",
        }
        verdict = {
            "reviewId": "typed-review",
            "action": "refine-spec",
            "issues": [
                {
                    "id": "housing-too-narrow",
                    "rootCauseKey": "housing-proportion",
                    "severity": "major",
                    "failureClass": "proportion",
                    "targetType": "component",
                    "target": root["id"],
                    "reason": "The housing is too narrow.",
                    "observedMismatch": {},
                    "evidenceCheck": "Compare the reference silhouette.",
                    "status": "open",
                }
            ],
            "corrections": [correction],
            "impactAssessment": assessment,
        }

        batch = correction_batch_from_verdict(verdict)
        unassessed = copy.deepcopy(batch)
        unassessed["impactAssessment"].pop("downstreamImpact")

        self.assertEqual(batch["corrections"][0]["packId"], "hard-surface-machinery")
        self.assertEqual(batch["corrections"][0]["operatorId"], "retune-panel-proportion")
        failures = correction_failures(spec, unassessed)
        self.assertTrue(
            any("downstreamImpact must be a non-empty array" in item for item in failures),
            failures,
        )
        with self.assertRaisesRegex(ValueError, "downstreamImpact"):
            apply_correction_batch(spec, unassessed)
        phase_mismatch = correction_failures(
            spec,
            batch,
            active_phase="blockout",
        )
        self.assertTrue(
            any(
                "must match the active correction phase" in item
                for item in phase_mismatch
            ),
            phase_mismatch,
        )
        original = copy.deepcopy(spec)
        with self.assertRaisesRegex(ValueError, "must match the active correction phase"):
            apply_correction_batch(spec, batch, active_phase="blockout")
        self.assertEqual(spec, original)
        self.assertEqual(correction_failures(spec, batch, active_phase="form"), [])
        challenger = apply_correction_batch(spec, batch, active_phase="form")
        self.assertAlmostEqual(challenger["componentTree"][0]["transform"]["scale"][0], 1.1)


if __name__ == "__main__":
    unittest.main()
