from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from new_sculpt_spec import make_spec  # noqa: E402
from generate_threejs_factory import generate  # noqa: E402
from sculpt_contract import generation_validation_hash, review_spec_hash  # noqa: E402
from sculpt_pass_orchestrator import material_gaps  # noqa: E402
from validate_sculpt_spec import validate_spec  # noqa: E402
from tests.style_helpers import make_assessed_visual_style  # noqa: E402


def assessed_smooth_surface() -> dict:
    return {
        "status": "assessed",
        "rigidity": {"value": "rigid", "basis": "observed", "confidence": 0.9},
        "finish": {"value": "matte", "basis": "observed", "confidence": 0.9},
        "microRelief": {
            "value": "smooth",
            "channel": "none",
            "basis": "observed",
            "confidence": 0.9,
        },
        "evidenceRefs": ["full-object"],
    }


def imagegen_texture_set() -> dict:
    return {
        "sourceType": "imagegen-authored",
        "status": "ready",
        "channels": {
            "albedo": {
                "path": "assets/materials/base-albedo.png",
                "url": "/assets/materials/base-albedo.png",
                "channel": "albedo",
                "colorSpace": "srgb",
                "tileSafe": True,
                "sha256": "b" * 64,
            }
        },
        "provenance": {
            "tool": "imagegen",
            "prompt": "Flat seamless material swatch under neutral lighting; no shadows or highlights.",
            "assetSha256": "b" * 64,
            "evidenceRefs": ["full-object"],
            "acceptanceAuthority": False,
        },
        "authoringChecks": {
            "flatNeutralLighting": True,
            "bakedLightingFree": True,
            "seamChecked": True,
        },
    }


