#!/usr/bin/env python3
"""Record explicit user approval or structured phase-change feedback."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sculpt_contract import (
    pipeline_status,
    record_user_phase_decision,
    sync_pipeline,
)
from sculpt_modules import (
    is_module_manifest,
    load_document,
    module_status,
    read_raw_spec,
    save_document,
)


def _feedback_payload(value: str | None) -> list[dict[str, Any]]:
    if not value:
        return []
    candidate = Path(value).expanduser()
    text = candidate.read_text(encoding="utf-8") if candidate.is_file() else value
    payload = json.loads(text)
    if not isinstance(payload, list):
        raise ValueError("--feedback-json must be a JSON array")
    return [dict(item) for item in payload if isinstance(item, dict)]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--pass-id", required=True)
    parser.add_argument(
        "--decision",
        required=True,
        choices=("approved", "changes-requested"),
    )
    parser.add_argument(
        "--user-statement",
        required=True,
        help="The user's explicit approval or change request, copied without invention.",
    )
    parser.add_argument(
        "--feedback-json",
        help=(
            "For changes-requested: JSON array/file of "
            "{visualRegion,problem,expectedDirection}."
        ),
    )
    args = parser.parse_args(argv)
    path = args.spec.expanduser().resolve()
    raw = read_raw_spec(path)
    if is_module_manifest(raw):
        status = module_status(path, raw)
        if not status.get("assemblyReady"):
            raise ValueError(
                "user phase approval is locked until every required module is accepted"
            )
    document = load_document(path, allow_missing=False)
    record = record_user_phase_decision(
        document.resolved,
        args.pass_id,
        args.decision,
        user_statement=args.user_statement,
        feedback=_feedback_payload(args.feedback_json),
    )
    sync_pipeline(document.resolved)
    save_document(document)
    print(
        json.dumps(
            {
                "ok": True,
                "record": record,
                "status": pipeline_status(document.resolved),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
