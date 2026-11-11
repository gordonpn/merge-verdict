# Checks report formatter

`formatChecksReport` in `src/publisher/checks-formatter.ts` renders a validated review snapshot and an explicit verdict into Checks API output. The caller supplies the evaluation timestamp and required-check names from trusted base policy. This module does not evaluate policy, publish checks, or submit approvals.

The report includes evaluated head SHA, state fingerprint, timestamp, reviewer completion and freshness, required-check conclusions and freshness, and unresolved findings. Missing required checks appear as MISSING. Reviewer freshness requires both the recorded freshness flag and the evaluated SHA matching the snapshot head. The formatter reports observations; it does not alter the supplied verdict.

Untrusted table cells escape HTML and Markdown control characters, flatten newlines and truncate at 1,000 UTF-8 bytes before escaping. Report text stays below 60,000 UTF-8 bytes, conservatively below the 65,535-character output limit. Rows are omitted whole, and each section reports its omitted count. Omitted findings still receive annotations when their recorded coordinates are usable. Findings retain recorded ending lines only; range starts are not invented.

Annotations use valid relative repository paths and recorded positive line numbers. File-level and general findings remain visible in the report without fabricated locations. Messages are bounded to 4,000 UTF-8 bytes; batches contain no more than 50 annotations. HIGH and BLOCKER findings produce failure annotations, MEDIUM produces warning, and other severities produce notice. Annotation levels are presentation metadata and do not override the overall verdict.

Refs [issue #28](https://github.com/gordonpn/merge-verdict/issues/28). The publisher tracked in [issue #14](https://github.com/gordonpn/merge-verdict/issues/14) must submit each annotation batch separately, preserve the authoritative verdict-to-check mapping, enforce publication ownership and verify the current head before writing. This PR supplies formatting only. Rendering in the live GitHub Checks UI and transport integration remain unverified.
