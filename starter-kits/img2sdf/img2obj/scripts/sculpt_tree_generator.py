#!/usr/bin/env python3
"""Compile a bounded tree recipe into existing ObjectSculptSpec primitives."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from sculpt_capabilities import synchronize_capability_plan
from sculpt_contract import load_spec_file, parse_json, pipeline_status, write_spec_atomic
from sculpt_geometry import MAX_BRANCH_NODES, MAX_INSTANCE_COUNT, validate_geometry_component


KINDS = {"broadleaf", "conifer"}
FIELDS = {
    "version", "kind", "seed", "height", "trunkRadius", "crownRadius",
    "crownStartRatio", "branchLevels", "branchCount", "rootCount",
    "foliageCount", "irregularity", "lean", "majorBranchAnchors",
}
ANCHOR_FIELDS = {"id", "heightRatio", "azimuth", "elevation", "lengthRatio"}
SEMANTIC_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
GOLDEN_ANGLE = math.pi * (3 - math.sqrt(5))


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _q(value: float) -> float:
    value = round(float(value), 6)
    return 0.0 if value == 0 else value


def _vec(value: list[float]) -> list[float]:
    return [_q(item) for item in value]


def _rand(seed: int, *keys: object) -> float:
    raw = "|".join([str(seed), *(str(key) for key in keys)]).encode()
    return int.from_bytes(hashlib.blake2s(raw, digest_size=8).digest(), "big") / (2**64 - 1)


def _signed(seed: int, *keys: object) -> float:
    return _rand(seed, *keys) * 2 - 1


def _bounded(
    source: Mapping[str, Any], key: str, default: float | int,
    low: float, high: float, errors: list[str], *, integer: bool = False,
) -> float | int:
    value = source.get(key, default)
    valid_type = (
        isinstance(value, int) and not isinstance(value, bool)
        if integer else _finite(value)
    )
    if not valid_type or not low <= float(value) <= high:
        kind = "integer" if integer else "finite number"
        errors.append(f"{key} must be a {kind} from {low} to {high}")
        return default
    return int(value) if integer else float(value)


def _trunk_segments(kind: str, branches: int) -> int:
    return 8 if kind == "broadleaf" else max(7, math.ceil(branches / 4) + 1)


def normalize_tree_recipe(recipe: Mapping[str, Any]) -> dict[str, Any]:
    """Reject unknown/unbounded input and return one canonical recipe."""

    if not isinstance(recipe, Mapping):
        raise ValueError("tree recipe must be a JSON object")
    errors: list[str] = []
    unknown = sorted(str(key) for key in recipe if key not in FIELDS)
    if unknown:
        errors.append("unsupported tree recipe fields: " + ", ".join(unknown))
    version = recipe.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        errors.append("version must be integer 1")
    kind = recipe.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        errors.append("kind must be broadleaf or conifer")
        kind = "broadleaf"
    defaults = {
        "broadleaf": (4.0, 0.32, 10, 5, 640, 0.18),
        "conifer": (5.0, 0.18, 20, 4, 900, 0.10),
    }[kind]
    default_height, default_crown_start, default_branches, default_roots, default_leaves, default_noise = defaults
    height = float(_bounded(recipe, "height", default_height, 0.1, 10_000, errors))
    normalized: dict[str, Any] = {
        "version": 1,
        "kind": kind,
        "seed": _bounded(recipe, "seed", 1, 1, 2_147_483_647, errors, integer=True),
        "height": height,
        "trunkRadius": _bounded(
            recipe, "trunkRadius", height * (0.05 if kind == "broadleaf" else 0.04),
            0.001, max(0.001, height * 0.2), errors,
        ),
        "crownRadius": _bounded(
            recipe, "crownRadius", height * (0.36 if kind == "broadleaf" else 0.28),
            0.01, height, errors,
        ),
        "crownStartRatio": _bounded(
            recipe, "crownStartRatio", default_crown_start, 0.1, 0.8, errors,
        ),
        "branchLevels": _bounded(recipe, "branchLevels", 2, 1, 3, errors, integer=True),
        "branchCount": _bounded(
            recipe, "branchCount", default_branches, 2, 32, errors, integer=True,
        ),
        "rootCount": _bounded(
            recipe, "rootCount", default_roots, 0, 12, errors, integer=True,
        ),
        "foliageCount": _bounded(
            recipe, "foliageCount", default_leaves, 1, MAX_INSTANCE_COUNT, errors, integer=True,
        ),
        "irregularity": _bounded(
            recipe, "irregularity", default_noise, 0, 0.35, errors,
        ),
    }
    lean = recipe.get("lean", [0.0, 0.0])
    if not (
        isinstance(lean, list) and len(lean) == 2
        and all(_finite(value) and abs(float(value)) <= 0.25 for value in lean)
    ):
        errors.append("lean must be [x, z] with each ratio from -0.25 to 0.25")
        lean = [0.0, 0.0]
    normalized["lean"] = [float(value) for value in lean]

    raw_anchors = recipe.get("majorBranchAnchors", [])
    anchors: list[dict[str, Any]] = []
    seen: set[str] = set()
    if not isinstance(raw_anchors, list) or len(raw_anchors) > 16:
        errors.append("majorBranchAnchors must be an array of at most 16 items")
        raw_anchors = []
    for index, raw in enumerate(raw_anchors):
        label = f"majorBranchAnchors[{index}]"
        if not isinstance(raw, Mapping):
            errors.append(f"{label} must be an object")
            continue
        missing_fields = sorted(ANCHOR_FIELDS - set(raw))
        if missing_fields:
            errors.append(f"{label} is missing required fields: " + ", ".join(missing_fields))
        extra = sorted(set(raw) - ANCHOR_FIELDS)
        if extra:
            errors.append(f"{label} has unsupported fields: " + ", ".join(extra))
        anchor_id = raw.get("id")
        if not isinstance(anchor_id, str) or not SEMANTIC_ID.fullmatch(anchor_id):
            errors.append(f"{label}.id must be semantic kebab-case")
            anchor_id = f"invalid-{index + 1}"
        if anchor_id in seen:
            errors.append(f"duplicate major branch anchor id {anchor_id!r}")
        seen.add(anchor_id)
        values = {
            "heightRatio": (float(normalized["crownStartRatio"]), 0.95),
            "azimuth": (-math.pi, math.pi),
            "elevation": (-math.pi / 3, math.pi / 2),
            "lengthRatio": (0.15, 1.0),
        }
        anchor: dict[str, Any] = {"id": anchor_id}
        for key, (low, high) in values.items():
            anchor[key] = _bounded(raw, key, low, low, high, errors)
        anchors.append(anchor)
    if len(anchors) > int(normalized["branchCount"]):
        errors.append("majorBranchAnchors count must not exceed branchCount")
    normalized["majorBranchAnchors"] = sorted(anchors, key=lambda item: item["id"])
    branch_nodes = int(normalized["branchCount"]) * (2 ** int(normalized["branchLevels"]) - 1)
    estimated = (
        1 + _trunk_segments(kind, int(normalized["branchCount"]))
        + int(normalized["rootCount"]) + branch_nodes
    )
    if estimated > MAX_BRANCH_NODES:
        errors.append(
            f"recipe would emit {estimated} branch nodes; maximum is {MAX_BRANCH_NODES}; "
            "reduce branchCount or branchLevels"
        )
    if errors:
        raise ValueError("; ".join(errors))
    return normalized


def validate_tree_recipe(recipe: Mapping[str, Any]) -> list[str]:
    try:
        normalize_tree_recipe(recipe)
        return []
    except ValueError as exc:
        return [str(exc)]


def _add(a: list[float], b: list[float]) -> list[float]:
    return [a[index] + b[index] for index in range(3)]


def _lerp(a: list[float], b: list[float], amount: float) -> list[float]:
    return [a[index] + (b[index] - a[index]) * amount for index in range(3)]


def _polar(angle: float, elevation: float, length: float) -> list[float]:
    horizontal = math.cos(elevation) * length
    return [math.cos(angle) * horizontal, math.sin(elevation) * length, math.sin(angle) * horizontal]


def _generate(recipe: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    kind, seed = str(recipe["kind"]), int(recipe["seed"])
    height, trunk_radius = float(recipe["height"]), float(recipe["trunkRadius"])
    crown_radius, crown_start = float(recipe["crownRadius"]), float(recipe["crownStartRatio"])
    count, levels = int(recipe["branchCount"]), int(recipe["branchLevels"])
    noise = float(recipe["irregularity"])
    lean_x, lean_z = (float(value) for value in recipe["lean"])
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    node_by_id: dict[str, dict[str, Any]] = {}

    def node(node_id: str, position: list[float], radius: float) -> None:
        item = {"id": node_id, "position": _vec(position), "radius": _q(radius)}
        nodes.append(item)
        node_by_id[node_id] = item

    def edge(parent: str, child: str, controls: list[list[float]] | None = None) -> None:
        edges.append({"from": parent, "to": child, "controlPoints": [_vec(item) for item in controls or []]})

    node("trunk-base", [0, 0, 0], trunk_radius)
    root_length = min(crown_radius * 0.42, height * 0.28)
    for index in range(int(recipe["rootCount"])):
        angle = index * GOLDEN_ANGLE + _signed(seed, "root-angle", index) * noise
        length = root_length * (0.72 + 0.28 * _rand(seed, "root-length", index))
        end = [
            math.cos(angle) * length,
            -height * (0.015 + 0.025 * _rand(seed, "root-depth", index)),
            math.sin(angle) * length,
        ]
        child = f"root-buttress-{index + 1:02d}"
        node(child, end, trunk_radius * (0.28 + 0.08 * _rand(seed, "root-radius", index)))
        edge("trunk-base", child, [[end[0] * 0.45, -height * 0.008, end[2] * 0.45]])

    trunk_ids = ["trunk-base"]
    trunk_count = _trunk_segments(kind, count)
    for index in range(1, trunk_count + 1):
        ratio = index / trunk_count
        child = f"trunk-leader-{index:02d}"
        node(
            child,
            [height * lean_x * ratio**2, height * ratio, height * lean_z * ratio**2],
            max(trunk_radius * 0.12, trunk_radius * (1 - 0.82 * ratio) ** 0.72),
        )
        edge(trunk_ids[-1], child)
        trunk_ids.append(child)

    records: list[dict[str, Any]] = []

    def limit_to_crown(position: list[float]) -> list[float]:
        position[1] = min(height * 0.995, max(0.0, position[1]))
        ratio = position[1] / height
        center_x, center_z = height * lean_x * ratio**2, height * lean_z * ratio**2
        if kind == "broadleaf":
            center, half = (crown_start + 1) / 2, max(0.01, (1 - crown_start) / 2)
            maximum = crown_radius * math.sqrt(
                max(0.08, 1 - ((ratio - center) / half) ** 2)
            )
        else:
            crown_ratio = min(1.0, max(0.0, (ratio - crown_start) / max(0.01, 0.9 - crown_start)))
            maximum = crown_radius * max(0.20, 1 - 0.8 * crown_ratio)
        delta_x, delta_z = position[0] - center_x, position[2] - center_z
        distance = math.hypot(delta_x, delta_z)
        if distance > maximum:
            scale = maximum / distance
            position[0], position[2] = center_x + delta_x * scale, center_z + delta_z * scale
        return position

    def branch(
        child: str, parent: str, angle: float, elevation: float, length: float,
        radius: float, level: int, droop: float,
    ) -> dict[str, Any]:
        start = list(node_by_id[parent]["position"])
        end = limit_to_crown(_add(start, _polar(angle, elevation, length)))
        node(child, end, radius)
        control = _lerp(start, end, 0.5)
        control[1] += length * droop
        edge(parent, child, [control])
        item = {
            "id": child, "start": start, "end": end, "angle": angle,
            "elevation": elevation, "length": length, "radius": radius, "level": level,
        }
        records.append(item)
        return item

    anchors = list(recipe["majorBranchAnchors"])
    free_count = count - len(anchors)
    whorls = max(1, math.ceil(max(1, free_count) / 4))
    frontier: list[dict[str, Any]] = []
    for index in range(count):
        anchor = anchors[index] if index < len(anchors) else None
        free_index = index - len(anchors)
        if anchor:
            ratio = float(anchor["heightRatio"])
            angle, elevation = float(anchor["azimuth"]), float(anchor["elevation"])
            length = crown_radius * float(anchor["lengthRatio"])
            child = f"signature-{anchor['id']}"
        elif kind == "broadleaf":
            fraction = (free_index + 0.5) / max(1, free_count)
            ratio = crown_start + (0.88 - crown_start) * fraction
            center, half = (crown_start + 1) / 2, max(0.01, (1 - crown_start) / 2)
            envelope = math.sqrt(max(0.08, 1 - ((ratio - center) / half) ** 2))
            angle = index * GOLDEN_ANGLE + _signed(seed, "primary-angle", index) * noise * 0.8
            elevation = 0.10 + 0.24 * envelope + _signed(seed, "primary-up", index) * noise * 0.35
            length = crown_radius * (0.52 + 0.28 * envelope) * (
                1 + _signed(seed, "primary-length", index) * noise
            )
            child = f"crown-branch-{index + 1:02d}-l1"
        else:
            whorl, member = divmod(free_index, 4)
            whorl_size = min(4, max(1, free_count - whorl * 4))
            fraction = whorl / max(1, whorls - 1)
            ratio = crown_start + (0.88 - crown_start) * fraction
            angle = member * math.tau / whorl_size + whorl * GOLDEN_ANGLE * 0.35
            angle += _signed(seed, "primary-angle", index) * noise * 0.5
            elevation = -0.18 + 0.38 * fraction
            length = crown_radius * max(0.22, 1 - 0.74 * fraction) * (
                1 + _signed(seed, "primary-length", index) * noise
            )
            child = f"whorl-branch-{index + 1:02d}-l1"
        parent_index = min(trunk_count - 1, max(1, round(ratio * trunk_count)))
        parent = trunk_ids[parent_index]
        radius = max(trunk_radius * 0.035, min(float(node_by_id[parent]["radius"]) * 0.42, trunk_radius * 0.34))
        frontier.append(branch(child, parent, angle, elevation, length, radius, 1, 0.10 if kind == "broadleaf" else -0.06))

    for level in range(2, levels + 1):
        next_frontier: list[dict[str, Any]] = []
        for parent in frontier:
            for child_index, sign in enumerate((-1, 1)):
                key = f"{parent['id']}:{child_index}"
                angle = float(parent["angle"]) + sign * (0.42 + 0.22 * _rand(seed, "fork", key))
                angle += _signed(seed, "fork-angle", key) * noise * 0.4
                elevation = min(0.95, max(-0.2, float(parent["elevation"]) + (0.14 if kind == "broadleaf" else 0.22) + _signed(seed, "fork-up", key) * noise * 0.45))
                length = float(parent["length"]) * (0.50 + 0.10 * _rand(seed, "fork-length", key))
                radius = min(float(parent["radius"]) * 0.9, max(trunk_radius * 0.01, float(parent["radius"]) * 0.56))
                child = f"crown-twig-l{level}-{len(next_frontier) + 1:03d}"
                next_frontier.append(branch(child, str(parent["id"]), angle, elevation, length, radius, level, 0.07))
        frontier = next_frontier

    sites: list[tuple[list[float], float, float]] = []
    if kind == "broadleaf":
        sites = [(list(item["end"]), float(item["angle"]), float(item["elevation"])) for item in frontier]
    else:
        for item in records:
            for amount in (0.52, 0.76, 0.96):
                sites.append((_lerp(item["start"], item["end"], amount), float(item["angle"]), float(item["elevation"])))
    leaf_size = height * (0.032 if kind == "broadleaf" else 0.018)
    instances: list[dict[str, Any]] = []
    for index in range(int(recipe["foliageCount"])):
        site, angle, elevation = sites[index % len(sites)]
        jitter = leaf_size * (1.0 if kind == "broadleaf" else 0.45)
        position = [site[axis] + _signed(seed, f"leaf-{axis}", index) * jitter for axis in range(3)]
        scale = 0.72 + 0.5 * _rand(seed, "leaf-scale", index)
        instances.append({
            "position": _vec(position),
            "rotation": _vec([
                elevation + _signed(seed, "leaf-x", index) * (0.75 if kind == "broadleaf" else 0.32),
                angle + _signed(seed, "leaf-y", index) * (math.pi if kind == "broadleaf" else 0.45),
                _signed(seed, "leaf-z", index) * (math.pi if kind == "broadleaf" else 0.35),
            ]),
            "scale": _vec([scale * (0.8 if kind == "broadleaf" else 0.42), scale * (1 if kind == "broadleaf" else 1.45), 1]),
        })
    return ({
        "representation": "branch-graph", "nodes": nodes, "edges": edges,
        "radialSegments": 8 if kind == "broadleaf" else 7,
        "segmentsPerEdge": 5, "junctionSegments": 6, "capEnds": True,
    }, instances)


def generate_tree_geometry(recipe: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return deterministic branch-network parameters and explicit foliage transforms."""

    return _generate(normalize_tree_recipe(recipe))


