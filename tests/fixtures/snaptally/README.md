# Recorded SnapTally collector evidence

Refs #12. These are projections of actual public GitHub responses captured on
2026-11-11 through the GitHub connector, not reconstructed historical responses.
The source URLs, head SHAs, comment IDs, recording date and upper timestamp, and SHA256 digests are in
tests/fixtures/snaptally/provenance.json. Capture envelope digests identify the
uncommitted original connector data; fixture digests cover the committed bytes.
No authentication headers or tokens are stored.

## Recording and sanitization

REST sources were fetched with github_fetch using the URLs in provenance.json.
Each collection used per_page=100 and contained fewer than 100 items. Checks use
the recorded PR head SHA. Commit SHA and committer timestamps are retained from
the commits endpoint; author names and email addresses are omitted.

Only collector input fields are retained. All reviews, checks, commit statuses,
changed file names, commits, and returned review threads are retained.
Conversation comments are intentionally limited to bodies containing
codex-review-state:v1 or pr-agent:review:full. These fixtures do not represent a
complete conversation or a historical event sequence.

Thread resolution metadata and bodies came from
github_list_pull_request_review_threads, whose connector returns snake case
fields and arrays. Thread fields are mapped to the collector GraphQL connection
shape, with a terminal pageInfo. Comment path, line, original line, and commit
SHA are joined from the REST review comments by GraphQL node ID. The resulting
connection wrappers are replay adapters, not original GraphQL wire responses.

The human login and repository owner are replaced with fixture-owner; the human
display name is replaced with Fixture Author. Actor objects retain only login.
External URLs and email addresses in bodies are redacted; GitHub evidence links
remain with the anonymized owner. Other profile fields, avatars, diffs, patches,
deployment links, and API URL fields are omitted. Bodies otherwise retain the
recorded markers and verdicts. Non-ASCII characters are JSON Unicode escapes,
preserving source body content without literal emojis or dash characters.

## Replay boundary and observed differences

tests/replay/snaptally.test.ts runs the real GitHubCollector with Octokit REST and
GraphQL clients whose fetch implementation returns only these recordings.
Unknown request paths throw; no live transport is installed. The protected base
policy response is an explicitly synthetic test placeholder, outside the
recordings, to exercise collection without claiming a recorded SnapTally policy.
The changed-files GraphQL wrapper uses recorded REST file names.

The tests verify evidence transport, body digests, neutral CodeRabbit rate-limit
evidence, Sourcery resolution, and divergent Codex and DeepSeek commit evidence.
They do not classify RATE_LIMITED or STALE and do not evaluate approval policy.
Normalizers (#43) and the policy evaluator (#11) are absent from this base.
Issue #12 remains open until full engine replay asserts the required verdicts.

The current PR #121 response has head
4650b21d3d1f70faa2958a4cb09c2c5a0df675ea and 10 resolved threads, whereas
docs/testing.md describes ce22a74 and 11 threads. The recording preserves what
GitHub returned. The DeepSeek review is still on 6ad1952 and Sourcery submissions
include ce22a74. The fixtures do not invent an earlier snapshot to match the docs.

Refresh by fetching the listed sources, applying the documented projection and
sanitization, reviewing differences, and updating fixture byte digests. Do not
replace recorded values with expected policy outcomes.
