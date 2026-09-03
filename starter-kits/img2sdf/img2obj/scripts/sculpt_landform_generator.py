#!/usr/bin/env python3
"""Compile a bounded landform recipe into existing ObjectSculptSpec primitives."""

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
from sculpt_geometry import (
    MAX_DEFORMABLE_CONTROL_POINTS,
    MAX_DEFORMABLE_SAMPLED_VERTICES,
    MAX_INSTANCE_COUNT,
    MAX_SCULPT_FIELD_EVALUATIONS,
    MAX_SCULPT_MODIFIERS,
    MAX_SCULPT_SOURCES,
    validate_geometry_component,
)


KINDS = {"terrain", "boulder", "cliff"}
PROFILES = {
    "terrain": {"rolling", "ridged", "terraced"},
    "boulder": {"rounded", "angular", "layered"},
    "cliff": {"weathered", "layered"},
}
FIELDS = {
    "version",
    "kind",
    "seed",
    "size",
    "profile",
    "roughness",
    "gridSize",
    "segments",
    "octaves",
    "ridgeMix",
    "terraceSteps",
    "relaxationPasses",
    "edgeFalloff",
    "rockCount",
    "rockScaleRange",
    "rockMinSpacingRatio",
    "maxRockSlope",
    "terrainAnchors",
    "sourceCount",
    "strataCount",
    "fractureStrength",
    "resolution",
    "rockAnchors",
}
TERRAIN_FIELDS = {
    "gridSize",
    "segments",
    "octaves",
    "ridgeMix",
    "terraceSteps",
    "relaxationPasses",
    "edgeFalloff",
    "rockCount",
    "rockScaleRange",
    "rockMinSpacingRatio",
    "maxRockSlope",
    "terrainAnchors",
}
ROCK_FIELDS = {
    "sourceCount",
    "strataCount",
    "fractureStrength",
    "resolution",
    "rockAnchors",
}
TERRAIN_ANCHOR_FIELDS = {
    "id", "type", "position", "radius", "strength", "angle", "length",
}
ROCK_ANCHOR_FIELDS = {"id", "position", "radii", "strength"}
SEMANTIC_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _q(value: float) -> float:
    result = round(float(value), 6)
    return 0.0 if result == 0 else result


def _vec(values: list[float]) -> list[float]:
    return [_q(value) for value in values]


def _rand(seed: int, *keys: object) -> float:
    raw = "|".join([str(seed), *(str(key) for key in keys)]).encode()
    return int.from_bytes(hashlib.blake2s(raw, digest_size=8).digest(), "big") / (
        2**64 - 1
    )


def _signed(seed: int, *keys: object) -> float:
    return _rand(seed, *keys) * 2 - 1


def _bounded(
    source: Mapping[str, Any],
    key: str,
    default: float | int,
    low: float,
    high: float,
    errors: list[str],
    *,
    integer: bool = False,
) -> float | int:
    value = source.get(key, default)
    valid = (
        isinstance(value, int) and not isinstance(value, bool)
        if integer
        else _finite(value)
    )
    if not valid or not low <= float(value) <= high:
        value_type = "integer" if integer else "finite number"
        errors.append(f"{key} must be a {value_type} from {low} to {high}")
        return default
    return int(value) if integer else float(value)


def _vector(
    source: Mapping[str, Any],
    key: str,
    default: list[float],
    errors: list[str],
    *,
    minimum: float,
    maximum: float,
) -> list[float]:
    value = source.get(key, default)
    if not (
        isinstance(value, list)
        and len(value) == len(default)
        and all(_finite(item) and minimum <= float(item) <= maximum for item in value)
    ):
        errors.append(
            f"{key} must contain {len(default)} finite numbers from {minimum} to {maximum}"
        )
        return list(default)
    return [float(item) for item in value]


