#!/usr/bin/env python3
"""Focused tests for the executable Quality Contract."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from new_sculpt_spec import make_spec  # noqa: E402
from sculpt_contract import (  # noqa: E402
    phase_spec_projection,
    phase_work_packet,
    review_spec_hash,
    sync_pipeline,
)
from sculpt_pass_orchestrator import (  # noqa: E402
    feature_contract_gaps,
    material_gaps,
    pass_specific_gaps,
    quality_contract_view_gaps,
    spec_depth_gaps,
)
from validate_sculpt_spec import validate_spec, warning_applies_to_pass  # noqa: E402

from tests.test_complexity import make_assessed_complexity  # noqa: E402


class QualityContractTests(unittest.TestCase):
    def test_new_contract_is_lean_and_measurable(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="complex")
        contract = spec["qualityContract"]

        self.assertEqual(
            set(contract),
            {"minimumSpecDepth", "requiredReviewViewIds"},
        )
        self.assertEqual(
            set(contract["minimumSpecDepth"]),
            {
                "macroComponents",
                "mesoComponents",
                "microFeatureGroups",
                "materials",
                "repetitionSystems",
            },
        )
        self.assertEqual(contract["requiredReviewViewIds"], ["full-object"])
        self.assertGreaterEqual(
            contract["minimumSpecDepth"]["repetitionSystems"], 1
        )

    def test_missing_and_legacy_contract_fields_fail_closed(self) -> None:
        spec = make_spec("Weak Contract", "ref.png")
        spec["qualityContract"] = {
            "qualityBar": "anything",
            "definitionOfDone": ["make it good"],
            "minimumSpecDepth": {},
        }

        errors, _ = validate_spec(spec)

        self.assertTrue(
            any("unsupported duplicate or non-operational fields" in item for item in errors),
            errors,
        )
        for field in (
            "macroComponents",
            "mesoComponents",
            "microFeatureGroups",
            "materials",
            "repetitionSystems",
        ):
            self.assertTrue(
                any(f"minimumSpecDepth.{field} is required" in item for item in errors),
                errors,
            )
        self.assertTrue(
            any("requiredReviewViewIds must be a non-empty array" in item for item in errors),
            errors,
        )

    def test_required_review_views_are_exact_unique_evidence_ids(self) -> None:
        spec = make_spec("Review Views", "ref.png")
        spec["qualityContract"]["requiredReviewViewIds"] = [
            "missing-view",
            "missing-view",
        ]

        errors, _ = validate_spec(spec)

        self.assertTrue(
            any("requiredReviewViewIds contains duplicates" in item for item in errors),
            errors,
        )
        self.assertTrue(
            any("references missing viewEvidence" in item for item in errors),
            errors,
        )
        self.assertTrue(quality_contract_view_gaps(spec))

    def test_sync_raises_repetition_floor_and_preserves_stronger_override(self) -> None:
        spec = make_spec("Repeated Object", "ref.png", complexity="simple")
        spec["qualityContract"]["minimumSpecDepth"]["repetitionSystems"] = 2
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"repetitionDensity": 3}
        )

        sync_pipeline(spec)

        self.assertTrue(
            spec["preSpecAssessment"]["specDepthDecision"]["needsRepetitionSystems"]
        )
        self.assertEqual(
            spec["qualityContract"]["minimumSpecDepth"]["repetitionSystems"],
            2,
        )

    def test_sync_does_not_hide_a_deleted_required_depth_field(self) -> None:
        spec = make_spec("Deleted Field", "ref.png")
        spec["qualityContract"]["minimumSpecDepth"].pop("materials")

        sync_pipeline(spec)
        errors, _ = validate_spec(spec)

        self.assertNotIn(
            "materials",
            spec["qualityContract"]["minimumSpecDepth"],
        )
        self.assertTrue(
            any("minimumSpecDepth.materials is required" in item for item in errors),
            errors,
        )

    def test_material_and_repetition_minimums_use_the_real_collections(self) -> None:
        spec = make_spec("Measured Collections", "ref.png", complexity="simple")
        minimums = spec["qualityContract"]["minimumSpecDepth"]
        minimums["materials"] = 2
        minimums["repetitionSystems"] = 1

        self.assertTrue(
            any("materials is below" in item for item in material_gaps(spec)),
        )
        self.assertTrue(
            any(
                "repetitionSystems is below" in item
                for item in spec_depth_gaps(spec, ("repetitionSystems",))
            ),
        )
        minimums["materials"] = -1
        self.assertTrue(
            any("must be a non-negative integer" in item for item in material_gaps(spec)),
        )

    def test_starter_target_blocks_only_until_it_is_source_specific(self) -> None:
        spec = make_spec("Specific Object", "ref.png")

        self.assertTrue(
            any("generic starter" in item for item in feature_contract_gaps(spec, "blockout"))
        )
        del spec["featureReviewTargets"][0]["criteria"]
        gaps = feature_contract_gaps(spec, "blockout")
        self.assertTrue(any("needs non-empty criteria" in item for item in gaps), gaps)
        self.assertTrue(any("generic starter" in item for item in gaps), gaps)
        spec["featureReviewTargets"][0].update(
            {
                "componentRefs": ["source-specific-part"],
                "requiresDedicatedEvidence": True,
                "reviewViewIds": ["full-object"],
            }
        )
        self.assertTrue(
            any(
                "generic starter" in item
                for item in feature_contract_gaps(spec, "blockout")
            )
        )
        spec["featureReviewTargets"][0]["criteria"] = [
            "Match the observed asymmetric crescent opening and the 2:1 cap-to-stem ratio."
        ]
        self.assertFalse(
            any("generic starter" in item for item in feature_contract_gaps(spec, "blockout"))
        )

    def test_blockout_packet_owns_and_projects_the_contract(self) -> None:
        spec = make_spec("Packet Object", "ref.png")
        packet = phase_work_packet(spec, "blockout")

        self.assertIn("qualityContract", packet["contextProjection"])
        self.assertIn("featureReviewTargets", packet["contextProjection"])
        self.assertIn(
            "qualityContract",
            packet["specDeltaContract"]["activePhaseOwnedPaths"],
        )
        self.assertIn(
            "featureReviewTargets",
            packet["specDeltaContract"]["activePhaseOwnedPaths"],
        )
        self.assertEqual(
            set(packet["derivedDepth"]),
            {
                "macroComponents",
                "mesoComponents",
                "microFeatureGroups",
                "materials",
                "repetitionSystems",
            },
        )
        self.assertEqual(
            set(packet["visualScout"]["activePhaseInput"]),
            {"phaseId", "phaseRubric"},
        )
        self.assertNotIn(
            "qualityContract",
            packet["visualScout"]["activePhaseInput"],
        )
        self.assertNotIn(
            "requiredFeatureTargets",
            packet["visualScout"]["activePhaseInput"],
        )
        self.assertIn(
            "qualityContract",
            phase_spec_projection(spec, "lookdev"),
        )

    def test_review_hash_tracks_contract_and_pass_specific_feature_targets(self) -> None:
        spec = make_spec("Hash Object", "ref.png")
        blockout_hash = review_spec_hash(spec, "blockout")
        form_hash = review_spec_hash(spec, "form")

        view_changed = copy.deepcopy(spec)
        view_changed["viewEvidence"].append(
            {
                "id": "opening-detail",
                "view": "detail",
                "imageRegion": {
                    "x": 0.1,
                    "y": 0.1,
                    "width": 0.3,
                    "height": 0.3,
                    "units": "normalized",
                },
                "observations": ["The crescent opening controls identity."],
                "confidence": 0.9,
            }
        )
        view_changed["qualityContract"]["requiredReviewViewIds"].append(
            "opening-detail"
        )
        self.assertNotEqual(
            review_spec_hash(view_changed, "blockout"),
            blockout_hash,
        )

        form_target_changed = copy.deepcopy(spec)
        form_target_changed["featureReviewTargets"].append(
            {
                "id": "crescent-opening",
                "name": "Asymmetric crescent opening",
                "tier": "critical",
                "passIds": ["form"],
                "minimumScore": 0.8,
                "mustPass": True,
                "componentRefs": ["root"],
                "evidenceRefs": ["full-object"],
                "criteria": ["Preserve the observed opening width, tilt, and negative space."],
            }
        )
        self.assertEqual(
            review_spec_hash(form_target_changed, "blockout"),
            blockout_hash,
        )
        self.assertNotEqual(
            review_spec_hash(form_target_changed, "form"),
            form_hash,
        )

        protocol_changed = copy.deepcopy(spec)
        protocol_changed["phaseExecutionContract"]["visualScout"]["inputRule"] += (
            " Changed protocol."
        )
        self.assertNotEqual(
            review_spec_hash(protocol_changed, "blockout"),
            blockout_hash,
        )

    def test_legacy_contract_shape_blocks_later_phases_and_changes_hash(self) -> None:
        spec = make_spec("Late Contract Mutation", "ref.png")
        baseline_hash = review_spec_hash(spec, "form")
        spec["qualityContract"]["qualityBar"] = "legacy"

        self.assertTrue(
            any(
                "unsupported fields" in item
                for item in pass_specific_gaps(spec, "form")
            )
        )
        self.assertNotEqual(review_spec_hash(spec, "form"), baseline_hash)

    def test_quality_warnings_remain_visible_to_lookdev(self) -> None:
        warning = (
            "quality: qualityContract requiredReviewViewIds contains an unresolved view"
        )
        self.assertTrue(warning_applies_to_pass(warning, "lookdev"))


if __name__ == "__main__":
    unittest.main()
