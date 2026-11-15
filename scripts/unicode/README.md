# Documentation emoji data

The checker uses the Unicode 17.0.0 `Emoji` property from the official
[emoji-data.txt](https://www.unicode.org/Public/17.0.0/ucd/emoji/emoji-data.txt).
`emoji-17.0-ranges.txt` retains every range whose property is exactly `Emoji`,
with comments removed. Its header records the original file's SHA-256.
The Unicode license is included in [LICENSE.txt](LICENSE.txt).

The zero-emoji policy rejects every non-ASCII character with that property,
including BMP symbols, default text presentation, default emoji presentation,
regional indicators, and skin-tone modifiers. A text presentation selector does
not exempt an emoji base. Joined and tag sequences are rejected through their
emoji bases. ASCII digits, number sign, and asterisk are rejected only when
followed by an optional U+FE0F and U+20E3 (a keycap sequence). Bare digits and
punctuation, isolated selectors or joiners, and non-emoji supplementary text
remain valid. This is a character policy, not a renderer-dependent test of
whether a platform draws a colorful glyph. All Markdown content, including
code examples, is scanned; punctuation checks are unchanged.

Runtime requires only the checker's existing Python 3.10+ standard library.
No network access, installed Unicode package, operating-system emoji font, or
Python Unicode database version affects the result. Missing data fails closed.

To update, download a chosen version's official `ucd/emoji/emoji-data.txt`,
verify its version header, record its SHA-256, and extract the first field from
non-comment lines whose semicolon-delimited second field (before `#`) is
exactly `Emoji`. Preserve the ranges and order. Rename the vendored table and
update the checker path and this document together in a reviewed change.
Review property additions/removals and extend the escaped regression fixtures
for that version before running all five repository gates. Do not refresh data
automatically during checks.
