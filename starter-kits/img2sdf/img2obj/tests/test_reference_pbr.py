from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from extract_reference_pbr import extract  # noqa: E402
from sculpt_image_io import write_png_rgb  # noqa: E402


def extraction_args(image: Path, out_dir: Path, material_id: str) -> Namespace:
    return Namespace(
        image=image,
        out_dir=out_dir,
        material_id=material_id,
        mask=None,
        size=256,
        palette_size=5,
        target_threshold=0.7,
        url_prefix="/assets/materials",
        spec=None,
        in_place=False,
        out_spec=None,
        report=None,
        allow_low_confidence=False,
        material_crop_confirmed=True,
        multi_view_reference=False,
    )


class ReferencePbrSafetyTests(unittest.TestCase):
    def test_flat_two_color_checker_keeps_albedo_but_omits_false_relief(self) -> None:
        size = 256
        payload = bytearray()
        colors = ((28, 42, 72), (222, 188, 116))
        for y in range(size):
            for x in range(size):
                payload.extend(colors[((x // 16) + (y // 16)) % 2])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "checker.png"
            out_dir = root / "maps"
            write_png_rgb(image, size, size, bytes(payload))

            report, patch = extract(extraction_args(image, out_dir, "checker"))

            self.assertEqual(report["verdict"], "reject")
            self.assertFalse(report["ok"])
            self.assertFalse(report["usable"])
            self.assertGreaterEqual(report["confidence"], report["targetThreshold"])
            self.assertLess(report["extractionSuitability"], report["targetThreshold"])
            self.assertIn(
                "flat-two-color-pattern-is-not-full-pbr-evidence",
                report["suitabilityBlockers"],
            )
            assessments = report["channelAssessments"]
            self.assertTrue(assessments["albedo"]["eligible"])
            for channel in ("roughness", "height", "normal", "ao"):
                self.assertFalse(assessments[channel]["eligible"], channel)

            maps = patch["referencePbr"]["maps"]
            self.assertEqual(set(maps), {"albedo"})
            self.assertGreaterEqual(len(set(report["palette"])), 2)
            self.assertTrue((out_dir / "checker_albedo.png").exists())
            self.assertFalse((out_dir / "checker_height.png").exists())
            self.assertFalse((out_dir / "checker_normal.png").exists())
            self.assertNotIn("normal", patch)
            self.assertNotIn("bump", patch)
            self.assertNotIn("ambientOcclusion", patch)
            self.assertEqual(patch["colorVariation"]["heightCorrelation"], 0.0)

    def test_textured_evidence_retains_legacy_complete_map_set(self) -> None:
        size = 256
        payload = bytearray()
        for y in range(size):
            for x in range(size):
                value = 48 + ((x * 17 + y * 29 + (x * y) % 71) % 170)
                payload.extend((value, min(255, value + (x % 23)), max(0, value - (y % 19))))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "textured.png"
            out_dir = root / "maps"
            write_png_rgb(image, size, size, bytes(payload))

            report, patch = extract(extraction_args(image, out_dir, "textured"))

            expected = {"albedo", "roughness", "height", "normal", "ao"}
            self.assertEqual(report["verdict"], "pass")
            self.assertTrue(report["usable"])
            self.assertEqual(set(patch["referencePbr"]["maps"]), expected)
            self.assertEqual(set(report["availableChannels"]), expected)
            self.assertEqual(report["omittedChannels"], [])
            self.assertEqual(report["confidence"], patch["referencePbr"]["confidence"])
            self.assertIn("normal", patch)
            self.assertIn("bump", patch)
            self.assertIn("ambientOcclusion", patch)
            for channel in expected:
                assessment = report["channelAssessments"][channel]
                self.assertTrue(assessment["eligible"], channel)
                self.assertGreaterEqual(assessment["confidence"], 0.0)
                self.assertLessEqual(assessment["confidence"], 1.0)
                self.assertTrue((out_dir / f"textured_{channel}.png").exists())


if __name__ == "__main__":
    unittest.main()
