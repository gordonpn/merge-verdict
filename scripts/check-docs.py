#!/usr/bin/env python3
"""Validate repository Markdown independently of the caller's working directory."""

import argparse
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname


ASCII_PUNCTUATION = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
UNESCAPE_PATTERN = re.compile(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])")
BLOCKQUOTE_PREFIX = re.compile(r"^(?: {0,3}>[ \t]?)+")
FENCE_MARKER = re.compile(r"^\s*(?:(?:[-+*]|[0-9]+[.)])[ \t]+|>[ \t]*)*(`{3,}|~{3,})(.*)$")
INDENTED_CODE = re.compile(r"^(?: {4}|\t)")
ATX_HEADING = re.compile(r"^ {0,3}#{1,6}(?:[ \t]|$)")
THEMATIC_BREAK = re.compile(r"^ {0,3}(?:[-*_][ \t]*){3,}$")
LIST_ITEM = re.compile(r"^\s*(?:[-+*]|[0-9]+[.)])[ \t]+")
DEFINITION_PATTERN = re.compile(
    r"^ {0,3}\[((?:\\.|[^\[\]\\])+)\]:[ \t]*(?:\n[ \t]*)?(<[^>\n\x00]*>|[^\s<>\x00]+)"
    r"(?:(?:[ \t]+|\n[ \t]*)(?:\"[^\"\n]*\"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$",
    re.MULTILINE,
)
EMOJI_PATTERN = re.compile(r"[\U00010000-\U0010ffff]")
EXTERNAL_SCHEMES = {"http", "https", "mailto", "ftp", "ftps", "tel"}


def normalize_label(label: str) -> str:
    """Normalize a Markdown reference link label using whitespace folding and casefold."""
    return re.sub(r"\s+", " ", label.strip()).casefold()


def clean_destination(raw: str) -> str:
    """Unwrap angle-bracket destinations and unescape backslash-escaped punctuation."""
    if raw.startswith("<") and raw.endswith(">"):
        raw = raw[1:-1]
    return UNESCAPE_PATTERN.sub(r"\1", raw)


def is_escaped(text: str, index: int) -> bool:
    """Return True when the character at index is preceded by an odd number of backslashes."""
    backslashes = 0
    while index > 0 and text[index - 1] == "\\":
        backslashes += 1
        index -= 1
    return backslashes % 2 == 1


def visible_markdown(text: str) -> str:
    """Mask fenced code, indented code, inline code, and HTML comments in source order."""
    raw_lines = text.splitlines()
    unquoted_lines: list[tuple[int, str]] = []
    for line in raw_lines:
        quote_match = BLOCKQUOTE_PREFIX.match(line)
        quote_depth = quote_match.group(0).count(">") if quote_match else 0
        unquoted = line[quote_match.end() :] if quote_match else line
        unquoted_lines.append((quote_depth, unquoted))

    has_closing_run: set[tuple[int, int]] = set()
    next_runs: set[str] = set()
    for line_index in range(len(unquoted_lines) - 1, -1, -1):
        _, unquoted = unquoted_lines[line_index]
        marker = FENCE_MARKER.match(unquoted)
        is_fence = marker is not None and not (
            marker.group(1).startswith("`") and "`" in marker.group(2)
        )
        if not unquoted.strip() or is_fence or THEMATIC_BREAK.match(unquoted):
            next_runs.clear()
            continue
        is_heading = ATX_HEADING.match(unquoted) is not None
        if is_heading:
            next_runs.clear()
        for run in reversed(list(re.finditer(r"`+", unquoted))):
            token = run.group(0)
            if token in next_runs:
                has_closing_run.add((line_index, run.start()))
            next_runs.add(token)
        if is_heading:
            next_runs.clear()

    fence: str | None = None
    fence_quote_depth = 0
    comment = False
    inline = ""
    in_paragraph = False
    in_list = False
    lines: list[str] = []

    for line_index, (quote_depth, unquoted) in enumerate(unquoted_lines):
        if fence is not None and quote_depth < fence_quote_depth:
            fence = None
            in_paragraph = False
            in_list = False
        marker = FENCE_MARKER.match(unquoted)
        if fence is not None:
            if (
                marker
                and marker.group(1)[0] == fence[0]
                and len(marker.group(1)) >= len(fence)
                and not marker.group(2).strip()
            ):
                fence = None
            lines.append("")
            continue
        if (
            not comment
            and not inline
            and marker
            and not (marker.group(1).startswith("`") and "`" in marker.group(2))
        ):
            fence = marker.group(1)
            fence_quote_depth = quote_depth
            in_paragraph = False
            in_list = False
            lines.append("")
            continue
        if not comment and not inline and not unquoted.strip():
            in_paragraph = False
            in_list = False
            lines.append("")
            continue
        if (
            not comment
            and not inline
            and not in_paragraph
            and not in_list
            and INDENTED_CODE.match(unquoted)
        ):
            lines.append("")
            continue

        visible: list[str] = []
        index = 0
        length = len(unquoted)
        while index < length:
            if comment:
                end = unquoted.find("-->", index)
                if end < 0:
                    break
                comment = False
                index = end + 3
                continue
            if (
                not inline
                and unquoted[index] == "\\"
                and index + 1 < length
                and unquoted[index + 1] in ASCII_PUNCTUATION
            ):
                if unquoted[index + 1] == "`":
                    visible.append("\x00")
                else:
                    visible.append(unquoted[index : index + 2])
                index += 2
                continue
            if unquoted[index] == "`":
                run_end = index
                while run_end < length and unquoted[run_end] == "`":
                    run_end += 1
                run = unquoted[index:run_end]
                if inline == run:
                    inline = ""
                elif not inline:
                    if (line_index, index) in has_closing_run:
                        inline = run
                    else:
                        visible.append(run)
                visible.append("\x00")
                index = run_end
                continue
            if inline:
                visible.append(unquoted[index] if unquoted[index].isalnum() else "\x00")
                index += 1
                continue
            if unquoted.startswith("<!--", index):
                comment = True
                visible.append(" ")
                index += 4
                continue
            visible.append(unquoted[index])
            index += 1

        rendered = "".join(visible)
        lines.append(rendered)
        if ATX_HEADING.match(unquoted) or THEMATIC_BREAK.match(unquoted):
            in_paragraph = False
            in_list = False
        elif not comment and rendered.replace("\x00", "x").strip():
            in_paragraph = True
            if LIST_ITEM.match(unquoted):
                in_list = True

    return "\n".join(lines)