def _evidence(spec: Mapping[str, Any], root: Mapping[str, Any]) -> list[str]:
    refs = root.get("evidenceRefs")
    if isinstance(refs, list) and refs:
        return [str(value) for value in refs if isinstance(value, str) and value]
    for item in spec.get("viewEvidence", []):
        if isinstance(item, Mapping) and isinstance(item.get("id"), str):
            return [item["id"]]
    return ["full-object"]


def _part_base(component_id: str, name: str, parent: str, material: str, evidence: list[str]) -> dict[str, Any]:
    return {
        "id": component_id, "name": name, "componentType": "part", "level": "meso",
        "role": "foliage canopy", "importance": 0.88, "confidence": 0.65,
        "parent": parent, "attachment": None,
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]},
        "actionProfile": {
            "animationRole": "static",
            "transformChannels": {"translate": True, "rotate": True, "scale": True, "visibility": True},
            "sockets": [], "constraints": [],
        },
        "material": material, "materialLayers": [material],
        "deformations": [], "joints": [], "seams": [], "localFeatures": [],
        "surfaceDetail": {
            "macroRoughness": 0.08, "microRoughness": 0.12, "bumpAmplitude": 0,
            "normalPattern": "leaf response belongs to the assigned Lookdev material",
        },
        "evidenceRefs": evidence, "details": [], "fidelityTier": "form",
    }


