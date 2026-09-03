from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from sculpt_checkpoint import (  # noqa: E402
    CheckpointError,
    capture_checkpoint,
    restore_checkpoint,
    verify_checkpoint,
)


class CheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = self.root / ".sculpt-cache" / "checkpoints"

    def test_multi_file_capture_verify_and_restore(self) -> None:
        spec = self.root / "object-sculpt.json"
        source = self.root / "src" / "model.ts"
        source.parent.mkdir(parents=True)
        spec.write_text('{"target":"original"}\n', encoding="utf-8")
        source.write_text("export const revision = 1;\n", encoding="utf-8")

        checkpoint = capture_checkpoint(
            self.root,
            self.store,
            [spec, source],
            roles={spec: ["manifest", "spec"], source: "implementation"},
            metadata={"phase": "form"},
        )
        manifest = verify_checkpoint(checkpoint, self.root)
        by_path = {record["path"]: record for record in manifest["files"]}
        self.assertEqual(by_path["object-sculpt.json"]["roles"], ["manifest", "spec"])
        self.assertEqual(by_path["src/model.ts"]["roles"], ["implementation"])

        spec.write_text('{"target":"challenger"}\n', encoding="utf-8")
        source.write_text("export const revision = 2;\n", encoding="utf-8")
        result = restore_checkpoint(checkpoint, self.root)

        self.assertEqual(spec.read_text(encoding="utf-8"), '{"target":"original"}\n')
        self.assertEqual(source.read_text(encoding="utf-8"), "export const revision = 1;\n")
        self.assertEqual(result["restored"], ["object-sculpt.json", "src/model.ts"])

    def test_tampered_blob_is_rejected_before_any_partial_restore(self) -> None:
        first = self.root / "first.txt"
        second = self.root / "second.txt"
        first.write_text("first baseline", encoding="utf-8")
        second.write_text("second baseline", encoding="utf-8")
        checkpoint = capture_checkpoint(self.root, self.store, [first, second])
        manifest = verify_checkpoint(checkpoint)
        second_record = next(record for record in manifest["files"] if record["path"] == "second.txt")
        blob_root = checkpoint.parents[2] / "blobs"
        (blob_root / second_record["sha256"]).write_text("tampered", encoding="utf-8")

        first.write_text("first challenger", encoding="utf-8")
        second.write_text("second challenger", encoding="utf-8")
        with self.assertRaisesRegex(CheckpointError, "integrity verification"):
            restore_checkpoint(checkpoint)

        self.assertEqual(first.read_text(encoding="utf-8"), "first challenger")
        self.assertEqual(second.read_text(encoding="utf-8"), "second challenger")

    def test_commit_failure_rolls_back_already_replaced_files(self) -> None:
        first = self.root / "first.txt"
        second = self.root / "second.txt"
        first.write_text("first baseline", encoding="utf-8")
        second.write_text("second baseline", encoding="utf-8")
        checkpoint = capture_checkpoint(self.root, self.store, [first, second])
        first.write_text("first challenger", encoding="utf-8")
        second.write_text("second challenger", encoding="utf-8")
        first.chmod(0o640)
        second.chmod(0o600)
        original_modes = (first.stat().st_mode & 0o777, second.stat().st_mode & 0o777)

        real_replace = os.replace
        restore_commits = 0

        def fail_second_restore(source: str, destination: str) -> None:
            nonlocal restore_commits
            if Path(source).name.startswith(".checkpoint-restore-"):
                restore_commits += 1
                if restore_commits == 2:
                    raise OSError("simulated second-file commit failure")
            real_replace(source, destination)

        with mock.patch("sculpt_checkpoint.os.replace", side_effect=fail_second_restore):
            with self.assertRaisesRegex(CheckpointError, "simulated second-file commit failure"):
                restore_checkpoint(checkpoint)

        self.assertEqual(first.read_text(encoding="utf-8"), "first challenger")
        self.assertEqual(second.read_text(encoding="utf-8"), "second challenger")
        self.assertEqual(
            (first.stat().st_mode & 0o777, second.stat().st_mode & 0o777),
            original_modes,
        )

    def test_outside_project_paths_are_rejected(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside.txt"
        outside.write_text("outside", encoding="utf-8")
        self.addCleanup(outside.unlink, missing_ok=True)

        with self.assertRaisesRegex(CheckpointError, "escapes the project root"):
            capture_checkpoint(self.root, self.store, [outside])

    def test_absent_file_is_metadata_and_restore_never_deletes_new_file(self) -> None:
        missing = self.root / "review" / "future.png"
        checkpoint = capture_checkpoint(
            self.root,
            self.store,
            [missing],
            roles={missing: "evidence"},
        )
        manifest = verify_checkpoint(checkpoint)
        self.assertEqual(
            manifest["files"],
            [
                {
                    "path": "review/future.png",
                    "roles": ["evidence"],
                    "exists": False,
                    "sha256": None,
                    "sizeBytes": 0,
                    "mode": None,
                }
            ],
        )

        missing.parent.mkdir(parents=True)
        missing.write_text("created after checkpoint", encoding="utf-8")
        result = restore_checkpoint(checkpoint)
        self.assertEqual(missing.read_text(encoding="utf-8"), "created after checkpoint")
        self.assertEqual(result["restored"], [])
        self.assertEqual(result["skippedAbsent"], ["review/future.png"])

    def test_identical_content_and_repeated_capture_are_stably_deduplicated(self) -> None:
        first = self.root / "a.bin"
        second = self.root / "nested" / "b.bin"
        second.parent.mkdir(parents=True)
        first.write_bytes(b"same immutable payload")
        second.write_bytes(b"same immutable payload")
        roles = {first: "code", second: "factory"}

        first_checkpoint = capture_checkpoint(
            self.root,
            self.store,
            [second, first],
            roles=roles,
            metadata={"phase": "form"},
        )
        second_checkpoint = capture_checkpoint(
            self.root,
            self.store,
            [first, second],
            roles=roles,
            metadata={"phase": "form"},
        )
        manifest = json.loads(first_checkpoint.read_text(encoding="utf-8"))

        self.assertEqual(first_checkpoint, second_checkpoint)
        self.assertEqual(len({record["sha256"] for record in manifest["files"]}), 1)
        self.assertEqual(len(list((self.store / "blobs").iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
