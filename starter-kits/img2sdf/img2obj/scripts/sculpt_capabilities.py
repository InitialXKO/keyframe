#!/usr/bin/env python3
"""Executable component capability registry and routing report."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class CapabilityPack:
    id: str
    triggers: tuple[str, ...]
    phases: tuple[str, ...]
    representations: tuple[str, ...]
    emitters: tuple[str, ...]
    operators: tuple[str, ...]
    editable_roots: tuple[str, ...]
    reference: str

    def manifest(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "triggers": list(self.triggers),
            "phases": list(self.phases),
            "representations": list(self.representations),
            "emitters": list(self.emitters),
            "operators": list(self.operators),
            "editableRoots": list(self.editable_roots),
            "reference": self.reference,
        }


PACKS = (
    CapabilityPack(
        "hard-surface-machinery",
        ("machine", "metal", "panel", "frame", "fastener", "bolt", "gear", "housing", "tool", "vehicle"),
        ("blockout", "form", "lookdev", "interaction"),
        ("true-geometry", "proxy-geometry", "decal", "hybrid"),
        ("box", "cylinder", "lathe", "extrude", "section-loft", "instanced-cluster"),
        (
            "set-bevel-profile",
            "repair-attachment",
            "retune-panel-proportion",
            "retune-hard-surface-material",
        ),
        ("componentTree", "surfaceTopologyPlan", "repetitionSystems", "materials"),
        "references/patterns/hard-surface-machinery.md",
    ),
    CapabilityPack(
        "organic-skin-eyes",
        ("skin", "face", "eye", "iris", "mouth", "nose", "flesh", "muzzle", "ear"),
        ("blockout", "form", "lookdev", "interaction"),
        ("true-geometry", "material-response", "hybrid"),
        ("sculpted-surface", "section-loft", "ellipsoid", "sphere"),
        ("adjust-organic-landmark", "repair-gaze", "retune-skin-response"),
        ("componentTree", "preSpecAssessment.specializedRegions", "materials"),
        "references/patterns/organic-skin-eyes.md",
    ),
    CapabilityPack(
        "hair-fur-fiber",
        ("hair", "fur", "fiber", "bristle", "feather", "strand", "fuzz"),
        ("form", "lookdev", "interaction"),
        ("card", "true-geometry", "material-response", "hybrid"),
        ("fiber-system", "plane-card", "surface-scatter", "instanced-cluster"),
        ("set-fiber-flow", "retune-fiber-density", "repair-fiber-root"),
        ("componentTree", "repetitionSystems", "materials", "interactionContract"),
        "references/patterns/hair-fur-fiber.md",
    ),
    CapabilityPack(
        "fabric-cloth",
        ("fabric", "cloth", "garment", "strap", "curtain", "flag", "upholstery", "woven"),
        ("form", "lookdev", "interaction"),
        ("true-geometry", "proxy-geometry", "material-response", "hybrid"),
        ("conforming-shell", "deformable-surface", "plane-card"),
        ("edit-fold-field", "repair-cloth-anchor", "retune-cloth-response"),
        ("componentTree", "surfaceTopologyPlan", "materials", "interactionContract"),
        "references/patterns/fabric-cloth.md",
    ),
    CapabilityPack(
        "transmissive-surfaces",
        ("glass", "liquid", "lens", "crystal", "transparent", "transmissive", "clear-cover"),
        ("form", "lookdev"),
        ("true-geometry", "material-response", "hybrid"),
        ("section-loft", "sphere", "cylinder", "implicit-surface"),
        ("retune-transmission", "repair-wall-thickness", "separate-transparent-layers"),
        ("componentTree", "materials", "lookDevTargets"),
        "references/patterns/transmissive-surfaces.md",
    ),
    CapabilityPack(
        "vegetation",
        ("tree", "trunk", "branch", "stem", "leaf", "foliage", "grass", "root-system", "plant"),
        ("blockout", "form", "lookdev", "interaction"),
        ("true-geometry", "card", "proxy-geometry", "hybrid"),
        ("branch-network", "curve-sweep", "surface-scatter", "plane-card", "instanced-cluster"),
        ("repair-branch-junction", "retune-taper", "redistribute-foliage"),
        ("componentTree", "repetitionSystems", "materials", "interactionContract"),
        "references/patterns/vegetation.md",
    ),
    CapabilityPack(
        "terrain-landform",
        (
            "terrain", "landform", "ground-surface", "soil", "rock", "stone",
            "boulder", "cliff", "canyon", "mountain", "pebble",
        ),
        ("blockout", "form", "lookdev"),
        ("true-geometry", "material-response", "hybrid"),
        ("deformable-surface", "sculpted-surface", "instanced-cluster", "ellipsoid"),
        ("reshape-landform", "redistribute-rocks", "retune-earth-material"),
        ("componentTree", "surfaceTopologyPlan", "materials"),
        "references/patterns/procedural-landform-generation.md",
    ),
    CapabilityPack(
        "procedural-motion",
        ("rotor", "hinge", "slide", "wheel", "lever", "piston", "sway", "pivot", "motion"),
        ("blockout", "form", "interaction"),
        ("true-geometry", "procedural-effect", "hybrid"),
        (),
        ("set-pivot-axis-limits", "repair-motion-clearance"),
        ("componentTree", "interactionContract"),
        "references/patterns/procedural-motion.md",
    ),
    CapabilityPack(
        "effects-emissive-volume",
        ("emissive", "glow", "energy", "smoke", "fog", "aura", "volume"),
        ("lookdev", "interaction"),
        ("material-response", "procedural-effect", "hybrid"),
        ("volume-field", "implicit-surface"),
        ("retune-emission", "retune-volume-density"),
        ("materials", "lookDevTargets", "componentTree"),
        "references/patterns/effects-emissive-volume.md",
    ),
    CapabilityPack(
        "markings-decals-text",
        ("decal", "marking", "logo", "label", "text", "symbol", "stripe"),
        ("form", "lookdev"),
        ("decal", "material-response", "hybrid"),
        ("plane-card",),
        ("place-decal", "retune-marking-contrast"),
        ("componentTree", "materials", "featureReviewTargets"),
        "references/patterns/markings-decals-text.md",
    ),
    CapabilityPack(
        "review-render-quality",
        (),
        ("blockout", "form", "lookdev", "interaction"),
        ("procedural-effect",),
        (),
        ("retune-render-quality",),
        ("viewingContract",),
        "references/browser-screenshot-feedback.md",
    ),
)

PACK_BY_ID = {pack.id: pack for pack in PACKS}
OPERATOR_TO_PACK = {
    operator: pack.id for pack in PACKS for operator in pack.operators
}
def registry_failures() -> list[str]:
    from sculpt_geometry import VALID_PRIMITIVES

    failures: list[str] = []
    pack_ids = [pack.id for pack in PACKS]
    if len(pack_ids) != len(set(pack_ids)):
        failures.append("capability pack ids must be unique")
    operators = [operator for pack in PACKS for operator in pack.operators]
    if len(operators) != len(set(operators)):
        failures.append("capability operators must have exactly one owner")
    for pack in PACKS:
        unsupported = sorted(
            emitter
            for emitter in pack.emitters
            if emitter not in VALID_PRIMITIVES
        )
        if unsupported:
            failures.append(
                f"capability pack {pack.id!r} declares unsupported emitters: "
                + ", ".join(unsupported)
            )
    return failures


def _text_tokens(value: Any) -> str:
    if isinstance(value, Mapping):
        return " ".join(_text_tokens(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_text_tokens(item) for item in value)
    return str(value or "").lower()


def matched_pack_ids(component: Mapping[str, Any], phase: str | None = None) -> list[str]:
    haystack = _text_tokens(
        {
            "id": component.get("id"),
            "name": component.get("name"),
            "role": component.get("role"),
            "primitive": component.get("primitive"),
            "geometryDescriptor": component.get("geometryDescriptor"),
            "detailPlan": component.get("detailPlan"),
            "localFeatures": component.get("localFeatures"),
        }
    )
    normalized = " " + re.sub(r"[^a-z0-9]+", " ", haystack).strip() + " "
    return [
        pack.id
        for pack in PACKS
        if pack.triggers
        if (phase is None or phase in pack.phases)
        and any(
            " " + re.sub(r"[^a-z0-9]+", " ", trigger).strip() + " " in normalized
            for trigger in pack.triggers
        )
    ]


def capability_report(spec: Mapping[str, Any], phase: str | None = None) -> dict[str, Any]:
    routes: list[dict[str, Any]] = []
    global_routes: list[dict[str, Any]] = []
    active: set[str] = set()
    unmatched: list[str] = []
    for component in spec.get("componentTree", []):
        if not isinstance(component, Mapping) or component.get("componentType") == "assembly":
            continue
        component_id = str(component.get("id") or "")
        matched = matched_pack_ids(component, phase)
        if matched:
            active.update(matched)
            routes.append({"componentId": component_id, "packIds": matched})
        elif component_id:
            unmatched.append(component_id)
    viewing = spec.get("viewingContract")
    render_pipeline = (
        viewing.get("renderPipeline") if isinstance(viewing, Mapping) else None
    )
    render_pack = PACK_BY_ID["review-render-quality"]
    if (
        isinstance(render_pipeline, Mapping)
        and render_pipeline.get("status") == "required"
        and (phase is None or phase in render_pack.phases)
    ):
        active.add(render_pack.id)
        global_routes.append(
            {"targetType": "global", "targetId": "render-pipeline", "packIds": [render_pack.id]}
        )
    return {
        "artifactType": "threejs-sculpt-capability-report",
        "version": 1,
        "phase": phase or "all",
        "activePacks": sorted(active),
        "componentRoutes": routes,
        "globalRoutes": global_routes,
        "unmatchedComponents": unmatched,
        "capabilityGaps": copy.deepcopy(
            spec.get("capabilityPlan", {}).get("capabilityGaps", [])
            if isinstance(spec.get("capabilityPlan"), Mapping)
            else []
        ),
        "lazyExpansionRule": (
            "Keep all matched manifests available; expand full instructions only for packs "
            "that own one of the active perceptual blockers."
        ),
        "packs": [PACK_BY_ID[pack_id].manifest() for pack_id in sorted(active)],
    }


def synchronize_capability_plan(spec: dict[str, Any], phase: str | None = None) -> dict[str, Any]:
    report = capability_report(spec, phase)
    plan = spec.setdefault("capabilityPlan", {})
    if not isinstance(plan, dict):
        raise ValueError("capabilityPlan must be an object")
    plan.update(
        {
            "version": 1,
            "status": "routed" if report["activePacks"] else "unassessed",
            "activePacks": report["activePacks"],
            "componentRoutes": report["componentRoutes"],
            "globalRoutes": report["globalRoutes"],
            "capabilityGaps": report["capabilityGaps"],
            "routingPolicy": "composable-component-packs-lazy-expanded-by-active-blocker",
        }
    )
    return report


def validate_capability_plan(spec: Mapping[str, Any]) -> list[str]:
    plan = spec.get("capabilityPlan")
    if plan is None:
        return []
    if not isinstance(plan, Mapping):
        return ["capabilityPlan must be an object"]
    failures: list[str] = registry_failures()
    active = plan.get("activePacks", [])
    if not isinstance(active, list):
        failures.append("capabilityPlan.activePacks must be an array")
    else:
        unknown = sorted({str(item) for item in active if item not in PACK_BY_ID})
        if unknown:
            failures.append("capabilityPlan.activePacks contains unknown packs: " + ", ".join(unknown))
    routes = plan.get("componentRoutes", [])
    if not isinstance(routes, list):
        failures.append("capabilityPlan.componentRoutes must be an array")
    global_routes = plan.get("globalRoutes", [])
    if not isinstance(global_routes, list):
        failures.append("capabilityPlan.globalRoutes must be an array")
    else:
        for index, route in enumerate(global_routes):
            if not isinstance(route, Mapping):
                failures.append(
                    f"capabilityPlan.globalRoutes[{index}] must be an object"
                )
                continue
            pack_ids = route.get("packIds")
            if (
                route.get("targetType") != "global"
                or route.get("targetId") != "render-pipeline"
                or not isinstance(pack_ids, list)
                or any(pack_id not in PACK_BY_ID for pack_id in pack_ids)
            ):
                failures.append(
                    f"capabilityPlan.globalRoutes[{index}] is invalid"
                )
    gaps = plan.get("capabilityGaps", [])
    if not isinstance(gaps, list):
        failures.append("capabilityPlan.capabilityGaps must be an array")
    else:
        for index, gap in enumerate(gaps):
            if not isinstance(gap, Mapping):
                failures.append(f"capabilityPlan.capabilityGaps[{index}] must be an object")
                continue
            if gap.get("status") not in {"resolved", "out-of-contract"}:
                failures.append(
                    f"capabilityPlan.capabilityGaps[{index}] is unresolved"
                )
    return failures


def main(argv: list[str]) -> int:
    from sculpt_contract import load_spec_file, sync_pipeline, write_spec_atomic

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--phase", choices=("blockout", "form", "lookdev", "interaction"))
    parser.add_argument("--in-place", action="store_true")
    args = parser.parse_args(argv)
    path = args.spec.expanduser().resolve()
    spec = load_spec_file(path)
    persisted_report = synchronize_capability_plan(spec)
    report = capability_report(spec, args.phase) if args.phase else persisted_report
    if args.in_place:
        revision = spec.get("specRevision", 0)
        spec["specRevision"] = revision + 1 if isinstance(revision, int) else 1
        sync_pipeline(spec)
        write_spec_atomic(path, spec)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
