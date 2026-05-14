#!/usr/bin/env python3
"""Sync CainFlow app version strings across the repository."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PACKAGE_JSON = ROOT / "package.json"
SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
}
SKIP_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".webm",
    ".pyc",
    ".pyo",
}
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
UTF8_BOM = b"\xef\xbb\xbf"


@dataclass
class FileChange:
    path: Path
    replacements: int
    encoding: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync CainFlow app version strings."
    )
    parser.add_argument(
        "version",
        nargs="?",
        help="Target version, e.g. 2.8.2 or v2.8.2",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing files.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation before writing.",
    )
    return parser.parse_args()


def load_current_version() -> str:
    try:
        raw = PACKAGE_JSON.read_bytes()
    except FileNotFoundError:
        fail(f"Missing file: {PACKAGE_JSON}")

    try:
        text, _ = decode_text(raw, PACKAGE_JSON)
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"Failed to parse package.json: {exc}")

    version = str(data.get("version", "")).strip()
    if not version:
        fail("package.json does not contain a valid version field.")
    return version


def normalize_version(raw_version: str | None) -> str:
    version = (raw_version or "").strip()
    if not version:
        version = input("Enter the new version: ").strip()

    if version.lower().startswith("v"):
        version = version[1:]

    if not version:
        fail("Version cannot be empty.")
    if not VERSION_PATTERN.fullmatch(version):
        fail("Invalid version format. Use values like 2.8.2 or 2.8.2-beta.1.")
    return version


def fail(message: str, exit_code: int = 1) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)
    raise SystemExit(exit_code)


def is_binary_bytes(content: bytes) -> bool:
    return b"\x00" in content


def decode_text(content: bytes, path: Path) -> tuple[str, str]:
    if content.startswith(UTF8_BOM):
        encodings = ("utf-8-sig", "utf-8", "gb18030")
    else:
        encodings = ("utf-8", "gb18030")
    for encoding in encodings:
        try:
            return content.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    fail(f"Failed to decode text file: {path}")


def iter_repo_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        yield path


def find_candidate_changes(old_version: str, new_version: str) -> list[FileChange]:
    changes: list[FileChange] = []

    for path in iter_repo_files(ROOT):
        raw = path.read_bytes()
        if is_binary_bytes(raw):
            continue

        text, encoding = decode_text(raw, path)
        replacements = text.count(old_version)
        if replacements == 0:
            continue

        changes.append(FileChange(path=path, replacements=replacements, encoding=encoding))

    if not changes:
        fail(f"No text files contain the current version {old_version}.")

    if old_version == new_version:
        fail("The target version matches the current version. Nothing to do.", exit_code=0)

    return changes


def apply_changes(changes: list[FileChange], old_version: str, new_version: str) -> None:
    for change in changes:
        raw = change.path.read_bytes()
        text, _ = decode_text(raw, change.path)
        updated = text.replace(old_version, new_version)
        change.path.write_bytes(updated.encode(change.encoding))


def find_leftovers(old_version: str) -> list[Path]:
    leftovers: list[Path] = []

    for path in iter_repo_files(ROOT):
        raw = path.read_bytes()
        if is_binary_bytes(raw):
            continue

        text, _ = decode_text(raw, path)
        if old_version in text:
            leftovers.append(path)

    return leftovers


def print_summary(changes: list[FileChange], old_version: str, new_version: str, dry_run: bool) -> None:
    action = "Will update" if dry_run else "Updated"
    total = sum(item.replacements for item in changes)

    print(f"Current version: {old_version}")
    print(f"Target version: {new_version}")
    print(f"{action} {len(changes)} files with {total} replacement(s):")
    for item in changes:
        rel = item.path.relative_to(ROOT)
        print(f"  - {rel} ({item.replacements})")


def confirm_or_exit(args: argparse.Namespace) -> None:
    if args.yes or args.dry_run:
        return

    answer = input("Write these changes now? [y/N]: ").strip().lower()
    if answer not in {"y", "yes"}:
        print("Cancelled.")
        raise SystemExit(0)


def main() -> int:
    args = parse_args()
    old_version = load_current_version()
    new_version = normalize_version(args.version)
    changes = find_candidate_changes(old_version, new_version)

    print_summary(changes, old_version, new_version, args.dry_run)
    if args.dry_run:
        return 0

    confirm_or_exit(args)
    apply_changes(changes, old_version, new_version)

    leftovers = find_leftovers(old_version)
    if leftovers:
        print("[ERROR] Old version string still exists in:", file=sys.stderr)
        for path in leftovers:
            print(f"  - {path.relative_to(ROOT)}", file=sys.stderr)
        return 1

    print("Version sync complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
