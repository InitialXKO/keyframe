from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from new_sculpt_spec import make_spec  # noqa: E402
from migrate_sculpt_spec import migrate_spec  # noqa: E402
from sculpt_contract import (  # noqa: E402
    generation_validation_hash,
    phase_spec_projection,
    phase_work_packet,
    review_spec_hash,
    sync_pipeline,
)
from sculpt_pass_orchestrator import pre_spec_gaps  # noqa: E402
from sculpt_style import (  # noqa: E402
    STYLE_AXIS_VALUES,
    derive_visual_style,
    make_unassessed_visual_style,
    sync_visual_style,
    validate_visual_style,
    visual_style_projection,
)
from tests.style_helpers import make_assessed_visual_style  # noqa: E402


class VisualStyleContractTests(unittest.TestCase):
    def test_default_profile_is_complete_but_blocks_blockout_until_assessed(self) -> None:
        spec = make_spec("Style Target", "reference.png")
        style = spec["preSpecAssessment"]["visualStyle"]

        self.assertEqual(style["status"], "unassessed")
        self.assertEqual(set(style["axes"]), set(STYLE_AXIS_VALUES))
        errors, warnings = validate_visual_style(style, {"full-object"})
        self.assertEqual(errors, [])
        self.assertTrue(any("is unassessed" in item for item in warnings))
        self.assertTrue(any("visualStyle" in item for item in pre_spec_gaps(spec)))

    def test_same_schema_migration_scaffolds_legacy_specs_without_guessing_style(self) -> None:
        legacy = make_spec("Legacy Target", "reference.png")
        legacy["preSpecAssessment"].pop("visualStyle")

        migrated, report = migrate_spec(legacy)
        self.assertEqual(report["visualStyleUpdates"], 1)
        self.assertTrue(report["changed"])
        self.assertEqual(
            migrated["preSpecAssessment"]["visualStyle"],
            make_unassessed_visual_style(),
        )

        legacy_profile = make_spec("Legacy Style Profile", "reference.png")
        legacy_profile["preSpecAssessment"]["visualStyle"].pop(
            "overallStyleProfile"
        )
        migrated, report = migrate_spec(legacy_profile)
        self.assertEqual(report["visualStyleUpdates"], 1)
        self.assertIn(
            "overallStyleProfile",
            migrated["preSpecAssessment"]["visualStyle"],
        )

    def test_assessed_profile_validates_and_sync_owns_derivation(self) -> None:
        style = make_assessed_visual_style()
        style["derivation"] = {
            "family": "realistic",
            "archetypeLabels": ["Invented Label"],
            "customLabel": "stale",
        }

        errors, warnings = validate_visual_style(style, {"full-object"})
        self.assertEqual(errors, [])
        self.assertTrue(any("derivation is stale" in item for item in warnings))

        spec = make_spec("Style Target", "reference.png")
        spec["preSpecAssessment"]["visualStyle"] = style
        sync_pipeline(spec)
        self.assertEqual(
            style["derivation"],
            derive_visual_style(style),
        )

    def test_axis_validation_rejects_unregistered_ambiguous_and_ungrounded_values(self) -> None:
        style = make_assessed_visual_style()
        style["axes"]["formTreatment"]["primary"] = "unknown-style"
        style["axes"]["detailTreatment"]["modifiers"] = [
            "selective",
            "selective",
            "amplified",
        ]
        style["axes"]["shadingTreatment"]["confidence"] = True
        style["axes"]["surfaceTreatment"]["evidenceRefs"] = ["missing-view"]
        style["axes"]["edgeTreatment"]["primary"] = "none"
        style["axes"]["edgeTreatment"]["modifiers"] = ["inked"]

        errors, _ = validate_visual_style(style, {"full-object"})
        message = "\n".join(errors)
        self.assertIn("registered value", message)
        self.assertIn("must not contain duplicates", message)
        self.assertIn("at most 2", message)
        self.assertIn("number from 0 to 1", message)
        self.assertIn("unknown viewEvidence ids", message)
        self.assertIn("primary 'none' cannot have modifiers", message)

    def test_every_registered_axis_primary_is_executable(self) -> None:
        for axis, registry in STYLE_AXIS_VALUES.items():
            for primary in registry:
                with self.subTest(axis=axis, primary=primary):
                    style = make_assessed_visual_style({axis: primary})
                    if primary == "other":
                        style["axes"][axis]["custom"] = [
                            {
                                "role": "primary",
                                "label": f"Custom {axis}",
                                "definition": "Preserve the explicitly observed custom treatment.",
                            }
                        ]
                        sync_visual_style(style)
                    errors, _ = validate_visual_style(style, {"full-object"})
                    self.assertEqual(errors, [])

    def test_other_requires_one_matching_custom_definition(self) -> None:
        style = make_assessed_visual_style({"formTreatment": "other"})
        errors, _ = validate_visual_style(style, {"full-object"})
        self.assertTrue(any("exactly one primary entry" in item for item in errors))

        style["axes"]["formTreatment"]["custom"] = [
            {
                "role": "primary",
                "label": "Ribbon-built",
                "definition": "Continuous broad ribbons define the visible volume.",
            }
        ]
        sync_visual_style(style)
        errors, _ = validate_visual_style(style, {"full-object"})
        self.assertEqual(errors, [])
        self.assertEqual(style["derivation"]["customLabel"], "Ribbon-built")

    def test_influences_and_axis_shape_fail_closed(self) -> None:
        style = make_assessed_visual_style()
        style["axes"].pop("edgeTreatment")
        style["axes"]["inventedAxis"] = {}
        style["influences"] = [
            {
                "id": "genre",
                "label": "Genre",
                "affectedAxes": ["inventedAxis"],
                "confidence": 1.2,
                "evidenceRefs": ["missing-view"],
            },
            {
                "id": "genre",
                "label": "Duplicate",
                "affectedAxes": ["realism"],
                "confidence": 0.8,
                "evidenceRefs": ["full-object"],
            },
        ]

        errors, _ = validate_visual_style(style, {"full-object"})
        message = "\n".join(errors)
        self.assertIn("missing axes: edgeTreatment", message)
        self.assertIn("unexpected axes: inventedAxis", message)
        self.assertIn("contains unknown axes: inventedAxis", message)
        self.assertIn("confidence must be a number from 0 to 1", message)
        self.assertIn("unknown viewEvidence ids: missing-view", message)
        self.assertIn("influences ids must be unique", message)

    def test_derivation_composes_axes_and_declared_influences(self) -> None:
        style = make_assessed_visual_style(
            {
                "realism": "stylized",
                "formTreatment": "faceted",
                "detailTreatment": "simplified",
                "shadingTreatment": "cel-banded",
                "surfaceTreatment": "hand-painted",
                "mediumEmulation": "clay",
            }
        )
        style["influences"] = [
            {
                "id": "anime",
                "label": "Anime",
                "affectedAxes": ["proportionTreatment", "shadingTreatment"],
                "confidence": 0.85,
                "evidenceRefs": ["full-object"],
            }
        ]
        sync_visual_style(style)

        labels = style["derivation"]["archetypeLabels"]
        self.assertEqual(style["derivation"]["family"], "stylized")
        self.assertEqual(len(labels), len(set(labels)))
        for label in (
            "Low Poly",
            "Cel-Shading",
            "Hand-Painted 3D",
            "Claymation Art",
            "Anime Stylized",
        ):
            self.assertIn(label, labels)
        voxel = make_assessed_visual_style({"formTreatment": "voxelized"})
        self.assertIn(
            "Voxel Art",
            sync_visual_style(voxel)["derivation"]["archetypeLabels"],
        )

    def test_overall_style_profile_synthesizes_phase_specific_guidance(self) -> None:
        style = make_assessed_visual_style(
            {
                "realism": "stylized",
                "formTreatment": "faceted",
                "detailTreatment": "simplified",
                "shadingTreatment": "cel-banded",
                "surfaceTreatment": "hand-painted",
            }
        )
        profile = style["overallStyleProfile"]

        self.assertIn("Stylized", profile["label"])
        self.assertIn("Low Poly", profile["label"])
        self.assertIn("Cel-Shading", profile["label"])
        self.assertEqual(len(profile["signatureTraits"]), len(STYLE_AXIS_VALUES))
        blockout_guidance = "\n".join(profile["phaseDirectives"]["blockout"])
        lookdev_guidance = "\n".join(profile["phaseDirectives"]["lookdev"])
        self.assertIn("Overall style [", blockout_guidance)
        self.assertNotIn("cel-banded", blockout_guidance)
        self.assertIn("cel-banded", lookdev_guidance)

        profile["label"] = "stale"
        errors, warnings = validate_visual_style(style, {"full-object"})
        self.assertEqual(errors, [])
        self.assertTrue(any("overallStyleProfile is stale" in item for item in warnings))
        sync_visual_style(style)
        self.assertNotEqual(style["overallStyleProfile"]["label"], "stale")

    def test_phase_projection_and_work_packet_do_not_leak_future_style_axes(self) -> None:
        spec = make_spec("Style Target", "reference.png")
        style = make_assessed_visual_style(
            {
                "shadingTreatment": "cel-banded",
                "surfaceTreatment": "hand-painted",
            }
        )
        style["influences"] = [
            {
                "id": "graphic-novel",
                "label": "Graphic Novel",
                "affectedAxes": ["shadingTreatment", "surfaceTreatment"],
                "confidence": 0.8,
                "evidenceRefs": ["full-object"],
            }
        ]
        sync_visual_style(style)
        spec["preSpecAssessment"]["visualStyle"] = style

        blockout = visual_style_projection(style, "blockout")
        form = visual_style_projection(style, "form")
        lookdev = visual_style_projection(style, "lookdev")
        self.assertEqual(
            set(blockout["axes"]),
            {"realism", "formTreatment", "proportionTreatment"},
        )
        self.assertEqual(
            set(form["axes"]),
            {
                "realism",
                "formTreatment",
                "proportionTreatment",
                "detailTreatment",
            },
        )
        self.assertEqual(set(lookdev["axes"]), set(STYLE_AXIS_VALUES))
        self.assertEqual(blockout["influences"], [])
        form_style = copy.deepcopy(style)
        form_style["influences"][0]["affectedAxes"] = [
            "formTreatment",
            "surfaceTreatment",
        ]
        projected_influence = visual_style_projection(form_style, "form")[
            "influences"
        ][0]
        self.assertEqual(projected_influence["affectedAxes"], ["formTreatment"])

        projection = phase_spec_projection(spec, "form")
        self.assertIn("visualStyle", projection["preSpecAssessment"])
        self.assertEqual(len(projection["styleDirectives"]), 5)
        packet = phase_work_packet(spec, "form")
        self.assertIn(
            "preSpecAssessment.visualStyle",
            packet["specDeltaContract"]["repairablePriorPhasePaths"],
        )
        self.assertEqual(
            len(packet["visualScout"]["activePhaseInput"]["phaseRubric"]["styleChecks"]),
            5,
        )

    def test_review_and_generation_hashes_are_phase_selective(self) -> None:
        base = make_spec("Style Target", "reference.png")
        base["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style()
        sync_pipeline(base)
        baseline_review = {
            phase: review_spec_hash(base, phase)
            for phase in ("blockout", "form", "lookdev")
        }
        baseline_generation = {
            phase: generation_validation_hash(base, phase)
            for phase in ("blockout", "form", "lookdev")
        }

        lookdev_edit = copy.deepcopy(base)
        lookdev_edit["preSpecAssessment"]["visualStyle"]["axes"][
            "shadingTreatment"
        ]["primary"] = "cel-banded"
        sync_pipeline(lookdev_edit)
        self.assertEqual(
            review_spec_hash(lookdev_edit, "blockout"),
            baseline_review["blockout"],
        )
        self.assertEqual(
            review_spec_hash(lookdev_edit, "form"),
            baseline_review["form"],
        )
        self.assertNotEqual(
            review_spec_hash(lookdev_edit, "lookdev"),
            baseline_review["lookdev"],
        )
        for phase in ("blockout", "form"):
            self.assertEqual(
                generation_validation_hash(lookdev_edit, phase),
                baseline_generation[phase],
            )
        self.assertNotEqual(
            generation_validation_hash(lookdev_edit, "lookdev"),
            baseline_generation["lookdev"],
        )

        detail_edit = copy.deepcopy(base)
        detail_edit["preSpecAssessment"]["visualStyle"]["axes"][
            "detailTreatment"
        ]["primary"] = "amplified"
        sync_pipeline(detail_edit)
        self.assertEqual(
            review_spec_hash(detail_edit, "blockout"),
            baseline_review["blockout"],
        )
        for phase in ("form", "lookdev"):
            self.assertNotEqual(
                review_spec_hash(detail_edit, phase),
                baseline_review[phase],
            )

        form_edit = copy.deepcopy(base)
        form_edit["preSpecAssessment"]["visualStyle"]["axes"][
            "formTreatment"
        ]["primary"] = "faceted"
        sync_pipeline(form_edit)
        for phase in ("blockout", "form", "lookdev"):
            self.assertNotEqual(
                review_spec_hash(form_edit, phase),
                baseline_review[phase],
            )

    def test_assessed_but_invalid_profile_is_a_blockout_gap(self) -> None:
        spec = make_spec("Style Target", "reference.png")
        style = make_assessed_visual_style()
        style["axes"]["paletteTreatment"]["primary"] = "not-registered"
        spec["preSpecAssessment"]["visualStyle"] = style

        self.assertTrue(
            any("invalid visual style" in item for item in pre_spec_gaps(spec))
        )


if __name__ == "__main__":
    unittest.main()
