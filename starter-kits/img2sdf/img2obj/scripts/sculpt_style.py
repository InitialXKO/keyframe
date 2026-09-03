#!/usr/bin/env python3
"""Executable visual-style classification for procedural sculpt specs."""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping
from typing import Any


STYLE_AXIS_VALUES: dict[str, tuple[str, ...]] = {
    "realism": (
        "hyper-realistic",
        "photorealistic",
        "naturalistic",
        "idealized-realistic",
        "semi-realistic",
        "stylized",
        "abstract-representational",
        "nonrepresentational",
        "other",
    ),
    "formTreatment": (
        "literal",
        "simplified-rounded",
        "simplified-geometric",
        "faceted",
        "voxelized",
        "inflated",
        "hand-sculpted",
        "flattened-relief",
        "deconstructed",
        "fragmented",
        "surreal-distorted",
        "amorphous",
        "other",
    ),
    "proportionTreatment": (
        "literal",
        "idealized",
        "heroic",
        "exaggerated",
        "chibi",
        "super-deformed",
        "caricatured",
        "elongated",
        "compact",
        "toy-like",
        "other",
    ),
    "detailTreatment": (
        "literal-complete",
        "selective",
        "simplified",
        "iconic",
        "ornamental",
        "amplified",
        "handcrafted-irregular",
        "procedural-patterned",
        "other",
    ),
    "shadingTreatment": (
        "physically-based",
        "physically-plausible-stylized",
        "smooth-lit",
        "flat-lit",
        "unlit",
        "toon-ramp",
        "cel-banded",
        "painterly",
        "matcap-like",
        "emissive-dominant",
        "other",
    ),
    "surfaceTreatment": (
        "literal-material",
        "clean-uniform",
        "hand-painted",
        "painterly-brushwork",
        "graphic-flat-fill",
        "photographic-projection",
        "procedural-pattern",
        "pixelated",
        "stippled",
        "hatched",
        "mosaic-tiled",
        "distressed",
        "handcrafted-imprint",
        "other",
    ),
    "edgeTreatment": (
        "none",
        "silhouette-outline",
        "silhouette-and-crease",
        "inked",
        "sketched",
        "brush-line",
        "technical-line",
        "hidden-line",
        "other",
    ),
    "paletteTreatment": (
        "source-natural",
        "graded-natural",
        "limited",
        "monochrome",
        "duotone",
        "pastel",
        "muted",
        "high-saturation",
        "high-contrast",
        "color-blocked",
        "neon-emissive",
        "other",
    ),
    "mediumEmulation": (
        "none",
        "clay",
        "plasticine",
        "paper-craft",
        "painted-miniature",
        "wood-carving",
        "ceramic-figurine",
        "stop-motion-handmade",
        "oil-paint",
        "watercolor",
        "ink",
        "pencil",
        "pixel-art",
        "mosaic",
        "other",
    ),
}

STYLE_PHASE_AXES: dict[str, tuple[str, ...]] = {
    "blockout": ("realism", "formTreatment", "proportionTreatment"),
    "form": (
        "realism",
        "formTreatment",
        "proportionTreatment",
        "detailTreatment",
    ),
    "lookdev": tuple(STYLE_AXIS_VALUES),
    "interaction": tuple(STYLE_AXIS_VALUES),
}

_AXIS_DIRECTIVES = {
    "realism": "Match the declared realism level without inventing detail absent from sourceImage.",
    "formTreatment": "Build silhouettes and masses with the declared form treatment.",
    "proportionTreatment": "Preserve the declared proportion logic across all major parts.",
    "detailTreatment": "Select, simplify, or amplify detail only as declared.",
    "shadingTreatment": "Use a lighting and shader response that implements the declared shading treatment.",
    "surfaceTreatment": "Implement the declared surface mark and texture treatment.",
    "edgeTreatment": "Apply the declared edge-line treatment consistently and only where visible.",
    "paletteTreatment": "Match the declared palette organization and source-relative color relationships.",
    "mediumEmulation": "Emulate the declared medium through buildable geometry and material cues.",
}

_STYLE_FIELDS = {
    "status",
    "axes",
    "influences",
    "derivation",
    "overallStyleProfile",
    "notes",
}
_AXIS_FIELDS = {
    "primary",
    "modifiers",
    "custom",
    "confidence",
    "evidenceRefs",
    "cues",
}
_CUSTOM_FIELDS = {"role", "label", "definition"}
_INFLUENCE_FIELDS = {
    "id",
    "label",
    "affectedAxes",
    "confidence",
    "evidenceRefs",
}