def _dimensions_from_geometry(
    branches: Mapping[str, Any],
    leaves: list[Mapping[str, Any]],
    leaf_size: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    node_map = {
        str(item["id"]): item
        for item in branches["nodes"]
        if isinstance(item, Mapping)
    }
    woody_samples: list[tuple[list[float], float]] = [
        ([float(value) for value in item["position"]], float(item["radius"]))
        for item in node_map.values()
    ]
    for edge in branches["edges"]:
        radius = max(
            float(node_map[str(edge["from"])]["radius"]),
            float(node_map[str(edge["to"])]["radius"]),
        )
        woody_samples.extend(
            ([float(value) for value in point], radius)
            for point in edge.get("controlPoints", [])
        )

    def extents(samples: list[tuple[list[float], float]], confidence: float) -> dict[str, Any]:
        minimum = [min(point[axis] - padding for point, padding in samples) for axis in range(3)]
        maximum = [max(point[axis] + padding for point, padding in samples) for axis in range(3)]
        return {
            "width": _q(maximum[0] - minimum[0]),
            "height": _q(maximum[1] - minimum[1]),
            "depth": _q(maximum[2] - minimum[2]),
            "units": "relative",
            "confidence": confidence,
        }

    foliage_samples = [
        (
            [float(value) for value in item["position"]],
            leaf_size * 1.1 * max(float(value) for value in item["scale"]),
        )
        for item in leaves
    ]
    return extents(woody_samples, 0.65), extents(foliage_samples, 0.6)


def apply_tree_recipe(
    spec: Mapping[str, Any], recipe: Mapping[str, Any], *, wood_material: str = "base",
    foliage_material: str = "base", active_phase: str | None = None,
) -> dict[str, Any]:
    """One-shot Form compiler. The input spec is never mutated."""

    normalized = normalize_tree_recipe(recipe)
    phase = active_phase or str(pipeline_status(dict(spec)).get("currentPass") or "")
    if phase != "form":
        raise ValueError(f"tree recipes may be expanded only during Form; current pass is {phase!r}")
    if not str(spec.get("schemaVersion", "")).startswith("3."):
        raise ValueError("tree expansion currently supports monolithic schema 3.x specs only")
    components = spec.get("componentTree")
    if not isinstance(components, list) or len(components) != 1:
        raise ValueError("tree expansion requires the one-root Form scaffold; authored hierarchies are not replaced")
    source_root = components[0]
    if not isinstance(source_root, Mapping) or source_root.get("id") != "root" or source_root.get("parent") is not None:
        raise ValueError("tree expansion requires one geometry root with id 'root' and parent null")
    if spec.get("repetitionSystems") not in (None, []):
        raise ValueError("tree expansion requires an empty repetitionSystems scaffold")
    material_ids = {
        item.get("id") for item in spec.get("materials", []) if isinstance(item, Mapping)
    }
    missing = [value for value in (wood_material, foliage_material) if value not in material_ids]
    if missing:
        raise ValueError("unknown tree material id(s): " + ", ".join(dict.fromkeys(missing)))
    assumption_id, leaf_id = "generated-tree-hidden-branching", "tree-foliage-crown"
    if any(isinstance(item, Mapping) and item.get("id") == assumption_id for item in spec.get("assumptions", [])):
        raise ValueError(f"assumption id collision: {assumption_id!r}")

    branches, leaves = _generate(normalized)
    challenger = copy.deepcopy(dict(spec))
    root = challenger["componentTree"][0]
    evidence = _evidence(spec, source_root)
    height = float(normalized["height"])
    leaf_size = height * (0.032 if normalized["kind"] == "broadleaf" else 0.018)
    woody_dimensions, foliage_dimensions = _dimensions_from_geometry(
        branches, leaves, leaf_size
    )
    root.update({
        "role": "woody branching structure", "primitive": "branch-network",
        "geometryDescriptor": {
            "parameters": branches,
            "topologyIntent": "rooted tube graph with intentional overlapping junctions; not a fused hero mesh",
            "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1},
            "deformationStack": [], "uvStrategy": "generated branch-local coordinates",
            "normalStrategy": "generated tube and junction normals",
        },
        "dimensions": woody_dimensions,
        "material": wood_material, "materialLayers": [wood_material], "fidelityTier": "form",
        "detailPlan": {
            "status": "planned", "observedComplexity": "complex", "decompositionMode": "children",
            "atomicityReason": "", "childComponentIds": [leaf_id], "features": [],
            "evidenceRefs": evidence,
            "coverageNotes": "The branch graph covers roots, trunk taper, branches, and twigs; foliage is a separate direct child.",
        },
    })
    leaf_outline = (
        [
            [0, -leaf_size * 0.55], [leaf_size * 0.28, -leaf_size * 0.1],
            [leaf_size * 0.4, leaf_size * 0.1], [leaf_size * 0.18, leaf_size * 0.38],
            [0, leaf_size * 0.55], [-leaf_size * 0.18, leaf_size * 0.38],
            [-leaf_size * 0.4, leaf_size * 0.1], [-leaf_size * 0.28, -leaf_size * 0.1],
        ]
        if normalized["kind"] == "broadleaf"
        else [
            [0, -leaf_size], [leaf_size * 0.18, 0],
            [0, leaf_size], [-leaf_size * 0.18, 0],
        ]
    )
    foliage = _part_base(leaf_id, "Tree foliage crown", "root", foliage_material, evidence)
    foliage.update({
        "primitive": "instanced-cluster",
        "geometryDescriptor": {
            "parameters": {
                "basePrimitive": "extrude",
                "baseParameters": {
                    "shape": leaf_outline, "holes": [], "depth": leaf_size * 0.04,
                    "steps": 1, "bevelEnabled": False, "bevelThickness": 0,
                    "bevelSize": 0, "bevelOffset": 0, "bevelSegments": 1,
                },
                "instances": leaves,
            },
            "topologyIntent": "bounded explicit leaf or needle-spray contours",
            "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1},
            "deformationStack": [], "uvStrategy": "generated extrude UVs",
            "normalStrategy": "instance-transformed contour normals",
        },
        "dimensions": foliage_dimensions,
        "detailPlan": {
            "status": "planned", "observedComplexity": "simple", "decompositionMode": "atomic",
            "atomicityReason": "The crown is one bounded instance system; contours are repetitions, not unique parts.",
            "childComponentIds": [], "features": [], "evidenceRefs": evidence,
            "coverageNotes": "Crown envelope, distal distribution, orientation, and density are explicit in the instances.",
        },
    })
    challenger["componentTree"].append(foliage)
    detail_contract = challenger.get("detailDecompositionContract")
    if not isinstance(detail_contract, dict):
        raise ValueError("detailDecompositionContract must be an object")
    detail_contract["status"] = "planned"
    challenger["surfaceTopologyPlan"] = {
        "status": "planned",
        "reason": "The tree uses one woody graph plus a separate repeated foliage system.",
        "decisionRule": "Keep graph junctions as intentional overlaps and foliage contours separate.",
        "groups": [{
            "id": "tree-growth-assembled-surfaces", "strategy": "assembled-solid",
            "regions": ["roots", "trunk", "branches", "foliage crown"],
            "componentRefs": ["root", leaf_id],
            "materialRefs": list(dict.fromkeys([wood_material, foliage_material])),
            "requiredTopology": "intentional-separate-parts",
            "separationReason": "Branch tubes overlap at junctions and foliage remains instanced contours; neither is fused hero topology.",
            "rationale": "The assembly preserves editable branch structure and efficient foliage repetition.",
            "evidenceRefs": evidence, "confidence": 0.7,
        }],
    }
    for field in ("featureReviewTargets", "buildPasses"):
        for item in challenger.get(field, []):
            refs = item.get("componentRefs") if isinstance(item, dict) else None
            if isinstance(refs, list) and "root" in refs and leaf_id not in refs:
                refs.append(leaf_id)
    challenger.setdefault("assumptions", []).append({
        "id": assumption_id,
        "statement": f"Hidden growth follows the {normalized['kind']} archetype where the source does not prove structure.",
        "scope": "occluded roots, branches, twigs, and foliage",
        "bounds": "Only the recipe, signature anchors, registry limits, and visible crown envelope define hidden growth.",
        "impactIfWrong": "Side or turnaround views may expose an incorrect signature branch or crown distribution.",
        "falsifyingCheck": "Compare front, side, and three-quarter silhouettes; revise majorBranchAnchors on disagreement.",
        "evidenceRefs": evidence,
    })
    revision = challenger.get("specRevision", 0)
    challenger["specRevision"] = revision + 1 if isinstance(revision, int) else 1
    synchronize_capability_plan(challenger, "form")
    challenger["sculptPipeline"] = pipeline_status(challenger)

    lookup = {item["id"]: item for item in challenger["componentTree"] if isinstance(item, dict)}
    geometry_errors = [
        error for item in challenger["componentTree"] if isinstance(item, dict)
        for error in validate_geometry_component(item, challenger.get("repetitionSystems", []), lookup)
    ]
    if geometry_errors:
        raise ValueError("generated tree geometry is invalid: " + "; ".join(geometry_errors))
    from validate_sculpt_spec import validate_spec
    errors, _ = validate_spec(challenger)
    if errors:
        raise ValueError("generated tree challenger is invalid: " + "; ".join(errors))
    return challenger


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--wood-material", default="base")
    parser.add_argument("--foliage-material", default="base")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    source, output = args.spec.expanduser().resolve(), args.out.expanduser().resolve()
    if source == output:
        raise ValueError("--out must be a separate challenger path; champion mutation is forbidden")
    if output.exists():
        raise ValueError(f"--out already exists: {output}")
    recipe = parse_json(
        args.recipe.expanduser().resolve().read_text(encoding="utf-8"),
        "tree recipe JSON",
    )
    spec = load_spec_file(source)
    challenger = apply_tree_recipe(
        spec, recipe, wood_material=args.wood_material, foliage_material=args.foliage_material,
        active_phase=str(pipeline_status(spec).get("currentPass") or ""),
    )
    write_spec_atomic(output, challenger)
    branch_data = challenger["componentTree"][0]["geometryDescriptor"]["parameters"]
    leaf_data = challenger["componentTree"][1]["geometryDescriptor"]["parameters"]
    print(json.dumps({
        "ok": True, "output": str(output), "kind": normalize_tree_recipe(recipe)["kind"],
        "branchNodes": len(branch_data["nodes"]), "foliageInstances": len(leaf_data["instances"]),
        "challengerOnly": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
