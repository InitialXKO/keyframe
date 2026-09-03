from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from generate_threejs_factory import generate  # noqa: E402
from new_sculpt_spec import make_spec  # noqa: E402
from sculpt_capabilities import OPERATOR_TO_PACK, registry_failures  # noqa: E402
from sculpt_corrections import OPERATOR_RULES  # noqa: E402
from sculpt_landform_generator import (  # noqa: E402
    _sample_height,
    apply_landform_recipe,
    generate_landform_geometry,
    normalize_landform_recipe,
)
from validate_sculpt_spec import validate_spec  # noqa: E402


class LandformGeometryTests(unittest.TestCase):
    def test_profiles_are_deterministic(self) -> None:
        recipes = [
            {"kind": "terrain", "seed": 42, "rockCount": 24},
            {"kind": "boulder", "seed": 42},
            {"kind": "cliff", "seed": 42},
        ]
        for recipe in recipes:
            with self.subTest(kind=recipe["kind"]):
                first = generate_landform_geometry(recipe)
                second = generate_landform_geometry(recipe)
                self.assertEqual(first, second)
                json.dumps(first, allow_nan=False)

    def test_named_profiles_emit_distinct_geometry(self) -> None:
        profiles = {
            "terrain": ("rolling", "ridged", "terraced"),
            "boulder": ("rounded", "angular", "layered"),
            "cliff": ("weathered", "layered"),
        }
        for kind, names in profiles.items():
            with self.subTest(kind=kind):
                geometries = [
                    generate_landform_geometry(
                        {"kind": kind, "profile": profile, "seed": 42}
                    )
                    for profile in names
                ]
                for index, geometry in enumerate(geometries):
                    self.assertNotIn(geometry, geometries[index + 1 :])

    def test_seed_changes_unanchored_terrain_but_not_center_anchor(self) -> None:
        anchor = {
            "id": "main-summit",
            "type": "peak",
            "position": [0.0, 0.0],
            "radius": 0.3,
            "strength": 0.8,
        }
        first = generate_landform_geometry(
            {"kind": "terrain", "seed": 1, "gridSize": 13, "terrainAnchors": [anchor]}
        )
        second = generate_landform_geometry(
            {"kind": "terrain", "seed": 2, "gridSize": 13, "terrainAnchors": [anchor]}
        )
        first_grid = first["rootParameters"]["controlGrid"]
        second_grid = second["rootParameters"]["controlGrid"]
        self.assertEqual(first_grid[6][6], second_grid[6][6])
        self.assertNotEqual(first_grid, second_grid)

    def test_seed_changes_unanchored_rock_but_not_signature_source(self) -> None:
        anchor = {
            "id": "front-cap",
            "position": [0.15, 0.05, 0.2],
            "radii": [0.2, 0.15, 0.18],
            "strength": 0.7,
        }
        first = generate_landform_geometry(
            {"kind": "boulder", "seed": 1, "rockAnchors": [anchor]}
        )
        second = generate_landform_geometry(
            {"kind": "boulder", "seed": 2, "rockAnchors": [anchor]}
        )
        first_sources = {
            item["id"]: item for item in first["rootParameters"]["sources"]
        }
        second_sources = {
            item["id"]: item for item in second["rootParameters"]["sources"]
        }
        self.assertEqual(
            first_sources["signature-front-cap"],
            second_sources["signature-front-cap"],
        )
        self.assertNotEqual(first_sources, second_sources)

    def test_rock_scatter_contacts_generated_height(self) -> None:
        geometry = generate_landform_geometry(
            {
                "kind": "terrain",
                "seed": 9,
                "size": [5.0, 1.2, 4.0],
                "rockCount": 40,
                "rockMinSpacingRatio": 0.0,
            }
        )
        control_grid = geometry["rootParameters"]["controlGrid"]
        heights = [[point[1] for point in row] for row in control_grid]
        for instance in geometry["rockInstances"]:
            terrain_height, _ = _sample_height(
                heights,
                5.0,
                4.0,
                instance["position"][0],
                instance["position"][2],
            )
            self.assertAlmostEqual(
                instance["position"][1] - instance["scale"][1] * 0.34,
                terrain_height,
                places=5,
            )

    def test_recipe_bounds_and_kind_specific_fields_fail_closed(self) -> None:
        invalid = [
            {"kind": "cave"},
            {"kind": "terrain", "version": True},
            {"kind": "terrain", "gridSize": 17},
            {"kind": "terrain", "sourceCount": 3},
            {"kind": "boulder", "rockCount": 10},
            {"kind": "cliff", "resolution": 41},
            {"kind": "terrain", "unknownControl": 1},
            {
                "kind": "terrain",
                "terrainAnchors": [
                    {
                        "id": "bad-valley",
                        "type": "valley",
                        "position": [0, 0],
                        "radius": 0.2,
                        "strength": 0.5,
                    }
                ],
            },
        ]
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                with self.assertRaises(ValueError):
                    normalize_landform_recipe(recipe)

    def test_declared_limits_stay_inside_registry_budgets(self) -> None:
        terrain = normalize_landform_recipe(
            {
                "kind": "terrain",
                "gridSize": 16,
                "segments": 128,
                "rockCount": 2_048,
                "rockMinSpacingRatio": 0.0,
            }
        )
        rock = normalize_landform_recipe(
            {
                "kind": "cliff",
                "resolution": 32,
                "sourceCount": 12,
                "strataCount": 12,
                "fractureStrength": 0.2,
                "rockAnchors": [
                    {
                        "id": f"anchor-{index}",
                        "position": [0, 0, 0],
                        "radii": [0.1, 0.1, 0.1],
                        "strength": 0.5,
                    }
                    for index in range(12)
                ],
            }
        )
        self.assertEqual(terrain["gridSize"] ** 2, 256)
        self.assertLessEqual((terrain["segments"] + 1) ** 2, 65_536)
        self.assertEqual(terrain["rockCount"], 2_048)
        terms = (
            rock["sourceCount"]
            + len(rock["rockAnchors"])
            + rock["strataCount"]
            + 2
        )
        self.assertLessEqual(rock["resolution"] ** 3 * terms, 2_000_000)