def canonical_style_phase(pass_id: str) -> str:
    if pass_id in {"structure", "structural-pass", "form-refinement"}:
        return "form"
    if pass_id in {"material-pass", "surface-pass", "lighting-pass"}:
        return "lookdev"
    if pass_id in {"interaction-pass", "optimization", "optimization-pass"}:
        return "interaction"
    return pass_id


def make_unassessed_visual_style() -> dict[str, Any]:
    profile = {
        "status": "unassessed",
        "axes": {
            axis: {
                "primary": "unassessed",
                "modifiers": [],
                "custom": [],
                "confidence": None,
                "evidenceRefs": [],
                "cues": [],
            }
            for axis in STYLE_AXIS_VALUES
        },
        "influences": [],
        "derivation": {
            "family": "unassessed",
            "archetypeLabels": [],
            "customLabel": "",
        },
        "notes": "",
    }
    profile["overallStyleProfile"] = derive_overall_style_profile(profile)
    return profile


def _axis_values(profile: Mapping[str, Any], axis: str) -> set[str]:
    axes = profile.get("axes")
    value = axes.get(axis) if isinstance(axes, Mapping) else None
    if not isinstance(value, Mapping):
        return set()
    result = {
        str(item)
        for item in value.get("modifiers", [])
        if isinstance(item, str)
    }
    primary = value.get("primary")
    if isinstance(primary, str):
        result.add(primary)
    return result


def _influence_tokens(profile: Mapping[str, Any]) -> set[str]:
    tokens: set[str] = set()
    influences = profile.get("influences")
    if not isinstance(influences, list):
        return tokens
    for item in influences:
        if not isinstance(item, Mapping):
            continue
        for field in ("id", "label"):
            value = item.get(field)
            if isinstance(value, str):
                tokens.add(value.strip().lower().replace("_", "-").replace(" ", "-"))
    return tokens


def derive_visual_style(profile: Mapping[str, Any]) -> dict[str, Any]:
    if profile.get("status") != "assessed":
        return {
            "family": "unassessed",
            "archetypeLabels": [],
            "customLabel": "",
        }

    realism = _axis_values(profile, "realism")
    family_tokens: set[str] = set()
    if realism & {
        "hyper-realistic",
        "photorealistic",
        "naturalistic",
        "idealized-realistic",
    }:
        family_tokens.add("realistic")
    if "stylized" in realism:
        family_tokens.add("stylized")
    if "semi-realistic" in realism:
        family_tokens.update({"realistic", "stylized"})
    if realism & {"abstract-representational", "nonrepresentational"}:
        family_tokens.add("abstract")
    if "other" in realism:
        family_tokens.add("other")
    known_families = family_tokens - {"other"}
    if len(known_families) > 1 or ("other" in family_tokens and known_families):
        family = "hybrid"
    elif known_families:
        family = next(iter(known_families))
    else:
        family = "other"

    form = _axis_values(profile, "formTreatment")
    proportion = _axis_values(profile, "proportionTreatment")
    detail = _axis_values(profile, "detailTreatment")
    shading = _axis_values(profile, "shadingTreatment")
    surface = _axis_values(profile, "surfaceTreatment")
    palette = _axis_values(profile, "paletteTreatment")
    medium = _axis_values(profile, "mediumEmulation")
    influences = _influence_tokens(profile)
    labels: list[str] = []

    def add(label: str, condition: bool) -> None:
        if condition and label not in labels:
            labels.append(label)

    add("Hyper-Realistic", "hyper-realistic" in realism)
    add("Photorealistic", "photorealistic" in realism)
    add("Standard Realistic", "naturalistic" in realism)
    add("Semi-Realistic", "semi-realistic" in realism)
    add("Abstract 3D", bool(realism & {"abstract-representational", "nonrepresentational"}))
    add(
        "Surrealism 3D",
        "surreal-distorted" in form
        and bool(realism & {"abstract-representational", "nonrepresentational"}),
    )
    add("Low Poly", "faceted" in form and bool(detail & {"simplified", "iconic"}))
    add(
        "High Poly Stylized",
        "stylized" in realism and bool(detail & {"ornamental", "amplified"}),
    )
    add("Toon Shading", "toon-ramp" in shading)
    add("Cel-Shading", "cel-banded" in shading)
    add("Anime Stylized", bool(influences & {"anime", "anime-stylized"}))
    add("Chibi Cute", bool(proportion & {"chibi", "super-deformed"}))
    add("Hand-Painted 3D", "hand-painted" in surface)
    add(
        "Claymation Art",
        bool(medium & {"clay", "stop-motion-handmade"}),
    )
    add("Plasticine Style", "plasticine" in medium)
    add("Voxel Art", "voxelized" in form)
    add(
        "Gritty Realism",
        family == "realistic" and "distressed" in surface,
    )
    add(
        "Dark Fantasy Realism",
        family == "realistic"
        and bool(influences & {"dark-fantasy", "dark-fantasy-realism"}),
    )
    add(
        "Flat Design 3D",
        "simplified-geometric" in form
        and bool(shading & {"flat-lit", "unlit"})
        and "graphic-flat-fill" in surface
        and "color-blocked" in palette,
    )

    custom_labels: list[str] = []
    axes = profile.get("axes")
    if isinstance(axes, Mapping):
        for axis in STYLE_AXIS_VALUES:
            value = axes.get(axis)
            custom = value.get("custom") if isinstance(value, Mapping) else None
            if not isinstance(custom, list):
                continue
            for item in custom:
                label = item.get("label") if isinstance(item, Mapping) else None
                if isinstance(label, str) and label.strip() and label not in custom_labels:
                    custom_labels.append(label.strip())
    return {
        "family": family,
        "archetypeLabels": labels,
        "customLabel": " + ".join(custom_labels),
    }


