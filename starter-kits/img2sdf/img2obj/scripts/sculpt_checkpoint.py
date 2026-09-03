#!/usr/bin/env python3
"""Immutable, content-addressed checkpoints for project-scoped sculpt artifacts.

The module deliberately knows nothing about sculpt workflow state. Callers provide an
explicit file list, so cache/history files are never captured or restored implicitly.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Optional, Union


CHECKPOINT_ARTIFACT_TYPE = "threejs-sculpt-checkpoint"
CHECKPOINT_VERSION = 1
DEFAULT_ROLE = "artifact"

PathLike = Union[str, os.PathLike]
RoleValue = Union[str, Iterable[str]]


class CheckpointError(ValueError):
    """Raised when a checkpoint cannot be captured, verified, or restored safely."""


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise CheckpointError(f"checkpoint data is not canonical JSON: {exc}") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _project_root(value: PathLike) -> Path:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise CheckpointError(f"project root is not a directory: {root}")
    return root


def _store_root(project_root: Path, value: PathLike) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = project_root / candidate
    return candidate.resolve()


def _relative_target(project_root: Path, value: PathLike) -> tuple[str, Path]:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = project_root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        relative = resolved.relative_to(project_root)
    except ValueError as exc:
        raise CheckpointError(f"checkpoint target escapes the project root: {value}") from exc
    if relative == Path("."):
        raise CheckpointError("the project root directory cannot be checkpointed as a file")
    return relative.as_posix(), resolved


def _target_from_record(project_root: Path, relative_value: Any) -> Path:
    if not isinstance(relative_value, str) or not relative_value:
        raise CheckpointError("checkpoint file path must be a non-empty relative path")
    pure = PurePosixPath(relative_value)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise CheckpointError(f"checkpoint file path is unsafe: {relative_value!r}")
    lexical = project_root.joinpath(*pure.parts)
    resolved = lexical.resolve(strict=False)
    try:
        normalized = resolved.relative_to(project_root).as_posix()
    except ValueError as exc:
        raise CheckpointError(
            f"checkpoint target now escapes the project root: {relative_value!r}"
        ) from exc
    if normalized != relative_value:
        raise CheckpointError(
            f"checkpoint target no longer resolves to its recorded path: {relative_value!r}"
        )
    return resolved


def _normalize_roles(value: RoleValue) -> list[str]:
    values = [value] if isinstance(value, str) else list(value)
    roles = sorted(
        {
            item.strip()
            for item in values
            if isinstance(item, str) and item.strip()
        }
    )
    if not roles:
        raise CheckpointError("checkpoint file roles must contain a non-empty string")
    return roles


def _capture_blob(source: Path, blob_root: Path) -> tuple[str, int]:
    before = source.stat()
    if not stat.S_ISREG(before.st_mode) or source.is_symlink():
        raise CheckpointError(f"checkpoint source must be a regular non-symlink file: {source}")

    blob_root.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".capture-", dir=str(blob_root))
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as destination, source.open("rb") as source_handle:
            for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                destination.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        after = source.stat()
        stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise CheckpointError(f"checkpoint source changed while it was being captured: {source}")

        sha256 = digest.hexdigest()
        blob = blob_root / sha256
        if blob.exists():
            if not blob.is_file() or blob.is_symlink():
                raise CheckpointError(f"checkpoint blob path is not a regular file: {blob}")
            if blob.stat().st_size != size or _sha256_file(blob) != sha256:
                raise CheckpointError(f"existing checkpoint blob is corrupt: {blob}")
        else:
            os.replace(str(temporary), str(blob))
        return sha256, size
    finally:
        temporary.unlink(missing_ok=True)


def _write_immutable(path: Path, payload: bytes) -> None:
    if path.exists():
        if not path.is_file() or path.is_symlink() or path.read_bytes() != payload:
            raise CheckpointError(f"immutable checkpoint artifact conflicts with existing data: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".manifest-", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
    finally:
        temporary.unlink(missing_ok=True)


def capture_checkpoint(
    project_root: PathLike,
    store_root: PathLike,
    files: Iterable[PathLike],
    *,
    roles: Optional[Mapping[PathLike, RoleValue]] = None,
    metadata: Optional[Mapping[str, Any]] = None,
) -> Path:
    """Capture explicit project files and return the immutable manifest path.

    Relative file and store paths are resolved from ``project_root``. Missing files
    are recorded but never deleted by :func:`restore_checkpoint`. ``roles`` keys
    must name files in the explicit ``files`` iterable.
    """

    root = _project_root(project_root)
    targets: dict[str, Path] = {}
    for value in files:
        relative, resolved = _relative_target(root, value)
        targets[relative] = resolved
    if not targets:
        raise CheckpointError("a checkpoint requires at least one explicit file target")

    role_map: dict[str, list[str]] = {}
    for value, role_value in (roles or {}).items():
        relative, _ = _relative_target(root, value)
        if relative not in targets:
            raise CheckpointError(
                f"role mapping names a file outside the explicit checkpoint list: {value}"
            )
        role_map[relative] = _normalize_roles(role_value)

    store = _store_root(root, store_root)
    blob_root = store / "blobs"
    records: list[dict[str, Any]] = []
    for relative, source in sorted(targets.items()):
        selected_roles = role_map.get(relative, [DEFAULT_ROLE])
        if source.exists():
            if not source.is_file() or source.is_symlink():
                raise CheckpointError(
                    f"checkpoint source must be a regular non-symlink file: {source}"
                )
            mode = stat.S_IMODE(source.stat().st_mode)
            sha256, size = _capture_blob(source, blob_root)
            records.append(
                {
                    "path": relative,
                    "roles": selected_roles,
                    "exists": True,
                    "sha256": sha256,
                    "sizeBytes": size,
                    "mode": mode,
                }
            )
        else:
            records.append(
                {
                    "path": relative,
                    "roles": selected_roles,
                    "exists": False,
                    "sha256": None,
                    "sizeBytes": 0,
                    "mode": None,
                }
            )

    body = {
        "artifactType": CHECKPOINT_ARTIFACT_TYPE,
        "version": CHECKPOINT_VERSION,
        "projectRoot": str(root),
        "files": records,
        "metadata": dict(metadata or {}),
    }
    checkpoint_id = hashlib.sha256(_canonical_json(body)).hexdigest()
    manifest = {**body, "checkpointId": checkpoint_id}
    manifest_path = store / "checkpoints" / checkpoint_id / "manifest.json"
    _write_immutable(manifest_path, _canonical_json(manifest) + b"\n")
    verify_checkpoint(manifest_path, root)
    return manifest_path


def _manifest_path(value: PathLike) -> Path:
    candidate = Path(value).expanduser().resolve()
    if candidate.is_dir():
        candidate = candidate / "manifest.json"
    if not candidate.is_file() or candidate.is_symlink():
        raise CheckpointError(f"checkpoint manifest is not a regular file: {candidate}")
    return candidate


def verify_checkpoint(
    checkpoint: PathLike,
    project_root: Optional[PathLike] = None,
) -> dict[str, Any]:
    """Verify manifest identity, every blob, and every original target boundary."""

    manifest_path = _manifest_path(checkpoint)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CheckpointError(f"checkpoint manifest is invalid: {exc}") from exc
    if not isinstance(manifest, dict):
        raise CheckpointError("checkpoint manifest must contain a JSON object")
    if manifest.get("artifactType") != CHECKPOINT_ARTIFACT_TYPE:
        raise CheckpointError("checkpoint manifest artifactType is invalid")
    if manifest.get("version") != CHECKPOINT_VERSION:
        raise CheckpointError(f"checkpoint manifest version must be {CHECKPOINT_VERSION}")

    checkpoint_id = manifest.get("checkpointId")
    if not isinstance(checkpoint_id, str) or len(checkpoint_id) != 64:
        raise CheckpointError("checkpointId must be a SHA-256 digest")
    body = {key: value for key, value in manifest.items() if key != "checkpointId"}
    if hashlib.sha256(_canonical_json(body)).hexdigest() != checkpoint_id:
        raise CheckpointError("checkpoint manifest content does not match checkpointId")
    if manifest_path.parent.name != checkpoint_id or manifest_path.parent.parent.name != "checkpoints":
        raise CheckpointError("checkpoint manifest is not stored under its content address")

    recorded_root = manifest.get("projectRoot")
    if not isinstance(recorded_root, str) or not Path(recorded_root).is_absolute():
        raise CheckpointError("checkpoint projectRoot must be an absolute path")
    root = _project_root(project_root if project_root is not None else recorded_root)
    if str(root) != str(Path(recorded_root).expanduser().resolve()):
        raise CheckpointError("checkpoint belongs to a different project root")

    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise CheckpointError("checkpoint manifest needs a non-empty files array")
    blob_root = manifest_path.parents[2] / "blobs"
    seen_paths: set[str] = set()
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise CheckpointError(f"checkpoint files[{index}] must be an object")
        relative = record.get("path")
        target = _target_from_record(root, relative)
        if relative in seen_paths:
            raise CheckpointError(f"checkpoint contains duplicate file path: {relative!r}")
        seen_paths.add(relative)
        roles_value = record.get("roles")
        if not isinstance(roles_value, list) or _normalize_roles(roles_value) != roles_value:
            raise CheckpointError(f"checkpoint file {relative!r} has invalid roles")
        exists = record.get("exists")
        if not isinstance(exists, bool):
            raise CheckpointError(f"checkpoint file {relative!r} has invalid exists state")
        if not exists:
            if record.get("sha256") is not None or record.get("sizeBytes") != 0 or record.get("mode") is not None:
                raise CheckpointError(f"absent checkpoint file {relative!r} has blob metadata")
            continue

        sha256 = record.get("sha256")
        size = record.get("sizeBytes")
        mode = record.get("mode")
        if not isinstance(sha256, str) or len(sha256) != 64:
            raise CheckpointError(f"checkpoint file {relative!r} has invalid sha256")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise CheckpointError(f"checkpoint file {relative!r} has invalid sizeBytes")
        if not isinstance(mode, int) or isinstance(mode, bool) or mode < 0:
            raise CheckpointError(f"checkpoint file {relative!r} has invalid mode")
        blob = blob_root / sha256
        if not blob.is_file() or blob.is_symlink():
            raise CheckpointError(f"checkpoint blob is missing or unsafe: {blob}")
        if blob.stat().st_size != size or _sha256_file(blob) != sha256:
            raise CheckpointError(f"checkpoint blob failed integrity verification: {blob}")
        # Resolve every target during verification, even when it is currently absent.
        _target_from_record(root, str(relative))

    return manifest


def _temporary_copy(source: Path, destination_parent: Path, prefix: str) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(prefix=prefix, dir=str(destination_parent))
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        # copy2 preserves the target's mode for transactional rollback backups.
        # Staged checkpoint blobs are explicitly chmod'ed to the recorded mode.
        shutil.copy2(source, temporary)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return temporary


def restore_checkpoint(
    checkpoint: PathLike,
    project_root: Optional[PathLike] = None,
) -> dict[str, Any]:
    """Transactionally restore captured existing files.

    Verification of the complete bundle happens before staging or replacing any
    target. Paths recorded as absent are informational and are never deleted.
    """

    manifest_path = _manifest_path(checkpoint)
    manifest = verify_checkpoint(manifest_path, project_root)
    root = _project_root(project_root if project_root is not None else manifest["projectRoot"])
    blob_root = manifest_path.parents[2] / "blobs"
    existing_records = [record for record in manifest["files"] if record["exists"] is True]
    skipped_absent = [record["path"] for record in manifest["files"] if record["exists"] is False]

    targets: list[tuple[dict[str, Any], Path, Path]] = []
    for record in existing_records:
        target = _target_from_record(root, record["path"])
        if target.exists() and (not target.is_file() or target.is_symlink()):
            raise CheckpointError(f"restore target is not a regular non-symlink file: {target}")
        blob = blob_root / record["sha256"]
        targets.append((record, target, blob))

    staged: dict[Path, Path] = {}
    backups: dict[Path, Optional[Path]] = {}
    committed: list[Path] = []
    try:
        for record, target, blob in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            _target_from_record(root, record["path"])
            staged_file = _temporary_copy(blob, target.parent, ".checkpoint-restore-")
            os.chmod(staged_file, record["mode"])
            if staged_file.stat().st_size != record["sizeBytes"] or _sha256_file(staged_file) != record["sha256"]:
                raise CheckpointError(f"staged checkpoint content failed verification: {target}")
            staged[target] = staged_file
            backups[target] = (
                _temporary_copy(target, target.parent, ".checkpoint-backup-")
                if target.exists()
                else None
            )

        for record, target, _ in targets:
            _target_from_record(root, record["path"])
            os.replace(str(staged[target]), str(target))
            committed.append(target)
    except Exception as exc:
        rollback_errors: list[str] = []
        for target in reversed(committed):
            backup = backups.get(target)
            try:
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    os.replace(str(backup), str(target))
                    backups[target] = None
            except OSError as rollback_exc:
                rollback_errors.append(f"{target}: {rollback_exc}")
        detail = f"; rollback errors: {'; '.join(rollback_errors)}" if rollback_errors else ""
        if isinstance(exc, CheckpointError):
            raise CheckpointError(f"{exc}{detail}") from exc
        raise CheckpointError(f"checkpoint restore failed: {exc}{detail}") from exc
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
        for temporary in backups.values():
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    return {
        "checkpointId": manifest["checkpointId"],
        "restored": [record["path"] for record in existing_records],
        "skippedAbsent": skipped_absent,
    }