def find_closing_bracket(prose: str, open_bracket: int) -> tuple[int | None, int | None]:
    """Find matching ']' for open_bracket, or return inner '[' if encountered first."""
    index = open_bracket + 1
    length = len(prose)
    while index < length:
        char = prose[index]
        if char == "\\" and index + 1 < length:
            index += 2
            continue
        if char == "[":
            return None, index
        if char == "]":
            return index, None
        index += 1
    return None, None


def read_inline_destination(prose: str, open_paren: int) -> tuple[str | None, int]:
    """Read an inline link destination with balanced parentheses and optional title."""
    cursor = open_paren + 1
    length = len(prose)
    while cursor < length and prose[cursor] in " \t\n\r":
        cursor += 1
    if cursor >= length:
        return None, open_paren + 1
    if prose[cursor] == "<":
        end = prose.find(">", cursor + 1)
        if end < 0 or "\n" in prose[cursor + 1 : end]:
            return None, open_paren + 1
        destination = clean_destination(prose[cursor : end + 1])
        cursor = end + 1
    else:
        start = cursor
        depth = 0
        while cursor < length:
            char = prose[cursor]
            if char == "\\" and cursor + 1 < length:
                cursor += 2
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
            elif char.isspace() and depth == 0:
                break
            cursor += 1
        destination = clean_destination(prose[start:cursor])

    paren_depth = 0
    in_quote: str | None = None
    while cursor < length:
        char = prose[cursor]
        if char == "\\" and cursor + 1 < length:
            cursor += 2
            continue
        if in_quote:
            if char == in_quote:
                in_quote = None
        elif char in ('"', "'"):
            in_quote = char
        elif char == "(":
            paren_depth += 1
        elif char == ")":
            if paren_depth == 0:
                return destination, cursor + 1
            paren_depth -= 1
        cursor += 1
    return destination, length


def link_destinations(text: str):
    """Extract inline and reference link destinations from visible Markdown.

    Unused reference definitions are ignored unless referenced. Single-bracket text
    without a matching reference definition is treated as literal prose, whereas
    explicit full or collapsed references without a definition are reported as broken.
    """
    definitions: dict[str, str] = {}

    def record_definition(match: re.Match[str]) -> str:
        label, destination = match.group(1), match.group(2)
        key = normalize_label(label)
        if not key or "\n\n" in label:
            return match.group(0)
        if key not in definitions:
            definitions[key] = clean_destination(destination)
        return ""

    prose = DEFINITION_PATTERN.sub(record_definition, visible_markdown(text))
    pos = 0
    length = len(prose)
    while pos < length:
        if prose[pos] == "]" and not is_escaped(prose, pos) and pos + 1 < length:
            if prose[pos + 1] == "(":
                destination, pos = read_inline_destination(prose, pos + 1)
                if destination is not None:
                    yield destination
                continue
            if prose[pos + 1] == "[":
                ref_close, _ = find_closing_bracket(prose, pos + 1)
                if ref_close is not None:
                    ref_label = prose[pos + 2 : ref_close]
                    key = normalize_label(ref_label)
                    if key and "\n\n" not in ref_label:
                        yield definitions.get(key, f"[{ref_label}]")
                    pos = ref_close + 1
                    continue
        open_bracket = prose.find("[", pos)
        if open_bracket < 0:
            break
        if is_escaped(prose, open_bracket):
            pos = open_bracket + 1
            continue
        close_bracket, inner_open = find_closing_bracket(prose, open_bracket)
        if inner_open is not None:
            pos = inner_open
            continue
        if close_bracket is None:
            break
        label_text = prose[open_bracket + 1 : close_bracket]
        after = close_bracket + 1
        if after < length and prose[after] == "(":
            destination, pos = read_inline_destination(prose, after)
            if destination is not None:
                yield destination
            continue
        if after < length and prose[after] == "[":
            ref_close, _ = find_closing_bracket(prose, after)
            if ref_close is not None and not (
                ref_close + 1 < length and prose[ref_close + 1] == "("
            ):
                ref_label = prose[after + 1 : ref_close]
                target_label = ref_label if ref_label else label_text
                key = normalize_label(target_label)
                if key and "\n\n" not in label_text and "\n\n" not in ref_label:
                    yield definitions.get(key, f"[{target_label}]")
                pos = ref_close + 1
                continue
        key = normalize_label(label_text)
        if key and "\n\n" not in label_text and key in definitions:
            yield definitions[key]
        pos = after


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
        if not url or url.startswith("["):
            return False
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
