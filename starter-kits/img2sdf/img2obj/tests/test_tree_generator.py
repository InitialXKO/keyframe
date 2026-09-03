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
from sculpt_geometry import validate_geometry_component  # noqa: E402
from sculpt_tree_generator import (  # noqa: E402
    apply_tree_recipe,
    generate_tree_geometry,
    normalize_tree_recipe,
)
from validate_sculpt_spec import validate_spec  # noqa: E402


def geometry_components(kind: str, seed: int = 42) -> tuple[dict, dict]:
    branches, leaves = generate_tree_geometry({"kind": kind, "seed": seed})
    wood = {
        "id": "root",
        "componentType": "part",
        "primitive": "branch-network",
        "geometryDescriptor": {"parameters": branches},
    }
    foliage = {
        "id": "tree-foliage-crown",
        "componentType": "part",
        "primitive": "instanced-cluster",
        "geometryDescriptor": {
            "parameters": {
                "basePrimitive": "extrude",
                "baseParameters": {
                    "shape": [[0, -0.1], [0.04, 0], [0, 0.1], [-0.04, 0]],
                    "holes": [],
                    "depth": 0.002,
                    "steps": 1,
                    "bevelEnabled": False,
                    "bevelThickness": 0,
                    "bevelSize": 0,
                    "bevelOffset": 0,
                    "bevelSegments": 1,
                },
                "instances": leaves,
            }
        },
    }
    return wood, foliage


class TreeGeometryTests(unittest.TestCase):
    def test_profiles_are_deterministic_registered_geometry(self) -> None:
        for kind in ("broadleaf", "conifer"):
            with self.subTest(kind=kind):
                first = generate_tree_geometry({"kind": kind, "seed": 42})
                second = generate_tree_geometry({"kind": kind, "seed": 42})
                self.assertEqual(first, second)
                branches, leaves = first
                self.assertEqual(len(branches["edges"]), len(branches["nodes"]) - 1)
                self.assertGreater(len(leaves), 0)
                wood, foliage = geometry_components(kind)
                self.assertEqual(validate_geometry_component(wood), [])
                self.assertEqual(validate_geometry_component(foliage), [])

    def test_seed_changes_growth_but_not_signature_anchor(self) -> None:
        recipe = {
            "kind": "broadleaf",
            "majorBranchAnchors": [
                {
                    "id": "east-signature-limb",
                    "heightRatio": 0.55,
                    "azimuth": 0.2,
                    "elevation": 0.3,
                    "lengthRatio": 0.9,
                }
            ],
        }
        first, first_leaves = generate_tree_geometry({**recipe, "seed": 1})
        second, second_leaves = generate_tree_geometry({**recipe, "seed": 2})
        first_nodes = {item["id"]: item for item in first["nodes"]}
        second_nodes = {item["id"]: item for item in second["nodes"]}
        self.assertEqual(
            first_nodes["signature-east-signature-limb"],
            second_nodes["signature-east-signature-limb"],
        )
        self.assertNotEqual(first, second)
        self.assertNotEqual(first_leaves, second_leaves)

    def test_recipe_bounds_fail_closed(self) -> None:
        invalid = [
            {"kind": "palm"},
            {"kind": []},
            {"kind": "broadleaf", "version": True},
            {"kind": "broadleaf", "foliageCount": 10_001},
            {"kind": "conifer", "branchLevels": 4},
            {"kind": "broadleaf", "unknownControl": 1},
            {
                "kind": "broadleaf",
                "majorBranchAnchors": [{"id": "incomplete-limb"}],
            },
        ]
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                with self.assertRaises(ValueError):
                    normalize_tree_recipe(recipe)

    def test_maximum_recipe_stays_inside_registry_caps(self) -> None:
        branches, leaves = generate_tree_geometry(
            {
                "kind": "conifer",
                "seed": 7,
                "branchCount": 32,
                "branchLevels": 3,
                "rootCount": 12,
                "foliageCount": 10_000,
            }
        )
        self.assertLessEqual(len(branches["nodes"]), 256)
        self.assertEqual(len(leaves), 10_000)


class TreeSpecIntegrationTests(unittest.TestCase):
    def test_apply_is_one_shot_valid_and_generatable(self) -> None:
        source = make_spec("Ancient Oak", None, complexity="simple")
        before = copy.deepcopy(source)
        for kind in ("broadleaf", "conifer"):
            with self.subTest(kind=kind):
                challenger = apply_tree_recipe(
                    source,
                    {"kind": kind, "seed": 42, "foliageCount": 96},
                    active_phase="form",
                )
                self.assertEqual(source, before)
                self.assertEqual([item["primitive"] for item in challenger["componentTree"]], [
                    "branch-network",
                    "instanced-cluster",
                ])
                self.assertNotIn("treeRecipe", challenger)
                errors, _ = validate_spec(challenger)
                self.assertEqual(errors, [])
                generated = generate(challenger, "form")
                self.assertIn("createBranchNetworkGeometry", generated)
                self.assertIn("createExtrudeGeometry", generated)
                self.assertIn("new THREE.InstancedMesh", generated)
                self.assertIn("vegetation", challenger["capabilityPlan"]["activePacks"])
                json.dumps(challenger, allow_nan=False)

    def test_apply_rejects_wrong_phase_and_authored_hierarchy(self) -> None:
        source = make_spec("Tree Study", None, complexity="simple")
        with self.assertRaisesRegex(ValueError, "only during Form"):
            apply_tree_recipe(source, {"kind": "conifer"}, active_phase="blockout")
        challenger = apply_tree_recipe(source, {"kind": "conifer"}, active_phase="form")
        with self.assertRaisesRegex(ValueError, "one-root Form scaffold"):
            apply_tree_recipe(challenger, {"kind": "conifer"}, active_phase="form")

    def test_declared_dimensions_cover_leaning_generated_geometry(self) -> None:
        challenger = apply_tree_recipe(
            make_spec("Leaning Pine", None, complexity="simple"),
            {"kind": "conifer", "lean": [0.25, -0.25], "foliageCount": 64},
            active_phase="form",
        )
        wood, foliage = challenger["componentTree"]
        nodes = wood["geometryDescriptor"]["parameters"]["nodes"]
        for axis, field in enumerate(("width", "height", "depth")):
            minimum = min(node["position"][axis] - node["radius"] for node in nodes)
            maximum = max(node["position"][axis] + node["radius"] for node in nodes)
            self.assertGreaterEqual(wood["dimensions"][field], maximum - minimum)
        instances = foliage["geometryDescriptor"]["parameters"]["instances"]
        for axis, field in enumerate(("width", "height", "depth")):
            span = max(item["position"][axis] for item in instances) - min(
                item["position"][axis] for item in instances
            )
            self.assertGreaterEqual(foliage["dimensions"][field], span)


if __name__ == "__main__":
    unittest.main()
