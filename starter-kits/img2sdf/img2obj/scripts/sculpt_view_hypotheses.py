#!/usr/bin/env python3
"""Register and verify cached ImageGen view hypotheses for cross-view vetoes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

from sculpt_contract import (
    adaptive_hypothesis_views,
    file_sha256,
    image_dimensions,
    parse_json,
    pipeline_status,
    write_spec_atomic,
)
from sculpt_image_io import crop_rgba, encode_png_rgba, load_image_rgba, write_png_rgba


VIEW_HYPOTHESIS_ARTIFACT_TYPE = "threejs-sculpt-view-hypotheses"
VIEW_HYPOTHESIS_VERSION = 2
SUPPORTED_VIEW_HYPOTHESIS_VERSIONS = {1, VIEW_HYPOTHESIS_VERSION}
DEFAULT_PROMPT_VERSION = "identity-turnaround-2x2-v1"
STANDARD_LAYOUT_ID = "identity-turnaround-2x2-v1"
EXPLODED_LAYOUT_ID = "assembly-exploded-2x2-v1"
TURNAROUND_LAYOUT_ID = STANDARD_LAYOUT_ID
TURNAROUND_LAYOUT = (
    ("three-quarter", "side"),
    ("back", "front"),
)
EXPLODED_LAYOUT = (
    ("exploded", "side"),
    ("back", "front"),
)
PLANNING_SHEET_LAYOUTS = {
    STANDARD_LAYOUT_ID: TURNAROUND_LAYOUT,
    EXPLODED_LAYOUT_ID: EXPLODED_LAYOUT,
}
SPATIAL_VIEW_IDS = {"three-quarter", "exploded", "side", "back"}
TURNAROUND_VIEW_IDS = {*SPATIAL_VIEW_IDS, "front"}


def _planning_layout(layout_id: str) -> tuple[tuple[str, str], tuple[str, str]]:
    try:
        return PLANNING_SHEET_LAYOUTS[layout_id]
    except KeyError as exc:
        raise ValueError(f"unsupported 2x2 planning layout: {layout_id}") from exc


def make_view_hypothesis_policy(
    complexity: str,
    quality_profile: str,
    source_image: str | None,
    layout_mode: str = "standard",
) -> dict[str, Any]:
    if layout_mode not in {"standard", "exploded"}:
        raise ValueError("view hypothesis layout_mode must be standard or exploded")
    layout_id = (
        EXPLODED_LAYOUT_ID if layout_mode == "exploded" else STANDARD_LAYOUT_ID
    )
    first_view = "exploded" if layout_mode == "exploded" else "three-quarter"
    has_source = bool(source_image)
    return {
        # Resolve hidden-view evidence before the first Blockout build so a
        # complex object cannot spend the whole phase reasoning from one view.
        # Skipping is valid only after an explicit simple-and-symmetric proof.
        "enabled": False,
        "activationMode": "pre-blockout-unless-simple-symmetric",
        "activationPhase": "blockout",
        "decision": "pending" if has_source else "not-applicable",
        "decisionReason": "" if has_source else "No source image is available.",
        "defaultDecision": "required",
        "skipEligibility": "simple-and-symmetric-only",
        "skipAssessment": {
            "objectIsSimple": complexity == "simple",
            "symmetry": "unassessed",
            "confidence": 0.0,
            "evidenceRefs": [],
            "reason": "",
        },
        "activationCriteria": [
            "Generate one cached 2x2 turnaround for every source-backed object by default.",
            "Skip only when the assessed complexity tier is simple and observed evidence supports strong bilateral, radial, or axial symmetry.",
            "Moderate, complex, ultra, asymmetric, articulated, occluded, or uncertain objects always require the 2x2 turnaround.",
        ],
        "generator": "built-in-imagegen",
        "promptVersion": DEFAULT_PROMPT_VERSION,
        "layoutId": layout_id,
        "layoutMode": layout_mode,
        "requiredViews": adaptive_hypothesis_views(
            complexity,
            quality_profile,
            first_view,
        ),
        "allowedUse": "planning-veto",
        "acceptanceAuthority": False,
        "generationContract": (
            (
                "Before the first Blockout build, invoke the imagegen skill once. "
                "Generate one edge-to-edge 2x2 neutral-background assembly planning sheet "
                "ordered exploded|side over back|front. Only the top-left tile is exploded; "
                "the other three keep the object assembled. Separate only source-supported "
                "major components while preserving orientation and assembly order; do not "
                "invent parts, labels, gutters, or redesigns."
            )
            if layout_mode == "exploded"
            else (
                "Before the first Blockout build, invoke the imagegen skill once. Preserve the "
                "exact object identity, proportions, parts, materials, and scale; "
                "generate one edge-to-edge 2x2 neutral-background turnaround ordered "
                "three-quarter|side over back|front; do not add labels, gutters, redesigns, or parts."
            )
        ),
        "manifestPath": "",
        "manifestSha256": "",
        "cacheKey": "",
    }


def _resolve_local_path(root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip() or "://" in value:
        raise ValueError(f"{label} must be a local file path")
    candidate = Path(value).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label} does not exist: {resolved}")
    return resolved


def _cache_key(
    source_sha256: str,
    prompt_version: str,
    layout_id: str | None = None,
) -> str:
    suffix = f"{layout_id}\n" if layout_id else ""
    payload = f"{source_sha256}\n{prompt_version}\n{suffix}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _manifest_path(spec_path: Path, cache_key: str) -> Path:
    return (
        spec_path.parent
        / ".sculpt-cache"
        / spec_path.stem
        / f"view-hypotheses-{cache_key[:20]}.json"
    )


def _read_object(path: Path, label: str) -> dict[str, Any]:
    payload = parse_json(path.read_text(encoding="utf-8"), label)
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object")
    return payload


def _parse_view(value: str, root: Path) -> tuple[str, Path]:
    view_id, separator, path_value = value.partition("=")
    view_id = view_id.strip()
    if not separator or view_id not in SPATIAL_VIEW_IDS:
        raise ValueError(
            "--view must use exploded=PATH, three-quarter=PATH, side=PATH, or back=PATH"
        )
    return view_id, _resolve_local_path(root, path_value.strip(), f"view {view_id!r}")


def _turnaround_rectangles(
    width: int,
    height: int,
    layout_id: str = STANDARD_LAYOUT_ID,
) -> dict[str, dict[str, int]]:
    if width < 2 or height < 2 or width % 2 or height % 2:
        raise ValueError(
            "2x2 turnaround must have even width and height so every tile has exact provenance"
        )
    tile_width = width // 2
    tile_height = height // 2
    layout = _planning_layout(layout_id)
    return {
        view_id: {
            "x": column * tile_width,
            "y": row * tile_height,
            "width": tile_width,
            "height": tile_height,
        }
        for row, view_row in enumerate(layout)
        for column, view_id in enumerate(view_row)
    }


def _turnaround_layout_manifest(
    width: int,
    height: int,
    layout_id: str = STANDARD_LAYOUT_ID,
) -> list[dict[str, Any]]:
    layout = _planning_layout(layout_id)
    rectangles = _turnaround_rectangles(width, height, layout_id)
    return [
        {
            "viewId": view_id,
            "row": row,
            "column": column,
            "tileRect": rectangles[view_id],
        }
        for row, view_row in enumerate(layout)
        for column, view_id in enumerate(view_row)
    ]


def _write_turnaround_tiles(
    sheet_path: Path,
    output_manifest: Path,
    layout_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    width, height, pixels = load_image_rgba(sheet_path)
    rectangles = _turnaround_rectangles(width, height, layout_id)
    sheet_hash = file_sha256(sheet_path)
    views: dict[str, dict[str, Any]] = {}
    for view_id, rectangle in rectangles.items():
        tile_path = output_manifest.with_name(
            f"{output_manifest.stem}-{view_id}.png"
        ).resolve()
        tile_pixels = crop_rgba(
            width,
            height,
            pixels,
            rectangle["x"],
            rectangle["y"],
            rectangle["width"],
            rectangle["height"],
        )
        write_png_rgba(
            tile_path,
            rectangle["width"],
            rectangle["height"],
            tile_pixels,
        )
        views[view_id] = {
            "viewId": view_id,
            "image": str(tile_path),
            "sha256": file_sha256(tile_path),
            "dimensions": {
                "width": rectangle["width"],
                "height": rectangle["height"],
            },
            "tileRect": rectangle,
            "sourceSheetSha256": sheet_hash,
            "origin": "synthetic-hypothesis",
            "allowedUse": "planning-veto",
        }
    root_provenance = {
        "turnaroundImage": str(sheet_path),
        "turnaroundSha256": sheet_hash,
        "turnaroundDimensions": {"width": width, "height": height},
        "layoutId": layout_id,
        "layout": _turnaround_layout_manifest(width, height, layout_id),
    }
    return views, root_provenance


def _policy(spec: dict[str, Any]) -> dict[str, Any]:
    value = spec.get("viewHypothesisPolicy")
    return value if isinstance(value, dict) else {}


def _required_views(spec: dict[str, Any]) -> list[str]:
    values = _policy(spec).get("requiredViews", [])
    if not isinstance(values, list):
        return []
    return list(dict.fromkeys(str(item) for item in values if item in SPATIAL_VIEW_IDS))


def _registered_manifest_path(spec_path: Path | None, policy: dict[str, Any]) -> Path:
    manifest_value = policy.get("manifestPath")
    if spec_path is None:
        if not isinstance(manifest_value, str) or not manifest_value.strip() or "://" in manifest_value:
            raise ValueError("view hypothesis manifest must be a local file path")
        candidate = Path(manifest_value).expanduser()
        if not candidate.is_absolute():
            raise ValueError(
                "view hypothesis manifestPath must be absolute when validation has no spec path"
            )
        return _resolve_local_path(candidate.parent, manifest_value, "view hypothesis manifest")
    root = spec_path.expanduser().resolve().parent
    return _resolve_local_path(root, manifest_value, "view hypothesis manifest")


def hypothesis_manifest_failures(
    spec_path: Path | None,
    spec: dict[str, Any],
    required_view_ids: Iterable[str] | None = None,
) -> list[str]:
    """Validate the registered cache against the current source and generated files."""
    policy = _policy(spec)
    if policy.get("enabled") is not True:
        return []
    failures: list[str] = []
    root = spec_path.expanduser().resolve().parent if spec_path is not None else None
    requested = {
        str(item)
        for item in (required_view_ids if required_view_ids is not None else _required_views(spec))
        if str(item) in SPATIAL_VIEW_IDS
    }
    try:
        manifest_path = _registered_manifest_path(spec_path, policy)
    except (OSError, ValueError) as exc:
        return [str(exc)]
    stored_file_hash = policy.get("manifestSha256")
    actual_file_hash = file_sha256(manifest_path)
    if stored_file_hash != actual_file_hash:
        failures.append("view hypothesis manifest changed after registration")
    try:
        manifest = _read_object(manifest_path, "view hypothesis manifest")
    except (OSError, ValueError) as exc:
        return [*failures, str(exc)]
    if manifest.get("artifactType") != VIEW_HYPOTHESIS_ARTIFACT_TYPE:
        failures.append("view hypothesis artifact type is invalid")
    manifest_version = manifest.get("version")
    if manifest_version not in SUPPORTED_VIEW_HYPOTHESIS_VERSIONS:
        failures.append(
            "view hypothesis version must be one of: "
            + ", ".join(str(item) for item in sorted(SUPPORTED_VIEW_HYPOTHESIS_VERSIONS))
        )
    if manifest.get("promptVersion") != policy.get("promptVersion"):
        failures.append("view hypothesis prompt version is stale")
    manifest_layout_id = (
        str(manifest.get("layoutId"))
        if manifest_version == VIEW_HYPOTHESIS_VERSION
        and isinstance(manifest.get("layoutId"), str)
        else None
    )
    if (
        policy.get("activationMode")
        in {
            "default-form-unless-simple-symmetric",
            "pre-blockout-unless-simple-symmetric",
        }
        and manifest_version != VIEW_HYPOTHESIS_VERSION
    ):
        failures.append("default view hypothesis policy requires one registered 2x2 turnaround")
    source_value = spec.get("sourceImage")
    source_root = root
    if spec_path is None:
        source_candidate = (
            Path(source_value).expanduser()
            if isinstance(source_value, str) and source_value.strip() and "://" not in source_value
            else None
        )
        if source_candidate is None or not source_candidate.is_absolute():
            source_value = manifest.get("sourceImage")
        source_root = manifest_path.parent
    try:
        assert source_root is not None
        source_path = _resolve_local_path(source_root, source_value, "spec.sourceImage")
    except (OSError, ValueError) as exc:
        failures.append(str(exc))
        source_path = None
    if source_path is not None:
        source_hash = file_sha256(source_path)
        if manifest.get("sourceSha256") != source_hash:
            failures.append("view hypotheses are stale for the current source image")
        if manifest.get("cacheKey") != _cache_key(
            source_hash,
            str(policy.get("promptVersion") or ""),
            manifest_layout_id,
        ):
            failures.append("view hypothesis cache key is invalid")

    turnaround_hash: str | None = None
    turnaround_pixels: list[tuple[int, int, int, int]] | None = None
    turnaround_width = 0
    turnaround_height = 0
    expected_rectangles: dict[str, dict[str, int]] = {}
    expected_layout = TURNAROUND_LAYOUT
    if manifest_version == VIEW_HYPOTHESIS_VERSION:
        if manifest_layout_id not in PLANNING_SHEET_LAYOUTS:
            failures.append("view hypothesis 2x2 layout id is invalid")
            manifest_layout_id = STANDARD_LAYOUT_ID
        expected_layout = _planning_layout(manifest_layout_id)
        if policy.get("layoutId") != manifest.get("layoutId"):
            failures.append("view hypothesis policy layout is stale")
        try:
            turnaround_path = _resolve_local_path(
                manifest_path.parent,
                manifest.get("turnaroundImage"),
                "view hypothesis turnaround",
            )
            turnaround_hash = file_sha256(turnaround_path)
            turnaround_width, turnaround_height, turnaround_pixels = load_image_rgba(
                turnaround_path
            )
            turnaround_dimensions = (turnaround_width, turnaround_height)
            if manifest.get("turnaroundSha256") != turnaround_hash:
                failures.append("view hypothesis turnaround changed after registration")
            stored_dimensions = manifest.get("turnaroundDimensions")
            if stored_dimensions != {
                "width": turnaround_dimensions[0],
                "height": turnaround_dimensions[1],
            }:
                failures.append("view hypothesis turnaround dimensions are invalid")
            expected_rectangles = _turnaround_rectangles(
                *turnaround_dimensions,
                manifest_layout_id,
            )
            if manifest.get("layout") != _turnaround_layout_manifest(
                *turnaround_dimensions,
                manifest_layout_id,
            ):
                failures.append("view hypothesis turnaround layout is invalid")
        except (OSError, ValueError) as exc:
            failures.append(str(exc))
    views = manifest.get("views")
    if not isinstance(views, list):
        failures.append("view hypothesis manifest views must be an array")
        views = []
    by_id: dict[str, dict[str, Any]] = {}
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            failures.append(f"view hypothesis views[{index}] must be an object")
            continue
        view_id = view.get("viewId")
        allowed_view_ids = (
            {item for row in expected_layout for item in row}
            if manifest_version == VIEW_HYPOTHESIS_VERSION
            else SPATIAL_VIEW_IDS
        )
        if view_id not in allowed_view_ids:
            failures.append(f"view hypothesis views[{index}].viewId is invalid")
            continue
        if view_id in by_id:
            failures.append(f"duplicate view hypothesis {view_id!r}")
            continue
        by_id[str(view_id)] = view
        try:
            image_root = root if root is not None else manifest_path.parent
            image_path = _resolve_local_path(
                image_root,
                view.get("image"),
                f"view hypothesis {view_id!r}",
            )
        except (OSError, ValueError) as exc:
            failures.append(str(exc))
            continue
        actual_image_hash = file_sha256(image_path)
        if view.get("sha256") != actual_image_hash:
            failures.append(f"view hypothesis {view_id!r} image changed after registration")
        if manifest_version == VIEW_HYPOTHESIS_VERSION:
            try:
                tile_width, tile_height = image_dimensions(image_path)
            except (OSError, ValueError) as exc:
                failures.append(
                    f"view hypothesis {view_id!r} dimensions cannot be read: {exc}"
                )
                continue
            actual_dimensions = (tile_width, tile_height)
            if view.get("dimensions") != {
                "width": actual_dimensions[0],
                "height": actual_dimensions[1],
            }:
                failures.append(f"view hypothesis {view_id!r} dimensions are invalid")
            if view.get("tileRect") != expected_rectangles.get(str(view_id)):
                failures.append(f"view hypothesis {view_id!r} tile rectangle is invalid")
            expected_rectangle = expected_rectangles.get(str(view_id))
            if expected_rectangle is not None and actual_dimensions != (
                expected_rectangle["width"],
                expected_rectangle["height"],
            ):
                failures.append(
                    f"view hypothesis {view_id!r} dimensions do not match its 2x2 tile"
                )
            if (
                expected_rectangle is not None
                and turnaround_pixels is not None
                and actual_dimensions
                == (expected_rectangle["width"], expected_rectangle["height"])
            ):
                expected_pixels = crop_rgba(
                    turnaround_width,
                    turnaround_height,
                    turnaround_pixels,
                    expected_rectangle["x"],
                    expected_rectangle["y"],
                    expected_rectangle["width"],
                    expected_rectangle["height"],
                )
                expected_tile_hash = hashlib.sha256(
                    encode_png_rgba(
                        expected_rectangle["width"],
                        expected_rectangle["height"],
                        expected_pixels,
                    )
                ).hexdigest()
                if actual_image_hash != expected_tile_hash:
                    failures.append(
                        f"view hypothesis {view_id!r} pixels do not match its source-sheet crop"
                    )
            if turnaround_hash is not None and view.get("sourceSheetSha256") != turnaround_hash:
                failures.append(f"view hypothesis {view_id!r} lost its source-sheet provenance")
        if view.get("origin") != "synthetic-hypothesis" or view.get("allowedUse") != "planning-veto":
            failures.append(f"view hypothesis {view_id!r} must remain synthetic planning-veto evidence")
    if manifest_version == VIEW_HYPOTHESIS_VERSION:
        required_tiles = {item for row in expected_layout for item in row}
        missing_turnaround_tiles = required_tiles - set(by_id)
        if missing_turnaround_tiles:
            failures.append(
                "missing registered 2x2 turnaround tiles: "
                + ", ".join(sorted(missing_turnaround_tiles))
            )
    missing = requested - set(by_id)
    if missing:
        failures.append("missing registered view hypotheses: " + ", ".join(sorted(missing)))
    return list(dict.fromkeys(failures))


def hypothesis_evidence_failures(
    spec_path: Path | None,
    spec: dict[str, Any],
    evidence: dict[str, Any],
    diagnostic_view_ids: Iterable[str],
) -> list[str]:
    """Bind synthetic diagnostic references to the registered ImageGen cache."""
    policy = _policy(spec)
    if policy.get("enabled") is not True:
        return []
    diagnostics = {str(item) for item in diagnostic_view_ids if str(item) in SPATIAL_VIEW_IDS}
    evidence_views = {
        str(item.get("viewId")): item
        for item in evidence.get("views", [])
        if isinstance(item, dict) and isinstance(item.get("viewId"), str)
    }
    failures: list[str] = []
    for view_id in sorted(diagnostics):
        view = evidence_views.get(view_id)
        provenance = view.get("referenceProvenance") if isinstance(view, dict) else None
        if not isinstance(provenance, dict) or (
            provenance.get("origin") != "synthetic-hypothesis"
            or provenance.get("allowedUse") != "planning-veto"
        ):
            failures.append(
                f"diagnostic view {view_id!r} must use the registered synthetic-hypothesis/planning-veto provenance"
            )
    failures.extend(hypothesis_manifest_failures(spec_path, spec, diagnostics))
    if failures:
        return list(dict.fromkeys(failures))
    manifest_path = _registered_manifest_path(spec_path, policy)
    manifest = _read_object(manifest_path, "view hypothesis manifest")
    registered = {
        str(item.get("viewId")): item
        for item in manifest.get("views", [])
        if isinstance(item, dict) and isinstance(item.get("viewId"), str)
    }
    for view_id in sorted(diagnostics):
        if evidence_views[view_id].get("referenceSha256") != registered[view_id].get("sha256"):
            failures.append(
                f"synthetic diagnostic view {view_id!r} is not the registered ImageGen hypothesis"
            )
    return list(dict.fromkeys(failures))


def register_views(
    spec_path: Path,
    view_arguments: list[str],
    prompt_version: str | None = None,
    sheet_path: Path | None = None,
) -> dict[str, Any]:
    from sculpt_modules import load_document, save_document

    path = spec_path.expanduser().resolve()
    document = load_document(path)
    spec = document.resolved
    if not document.modular:
        current_phase = str(pipeline_status(spec, path).get("currentPass") or "")
        if current_phase not in {"blockout", "form"}:
            raise ValueError(
                "view hypotheses may be registered only during Blockout preparation or Form; "
                f"current phase is {current_phase or 'unknown'}"
            )
    policy = _policy(spec)
    if not policy:
        raise ValueError("spec has no viewHypothesisPolicy; migrate or reinitialize it first")
    source_path = _resolve_local_path(path.parent, spec.get("sourceImage"), "spec.sourceImage")
    selected_prompt = str(prompt_version or policy.get("promptVersion") or DEFAULT_PROMPT_VERSION).strip()
    if not selected_prompt:
        raise ValueError("prompt version must be non-empty")
    if sheet_path is not None and view_arguments:
        raise ValueError("provide one --sheet or repeated --view values, not both")
    if (
        policy.get("activationMode")
        in {
            "default-form-unless-simple-symmetric",
            "pre-blockout-unless-simple-symmetric",
        }
        and sheet_path is None
    ):
        raise ValueError(
            "the default view policy requires one ImageGen 2x2 turnaround via --sheet; "
            "per-view registration is legacy-only"
        )
    parsed: dict[str, Path] = {}
    for argument in view_arguments:
        view_id, image_path = _parse_view(argument, path.parent)
        if view_id in parsed:
            raise ValueError(f"duplicate --view {view_id!r}")
        parsed[view_id] = image_path
    source_hash = file_sha256(source_path)
    image_dimensions(source_path)
    selected_sheet = (
        _resolve_local_path(path.parent, str(sheet_path), "2x2 turnaround")
        if sheet_path is not None
        else None
    )
    selected_layout_id = str(policy.get("layoutId") or STANDARD_LAYOUT_ID)
    if selected_sheet is not None:
        _planning_layout(selected_layout_id)
    layout_id = selected_layout_id if selected_sheet is not None else None
    cache_key = _cache_key(source_hash, selected_prompt, layout_id)
    output = _manifest_path(path, cache_key)
    required = set(_required_views(spec))
    existing_views: dict[str, dict[str, Any]] = {}
    existing_manifest: dict[str, Any] | None = None
    if output.is_file():
        existing = _read_object(output, "cached view hypothesis manifest")
        expected_version = VIEW_HYPOTHESIS_VERSION if selected_sheet is not None else 1
        if (
            existing.get("artifactType") != VIEW_HYPOTHESIS_ARTIFACT_TYPE
            or existing.get("version") != expected_version
            or existing.get("sourceSha256") != source_hash
            or existing.get("promptVersion") != selected_prompt
        ):
            raise ValueError("existing view hypothesis cache has incompatible provenance")
        if selected_sheet is not None and (
            existing.get("layoutId") != selected_layout_id
            or existing.get("turnaroundSha256") != file_sha256(selected_sheet)
        ):
            raise ValueError(
                "cached 2x2 turnaround already exists for this source/prompt; "
                "reuse it or increment --prompt-version explicitly"
            )
        registered_manifest = policy.get("manifestPath")
        registered_path: Path | None = None
        if isinstance(registered_manifest, str) and registered_manifest.strip():
            candidate = Path(registered_manifest).expanduser()
            registered_path = (
                candidate.resolve()
                if candidate.is_absolute()
                else (path.parent / candidate).resolve()
            )
        same_registered_cache = registered_path == output
        validation_policy = {
            **policy,
            "enabled": True,
            "decision": "required",
            "decisionReason": (
                "Blockout planning requires hidden-view evidence; a cached 2x2 turnaround was registered."
            ),
            "promptVersion": selected_prompt,
            "layoutId": layout_id or "",
            "manifestPath": str(output),
            "manifestSha256": (
                policy.get("manifestSha256")
                if same_registered_cache
                else file_sha256(output)
            ),
            "cacheKey": cache_key,
        }
        validation_spec = {**spec, "viewHypothesisPolicy": validation_policy}
        existing_failures = hypothesis_manifest_failures(
            path,
            validation_spec,
            required,
        )
        if existing_failures:
            raise ValueError(
                "existing view hypothesis cache failed integrity validation: "
                + "; ".join(existing_failures)
            )
        existing_manifest = existing
        existing_views = {
            str(item.get("viewId")): item
            for item in existing.get("views", [])
            if isinstance(item, dict) and isinstance(item.get("viewId"), str)
        }
    cache_hit = existing_manifest is not None
    root_provenance: dict[str, Any] = {}
    if selected_sheet is not None:
        if existing_manifest is None:
            existing_views, root_provenance = _write_turnaround_tiles(
                selected_sheet,
                output,
                selected_layout_id,
            )
        else:
            root_provenance = {
                key: existing_manifest[key]
                for key in (
                    "turnaroundImage",
                    "turnaroundSha256",
                    "turnaroundDimensions",
                    "layoutId",
                    "layout",
                )
                if key in existing_manifest
            }
    else:
        for view_id, image_path in parsed.items():
            dimensions = image_dimensions(image_path)
            digest = file_sha256(image_path)
            previous = existing_views.get(view_id)
            if previous is not None and previous.get("sha256") != digest:
                raise ValueError(
                    f"cached {view_id!r} hypothesis already exists for this source/prompt; "
                    "reuse it or increment --prompt-version explicitly"
                )
            if previous is None:
                cache_hit = False
                existing_views[view_id] = {
                    "viewId": view_id,
                    "image": str(image_path),
                    "sha256": digest,
                    "dimensions": {"width": dimensions[0], "height": dimensions[1]},
                    "origin": "synthetic-hypothesis",
                    "allowedUse": "planning-veto",
                }
    missing = required - set(existing_views)
    if missing:
        raise ValueError(
            "registration is incomplete; provide generated views: " + ", ".join(sorted(missing))
        )
    view_order = (
        [
            view_id
            for view_row in _planning_layout(selected_layout_id)
            for view_id in view_row
        ]
        if selected_sheet is not None
        else sorted(existing_views)
    )
    candidate_manifest = {
        "artifactType": VIEW_HYPOTHESIS_ARTIFACT_TYPE,
        "version": VIEW_HYPOTHESIS_VERSION if selected_sheet is not None else 1,
        "generator": "built-in-imagegen",
        "sourceImage": str(source_path),
        "sourceSha256": source_hash,
        "promptVersion": selected_prompt,
        "cacheKey": cache_key,
        "views": [existing_views[key] for key in view_order],
        "acceptanceAuthority": False,
        "allowedUse": "planning-veto",
        **root_provenance,
    }
    if cache_hit and existing_manifest is not None:
        manifest = existing_manifest
    else:
        manifest = candidate_manifest
        write_spec_atomic(output, manifest)
    policy.update(
        {
            "enabled": True,
            "decision": "required",
            "decisionReason": (
                "Blockout planning requires hidden-view evidence; a cached 2x2 turnaround was registered."
            ),
            "generator": "built-in-imagegen",
            "promptVersion": selected_prompt,
            "layoutId": layout_id or "",
            "manifestPath": str(output),
            "manifestSha256": file_sha256(output),
            "cacheKey": cache_key,
        }
    )
    document.resolved["viewHypothesisPolicy"] = policy
    save_document(document, path)
    integrity_failures = hypothesis_manifest_failures(path, document.resolved)
    if integrity_failures:
        raise ValueError(
            "registered view hypotheses failed integrity validation: "
            + "; ".join(integrity_failures)
        )
    return {
        "ok": True,
        "cacheHit": cache_hit,
        "cacheKey": cache_key,
        "manifest": str(output),
        "registeredViews": sorted(existing_views),
        "requiredViews": sorted(required),
        "layoutId": layout_id or "",
        "turnaroundImage": root_provenance.get("turnaroundImage", ""),
        "turnaroundSha256": root_provenance.get("turnaroundSha256", ""),
    }


def status(spec_path: Path) -> dict[str, Any]:
    from sculpt_modules import load_document

    path = spec_path.expanduser().resolve()
    document = load_document(path)
    spec = document.resolved
    policy = _policy(spec)
    failures = hypothesis_manifest_failures(path, spec)
    turnaround_image = ""
    turnaround_sha256 = ""
    try:
        if policy.get("manifestPath"):
            manifest = _read_object(
                _registered_manifest_path(path, policy),
                "view hypothesis manifest",
            )
            turnaround_image = str(manifest.get("turnaroundImage") or "")
            turnaround_sha256 = str(manifest.get("turnaroundSha256") or "")
    except (OSError, ValueError):
        pass
    return {
        "enabled": policy.get("enabled") is True,
        "ready": policy.get("enabled") is not True or not failures,
        "requiredViews": _required_views(spec),
        "manifest": policy.get("manifestPath", ""),
        "cacheKey": policy.get("cacheKey", ""),
        "layoutId": policy.get("layoutId", ""),
        "turnaroundImage": turnaround_image,
        "turnaroundSha256": turnaround_sha256,
        "failures": failures,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    register = subparsers.add_parser("register", help="Register built-in ImageGen outputs once")
    register.add_argument("spec", type=Path)
    # Keep the legacy no-argument cache-refresh path while preventing mixed
    # per-view and 2x2 registrations.
    inputs = register.add_mutually_exclusive_group()
    inputs.add_argument("--view", action="append", default=[])
    inputs.add_argument(
        "--sheet",
        type=Path,
        help=(
            "One edge-to-edge 2x2 sheet matching the spec's standard or exploded layout"
        ),
    )
    register.add_argument("--prompt-version")
    inspect = subparsers.add_parser("status", help="Check source/hash/view cache freshness")
    inspect.add_argument("spec", type=Path)
    args = parser.parse_args(argv)
    result = (
        register_views(
            args.spec,
            args.view,
            args.prompt_version,
            args.sheet,
        )
        if args.command == "register"
        else status(args.spec)
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok", result.get("ready")) is True else 1


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