def sync_visual_style(profile: dict[str, Any]) -> dict[str, Any]:
    profile["derivation"] = derive_visual_style(profile)
    profile["overallStyleProfile"] = derive_overall_style_profile(profile)
    return profile


def visual_style_projection(profile: Any, pass_id: str) -> dict[str, Any]:
    if not isinstance(profile, Mapping):
        return {}
    phase = canonical_style_phase(pass_id)
    selected_axes = STYLE_PHASE_AXES.get(phase, tuple(STYLE_AXIS_VALUES))
    axes = profile.get("axes")
    axes = axes if isinstance(axes, Mapping) else {}
    projected_influences: list[dict[str, Any]] = []
    influences = profile.get("influences")
    if isinstance(influences, list):
        for item in influences:
            if not isinstance(item, Mapping):
                continue
            affected = item.get("affectedAxes")
            if isinstance(affected, list) and set(affected) & set(selected_axes):
                projected = copy.deepcopy(dict(item))
                projected["affectedAxes"] = [
                    axis for axis in affected if axis in selected_axes
                ]
                projected_influences.append(projected)
    return {
        "status": profile.get("status"),
        "axes": {
            axis: copy.deepcopy(axes.get(axis))
            for axis in selected_axes
            if axis in axes
        },
        "influences": projected_influences,
    }


def _overall_style_label(profile: Mapping[str, Any]) -> str:
    summary = derive_visual_style(profile)
    family = summary.get("family")
    if family == "unassessed":
        return ""
    family_label = str(family).replace("-", " ").title()
    details = [
        str(item)
        for item in summary.get("archetypeLabels", [])
        if isinstance(item, str) and item.strip()
    ]
    custom_label = summary.get("customLabel")
    if isinstance(custom_label, str) and custom_label.strip():
        details.append(custom_label.strip())
    influences = profile.get("influences")
    if isinstance(influences, list):
        for item in influences:
            label = item.get("label") if isinstance(item, Mapping) else None
            if not isinstance(label, str) or not label.strip():
                continue
            normalized = label.strip().lower()
            if not any(normalized in detail.lower() for detail in details):
                details.append(label.strip())
    details = list(dict.fromkeys(details))
    return f"{family_label}: {' + '.join(details)}" if details else family_label


def _observed_style_cues(profile: Mapping[str, Any]) -> list[str]:
    axes = profile.get("axes")
    if not isinstance(axes, Mapping):
        return []
    cues: list[str] = []
    for value in axes.values():
        if not isinstance(value, Mapping):
            continue
        observed = value.get("cues")
        if isinstance(observed, list):
            cues.extend(
                item.strip()
                for item in observed
                if isinstance(item, str) and item.strip()
            )
    return list(dict.fromkeys(cues))


