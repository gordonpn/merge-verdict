## PR Reviewer Guide 

<!-- pr-agent:review:full -->

#### (Review updated until commit https://github.com/fixture-owner/merge-verdict/commit/43adf935e4009a5e864b26f36ee56669c672ad26)

Here are some key observations to aid the review process:

<table>
<tr><td>

** Ticket compliance analysis **

**[74](https://github.com/fixture-owner/merge-verdict/issues/74) - Partially compliant**

Compliant requirements:

- Handle PR, review, comment, and relevant check/workflow lifecycle events with identity validation and self-trigger guards.
- Exclude owned publication artifacts (merge-verdict, runner / merge-verdict, github-actions check runs) from self-triggering.
- Document event gaps including thread-only resolution refresh and retain workflow_dispatch manual refresh path.
- Preserve advisory rollout (no branch-protection gate or automated approvals added).
- Add sanitized regressions for self-trigger guards and PR number extraction.

Non-compliant requirements:

- Demonstrate live commit and review/thread changes during evaluation; obsolete evaluations cannot overwrite newer evidence.
- Validate cancellation recovery and partial publication recovery before using cancel-in-progress: true.
- Demonstrate a fork PR keeps both executed code and policy under trusted-base control.
- Record operational feedback.

Requires further human verification:

- Live demonstration that obsolete evaluations cannot overwrite newer evidence.
- Live validation of cancellation and partial publication recovery.
- Live fork PR demonstration of trusted-base code and policy control.
- Operational feedback recording.

**[5](https://github.com/fixture-owner/merge-verdict/issues/5) - Partially compliant**

Compliant requirements:

- Document unsupported thread-only refresh and retain manual invocation (workflow_dispatch).

Non-compliant requirements:

- Stateless Cloudflare Worker with HMAC SHA-256 signature verification.
- Ingestion of pull_request_review_thread (resolved, unresolved) events.
- Programmatic dispatch to GitHub Actions workflow via workflow_dispatch.
- Edge debouncing to coalesce rapid consecutive thread updates.
- Resolving an inline review thread without comments triggers a verification workflow run within 10 seconds.
- Unauthorized or invalid signatures are rejected with HTTP 401.

Requires further human verification:

- Confirmation that the relay epic remains intentionally deferred and is not expected to be delivered by this PR.

</td></tr>
<tr><td>&nbsp;<strong>Estimated effort to review</strong>: 3 </td></tr>
<tr><td>&nbsp;<strong>PR contains tests</strong></td></tr>
<tr><td>&nbsp;<strong>No security concerns identified</strong></td></tr>
<tr><td>&nbsp;<strong>Recommended focus areas for review</strong><br><br>

<details><summary><a href='https://github.com/fixture-owner/merge-verdict/pull/154/files#diff-0088665e49f18b6ef5f1ede6af007122b0528999db798d266f733cf6d3abcad6R10-R22'><strong>Missing merge_group Trigger</strong></a>

`docs/events-and-state.md` still lists `merge_group: [checks_requested]` as a supported trigger, but the workflow `on:` block does not declare `merge_group`.
</summary>

```yaml
pull_request_target:
  types: [opened, synchronize, reopened, ready_for_review, edited]
```

</details>

</td></tr>
</table>

<details>
<summary>Resolved findings</summary>

### .github/workflows/merge-verdict.yml:38-41

**Possible Issue**

The `check_run` filter uses `github.event.check_run.pull_requests[1] == null` to reject multi-PR check runs.

</details>

<!-- pr-agent-review-state:v1
{"findings":[{"body":"**Bot Edit Bypass**\n\nThe new condition allows edited and deleted actions through even when the comment author is a self bot.","finding_id":"ab3f97f41c85","first_seen":"2026-11-22T18:51:18.869816Z","last_seen":"2026-11-22T18:51:18.869816Z","last_seen_head_sha":"43adf935e4009a5e864b26f36ee56669c672ad26","line_end":259,"line_start":251,"path":"src/action/index.ts","state":"ACTIVE"},{"body":"**Missing merge_group Trigger**\n\n`docs/events-and-state.md` still lists `merge_group: [checks_requested]` as a supported trigger.","finding_id":"ac5dcb7d0d27","first_seen":"2026-11-22T04:28:38.434565Z","last_seen":"2026-11-22T18:51:18.869816Z","last_seen_head_sha":"43adf935e4009a5e864b26f36ee56669c672ad26","line_end":22,"line_start":10,"path":".github/workflows/merge-verdict.yml","state":"ACTIVE"},{"body":"**Possible Issue**\n\nThe `check_run` filter uses `github.event.check_run.pull_requests[1] == null` to reject multi-PR check runs.","finding_id":"b1b97a34478c","first_seen":"2026-11-22T03:21:39.692470Z","last_seen":"2026-11-22T03:21:39.692470Z","last_seen_head_sha":"0da2b263b942bdc037383a09866f679cf8a74f33","line_end":41,"line_start":38,"path":".github/workflows/merge-verdict.yml","resolution_run_id":"https://github.com/fixture-owner/merge-verdict/commit/b71aa70792e9e45f0af1da6d51b2d742e139d987","resolved_at":"2026-11-22T04:28:38.434565Z","resolved_head_sha":"b71aa70792e9e45f0af1da6d51b2d742e139d987","state":"RESOLVED"}],"last_run":{"complete":false,"excluded_files":[],"head_sha":"43adf935e4009a5e864b26f36ee56669c672ad26","kind":"partial","run_id":"https://github.com/fixture-owner/merge-verdict/commit/43adf935e4009a5e864b26f36ee56669c672ad26"},"schema_version":1}
-->
