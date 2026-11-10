#!/usr/bin/env python3
"""Validate repository Markdown independently of the caller's working directory."""

import argparse
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


LINK_PATTERN = re.compile(r"\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)")
EMOJI_PATTERN = re.compile(r"[\U00010000-\U0010ffff]")


def link_exists(url: str, document: Path, root: Path) -> bool:
    """Resolve file URLs, document-relative links, and legacy root-relative links."""
    parsed = urlsplit(url.removeprefix("<").removesuffix(">"))
    if parsed.scheme and parsed.scheme != "file":
        return True
    if not parsed.path:
        return True
    path = Path(unquote(parsed.path))
    if parsed.scheme == "file":
        # A file URI names an actual local path, never a guessed workstation prefix.
        return parsed.netloc in ("", "localhost") and path.is_absolute() and path.exists()
    if parsed.path.startswith("/"):
        return (root / parsed.path.lstrip("/")).exists()
    # Existing specifications use docs/... links from inside docs/. Preserve those
    # while supporting conventional links relative to the containing document.
    return (document.parent / path).exists() or (root / path).exists()


def validate(root: Path) -> bool:
    valid = True
    for directory, subdirectories, filenames in os.walk(root):
        subdirectories[:] = sorted(
            name for name in subdirectories if name not in (".git", "node_modules")
        )
        for filename in sorted(filenames):
            if not filename.endswith(".md"):
                continue
            document = Path(directory) / filename
            display = document.relative_to(root)
            text = document.read_text(encoding="utf-8")
            if "\u2014" in text or "\u2013" in text:
                print(f"Em or en dash found in {display}")
                valid = False
            if EMOJI_PATTERN.search(text):
                print(f"Emoji found in {display}")
                valid = False
            for match in LINK_PATTERN.finditer(text):
                url = match.group(1)
                if not link_exists(url, document, root):
                    print(f"Broken link in {display}: {url}")
                    valid = False
    return valid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    root = parser.parse_args().root.resolve()
    if not root.is_dir():
        parser.error(f"Repository root is not a directory: {root}")
    if not validate(root):
        return 1
    print("Documentation validation passed: all links valid, zero em dashes, zero emojis.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