def visual_style_directives(profile: Any, pass_id: str) -> list[str]:
    projected = visual_style_projection(profile, pass_id)
    if not projected:
        return []
    if projected.get("status") != "assessed":
        return ["Assess visual style from sourceImage before generating Blockout."]
    phase_label = _overall_style_label(projected)
    directives = [
        f"Overall style [{phase_label}]: keep this phase coherent with sourceImage."
    ]
    axes = projected.get("axes")
    if isinstance(axes, Mapping):
        for axis in STYLE_PHASE_AXES.get(
            canonical_style_phase(pass_id), tuple(STYLE_AXIS_VALUES)
        ):
            value = axes.get(axis)
            if not isinstance(value, Mapping):
                continue
            primary = value.get("primary")
            modifiers = value.get("modifiers")
            selection = [primary] if isinstance(primary, str) else []
            if isinstance(modifiers, list):
                selection.extend(item for item in modifiers if isinstance(item, str))
            custom = value.get("custom")
            custom_items = custom if isinstance(custom, list) else []
            custom_by_role = {
                item.get("role"): item
                for item in custom_items
                if isinstance(item, Mapping)
                and item.get("role") in {"primary", "modifier"}
            }
            rendered_selection: list[str] = []
            for index, item in enumerate(selection):
                if item != "other":
                    rendered_selection.append(item)
                    continue
                role = "primary" if index == 0 else "modifier"
                custom_value = custom_by_role.get(role, {})
                label = custom_value.get("label")
                definition = custom_value.get("definition")
                rendered_selection.append(
                    "other"
                    + (
                        f"[{label}: {definition}]"
                        if isinstance(label, str)
                        and label
                        and isinstance(definition, str)
                        and definition
                        else ""
                    )
                )
            directives.append(
                f"{axis}={'+'.join(rendered_selection)}: {_AXIS_DIRECTIVES[axis]}"
            )
    for item in projected.get("influences", []):
        if isinstance(item, Mapping):
            directives.append(
                "Influence "
                f"{item.get('label') or item.get('id')} applies only to "
                f"{', '.join(str(axis) for axis in item.get('affectedAxes', []))}."
            )
    return directives


def derive_overall_style_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    if profile.get("status") != "assessed":
        return {
            "label": "",
            "signatureTraits": [],
            "phaseDirectives": {phase: [] for phase in STYLE_PHASE_AXES},
        }
    return {
        "label": _overall_style_label(profile),
        "signatureTraits": _observed_style_cues(profile),
        "phaseDirectives": {
            phase: visual_style_directives(profile, phase)
            for phase in STYLE_PHASE_AXES
        },
    }


def _is_confidence(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and 0 <= float(value) <= 1
    )


def _validate_string_list(value: Any, label: str, errors: list[str]) -> bool:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        errors.append(f"{label} must be an array of non-empty strings")
        return False
    if len(value) != len(set(value)):
        errors.append(f"{label} must not contain duplicates")
        return False
    return True


