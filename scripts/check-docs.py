#!/usr/bin/env python3
"""Validate repository Markdown independently of the caller's working directory."""

import argparse
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname


LINK_START = re.compile(r"\[[^\]\n]*\]\(\s*")
EMOJI_PATTERN = re.compile(r"[\U00010000-\U0010ffff]")
EXTERNAL_SCHEMES = {"http", "https", "mailto", "ftp", "ftps", "tel"}


def link_destinations(text: str):
    """Read inline destinations with balanced parentheses and optional titles."""
    for match in LINK_START.finditer(text):
        start = end = match.end()
        if end < len(text) and text[end] == "<":
            end = text.find(">", end + 1)
            if end == -1:
                continue
            yield text[start + 1:end]
            continue
        depth = 0
        while end < len(text):
            char = text[end]
            if char == "\\" and end + 1 < len(text):
                end += 2
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
            elif char.isspace() and depth == 0:
                break
            end += 1
        yield re.sub(r"\\([!\"#$%&'()*+,./:;<=>?@\[\\\]^_`{|}~-])", r"\1", text[start:end])


def contained(path: Path, root: Path) -> bool:
    """Reject escapes before testing existence, including symlink targets."""
    try:
        resolved = path.resolve()
        return resolved.is_relative_to(root.resolve()) and resolved.exists()
    except (OSError, ValueError, RuntimeError):
        return False


def link_exists(url: str, document: Path, root: Path) -> bool:
    """Resolve / paths from the repository and other paths from the document."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme in EXTERNAL_SCHEMES:
            return True
        if parsed.scheme and parsed.scheme != "file":
            return False
        if parsed.scheme == "file":
            path = Path(url2pathname(parsed.path))
            return (
                parsed.netloc in ("", "localhost")
                and path.is_absolute()
                and contained(path, root)
            )
        if parsed.netloc:
            return False
        path = unquote(parsed.path)
        if not path:
            return True
        target = root / path.lstrip("/") if path.startswith("/") else document.parent / path
        return contained(target, root)
    except (ValueError, OSError):
        return False


def validate(root: Path) -> bool:
    valid = True

    def walk_error(error: OSError) -> None:
        nonlocal valid
        print(f"Cannot scan documentation: {error}")
        valid = False

    for directory, subdirectories, filenames in os.walk(root, onerror=walk_error):
        subdirectories[:] = sorted(
            name for name in subdirectories if name not in (".git", "node_modules")
        )
        for filename in sorted(filenames):
            if not filename.endswith(".md"):
                continue
            document = Path(directory) / filename
            display = document.relative_to(root)
            if not contained(document, root):
                print(f"Documentation path escapes repository: {display}")
                valid = False
                continue
            try:
                text = document.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as error:
                print(f"Cannot read documentation {display}: {error}")
                valid = False
                continue
            if "\u2014" in text or "\u2013" in text:
                print(f"Em or en dash found in {display}")
                valid = False
            if EMOJI_PATTERN.search(text):
                print(f"Emoji found in {display}")
                valid = False
            for url in link_destinations(text):
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
