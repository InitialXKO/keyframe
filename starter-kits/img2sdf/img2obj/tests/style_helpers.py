from __future__ import annotations

from typing import Any

from sculpt_style import make_unassessed_visual_style, sync_visual_style


TEST_STYLE_PRIMARIES = {
    "realism": "stylized",
    "formTreatment": "simplified-rounded",
    "proportionTreatment": "literal",
    "detailTreatment": "selective",
    "shadingTreatment": "physically-plausible-stylized",
    "surfaceTreatment": "clean-uniform",
    "edgeTreatment": "none",
    "paletteTreatment": "source-natural",
    "mediumEmulation": "none",
}


def make_assessed_visual_style(
    overrides: dict[str, str] | None = None,
    evidence_ref: str = "full-object",
) -> dict[str, Any]:
    style = make_unassessed_visual_style()
    primaries = {**TEST_STYLE_PRIMARIES, **(overrides or {})}
    style["status"] = "assessed"
    for axis, primary in primaries.items():
        style["axes"][axis].update(
            {
                "primary": primary,
                "confidence": 0.9,
                "evidenceRefs": [evidence_ref],
                "cues": [f"Observed {axis} cue in the test reference."],
            }
        )
    return sync_visual_style(style)