def validate_visual_style(
    style: Any,
    evidence_ids: set[str] | None = None,
) -> tuple[list[str], list[str]]:
    path = "preSpecAssessment.visualStyle"
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(style, Mapping):
        return [f"{path} must be an object"], warnings

    unexpected = set(style) - _STYLE_FIELDS
    if unexpected:
        errors.append(f"{path} has unexpected fields: {', '.join(sorted(unexpected))}")
    status = style.get("status")
    if status not in {"unassessed", "assessed"}:
        errors.append(f"{path}.status must be 'unassessed' or 'assessed'")
    axes = style.get("axes")
    if not isinstance(axes, Mapping):
        errors.append(f"{path}.axes must be an object")
        axes = {}
    else:
        missing = set(STYLE_AXIS_VALUES) - set(axes)
        extra = set(axes) - set(STYLE_AXIS_VALUES)
        if missing:
            errors.append(f"{path}.axes missing axes: {', '.join(sorted(missing))}")
        if extra:
            errors.append(f"{path}.axes has unexpected axes: {', '.join(sorted(extra))}")

    completed_axes = 0
    for axis, registry in STYLE_AXIS_VALUES.items():
        axis_path = f"{path}.axes.{axis}"
        value = axes.get(axis)
        if not isinstance(value, Mapping):
            errors.append(f"{axis_path} must be an object")
            continue
        unexpected = set(value) - _AXIS_FIELDS
        if unexpected:
            errors.append(
                f"{axis_path} has unexpected fields: {', '.join(sorted(unexpected))}"
            )
        primary = value.get("primary")
        if primary not in {*registry, "unassessed"}:
            errors.append(
                f"{axis_path}.primary must be 'unassessed' or a registered value"
            )
        modifiers = value.get("modifiers")
        modifiers_ok = _validate_string_list(
            modifiers, f"{axis_path}.modifiers", errors
        )
        if isinstance(modifiers, list) and len(modifiers) > 2:
            errors.append(f"{axis_path}.modifiers supports at most 2 values")
        if modifiers_ok and isinstance(modifiers, list):
            invalid = [item for item in modifiers if item not in registry]
            if invalid:
                errors.append(
                    f"{axis_path}.modifiers contains unregistered values: "
                    + ", ".join(invalid)
                )
            if primary in modifiers:
                errors.append(f"{axis_path}.modifiers must not repeat primary")
            if "none" in modifiers:
                errors.append(f"{axis_path}.modifiers cannot contain 'none'")
            if primary == "none" and modifiers:
                errors.append(f"{axis_path} primary 'none' cannot have modifiers")

        custom = value.get("custom")
        custom_roles: list[str] = []
        if not isinstance(custom, list):
            errors.append(f"{axis_path}.custom must be an array")
        else:
            for index, item in enumerate(custom):
                item_path = f"{axis_path}.custom[{index}]"
                if not isinstance(item, Mapping):
                    errors.append(f"{item_path} must be an object")
                    continue
                unexpected = set(item) - _CUSTOM_FIELDS
                if unexpected:
                    errors.append(
                        f"{item_path} has unexpected fields: "
                        + ", ".join(sorted(unexpected))
                    )
                role = item.get("role")
                if role not in {"primary", "modifier"}:
                    errors.append(f"{item_path}.role must be primary or modifier")
                else:
                    custom_roles.append(str(role))
                for field in ("label", "definition"):
                    if not isinstance(item.get(field), str) or not item[field].strip():
                        errors.append(f"{item_path}.{field} must be a non-empty string")
            needs_primary = primary == "other"
            needs_modifier = isinstance(modifiers, list) and "other" in modifiers
            if custom_roles.count("primary") != (1 if needs_primary else 0):
                errors.append(
                    f"{axis_path}.custom must contain exactly one primary entry "
                    "iff primary is 'other'"
                )
            if custom_roles.count("modifier") != (1 if needs_modifier else 0):
                errors.append(
                    f"{axis_path}.custom must contain exactly one modifier entry "
                    "iff modifiers contains 'other'"
                )

        confidence = value.get("confidence")
        evidence_refs = value.get("evidenceRefs")
        cues = value.get("cues")
        refs_ok = _validate_string_list(
            evidence_refs, f"{axis_path}.evidenceRefs", errors
        )
        cues_ok = _validate_string_list(cues, f"{axis_path}.cues", errors)
        if refs_ok and evidence_ids is not None:
            unknown = sorted(set(evidence_refs) - evidence_ids)
            if unknown:
                errors.append(
                    f"{axis_path}.evidenceRefs references unknown viewEvidence ids: "
                    + ", ".join(unknown)
                )
        if primary == "unassessed":
            if confidence is not None:
                errors.append(f"{axis_path}.confidence must be null when unassessed")
            if modifiers or custom or evidence_refs or cues:
                errors.append(
                    f"{axis_path} cannot carry modifiers, custom values, evidence, or cues while unassessed"
                )
        else:
            completed_axes += 1
            if not _is_confidence(confidence):
                errors.append(f"{axis_path}.confidence must be a number from 0 to 1")
            if refs_ok and not evidence_refs:
                errors.append(f"{axis_path}.evidenceRefs must not be empty when assessed")
            if cues_ok and not cues:
                errors.append(f"{axis_path}.cues must not be empty when assessed")

    influences = style.get("influences")
    influence_ids: list[str] = []
    if not isinstance(influences, list):
        errors.append(f"{path}.influences must be an array")
    else:
        for index, item in enumerate(influences):
            item_path = f"{path}.influences[{index}]"
            if not isinstance(item, Mapping):
                errors.append(f"{item_path} must be an object")
                continue
            unexpected = set(item) - _INFLUENCE_FIELDS
            if unexpected:
                errors.append(
                    f"{item_path} has unexpected fields: "
                    + ", ".join(sorted(unexpected))
                )
            for field in ("id", "label"):
                value = item.get(field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(f"{item_path}.{field} must be a non-empty string")
            if isinstance(item.get("id"), str):
                influence_ids.append(item["id"])
            affected = item.get("affectedAxes")
            if _validate_string_list(affected, f"{item_path}.affectedAxes", errors):
                if not affected:
                    errors.append(f"{item_path}.affectedAxes must not be empty")
                unknown = sorted(set(affected) - set(STYLE_AXIS_VALUES))
                if unknown:
                    errors.append(
                        f"{item_path}.affectedAxes contains unknown axes: "
                        + ", ".join(unknown)
                    )
            if not _is_confidence(item.get("confidence")):
                errors.append(f"{item_path}.confidence must be a number from 0 to 1")
            refs = item.get("evidenceRefs")
            if _validate_string_list(refs, f"{item_path}.evidenceRefs", errors):
                if not refs:
                    errors.append(f"{item_path}.evidenceRefs must not be empty")
                if evidence_ids is not None:
                    unknown = sorted(set(refs) - evidence_ids)
                    if unknown:
                        errors.append(
                            f"{item_path}.evidenceRefs references unknown viewEvidence ids: "
                            + ", ".join(unknown)
                        )
    if len(influence_ids) != len(set(influence_ids)):
        errors.append(f"{path}.influences ids must be unique")

    notes = style.get("notes")
    if not isinstance(notes, str):
        errors.append(f"{path}.notes must be a string")
    derivation = style.get("derivation")
    if not isinstance(derivation, Mapping):
        errors.append(f"{path}.derivation must be an object")
    else:
        expected_derivation_fields = {"family", "archetypeLabels", "customLabel"}
        missing = expected_derivation_fields - set(derivation)
        unexpected = set(derivation) - expected_derivation_fields
        if missing:
            errors.append(
                f"{path}.derivation missing fields: {', '.join(sorted(missing))}"
            )
        if unexpected:
            errors.append(
                f"{path}.derivation has unexpected fields: "
                + ", ".join(sorted(unexpected))
            )
        if derivation.get("family") not in {
            "unassessed",
            "realistic",
            "stylized",
            "abstract",
            "hybrid",
            "other",
        }:
            errors.append(f"{path}.derivation.family is invalid")
        _validate_string_list(
            derivation.get("archetypeLabels"),
            f"{path}.derivation.archetypeLabels",
            errors,
        )
        if not isinstance(derivation.get("customLabel"), str):
            errors.append(f"{path}.derivation.customLabel must be a string")
        if not errors:
            expected = derive_visual_style(style)
            if dict(derivation) != expected:
                warnings.append(
                    f"quality: {path}.derivation is stale; run pipeline synchronization"
                )

    overall_path = f"{path}.overallStyleProfile"
    overall_style = style.get("overallStyleProfile")
    if overall_style is None:
        warnings.append(
            f"quality: {overall_path} is missing; run pipeline synchronization"
        )
    elif not isinstance(overall_style, Mapping):
        errors.append(f"{overall_path} must be an object")
    else:
        expected_fields = {"label", "signatureTraits", "phaseDirectives"}
        missing = expected_fields - set(overall_style)
        unexpected = set(overall_style) - expected_fields
        if missing:
            errors.append(
                f"{overall_path} missing fields: {', '.join(sorted(missing))}"
            )
        if unexpected:
            errors.append(
                f"{overall_path} has unexpected fields: "
                + ", ".join(sorted(unexpected))
            )
        if dict(overall_style) != derive_overall_style_profile(style):
            warnings.append(
                f"quality: {overall_path} is stale; run pipeline synchronization"
            )

    if status == "assessed" and completed_axes != len(STYLE_AXIS_VALUES):
        errors.append(f"{path}.status cannot be assessed until every axis is assessed")
    elif status == "unassessed":
        warnings.append(f"quality: {path} is unassessed")
        if completed_axes == len(STYLE_AXIS_VALUES):
            warnings.append(
                f"quality: {path}.status is unassessed although every axis is complete"
            )
    return errors, warnings


def visual_style_assessment_gaps(style: Any) -> list[str]:
    if not isinstance(style, Mapping):
        return ["preSpecAssessment.visualStyle is required before blockout"]
    if style.get("status") != "assessed":
        return ["preSpecAssessment.visualStyle must be assessed before blockout build"]
    axes = style.get("axes")
    if not isinstance(axes, Mapping):
        return ["preSpecAssessment.visualStyle.axes is required before blockout"]
    missing = [
        axis
        for axis in STYLE_AXIS_VALUES
        if not isinstance(axes.get(axis), Mapping)
        or axes[axis].get("primary") in {None, "", "unassessed"}
    ]
    return (
        [
            "assess preSpecAssessment.visualStyle axes before blockout: "
            + ", ".join(missing)
        ]
        if missing
        else []
    )