class LandformSpecIntegrationTests(unittest.TestCase):
    def test_all_kinds_are_valid_generatable_challengers(self) -> None:
        source = make_spec("Landform Study", None, complexity="simple")
        before = copy.deepcopy(source)
        recipes = [
            {"kind": "terrain", "seed": 42, "rockCount": 24},
            {"kind": "boulder", "seed": 42},
            {"kind": "cliff", "seed": 42},
        ]
        for recipe in recipes:
            with self.subTest(kind=recipe["kind"]):
                challenger = apply_landform_recipe(
                    source, recipe, active_phase="form"
                )
                self.assertEqual(source, before)
                self.assertNotIn("landformRecipe", challenger)
                errors, _ = validate_spec(challenger)
                self.assertEqual(errors, [])
                generated = generate(challenger, "form")
                expected_helper = (
                    "createDeformableSurfaceGeometry"
                    if recipe["kind"] == "terrain"
                    else "createSculptedSurfaceGeometry"
                )
                self.assertIn(expected_helper, generated)
                if recipe["kind"] == "terrain":
                    self.assertIn("new THREE.InstancedMesh", generated)
                self.assertIn(
                    "terrain-landform",
                    challenger["capabilityPlan"]["activePacks"],
                )
                json.dumps(challenger, allow_nan=False)

    def test_apply_rejects_wrong_phase_authored_hierarchy_and_material(self) -> None:
        source = make_spec("Landform Study", None, complexity="simple")
        with self.assertRaisesRegex(ValueError, "only during Form"):
            apply_landform_recipe(
                source, {"kind": "terrain"}, active_phase="blockout"
            )
        challenger = apply_landform_recipe(
            source, {"kind": "terrain"}, active_phase="form"
        )
        with self.assertRaisesRegex(ValueError, "one-shot"):
            apply_landform_recipe(
                challenger, {"kind": "boulder"}, active_phase="form"
            )
        authored = copy.deepcopy(source)
        authored["componentTree"][0]["fidelityTier"] = "form"
        authored["componentTree"][0]["detailPlan"]["status"] = "planned"
        with self.assertRaisesRegex(ValueError, "unauthored"):
            apply_landform_recipe(
                authored, {"kind": "cliff"}, active_phase="form"
            )
        with self.assertRaisesRegex(ValueError, "unknown landform material"):
            apply_landform_recipe(
                source,
                {"kind": "boulder"},
                rock_material="missing",
                active_phase="form",
            )

    def test_capability_registry_remains_executable(self) -> None:
        self.assertEqual(registry_failures(), [])
        operators = {
            operator
            for operator, pack in OPERATOR_TO_PACK.items()
            if pack == "terrain-landform"
        }
        self.assertEqual(
            operators,
            {"reshape-landform", "redistribute-rocks", "retune-earth-material"},
        )
        self.assertTrue(operators <= set(OPERATOR_RULES))


if __name__ == "__main__":
    unittest.main()
