# Optional Reviewer Workflow Validation

This is a source inspection of repository revision `f7c536760d134cef7613ab505d367c5bbbaa0daf`. It describes the workflow guards at that revision, not proof that an external reviewer ran or that hosted permissions worked. Recheck the deployed default-branch revision before each live trial.

Sources: [DeepSeek Review](../.github/workflows/deepseek-review.yml), [PR-Agent](../.github/workflows/pr-agent.yml), [reviewdog](../.github/workflows/reviewdog.yml), and [coverage](../.github/workflows/coverage.yml).

## Event and Identity Matrix

The following outcomes assume a non-empty `DEEPSEEK_API_KEY` unless the row explicitly covers missing credentials. Both optional reviewer jobs reject a bot sender and `dependabot[bot]` actor. For comment events, the commenter must have `OWNER`, `MEMBER`, or `COLLABORATOR` association.

| Event or origin                                                             | DeepSeek Review                                       | PR-Agent                                                      | Evidence boundary                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Human opens or marks a same-repository, non-draft PR ready                  | Job eligible                                          | Job eligible                                                  | Guards inspected; live invocation and resulting identity not verified here                 |
| Human opens a draft PR                                                      | Job skipped                                           | Job skipped                                                   | Draft guard inspected                                                                      |
| Direct fork PR event                                                        | Job skipped                                           | Job skipped                                                   | Head repository equality guard inspected                                                   |
| Bot or Dependabot direct PR event                                           | Job skipped                                           | Job skipped                                                   | Sender and actor guards inspected                                                          |
| New commit (`synchronize`) or reopened PR                                   | No event trigger                                      | No event trigger                                              | Trigger lists inspected; use an authorized comment to request another review               |
| Authorized human creates or edits an open-PR comment                        | Eligible only if body contains `/review` anywhere     | Job eligible for any body                                     | Current command matching differs; see proposed changes below                               |
| Authorized comment on a draft PR                                            | Runner reads current draft state; review step skipped | Runner reads current draft state; review step skipped         | REST `.draft` guard inspected; live draft transition/race behavior not verified            |
| Authorized comment on a fork PR                                             | Job eligible; draft REST guard applies                | Job eligible; draft REST guard applies                        | Privileged default-branch comment path; external Action behavior still requires validation |
| Unauthorized association, bot comment, ordinary issue, or closed PR comment | Job skipped                                           | Job skipped                                                   | Identity, PR-presence, and issue-state guards inspected                                    |
| Eligible event with absent or empty API key                                 | Runner can start; all functional steps skipped        | Runner and Docker Action setup can start; review step skipped | A successful job is not evidence that a review was performed                               |

The declared token permissions are `contents: read` and `pull-requests: write` for DeepSeek, with `issues: write` additionally declared for PR-Agent. Intended review output uses the workflow token identity, normally `github-actions[bot]`; retain the actual submitted author and reviewed commit in live evidence. Permission declarations do not prove the effective hosted token permissions.

The comment path does not check out PR head code in these workflow definitions. DeepSeek checks out only its prompt path, and PR-Agent is a pinned external Action. This inspection does not establish that third-party Actions never fetch or execute untrusted content. Review their resolved implementations before claiming the fork comment path is safe for credentials. Do not add a privileged checkout of fork code to complete a trial.

## Proposed Opt-In Changes

