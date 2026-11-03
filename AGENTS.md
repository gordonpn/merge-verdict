# Agent Engineering Guidelines and Repository Instructions

## 1. Project Invariants

- **Authoritative Status Check and Mandatory PR Approval**: Merge Verdict enforces two required outputs when verification passes: (1) the required status check (GitHub Checks API check run named `merge-verdict`) as the primary authoritative merge gate under branch protection, and (2) a formal GitHub pull request review with state `APPROVE` managed via configurable approval providers (`github_copilot`, `github_app`) when eligible under the matched path risk tier. Refer to [ADR 0002](docs/adr/0002-authoritative-status-check-vs-pr-approval.md) and [docs/verification-policy.md](docs/verification-policy.md).
- **Base-Branch Policy Authority**: Always load `.github/merge-verdict.yml` (verification rules, path risk tiers, reviewer policies) from the protected base branch revision, never from the untrusted PR head branch. Refer to [docs/security.md](docs/security.md).
- **Blocking Conclusions for Non-Passing States**: Publish conclusion `success` only for verified passes (`PASS`), `status: in_progress` with `conclusion: null` for `PENDING`, and an explicit blocking conclusion (`failure` or `action_required`) for every other terminal outcome (`FAIL`, `STALE`, `ERROR`). Never emit `neutral` or `skipped` for non-passing outcomes.
- **Decoupled Pure Engine**: Keep the core verification engine as a pure TypeScript library in `src/` decoupled from GitHub Actions runtime wrappers or external databases. Refer to [docs/architecture.md](docs/architecture.md).

## 2. Repository Conventions and Verification

- **Zero Emojis and Zero Em Dashes**: Never use emojis or em dashes (`\u2014`, `\u2013`) in code, comments, documentation, commit messages, or pull request descriptions. Verified by `just check-docs`.
- **Task Runner Discipline**: Run `just format`, `just lint`, `just check-docs`, `just typecheck`, and `just test` before committing.

## 3. Memory vs. Version-Controlled Policy Authority

- **Version Control Over Memory**: Keep consequential engineering decisions, review criteria, security requirements, and approval policies in version-controlled files (`AGENTS.md`, `docs/`, `.github/merge-verdict.yml`). Use persistent memory only for personal preferences and session continuity.
- **Explicit Policy Changes Only**: Repository policies always override persistent memory. Never treat observed patterns or repeated developer behavior as established project rules, and never silently weaken review gates based on memory; propose policy changes for explicit Git review (see [docs/verification-policy.md](docs/verification-policy.md)).
