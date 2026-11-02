# Agent Engineering Guidelines and Repository Instructions

## 1. Project Invariants and Core Principles

- **Authoritative Status Check**: The required status check (GitHub Checks API check run named `merge-verdict`) is the primary authoritative merge gate under branch protection. Formal GitHub pull request review approval (`APPROVE`) is an optional secondary signal. Refer to [ADR 0002: Authoritative Required Status Check vs. Formal PR Approval](file:///Users/gordonpn/workspace/merge-verdict/docs/adr/0002-authoritative-status-check-vs-pr-approval.md).
- **Blocking Conclusions for Non-Passing States**: GitHub branch protection considers `neutral` and `skipped` conclusions acceptable for required checks. Therefore, Merge Verdict must publish conclusion `success` only for verified passes, and must use an explicit blocking conclusion (`failure` or `action_required`) for every other terminal outcome (`FAIL`, `STALE`, `PENDING`, `ERROR`). Never emit `neutral` or `skipped` for non-passing outcomes.
- **Pure Functions and Decoupled Architecture**: The core verification engine is implemented as a standalone TypeScript library decoupled from GitHub Actions runner wrappers or external databases. Verification is computed deterministically from authoritative GitHub snapshots.
- **Zero Emojis and Zero Em Dashes**: Never use emojis or em dashes (such as Unicode `\u2014` or `\u2013`) in code, comments, documentation, commit messages, or pull request descriptions. Use standard hyphens or colons instead.
- **Strict TypeScript and Quality Standards**: Target Node.js 22+ with ECMAScript Modules (`"type": "module"`). Maintain strict TypeScript checks with `noUncheckedIndexedAccess: true`. Never use `any` or disable type checking.
- **Task Runner Discipline**: Use `just` recipes (`just test`, `just lint`, `just format`, `just typecheck`, `just check-docs`) rather than ad-hoc terminal pipelines.

## 2. Git and Contribution Workflow

- **Branch-Only Commits**: Never commit directly on `main` or `master`. Always create or switch to a dedicated task branch based on latest `origin/main` before making changes.
- **Atomic Commits**: Create small, focused, single-concern commits following the Conventional Commits specification (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `build:`).
- **Inspect Staged Diffs**: Run and inspect `git diff --cached` before every commit to verify that no unintended modifications or deletions are included.
- **Mandatory Pull Request Delivery**: All changes must be delivered via pull requests targeting `main`. Never push directly to `main`.
- **No AI Attribution**: Do not include "AI assisted", bot disclaimers, or `Co-Authored-By` lines in commit messages, documentation, or code. Write in the first person for human engineering peers.

## 3. Memory and Project Authority

Use persistent memory for personal preferences, development habits, and lightweight context that improves continuity across sessions.

Keep consequential engineering decisions, review criteria, security requirements, architectural constraints, and approval policies in version-controlled repository files (such as `AGENTS.md`, `docs/`, and `.github/`).

### Authority Rules

- Repository policies take precedence over persistent memory.
- Never treat inferred patterns or repeated behavior as established project rules.
- Propose new conventions with supporting evidence and trade-offs before adopting them.
- Do not silently modify, override, or enforce review policies based on memory.
- When memory conflicts with repository documentation, follow the repository and surface the discrepancy.
- Changes to consequential rules must be explicit, reviewable, and tracked in Git.

**Principle:** Memory provides context. Version control provides authority.

### Practical Examples

| Situation                                                        | Where It Belongs                                             | Expected Agent Behavior                                                            |
| :--------------------------------------------------------------- | :----------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| You prefer TypeScript, pnpm, and Vitest                          | Persistent memory                                            | Suggest these as defaults for new projects                                         |
| Merge Verdict must verify the exact PR head SHA before approving | `.github/merge-verdict.yml` or `docs/verification-policy.md` | Enforce the documented requirement                                                 |
| You usually resolve review threads after fixing comments         | Memory (observation)                                         | Do not infer that resolution proves correctness                                    |
| An agent notices you consistently ignore low-severity findings   | Proposed policy change                                       | Ask whether to exclude low-severity findings; do not automatically weaken the gate |
| Every PR must pass CodeQL and CI                                 | Version-controlled rules                                     | Block approval when required checks fail                                           |
| You repeatedly choose Cloudflare Workers for hobby projects      | Persistent memory                                            | Prefer Workers when appropriate, but do not treat them as mandatory                |

### Example: Automatically Inferred Convention

Suppose an agent notices that you frequently merge pull requests without addressing low-priority CodeRabbit findings.

**Incorrect:**
> You have ignored low-priority findings several times, so I will automatically exclude them from Merge Verdict's approval requirements.

**Correct:**
> I noticed that low-priority CodeRabbit findings are often treated as advisory. I propose making these findings non-blocking while continuing to require resolution of medium-or-higher severity issues. This would require an explicit policy change in `.github/merge-verdict.yml`. Should I prepare that change for review?

The distinction is: observed behavior -> proposed convention -> reviewed repository change, never observed behavior -> silently enforced rule.