def _normalize_terrain_anchors(value: Any, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 16:
        errors.append("terrainAnchors must be an array of at most 16 items")
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        label = f"terrainAnchors[{index}]"
        if not isinstance(raw, Mapping):
            errors.append(f"{label} must be an object")
            continue
        extra = sorted(set(raw) - TERRAIN_ANCHOR_FIELDS)
        if extra:
            errors.append(f"{label} has unsupported fields: " + ", ".join(extra))
        anchor_id = raw.get("id")
        if not isinstance(anchor_id, str) or not SEMANTIC_ID.fullmatch(anchor_id):
            errors.append(f"{label}.id must be semantic kebab-case")
            anchor_id = f"invalid-{index + 1}"
        if anchor_id in seen:
            errors.append(f"duplicate terrain anchor id {anchor_id!r}")
        seen.add(anchor_id)
        anchor_type = raw.get("type")
        if anchor_type not in {"peak", "valley", "plateau", "ridge"}:
            errors.append(f"{label}.type must be peak, valley, plateau, or ridge")
            anchor_type = "peak"
        position = raw.get("position")
        if not (
            isinstance(position, list)
            and len(position) == 2
            and all(_finite(item) and -1 <= float(item) <= 1 for item in position)
        ):
            errors.append(f"{label}.position must be 2 finite numbers from -1 to 1")
            position = [0.0, 0.0]
        anchor = {
            "id": anchor_id,
            "type": anchor_type,
            "position": [float(item) for item in position],
            "radius": _bounded(raw, "radius", 0.25, 0.03, 1.0, errors),
            "strength": _bounded(raw, "strength", 0.7, -1.0, 1.0, errors),
            "angle": _bounded(raw, "angle", 0.0, -math.pi, math.pi, errors),
            "length": _bounded(raw, "length", 0.5, 0.05, 2.0, errors),
        }
        if anchor_type in {"peak", "ridge"} and float(anchor["strength"]) <= 0:
            errors.append(f"{label}.strength must be positive for {anchor_type}")
        if anchor_type == "valley" and float(anchor["strength"]) >= 0:
            errors.append(f"{label}.strength must be negative for valley")
        result.append(anchor)
    return sorted(result, key=lambda item: item["id"])


def _normalize_rock_anchors(value: Any, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 12:
        errors.append("rockAnchors must be an array of at most 12 items")
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        label = f"rockAnchors[{index}]"
        if not isinstance(raw, Mapping):
            errors.append(f"{label} must be an object")
            continue
        extra = sorted(set(raw) - ROCK_ANCHOR_FIELDS)
        if extra:
            errors.append(f"{label} has unsupported fields: " + ", ".join(extra))
        anchor_id = raw.get("id")
        if not isinstance(anchor_id, str) or not SEMANTIC_ID.fullmatch(anchor_id):
            errors.append(f"{label}.id must be semantic kebab-case")
            anchor_id = f"invalid-{index + 1}"
        if anchor_id in seen:
            errors.append(f"duplicate rock anchor id {anchor_id!r}")
        seen.add(anchor_id)
        position = raw.get("position")
        if not (
            isinstance(position, list)
            and len(position) == 3
            and all(_finite(item) and -0.5 <= float(item) <= 0.5 for item in position)
        ):
            errors.append(f"{label}.position must be 3 finite ratios from -0.5 to 0.5")
            position = [0.0, 0.0, 0.0]
        radii = raw.get("radii")
        if not (
            isinstance(radii, list)
            and len(radii) == 3
            and all(_finite(item) and 0.04 <= float(item) <= 0.5 for item in radii)
        ):
            errors.append(f"{label}.radii must be 3 finite ratios from 0.04 to 0.5")
            radii = [0.2, 0.2, 0.2]
        result.append({
            "id": anchor_id,
            "position": [float(item) for item in position],
            "radii": [float(item) for item in radii],
            "strength": _bounded(raw, "strength", 0.6, 0.1, 2.0, errors),
        })
    return sorted(result, key=lambda item: item["id"])


def normalize_landform_recipe(recipe: Mapping[str, Any]) -> dict[str, Any]:
    """Reject unknown or unbounded input and return one canonical recipe."""

    if not isinstance(recipe, Mapping):
        raise ValueError("landform recipe must be a JSON object")
    errors: list[str] = []
    unknown = sorted(str(key) for key in recipe if key not in FIELDS)
    if unknown:
        errors.append("unsupported landform recipe fields: " + ", ".join(unknown))
    version = recipe.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        errors.append("version must be integer 1")
    kind = recipe.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        errors.append("kind must be terrain, boulder, or cliff")
        kind = "terrain"
    wrong_fields = sorted(
        (ROCK_FIELDS if kind == "terrain" else TERRAIN_FIELDS) & set(recipe)
    )
    if wrong_fields:
        errors.append(
            f"{kind} recipe contains fields owned by another kind: "
            + ", ".join(wrong_fields)
        )
    default_sizes = {
        "terrain": [6.0, 1.5, 6.0],
        "boulder": [1.8, 1.3, 1.5],
        "cliff": [3.0, 4.0, 1.6],
    }
    size = _vector(
        recipe, "size", default_sizes[kind], errors, minimum=0.01, maximum=10_000
    )
    default_profiles = {"terrain": "rolling", "boulder": "rounded", "cliff": "weathered"}
    profile = recipe.get("profile", default_profiles[kind])
    if not isinstance(profile, str) or profile not in PROFILES[kind]:
        errors.append(
            f"profile for {kind} must be one of: " + ", ".join(sorted(PROFILES[kind]))
        )
        profile = default_profiles[kind]
    normalized: dict[str, Any] = {
        "version": 1,
        "kind": kind,
        "seed": _bounded(
            recipe, "seed", 1, 1, 2_147_483_647, errors, integer=True
        ),
        "size": size,
        "profile": profile,
        "roughness": _bounded(recipe, "roughness", 0.35, 0.0, 1.0, errors),
    }
    if kind == "terrain":
        profile_defaults = {
            "rolling": (0.12, 0),
            "ridged": (0.72, 0),
            "terraced": (0.38, 7),
        }[profile]
        ridge_default, terrace_default = profile_defaults
        minimum_rock = min(size[0], size[2]) * 0.025
        maximum_rock = min(size[0], size[2]) * 0.10
        scale_range = recipe.get("rockScaleRange", [minimum_rock, maximum_rock])
        if not (
            isinstance(scale_range, list)
            and len(scale_range) == 2
            and all(_finite(item) and 0.001 <= float(item) <= min(size[0], size[2]) for item in scale_range)
            and float(scale_range[0]) <= float(scale_range[1])
        ):
            errors.append(
                "rockScaleRange must be two ascending positive sizes bounded by the terrain"
            )
            scale_range = [minimum_rock, maximum_rock]
        normalized.update({
            "gridSize": _bounded(recipe, "gridSize", 13, 4, 16, errors, integer=True),
            "segments": _bounded(recipe, "segments", 96, 4, 128, errors, integer=True),
            "octaves": _bounded(recipe, "octaves", 4, 1, 6, errors, integer=True),
            "ridgeMix": _bounded(recipe, "ridgeMix", ridge_default, 0.0, 1.0, errors),
            "terraceSteps": _bounded(
                recipe, "terraceSteps", terrace_default, 0, 32, errors, integer=True
            ),
            "relaxationPasses": _bounded(
                recipe, "relaxationPasses", 3, 0, 16, errors, integer=True
            ),
            "edgeFalloff": _bounded(recipe, "edgeFalloff", 0.12, 0.0, 0.49, errors),
            "rockCount": _bounded(
                recipe,
                "rockCount",
                0,
                0,
                min(2_048, MAX_INSTANCE_COUNT),
                errors,
                integer=True,
            ),
            "rockScaleRange": [float(item) for item in scale_range],
            "rockMinSpacingRatio": _bounded(
                recipe, "rockMinSpacingRatio", 0.018, 0.0, 0.25, errors
            ),
            "maxRockSlope": _bounded(recipe, "maxRockSlope", 1.5, 0.0, 8.0, errors),
            "terrainAnchors": _normalize_terrain_anchors(
                recipe.get("terrainAnchors", []), errors
            ),
        })
        grid_size = int(normalized["gridSize"])
        if grid_size * grid_size > MAX_DEFORMABLE_CONTROL_POINTS:
            errors.append(
                f"gridSize would emit {grid_size * grid_size} control points; "
                f"maximum is {MAX_DEFORMABLE_CONTROL_POINTS}"
            )
        segments = int(normalized["segments"])
        if (segments + 1) ** 2 > MAX_DEFORMABLE_SAMPLED_VERTICES:
            errors.append(
                f"segments would emit {(segments + 1) ** 2} vertices; "
                f"maximum is {MAX_DEFORMABLE_SAMPLED_VERTICES}"
            )
    else:
        default_strata = 5 if profile == "layered" else 0
        normalized.update({
            "sourceCount": _bounded(
                recipe, "sourceCount", 5, 1, 12, errors, integer=True
            ),
            "strataCount": _bounded(
                recipe,
                "strataCount",
                default_strata,
                0,
                12,
                errors,
                integer=True,
            ),
            "fractureStrength": _bounded(
                recipe, "fractureStrength", 0.08, 0.0, 0.25, errors
            ),
            "resolution": _bounded(
                recipe, "resolution", 32, 16, 40, errors, integer=True
            ),
            "rockAnchors": _normalize_rock_anchors(
                recipe.get("rockAnchors", []), errors
            ),
        })
        term_count = (
            int(normalized["sourceCount"])
            + len(normalized["rockAnchors"])
            + int(normalized["strataCount"])
            + (2 if float(normalized["fractureStrength"]) > 0 else 0)
        )
        if int(normalized["sourceCount"]) + len(normalized["rockAnchors"]) > MAX_SCULPT_SOURCES:
            errors.append(f"rock recipe exceeds {MAX_SCULPT_SOURCES} sculpt sources")
        modifier_count = int(normalized["strataCount"]) + (
            2 if float(normalized["fractureStrength"]) > 0 else 0
        )
        if modifier_count > MAX_SCULPT_MODIFIERS:
            errors.append(f"rock recipe exceeds {MAX_SCULPT_MODIFIERS} sculpt modifiers")
        if int(normalized["resolution"]) ** 3 * term_count > MAX_SCULPT_FIELD_EVALUATIONS:
            errors.append(
                f"rock field workload exceeds {MAX_SCULPT_FIELD_EVALUATIONS} sample-term evaluations"
            )
    if errors:
        raise ValueError("; ".join(errors))
    return normalized


def validate_landform_recipe(recipe: Mapping[str, Any]) -> list[str]:
    try:
        normalize_landform_recipe(recipe)
        return []
    except ValueError as exc:
        return [str(exc)]


def _smooth(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def _value_noise(seed: int, x: float, z: float) -> float:
    x0, z0 = math.floor(x), math.floor(z)
    tx, tz = _smooth(x - x0), _smooth(z - z0)
    top = (
        _rand(seed, "terrain-noise", x0, z0) * (1 - tx)
        + _rand(seed, "terrain-noise", x0 + 1, z0) * tx
    )
    bottom = (
        _rand(seed, "terrain-noise", x0, z0 + 1) * (1 - tx)
        + _rand(seed, "terrain-noise", x0 + 1, z0 + 1) * tx
    )
    return top * (1 - tz) + bottom * tz


def _fbm(recipe: Mapping[str, Any], x: float, z: float) -> float:
    seed = int(recipe["seed"])
    amplitude, total, value = 1.0, 0.0, 0.0
    persistence = 0.43 + float(recipe["roughness"]) * 0.22
    ridge_mix = float(recipe["ridgeMix"])
    for octave in range(int(recipe["octaves"])):
        frequency = 1.35 * (2**octave)
        noise = _value_noise(seed + octave * 1009, x * frequency, z * frequency)
        signed = noise * 2 - 1
        ridge = (1 - abs(signed)) * 2 - 1
        value += amplitude * (signed * (1 - ridge_mix) + ridge * ridge_mix)
        total += amplitude
        amplitude *= persistence
    return value / total if total else 0.0


def _relax(heights: list[list[float]], passes: int, height: float) -> None:
    threshold = max(height * 0.025, 1e-6)
    for _ in range(passes):
        delta = [[0.0 for _ in row] for row in heights]
        for row in range(len(heights)):
            for column in range(len(heights[row])):
                for next_row, next_column in ((row + 1, column), (row, column + 1)):
                    if next_row >= len(heights) or next_column >= len(heights[row]):
                        continue
                    difference = heights[row][column] - heights[next_row][next_column]
                    if abs(difference) <= threshold:
                        continue
                    transfer = math.copysign(
                        (abs(difference) - threshold) * 0.16, difference
                    )
                    delta[row][column] -= transfer
                    delta[next_row][next_column] += transfer
        for row in range(len(heights)):
            for column in range(len(heights[row])):
                heights[row][column] += delta[row][column]


def _segment_distance(
    x: float, z: float, center: list[float], angle: float, length: float
) -> float:
    direction = [math.cos(angle), math.sin(angle)]
    half = length * 0.5
    start = [center[0] - direction[0] * half, center[1] - direction[1] * half]
    offset = [x - start[0], z - start[1]]
    amount = max(
        0.0,
        min(
            1.0,
            (offset[0] * direction[0] + offset[1] * direction[1])
            / max(length, 1e-9),
        ),
    )
    closest = [
        start[0] + direction[0] * length * amount,
        start[1] + direction[1] * length * amount,
    ]
    return math.hypot(x - closest[0], z - closest[1])


def _apply_terrain_anchors(
    heights: list[list[float]], recipe: Mapping[str, Any]
) -> None:
    size = len(heights)
    vertical = float(recipe["size"][1])
    for row in range(size):
        normalized_z = row / (size - 1) * 2 - 1
        for column in range(size):
            normalized_x = column / (size - 1) * 2 - 1
            for anchor in recipe["terrainAnchors"]:
                if anchor["type"] == "ridge":
                    distance = _segment_distance(
                        normalized_x,
                        normalized_z,
                        anchor["position"],
                        float(anchor["angle"]),
                        float(anchor["length"]),
                    )
                else:
                    distance = math.hypot(
                        normalized_x - float(anchor["position"][0]),
                        normalized_z - float(anchor["position"][1]),
                    )
                radius = float(anchor["radius"])
                if distance >= radius:
                    continue
                weight = _smooth(1 - distance / radius)
                strength = float(anchor["strength"])
                if anchor["type"] == "valley":
                    target = vertical * (0.42 + strength * 0.38)
                elif anchor["type"] == "plateau":
                    target = vertical * (0.5 + strength * 0.34)
                else:
                    target = vertical * (0.48 + abs(strength) * 0.46)
                heights[row][column] = (
                    heights[row][column] * (1 - weight) + target * weight
                )


def _terrain_grid(recipe: Mapping[str, Any]) -> tuple[list[list[list[float]]], list[list[float]]]:
    width, vertical, depth = (float(value) for value in recipe["size"])
    grid_size = int(recipe["gridSize"])
    heights: list[list[float]] = []
    for row in range(grid_size):
        v = row / (grid_size - 1)
        normalized_z = v * 2 - 1
        height_row: list[float] = []
        for column in range(grid_size):
            u = column / (grid_size - 1)
            normalized_x = u * 2 - 1
            value = vertical * (0.42 + _fbm(recipe, normalized_x, normalized_z) * 0.36)
            steps = int(recipe["terraceSteps"])
            if steps:
                value = round(value / vertical * steps) / steps * vertical
            edge_falloff = float(recipe["edgeFalloff"])
            if edge_falloff:
                edge_distance = min(u, 1 - u, v, 1 - v)
                value *= _smooth(min(1.0, edge_distance / edge_falloff))
            height_row.append(value)
        heights.append(height_row)
    _relax(heights, int(recipe["relaxationPasses"]), vertical)
    _apply_terrain_anchors(heights, recipe)
    control_grid = [
        [
            _vec([
                -width * 0.5 + width * column / (grid_size - 1),
                heights[row][column],
                -depth * 0.5 + depth * row / (grid_size - 1),
            ])
            for column in range(grid_size)
        ]
        for row in range(grid_size)
    ]
    return control_grid, heights


def _sample_height(
    heights: list[list[float]], width: float, depth: float, x: float, z: float
) -> tuple[float, float]:
    rows, columns = len(heights), len(heights[0])
    u = max(0.0, min(1.0, x / width + 0.5))
    v = max(0.0, min(1.0, z / depth + 0.5))
    scaled_x, scaled_z = u * (columns - 1), v * (rows - 1)
    column, row = min(columns - 2, int(scaled_x)), min(rows - 2, int(scaled_z))
    local_x, local_z = scaled_x - column, scaled_z - row
    top = heights[row][column] * (1 - local_x) + heights[row][column + 1] * local_x
    bottom = (
        heights[row + 1][column] * (1 - local_x)
        + heights[row + 1][column + 1] * local_x
    )
    height = top * (1 - local_z) + bottom * local_z
    step_x, step_z = width / (columns - 1), depth / (rows - 1)
    left = heights[row][max(0, column - 1)]
    right = heights[row][min(columns - 1, column + 1)]
    up = heights[max(0, row - 1)][column]
    down = heights[min(rows - 1, row + 1)][column]
    slope = math.hypot(
        (right - left) / max(step_x * 2, 1e-9),
        (down - up) / max(step_z * 2, 1e-9),
    )
    return height, slope


def _rock_instances(
    recipe: Mapping[str, Any], heights: list[list[float]]
) -> list[dict[str, Any]]:
    count = int(recipe["rockCount"])
    if count == 0:
        return []
    seed = int(recipe["seed"])
    width, _, depth = (float(value) for value in recipe["size"])
    minimum_scale, maximum_scale = (
        float(value) for value in recipe["rockScaleRange"]
    )
    spacing = min(width, depth) * float(recipe["rockMinSpacingRatio"])
    occupied: dict[tuple[int, int], list[tuple[float, float]]] = {}
    instances: list[dict[str, Any]] = []
    attempts = max(80, count * 30)
    for attempt in range(attempts):
        if len(instances) >= count:
            break
        x = _signed(seed, "rock-x", attempt) * width * 0.46
        z = _signed(seed, "rock-z", attempt) * depth * 0.46
        cell = (math.floor(x / spacing), math.floor(z / spacing)) if spacing else (0, 0)
        if spacing:
            neighbors = (
                point
                for offset_x in (-1, 0, 1)
                for offset_z in (-1, 0, 1)
                for point in occupied.get((cell[0] + offset_x, cell[1] + offset_z), [])
            )
            if any(math.hypot(x - px, z - pz) < spacing for px, pz in neighbors):
                continue
        height, slope = _sample_height(heights, width, depth, x, z)
        if slope > float(recipe["maxRockSlope"]):
            continue
        scale = minimum_scale + (
            maximum_scale - minimum_scale
        ) * _rand(seed, "rock-scale", attempt)
        scale_y = scale * (0.55 + 0.45 * _rand(seed, "rock-height", attempt))
        instances.append({
            "position": _vec([x, height + scale_y * 0.34, z]),
            "rotation": _vec([
                _signed(seed, "rock-rx", attempt) * 0.35,
                _rand(seed, "rock-ry", attempt) * math.tau,
                _signed(seed, "rock-rz", attempt) * 0.35,
            ]),
            "scale": _vec([
                scale * (0.8 + 0.5 * _rand(seed, "rock-sx", attempt)),
                scale_y,
                scale * (0.8 + 0.5 * _rand(seed, "rock-sz", attempt)),
            ]),
        })
        occupied.setdefault(cell, []).append((x, z))
    if len(instances) != count:
        raise ValueError(
            f"rock scatter placed {len(instances)} of {count} instances; "
            "reduce rockCount/rockMinSpacingRatio or raise maxRockSlope"
        )
    return instances


def _rock_field(recipe: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    kind = str(recipe["kind"])
    profile = str(recipe["profile"])
    seed = int(recipe["seed"])
    width, height, depth = (float(value) for value in recipe["size"])
    core_radii = (
        [width * 0.48, height * 0.48, depth * 0.48]
        if kind == "boulder"
        else [width * 0.48, height * 0.48, depth * 0.38]
    )
    sources: list[dict[str, Any]] = [{
        "id": "rock-core",
        "shape": "ellipsoid",
        "position": [0.0, height * 0.5, 0.0],
        "radii": _vec(core_radii),
        "strength": 1.0,
        "falloff": 1.8 if profile == "angular" else 1.35,
        "operation": "add",
    }]
    for anchor in recipe["rockAnchors"]:
        sources.append({
            "id": f"signature-{anchor['id']}",
            "shape": "ellipsoid",
            "position": _vec([
                float(anchor["position"][0]) * width,
                height * (0.5 + float(anchor["position"][1])),
                float(anchor["position"][2]) * depth,
            ]),
            "radii": _vec([
                float(anchor["radii"][0]) * width,
                float(anchor["radii"][1]) * height,
                float(anchor["radii"][2]) * depth,
            ]),
            "strength": float(anchor["strength"]),
            "falloff": 1.45,
            "operation": "add",
        })
    for index in range(max(0, int(recipe["sourceCount"]) - 1)):
        if kind == "cliff":
            x = _signed(seed, "source-x", index) * width * 0.24
            y = height * (0.25 + 0.5 * _rand(seed, "source-y", index))
            z = _signed(seed, "source-z", index) * depth * 0.10
            radii = [
                width * (0.20 + 0.10 * _rand(seed, "source-rx", index)),
                height * (0.22 + 0.16 * _rand(seed, "source-ry", index)),
                depth * (0.28 + 0.10 * _rand(seed, "source-rz", index)),
            ]
        else:
            x = _signed(seed, "source-x", index) * width * 0.20
            y = height * (0.35 + 0.3 * _rand(seed, "source-y", index))
            z = _signed(seed, "source-z", index) * depth * 0.18
            radii = [
                width * (0.20 + 0.14 * _rand(seed, "source-rx", index)),
                height * (0.18 + 0.15 * _rand(seed, "source-ry", index)),
                depth * (0.20 + 0.14 * _rand(seed, "source-rz", index)),
            ]
        sources.append({
            "id": f"weathered-mass-{index + 1:02d}",
            "shape": "ellipsoid",
            "position": _vec([x, y, z]),
            "radii": _vec(radii),
            "strength": _q(0.38 + 0.24 * _rand(seed, "source-strength", index)),
            "falloff": 2.1 if profile == "angular" else 1.55,
            "operation": "add",
        })
    modifiers: list[dict[str, Any]] = []
    minimum_dimension = min(width, height, depth)
    for index in range(int(recipe["strataCount"])):
        ratio = (index + 1) / (int(recipe["strataCount"]) + 1)
        y = height * ratio
        modifier_type = "ridge" if index % 2 == 0 else "crease"
        modifiers.append({
            "id": f"stratum-{index + 1:02d}",
            "type": modifier_type,
            "start": _vec([-width * 0.42, y, depth * 0.18]),
            "end": _vec([width * 0.42, y, depth * 0.18]),
            "radius": _q(max(minimum_dimension * 0.07, height * 0.018)),
            "strength": _q(0.08 + float(recipe["roughness"]) * 0.05),
            "falloff": 2.4,
        })
    fracture = float(recipe["fractureStrength"])
    if fracture > 0:
        for index, sign in enumerate((-1, 1)):
            modifiers.append({
                "id": f"fracture-{index + 1:02d}",
                "type": "crease",
                "start": _vec([
                    sign * width * 0.28,
                    height * 0.15,
                    depth * 0.30,
                ]),
                "end": _vec([
                    -sign * width * 0.12,
                    height * 0.82,
                    depth * 0.30,
                ]),
                "radius": _q(max(minimum_dimension * 0.055, 0.001)),
                "strength": fracture,
                "falloff": 2.8,
            })
    parameters = {
        "representation": "field-sculpt",
        "bounds": {
            "min": _vec([-width * 0.75, -height * 0.24, -depth * 0.75]),
            "max": _vec([width * 0.75, height * 1.24, depth * 0.75]),
        },
        "resolution": [int(recipe["resolution"])] * 3,
        "isoLevel": 0.34,
        "sources": sources,
        "surfaceModifiers": modifiers,
        "connectivity": "single-surface",
        "uvProjection": "xz" if kind == "boulder" else "xy",
    }
    noise = float(recipe["roughness"])
    deformation = []
    if noise > 0:
        deformation = [
            {
                "type": "noise",
                "axis": "y",
                "amount": _q(minimum_dimension * noise * 0.055),
                "start": 0.0,
                "end": 1.0,
                "power": 0.35,
                "frequency": 4.0,
                "seed": seed,
            },
            {
                "type": "noise",
                "axis": "y",
                "amount": _q(minimum_dimension * noise * 0.022),
                "start": 0.0,
                "end": 1.0,
                "power": 0.55,
                "frequency": 11.0,
                "seed": min(2_147_483_647, seed + 7919),
            },
        ]
    return parameters, deformation


def generate_landform_geometry(recipe: Mapping[str, Any]) -> dict[str, Any]:
    """Return deterministic canonical geometry payloads for one recipe."""

    normalized = normalize_landform_recipe(recipe)
    if normalized["kind"] == "terrain":
        control_grid, heights = _terrain_grid(normalized)
        return {
            "kind": "terrain",
            "rootPrimitive": "deformable-surface",
            "rootParameters": {
                "representation": "grid",
                "controlGrid": control_grid,
                "segments": [int(normalized["segments"])] * 2,
                "folds": [],
            },
            "deformationStack": [],
            "rockInstances": _rock_instances(normalized, heights),
        }
    parameters, deformation = _rock_field(normalized)
    return {
        "kind": normalized["kind"],
        "rootPrimitive": "sculpted-surface",
        "rootParameters": parameters,
        "deformationStack": deformation,
        "rockInstances": [],
    }


def _evidence(spec: Mapping[str, Any], root: Mapping[str, Any]) -> list[str]:
    refs = root.get("evidenceRefs")
    if isinstance(refs, list) and refs:
        return [str(value) for value in refs if isinstance(value, str) and value]
    for item in spec.get("viewEvidence", []):
        if isinstance(item, Mapping) and isinstance(item.get("id"), str):
            return [item["id"]]
    return ["full-object"]


def _rock_cluster(
    parent: str,
    material: str,
    evidence: list[str],
    instances: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "id": "terrain-rock-scatter",
        "name": "Terrain rock scatter",
        "componentType": "part",
        "level": "meso",
        "role": "distributed terrain rocks and pebbles",
        "importance": 0.72,
        "confidence": 0.62,
        "parent": parent,
        "attachment": None,
        "primitive": "instanced-cluster",
        "geometryDescriptor": {
            "parameters": {
                "basePrimitive": "ellipsoid",
                "baseParameters": {"widthSegments": 12, "heightSegments": 8},
                "instances": instances,
            },
            "topologyIntent": "bounded explicit rock transforms sampled on the generated terrain",
            "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1},
            "deformationStack": [],
            "uvStrategy": "generated spherical UVs",
            "normalStrategy": "instance-transformed ellipsoid normals",
        },
        "dimensions": {
            "width": max(
                (abs(float(item["position"][0])) + float(item["scale"][0]) for item in instances),
                default=0.01,
            )
            * 2,
            "height": max(
                (
                    float(item["position"][1]) + float(item["scale"][1]) * 0.5
                    for item in instances
                ),
                default=0.01,
            ),
            "depth": max(
                (abs(float(item["position"][2])) + float(item["scale"][2]) for item in instances),
                default=0.01,
            )
            * 2,
            "units": "relative",
            "confidence": 0.62,
        },
        "transform": {
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
        },
        "actionProfile": {
            "animationRole": "static",
            "transformChannels": {
                "translate": True,
                "rotate": True,
                "scale": True,
                "visibility": True,
            },
            "sockets": [],
            "constraints": [],
        },
        "material": material,
        "materialLayers": [material],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": [],
        "detailPlan": {
            "status": "planned",
            "observedComplexity": "simple",
            "decompositionMode": "atomic",
            "atomicityReason": "The rocks are one bounded instance system rather than unique hero parts.",
            "childComponentIds": [],
            "features": [],
            "evidenceRefs": evidence,
            "coverageNotes": "Position, scale, rotation, terrain contact, spacing, and slope veto are explicit.",
        },
        "surfaceDetail": {
            "macroRoughness": 0.18,
            "microRoughness": 0.22,
            "bumpAmplitude": 0.0,
            "normalPattern": "rock response belongs to the assigned Lookdev material",
        },
        "evidenceRefs": evidence,
        "details": [],
        "fidelityTier": "form",
    }


def apply_landform_recipe(
    spec: Mapping[str, Any],
    recipe: Mapping[str, Any],
    *,
    ground_material: str = "base",
    rock_material: str = "base",
    active_phase: str | None = None,
) -> dict[str, Any]:
    """One-shot Form compiler. The input spec is never mutated."""

    normalized = normalize_landform_recipe(recipe)
    phase = active_phase or str(pipeline_status(dict(spec)).get("currentPass") or "")
    if phase != "form":
        raise ValueError(
            f"landform recipes may be expanded only during Form; current pass is {phase!r}"
        )
    if not str(spec.get("schemaVersion", "")).startswith("3."):
        raise ValueError("landform expansion supports monolithic schema 3.x specs only")
    components = spec.get("componentTree")
    if not isinstance(components, list) or len(components) != 1:
        raise ValueError(
            "landform expansion requires the one-root Form scaffold; authored hierarchies are not replaced"
        )
    source_root = components[0]
    if (
        not isinstance(source_root, Mapping)
        or source_root.get("id") != "root"
        or source_root.get("parent") is not None
    ):
        raise ValueError(
            "landform expansion requires one geometry root with id 'root' and parent null"
        )
    assumption_id = "generated-landform-hidden-structure"
    if any(
        isinstance(item, Mapping) and item.get("id") == assumption_id
        for item in spec.get("assumptions", [])
    ):
        raise ValueError("landform expansion is one-shot; generated geometry is not replaced")
    source_detail = source_root.get("detailPlan")
    if (
        source_root.get("fidelityTier") not in {None, "blockout"}
        or (
            isinstance(source_detail, Mapping)
            and source_detail.get("status") not in {None, "unassessed"}
        )
    ):
        raise ValueError(
            "landform expansion requires an unauthored one-root Form scaffold"
        )
    if spec.get("repetitionSystems") not in (None, []):
        raise ValueError("landform expansion requires an empty repetitionSystems scaffold")
    material_ids = {
        item.get("id") for item in spec.get("materials", []) if isinstance(item, Mapping)
    }
    required_materials = (
        [ground_material, rock_material]
        if normalized["kind"] == "terrain" and int(normalized["rockCount"]) > 0
        else [ground_material]
        if normalized["kind"] == "terrain"
        else [rock_material]
    )
    missing = [value for value in required_materials if value not in material_ids]
    if missing:
        raise ValueError(
            "unknown landform material id(s): " + ", ".join(dict.fromkeys(missing))
        )
    geometry = generate_landform_geometry(normalized)
    challenger = copy.deepcopy(dict(spec))
    root = challenger["componentTree"][0]
    evidence = _evidence(spec, source_root)
    width, height, depth = (float(value) for value in normalized["size"])
    rock_instances = geometry["rockInstances"]
    child_ids = ["terrain-rock-scatter"] if rock_instances else []
    material = ground_material if normalized["kind"] == "terrain" else rock_material
    root.update({
        "name": (
            "Bounded terrain surface"
            if normalized["kind"] == "terrain"
            else f"Procedural {normalized['kind']} rock"
        ),
        "role": (
            "bounded terrain landform"
            if normalized["kind"] == "terrain"
            else f"hero {normalized['kind']} geological mass"
        ),
        "primitive": geometry["rootPrimitive"],
        "geometryDescriptor": {
            "parameters": geometry["rootParameters"],
            "topologyIntent": (
                "one connected open terrain sheet"
                if normalized["kind"] == "terrain"
                else "one closed connected geological field surface"
            ),
            "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1},
            "deformationStack": geometry["deformationStack"],
            "uvStrategy": (
                "generated planar terrain coordinates"
                if normalized["kind"] == "terrain"
                else f"generated {geometry['rootParameters']['uvProjection']} field projection"
            ),
            "normalStrategy": "generated surface normals after bounded deformation",
        },
        "dimensions": {
            "width": width,
            "height": height,
            "depth": depth,
            "units": "relative",
            "confidence": 0.68,
        },
        "material": material,
        "materialLayers": [material],
        "fidelityTier": "form",
        "detailPlan": {
            "status": "planned",
            "observedComplexity": "complex" if child_ids else "simple",
            "decompositionMode": "children" if child_ids else "atomic",
            "atomicityReason": (
                ""
                if child_ids
                else "The generated profile is one connected landform surface."
            ),
            "childComponentIds": child_ids,
            "features": [],
            "evidenceRefs": evidence,
            "coverageNotes": (
                "Macro relief, stable anchors, bounded variation, edge behavior, and terrain contact are explicit."
                if normalized["kind"] == "terrain"
                else "Macro mass, stable source anchors, strata, fractures, and surface breakup are explicit."
            ),
        },
    })
    if rock_instances:
        challenger["componentTree"].append(
            _rock_cluster("root", rock_material, evidence, rock_instances)
        )
    detail_contract = challenger.get("detailDecompositionContract")
    if not isinstance(detail_contract, dict):
        raise ValueError("detailDecompositionContract must be an object")
    detail_contract["status"] = "planned"

    root_group = {
        "id": "landform-primary-surface",
        "strategy": "continuous-sculpt",
        "regions": [
            "terrain relief"
            if normalized["kind"] == "terrain"
            else f"{normalized['kind']} geological mass"
        ],
        "componentRefs": ["root"],
        "materialRefs": [material],
        "hostComponentRef": "root",
        "requiredTopology": "single-connected-surface",
        "rationale": (
            "The bounded height grid is one connected terrain surface."
            if normalized["kind"] == "terrain"
            else "The field compiler requires one connected closed hero-rock surface."
        ),
        "evidenceRefs": evidence,
        "confidence": 0.7,
    }
    topology_groups = [root_group]
    if rock_instances:
        topology_groups.append({
            "id": "terrain-rock-assembly",
            "strategy": "assembled-solid",
            "regions": ["distributed rocks and pebbles"],
            "componentRefs": ["terrain-rock-scatter"],
            "materialRefs": [rock_material],
            "requiredTopology": "intentional-separate-parts",
            "separationReason": "Scattered rocks are real repeated parts resting on the terrain surface.",
            "rationale": "Instancing preserves bounded repetition without merging rocks into the ground sheet.",
            "evidenceRefs": evidence,
            "confidence": 0.65,
        })
    challenger["surfaceTopologyPlan"] = {
        "status": "planned",
        "reason": (
            "The generated terrain separates its primary surface from repeated loose rocks."
            if rock_instances
            else "The generated landform is one connected primary surface."
        ),
        "decisionRule": (
            "Keep the terrain connected and retain loose rocks as intentional instances."
            if rock_instances
            else "Keep the generated primary landform connected."
        ),
        "groups": topology_groups,
    }
    for field in ("featureReviewTargets", "buildPasses"):
        for item in challenger.get(field, []):
            refs = item.get("componentRefs") if isinstance(item, dict) else None
            if isinstance(refs, list):
                for child_id in child_ids:
                    if "root" in refs and child_id not in refs:
                        refs.append(child_id)
    challenger.setdefault("assumptions", []).append({
        "id": assumption_id,
        "statement": (
            f"Unobserved landform variation follows the bounded {normalized['profile']} "
            "profile while declared anchors remain fixed."
        ),
        "scope": "occluded relief, hidden rock faces, strata continuation, and loose-rock placement",
        "bounds": "Only recipe limits, stable anchors, registry budgets, and visible silhouette define generated structure.",
        "impactIfWrong": "Side or turnaround views may expose incorrect relief, strata, or rock contact.",
        "falsifyingCheck": "Compare primary, side, and three-quarter silhouettes and revise anchors or profile on disagreement.",
        "evidenceRefs": evidence,
    })
    revision = challenger.get("specRevision", 0)
    challenger["specRevision"] = revision + 1 if isinstance(revision, int) else 1
    synchronize_capability_plan(challenger, "form")
    challenger["sculptPipeline"] = pipeline_status(challenger)

    lookup = {
        item["id"]: item
        for item in challenger["componentTree"]
        if isinstance(item, dict)
    }
    geometry_errors = [
        error
        for item in challenger["componentTree"]
        if isinstance(item, dict)
        for error in validate_geometry_component(
            item, challenger.get("repetitionSystems", []), lookup
        )
    ]
    if geometry_errors:
        raise ValueError(
            "generated landform geometry is invalid: " + "; ".join(geometry_errors)
        )
    from validate_sculpt_spec import validate_spec

    errors, _ = validate_spec(challenger)
    if errors:
        raise ValueError(
            "generated landform challenger is invalid: " + "; ".join(errors)
        )
    return challenger


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--ground-material", default="base")
    parser.add_argument("--rock-material", default="base")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    source, output = args.spec.expanduser().resolve(), args.out.expanduser().resolve()
    if source == output:
        raise ValueError("--out must be a separate challenger path; champion mutation is forbidden")
    if output.exists():
        raise ValueError(f"--out already exists: {output}")
    recipe = parse_json(
        args.recipe.expanduser().resolve().read_text(encoding="utf-8"),
        "landform recipe JSON",
    )
    spec = load_spec_file(source)
    challenger = apply_landform_recipe(
        spec,
        recipe,
        ground_material=args.ground_material,
        rock_material=args.rock_material,
        active_phase=str(pipeline_status(spec).get("currentPass") or ""),
    )
    write_spec_atomic(output, challenger)
    normalized = normalize_landform_recipe(recipe)
    print(json.dumps({
        "ok": True,
        "output": str(output),
        "kind": normalized["kind"],
        "components": len(challenger["componentTree"]),
        "rockInstances": (
            len(challenger["componentTree"][1]["geometryDescriptor"]["parameters"]["instances"])
            if len(challenger["componentTree"]) > 1
            else 0
        ),
        "challengerOnly": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
