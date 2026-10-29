# Merge Verdict Task Runner

default:
    @just --list

# Verify markdown files for broken links, em dashes, and emojis
check-docs:
    #!/usr/bin/env python3
    import glob
    import re
    import os
    import sys

    md_files = glob.glob("**/*.md", recursive=True)
    emoji_pattern = re.compile(r"[\U00010000-\U0010ffff]", flags=re.UNICODE)
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
    errors = False

    for path in md_files:
        with open(path) as f:
            text = f.read()
        if "\u2014" in text:
            print(f"Em dash found in {path}")
            errors = True
        if emoji_pattern.findall(text):
            print(f"Emoji found in {path}")
            errors = True
        for match in link_pattern.finditer(text):
            _, url = match.groups()
            if url.startswith("http") or url.startswith("#") or url.startswith("mailto"):
                continue
            clean_url = url.replace("file:///Users/gordonpn/workspace/merge-verdict/", "").split("#")[0]
            if not os.path.exists(clean_url):
                print(f"Broken link in {path}: {url}")
                errors = True

    if errors:
        sys.exit(1)
    print("Documentation validation passed: all links valid, zero em dashes, zero emojis.")