The [optional workflow gating change](https://github.com/gordonpn/merge-verdict/pull/120), inspected at head `b1a5295515385df035f1ff1cb57b3a6e7b3ad175`, is separate from the pinned baseline above. Its inspected diff adds job-level `ENABLE_DEEPSEEK_REVIEW` and `ENABLE_PR_AGENT` repository-variable gates, each requiring the exact value `true`. An unset or false variable skips the job before runner allocation. A true variable with a missing API key still skips functional steps and does not prove review completion.

That diff restricts PR-Agent comments to exact `/review`, `/describe`, `/improve`, or `/ask`, or one of those commands followed by an ASCII space and arguments. It leaves DeepSeek's substring `/review` check unchanged. It also removes reviewdog's duplicate Biome job and scopes reviewdog to workflow and Actionlint configuration changes. These are proposed behaviors until the change is merged and deployed; this document does not enable them.

## Cancellation and Manual Recovery

DeepSeek serializes per workflow and PR with `cancel-in-progress: true`; a later eligible run can cancel an earlier one. PR-Agent uses the same PR-scoped grouping with `cancel-in-progress: false`, preserving the existing exception for comment-producing work. This avoids cancelling the running PR-Agent job on every new request, but does not prove that every queued request executes or that writes are idempotent. Both jobs have a ten-minute timeout.

After a cancellation, timeout, missing credential, or unsupported direct event, inspect the actual run and review artifacts before requesting another review. An authorized maintainer can post `/review` on an open, non-draft PR after checking credentials and, once deployed, opt-in variables. Fork PRs require the external Action trust review described above. A maintainer review is the manual alternative when credentials, quota, or origin restrictions prevent automation; do not mark the automated reviewer completed merely because a maintainer reviewed the PR.

## Remaining Live Validation

### Workflow-run resolver component

`resolveWorkflowRunPullRequestNumber` is exported as a library helper. The Action
event handler and workflow trigger guards do not yet call it. Manual
`workflow_dispatch` remains the refresh path until that integration is delivered.

The helper rejects explicit `workflow_run.repository.full_name` mismatches
(including blank values) before direct or fallback lookups, and rejects multiple
direct PR references without fallback. Fork lookups intentionally query
`state: "open"` PRs and require a unique exact head SHA and repository match
across all returned pages. Comment-run lookups require an allowlisted workflow
path, same-repository run, and a unique target artifact name with explicit
`expired === false`. The name selects a refresh target; it does not authenticate
review evidence or authorize approval. DeepSeek's job guard requires
`github.event.issue.pull_request` before eligibility lookup or artifact
creation, excluding ordinary issue comments.

Both REST lookups follow pagination for at most 10 pages and 1000 items, matching
the collector's resource limits. Next-page detection parses `Link` parameters
outside URI brackets and quoted parameter values, ignoring `rel=next` text
inside URLs or quoted values, and matches the RFC 8288 `next` relation token
case-insensitively across parameter ordering, quoting, and multi-token
relations. Incomplete listings return `null` even if a candidate was
already found; a later page could contain another match. API failures propagate.
Custom REST clients must preserve response `headers.link` to expose subsequent
pages. A missing, empty, or whitespace-only link is treated as a complete
response, whereas a malformed non-empty `Link` header fails closed (`null`)
rather than treating a potentially truncated listing as complete.

Track outcomes against the exact workflow revision, event, PR origin, actor association, and head SHA. Record run and artifact URLs, expected versus observed status, effective permissions, review author, and reviewed commit. Never record tokens, API keys, secret values, or unsanitized provider payloads.

| Trial                                                                 | Expected evidence                                                                                                                  | Status in this document                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Same-repository non-draft `opened` and `ready_for_review`             | Each configured reviewer submits a review under the intended identity for the expected head SHA                                    | Not run                                      |
| Draft, fork, bot, unauthorized comment, closed PR, and ordinary issue | Guard excludes unsupported direct execution; no review artifact or credential exposure                                             | Not run; source guards inspected             |
| Authorized `/review` on same-repository and fork PRs                  | Current draft guard, trust boundary, permissions, and reviewed SHA are verified independently                                      | Not run                                      |
| Missing key and disabled opt-in                                       | Explicitly distinguish skipped functional work from completed review; verify no provider call                                      | Not run; current missing-key guard inspected |
| Repeated requests and cancellation                                    | DeepSeek cancellation and PR-Agent serialization do not leave misleading completion artifacts or duplicate writes                  | Not run; concurrency configuration inspected |
| Reviewdog same-repository and fork PRs                                | Current same-repository guard and review permissions match observed annotations; proposed path filter tested only after deployment | Not run; guards inspected                    |
| Coverage generation and upload                                        | `just test-coverage` produces `coverage/lcov.info`; hosted Codecov upload and report behavior verified separately                  | Not run in this documentation inspection     |

The coverage workflow runs on PR opened, synchronize, and reopened events targeting `main`, and pushes to `main`. It generates LCOV with `just test-coverage`, checks PR diff coverage, and uploads with `fail_ci_if_error: true`. The upload selects OIDC when `CODECOV_TOKEN` is empty. Its LCOV report/comment step is restricted to same-repository PRs. Hosted upload authorization, fork behavior, and branch-protection enforcement remain separate validation targets.
