"""Resolve local ESP Web Tools flash manifests into address and byte pairs."""

import json
from pathlib import Path
import re


def read_flash_manifest(path: str | Path, chip: str | None) -> list[tuple[int, bytes]]:
    manifest = Path(path).resolve()
    root = manifest.parent
    document = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("Expected a flash manifest object")
    parts = document.get("parts")
    builds = document.get("builds")
    if isinstance(builds, list):
        def family(value):
            return re.sub(r"[^a-z0-9]", "", str(value or "").lower())

        matches = [build for build in builds if isinstance(build, dict) and family(build.get("chipFamily")) == family(chip)]
        if not chip and len(builds) == 1 and isinstance(builds[0], dict):
            matches = builds
        if len(matches) != 1:
            raise ValueError("Expected one build matching the selected board chip")
        parts = matches[0].get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 16:
        raise ValueError("Expected 1 to 16 flash manifest parts")
    images = []
    total = 0
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("Invalid flash manifest part")
        relative, offset = part.get("path"), part.get("offset")
        if (not isinstance(relative, str) or re.search(r"[\\:?#]", relative)
                or any(segment in {"", ".", ".."} for segment in relative.split("/"))
                or type(offset) is not int or not 0 <= offset <= 64 * 1024 * 1024):
            raise ValueError("Expected a relative file path and a valid byte offset")
        binary = (root / relative).resolve()
        if not binary.is_relative_to(root) or not binary.is_file():
            raise ValueError("Flash manifest binaries must be files within the manifest directory")
        total += binary.stat().st_size
        if total > 64 * 1024 * 1024:
            raise ValueError("Flash manifest images exceed 64 MiB")
        images.append((offset, binary.read_bytes()))
    return images