class MaterialTextureContractTests(unittest.TestCase):
    def test_starter_contract_remains_legacy_compatible(self) -> None:
        spec = make_spec("Material Starter", None, complexity="simple")
        self.assertNotIn("textureSet", spec["materials"][0])
        errors, _ = validate_spec(spec)
        self.assertFalse(any("textureSet" in item for item in errors), errors)

    def test_imagegen_texture_is_an_asset_not_acceptance_authority(self) -> None:
        spec = make_spec(
            "ImageGen Material",
            "reference.png",
            complexity="simple",
            quality_profile="reference-fidelity",
        )
        original_source = spec["sourceImage"]
        material = spec["materials"][0]
        material["surfaceDescriptor"] = assessed_smooth_surface()
        material["textureSet"] = imagegen_texture_set()

        errors, warnings = validate_spec(spec)

        self.assertEqual(spec["sourceImage"], original_source)
        self.assertFalse(any("textureSet" in item for item in errors), errors)
        self.assertFalse(
            any("needs confirmed material-crop PBR" in item for item in material_gaps(spec)),
            material_gaps(spec),
        )
        self.assertFalse(any("acceptance authority" in item for item in warnings), warnings)

    def test_imagegen_texture_requires_reproducible_provenance_and_clean_authoring(self) -> None:
        spec = make_spec("Invalid ImageGen Material", None, complexity="simple")
        texture_set = imagegen_texture_set()
        texture_set["provenance"].pop("prompt")
        texture_set["provenance"].pop("assetSha256")
        texture_set["authoringChecks"]["bakedLightingFree"] = False
        texture_set["provenance"]["acceptanceAuthority"] = True
        spec["materials"][0]["textureSet"] = texture_set

        errors, _ = validate_spec(spec)

        for fragment in ("prompt is required", "assetSha256 is required", "bakedLightingFree", "acceptance authority"):
            with self.subTest(fragment=fragment):
                self.assertTrue(any(fragment in item for item in errors), errors)

    def test_ineligible_reference_relief_channels_may_be_omitted_for_smooth_material(self) -> None:
        spec = make_spec(
            "Smooth Painted Surface",
            "reference.png",
            complexity="simple",
            quality_profile="reference-fidelity",
        )
        material = spec["materials"][0]
        material["surfaceDescriptor"] = assessed_smooth_surface()
        material["referencePbr"] = {
            "usable": True,
            "materialCropConfirmed": True,
            "confidence": 0.86,
            "extractionSuitability": 0.35,
            "maps": {"albedo": {"url": "/maps/albedo.png", "channel": "albedo"}},
            "channelAssessments": {
                "albedo": {"eligible": True, "confidence": 0.9, "reason": "Observed color evidence."},
                "roughness": {"eligible": False, "confidence": 0.2, "reason": "Lighting ambiguity."},
                "height": {"eligible": False, "confidence": 0.1, "reason": "Flat painted pattern."},
                "normal": {"eligible": False, "confidence": 0.1, "reason": "Flat painted pattern."},
                "ao": {"eligible": False, "confidence": 0.2, "reason": "No cavity evidence."},
            },
        }

        errors, warnings = validate_spec(spec)

        self.assertFalse(any("referencePbr.channelAssessments" in item for item in errors), errors)
        self.assertFalse(any("referencePbr.maps missing" in item for item in warnings), warnings)

    def test_texture_contract_changes_only_lookdev_hash_scope(self) -> None:
        spec = make_spec("Scoped Texture", None, complexity="simple")
        changed = copy.deepcopy(spec)
        changed["materials"][0]["textureSet"] = imagegen_texture_set()
        self.assertEqual(spec["sourceImage"], changed["sourceImage"])
        self.assertEqual(review_spec_hash(spec, "blockout"), review_spec_hash(changed, "blockout"))
        self.assertEqual(review_spec_hash(spec, "form"), review_spec_hash(changed, "form"))
        self.assertNotEqual(review_spec_hash(spec, "lookdev"), review_spec_hash(changed, "lookdev"))

    def test_style_is_executed_and_scoped_to_lookdev_generation(self) -> None:
        physical = make_spec("Style Runtime", None, complexity="simple")
        physical["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style()
        unlit = copy.deepcopy(physical)
        unlit["preSpecAssessment"]["visualStyle"]["axes"]["shadingTreatment"]["primary"] = "unlit"

        output = generate(unlit, "lookdev")
        self.assertIn('const SCULPT_SHADING_TREATMENT: string = "unlit"', output)
        self.assertIn("new THREE.MeshBasicMaterial", output)
        self.assertEqual(
            generation_validation_hash(physical, "form"),
            generation_validation_hash(unlit, "form"),
        )
        self.assertNotEqual(
            generation_validation_hash(physical, "lookdev"),
            generation_validation_hash(unlit, "lookdev"),
        )

    def test_authored_texture_load_has_runtime_readiness_and_error_path(self) -> None:
        spec = make_spec("Texture Runtime", None, complexity="simple")
        spec["materials"][0]["textureSet"] = imagegen_texture_set()

        output = generate(spec, "lookdev")

        self.assertIn("makeAuthoredTextureSet(spec, options) ?? makeReferenceTextureSet", output)
        self.assertIn("materialReady: Promise<void>", output)
        self.assertIn("sculptLoadStatus = 'pending'", output)
        self.assertIn("sculptLoadStatus = 'error'", output)
        self.assertIn("rejectReady(new Error", output)
        self.assertIn("materialStatus: runtime.materialStatus()", output)

    def test_unsupported_shading_fails_lookdev_validation(self) -> None:
        spec = make_spec("Unsupported Style", None, complexity="simple")
        spec["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style(
            {"shadingTreatment": "painterly"}
        )

        errors, _ = validate_spec(spec, "lookdev")

        self.assertTrue(any("no executable Three.js material route" in item for item in errors), errors)

    def test_reference_extracted_shortcut_does_not_bypass_reference_fidelity(self) -> None:
        spec = make_spec(
            "Reference Shortcut",
            "reference.png",
            complexity="simple",
            quality_profile="reference-fidelity",
        )
        texture_set = imagegen_texture_set()
        texture_set["sourceType"] = "reference-extracted"
        texture_set["provenance"]["tool"] = "extract_reference_pbr.py"
        spec["materials"][0]["textureSet"] = texture_set

        self.assertTrue(
            any("needs confirmed material-crop PBR" in item for item in material_gaps(spec)),
            material_gaps(spec),
        )

    def test_ineligible_albedo_cannot_make_reference_pbr_usable(self) -> None:
        spec = make_spec(
            "Rejected Albedo",
            "reference.png",
            complexity="simple",
            quality_profile="reference-fidelity",
        )
        spec["materials"][0]["referencePbr"] = {
            "usable": True,
            "materialCropConfirmed": True,
            "extractionSuitability": 0.9,
            "maps": {"albedo": {"url": "/maps/albedo.png"}},
            "channelAssessments": {
                channel: {"eligible": False, "confidence": 0.1}
                for channel in ("albedo", "roughness", "height", "normal", "ao")
            },
        }

        self.assertTrue(
            any("needs confirmed material-crop PBR" in item for item in material_gaps(spec)),
            material_gaps(spec),
        )


if __name__ == "__main__":
    unittest.main()
