#!/usr/bin/env python3
"""Tests for the current Complexity Scoring contract."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from new_sculpt_spec import make_spec
from sculpt_contract import (
    derive_complexity_tier,
    sync_pipeline,
    phase_spec_projection,
    phase_work_packet,
    review_spec_hash,
)
from validate_sculpt_spec import validate_spec
from sculpt_pass_orchestrator import pre_spec_gaps, view_hypothesis_skip_gaps
from tests.style_helpers import make_assessed_visual_style


def make_assessed_complexity(
    scores: dict[str, int] | None = None,
    modifiers: dict[str, int] | None = None,
    tier: str | None = None,
) -> dict[str, Any]:
    default_scores = {
        "silhouetteComplexity": 0,
        "formTopologyComplexity": 0,
        "componentCount": 0,
        "hierarchyDepth": 0,
        "repetitionDensity": 0,
        "materialLayerCount": 0,
        "localDetailDensity": 0,
        "representationComplexity": 0,
    }
    if scores:
        default_scores.update(scores)

    default_modifiers = {
        "occlusionRisk": 0,
        "actionReadinessNeed": 0,
    }
    if modifiers:
        default_modifiers.update(modifiers)

    derived = derive_complexity_tier({
        "status": "assessed",
        "scores": default_scores,
        "modifiers": default_modifiers,
    })

    assigned_tier = tier or derived["baseTier"]

    return {
        "status": "assessed",
        "initialTierHint": "moderate",
        "tier": assigned_tier,
        "scoreScale": {
            "type": "integer-ordinal",
            "minimum": 0,
            "maximum": 3,
        },
        "scores": default_scores,
        "modifiers": default_modifiers,
        "evidenceRefs": ["ref://image1.png"],
        "reasoning": ["Detailed visual inspection completed."],
        "derivation": derived,
        "estimatedCounts": {
            "macroComponents": 1,
            "mesoComponents": 0,
            "microFeatureGroups": 0,
            "materialLayers": 1,
            "repetitionSystems": 0,
        },
    }


class TestComplexityTierDerivation(unittest.TestCase):
    def test_single_extreme_score(self) -> None:
        c = make_assessed_complexity(scores={"formTopologyComplexity": 3})
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "complex")

    def test_three_high_scores(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 2,
            "componentCount": 2,
            "materialLayerCount": 2,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "complex")

    def test_ultra_three_extreme(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 3,
            "componentCount": 3,
            "hierarchyDepth": 3,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "ultra")

    def test_ultra_two_extreme_five_high(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 3,
            "componentCount": 3,
            "hierarchyDepth": 2,
            "repetitionDensity": 2,
            "materialLayerCount": 2,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "ultra")

    def test_ultra_seven_high(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 2,
            "formTopologyComplexity": 2,
            "componentCount": 2,
            "hierarchyDepth": 2,
            "repetitionDensity": 2,
            "materialLayerCount": 2,
            "localDetailDensity": 2,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "ultra")

    def test_simple_low_scores(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 1,
            "componentCount": 1,
            "materialLayerCount": 1,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "simple")

    def test_moderate_sum_four(self) -> None:
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 1,
            "componentCount": 1,
            "hierarchyDepth": 1,
            "materialLayerCount": 1,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "moderate")


class TestComplexityContractValidation(unittest.TestCase):
    def test_unassessed_valid(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        errors, warnings = validate_spec(spec)
        self.assertEqual(errors, [])
        self.assertTrue(any("unassessed" in w for w in warnings))

    def test_assessed_valid(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"formTopologyComplexity": 1, "materialLayerCount": 1, "componentCount": 1, "silhouetteComplexity": 1}
        )
        sync_pipeline(spec)
        errors, warnings = validate_spec(spec)
        self.assertEqual(errors, [])

    def test_partial_assessment_fails(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        comp = make_assessed_complexity()
        comp["scores"]["silhouetteComplexity"] = None
        spec["preSpecAssessment"]["complexity"] = comp
        errors, warnings = validate_spec(spec)
        self.assertTrue(any("cannot be null" in e for e in errors))

    def test_mismatched_tier_fails(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        # scores derive complex, but tier is declared simple
        comp = make_assessed_complexity(
            scores={"silhouetteComplexity": 3},
            tier="simple",
        )
        spec["preSpecAssessment"]["complexity"] = comp
        errors, warnings = validate_spec(spec)
        self.assertTrue(any("does not match derived tier" in e for e in errors))

    def test_legacy_shape_warning(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = {
            "tier": "moderate",
            "scores": {
                "silhouetteComplexity": 1,
                "componentCount": 1,
                "hierarchyDepth": 0,
                "repetitionDensity": 0,
                "materialLayerCount": 1,
                "localDetailDensity": 0,
                "occlusionRisk": 0,
                "actionReadinessNeed": 0,
            },
            "estimatedCounts": {
                "macroComponents": 1,
                "mesoComponents": 0,
                "microFeatureGroups": 0,
                "materialLayers": 1,
                "repetitionSystems": 0,
            },
            "reasoning": ["Legacy v1 spec test."],
        }
        errors, warnings = validate_spec(spec)
        self.assertEqual(errors, [])
        self.assertTrue(any("legacy flat shape" in w for w in warnings))

    def test_unassessed_rejects_populated_invalid_values(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"]["scores"]["componentCount"] = "many"
        spec["preSpecAssessment"]["complexity"]["modifiers"]["occlusionRisk"] = True
        errors, _ = validate_spec(spec)
        self.assertTrue(any("componentCount" in error for error in errors))
        self.assertTrue(any("occlusionRisk" in error for error in errors))


class TestSyncPipelineComplexity(unittest.TestCase):
    def test_upgrade_moderate_to_ultra(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={
                "silhouetteComplexity": 3,
                "componentCount": 3,
                "hierarchyDepth": 3,
                "representationComplexity": 3,
            }
        )
        sync_pipeline(spec)
        self.assertEqual(spec["preSpecAssessment"]["complexity"]["tier"], "ultra")
        self.assertEqual(spec["preSpecAssessment"]["specDepthDecision"]["requiredDepth"], "ultra")
        self.assertGreaterEqual(
            spec["qualityContract"]["minimumSpecDepth"]["materials"], 4
        )

    def test_upgrade_simple_to_ultra_syncs_downstream_contracts(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="simple")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={
                "silhouetteComplexity": 3,
                "formTopologyComplexity": 3,
                "componentCount": 3,
            }
        )
        sync_pipeline(spec)
        decision = spec["preSpecAssessment"]["specDepthDecision"]
        self.assertNotIn("qualityBar", spec["qualityContract"])
        self.assertGreaterEqual(
            spec["qualityContract"]["minimumSpecDepth"]["repetitionSystems"], 1
        )
        self.assertEqual(decision["minimumComponentLevels"], ["macro", "meso", "micro"])
        self.assertTrue(decision["needsRepetitionSystems"])
        self.assertTrue(decision["needsMaterialLocalOverrides"])
        self.assertTrue(decision["needsMultipleReviewViews"])
        self.assertEqual(
            spec["viewHypothesisPolicy"]["requiredViews"],
            ["three-quarter", "side", "back"],
        )
        errors, _ = validate_spec(spec)
        self.assertFalse(
            any("viewHypothesisPolicy.requiredViews" in error for error in errors)
        )

    def test_registered_view_evidence_is_preserved_but_rejected_if_weak(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="simple")
        policy = spec["viewHypothesisPolicy"]
        policy.update(
            {
                "manifestPath": "turnaround.json",
                "manifestSha256": "a" * 64,
                "cacheKey": "b" * 64,
                "requiredViews": ["side"],
            }
        )
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={
                "silhouetteComplexity": 3,
                "formTopologyComplexity": 3,
                "componentCount": 3,
            }
        )
        sync_pipeline(spec)
        self.assertEqual(policy["requiredViews"], ["side"])
        errors, _ = validate_spec(spec)
        self.assertTrue(
            any("viewHypothesisPolicy.requiredViews" in error for error in errors)
        )

    def test_manual_overrides_not_downgraded(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="complex")
        spec["qualityContract"]["minimumSpecDepth"]["materials"] = 6
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"silhouetteComplexity": 0}
        )  # derives simple
        sync_pipeline(spec)
        self.assertEqual(
            spec["qualityContract"]["minimumSpecDepth"]["materials"], 6
        )

    def test_action_modifier_promotes_depth(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="simple")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"silhouetteComplexity": 0},
            modifiers={"actionReadinessNeed": 3},
        )
        sync_pipeline(spec)
        self.assertEqual(spec["preSpecAssessment"]["complexity"]["tier"], "simple")
        self.assertEqual(spec["preSpecAssessment"]["specDepthDecision"]["requiredDepth"], "complex")
        self.assertTrue(spec["preSpecAssessment"]["specDepthDecision"]["needsActionReadyHierarchy"])


class TestWorkflowComplexity(unittest.TestCase):
    def test_blockout_projection_includes_full_complexity(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        proj = phase_spec_projection(spec, "blockout")
        self.assertIn("complexity", proj["preSpecAssessment"])
        self.assertEqual(
            proj["preSpecAssessment"]["complexity"]["status"],
            "unassessed",
        )
        self.assertIn("qualityContract", proj)
        self.assertEqual(
            proj["qualityContract"]["requiredReviewViewIds"],
            ["full-object"],
        )
        self.assertIn("specDepthDecision", proj["preSpecAssessment"])

    def test_blockout_packet_can_edit_full_complexity_contract(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        editable = phase_work_packet(
            spec, "blockout"
        )["specDeltaContract"]["editablePaths"]
        self.assertIn("preSpecAssessment.complexity", editable)
        self.assertIn("qualityContract", editable)
        self.assertIn("featureReviewTargets", editable)
        self.assertNotIn("preSpecAssessment.complexity.tier", editable)

    def test_pre_blockout_gap_when_unassessed(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        gaps = pre_spec_gaps(spec)
        self.assertTrue(any("must be assessed before blockout" in g for g in gaps))

    def test_pre_blockout_gap_cleared_when_assessed(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"silhouetteComplexity": 1}
        )
        spec["preSpecAssessment"]["objectClass"]["primaryType"] = "vase"
        spec["preSpecAssessment"]["objectClass"]["representationKind"] = ["solid mesh"]
        spec["preSpecAssessment"]["objectClass"]["formLanguage"] = ["ceramic"]
        spec["preSpecAssessment"]["objectClass"]["structureKind"] = ["single body"]
        spec["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style()
        spec["silhouette"] = {"boundingShape": "cylinder", "aspectRatios": [1.0], "dominantCurves": ["curved"]}
        gaps = pre_spec_gaps(spec)
        self.assertFalse(any("must be assessed" in g for g in gaps))

    def test_legacy_flat_complexity_remains_runnable(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = {
            "tier": "moderate",
            "scores": {
                "silhouetteComplexity": 1,
                "componentCount": 1,
                "hierarchyDepth": 0,
                "repetitionDensity": 0,
                "materialLayerCount": 1,
                "localDetailDensity": 0,
                "occlusionRisk": 0,
                "actionReadinessNeed": 0,
            },
            "estimatedCounts": {
                "macroComponents": 1,
                "mesoComponents": 0,
                "microFeatureGroups": 0,
                "materialLayers": 1,
                "repetitionSystems": 0,
            },
            "reasoning": ["Legacy v1 spec test."],
        }
        original_complexity = dict(spec["preSpecAssessment"]["complexity"])
        sync_pipeline(spec)
        self.assertEqual(spec["preSpecAssessment"]["complexity"], original_complexity)
        gaps = pre_spec_gaps(spec)
        self.assertFalse(any("complexity" in gap for gap in gaps))

    def test_turnaround_skip_forbidden_when_occlusion_risk(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="simple")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={},
            modifiers={"occlusionRisk": 2},
        )
        spec["viewHypothesisPolicy"] = {
            "skipAssessment": {
                "objectIsSimple": True,
                "symmetry": "bilateral",
                "confidence": 0.9,
                "evidenceRefs": ["ref.png"],
                "reason": "Front view proves bilateral symmetry clearly.",
            }
        }
        gaps = view_hypothesis_skip_gaps(spec)
        self.assertTrue(any("occlusionRisk" in g for g in gaps))

    def test_review_hash_stable_across_reasoning_edits(self) -> None:
        spec = make_spec("Test Object", "ref.png", complexity="moderate")
        spec["preSpecAssessment"]["complexity"] = make_assessed_complexity(
            scores={"silhouetteComplexity": 1}
        )
        h1 = review_spec_hash(spec, "blockout")

        # Edit reasoning only
        spec["preSpecAssessment"]["complexity"]["reasoning"].append("Added observation.")
        h2 = review_spec_hash(spec, "blockout")
        self.assertEqual(h1, h2)

        # Edit modifier
        spec["preSpecAssessment"]["complexity"]["modifiers"]["occlusionRisk"] = 2
        h3 = review_spec_hash(spec, "blockout")
        self.assertNotEqual(h1, h3)


class TestScenarios(unittest.TestCase):
    def test_scenario_symmetric_knob(self) -> None:
        # Symmetrical knob -> simple
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 0,
            "formTopologyComplexity": 0,
            "componentCount": 0,
            "hierarchyDepth": 0,
            "repetitionDensity": 0,
            "materialLayerCount": 0,
            "localDetailDensity": 0,
            "representationComplexity": 0,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "simple")
        self.assertEqual(d["requiredDepth"], "simple")

    def test_scenario_glass_bottle(self) -> None:
        # Simple glass bottle -> moderate (materialLayerCount=2, formTopology=1, localDetail=1 -> sum=4, high=1)
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 0,
            "formTopologyComplexity": 1,
            "componentCount": 0,
            "hierarchyDepth": 0,
            "repetitionDensity": 0,
            "materialLayerCount": 2,
            "localDetailDensity": 1,
            "representationComplexity": 0,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "moderate")
        self.assertEqual(d["requiredDepth"], "moderate")

    def test_scenario_car_body_or_face(self) -> None:
        # Precision car body or face -> complex (formTopology=3, silhouette=2, localDetail=2 -> extreme=1, high=3)
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 2,
            "formTopologyComplexity": 3,
            "componentCount": 1,
            "hierarchyDepth": 1,
            "repetitionDensity": 0,
            "materialLayerCount": 1,
            "localDetailDensity": 2,
            "representationComplexity": 0,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "complex")
        self.assertEqual(d["requiredDepth"], "complex")

    def test_scenario_dense_tree_or_machine(self) -> None:
        # Dense tree or multi-subsystem machine -> ultra (componentCount=3, hierarchyDepth=3, repetition=3, representation=3 -> extreme=4)
        c = make_assessed_complexity(scores={
            "silhouetteComplexity": 2,
            "formTopologyComplexity": 2,
            "componentCount": 3,
            "hierarchyDepth": 3,
            "repetitionDensity": 3,
            "materialLayerCount": 2,
            "localDetailDensity": 2,
            "representationComplexity": 3,
        })
        d = derive_complexity_tier(c)
        self.assertEqual(d["baseTier"], "ultra")
        self.assertEqual(d["requiredDepth"], "ultra")


if __name__ == "__main__":
    unittest.main()
