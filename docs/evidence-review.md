# Proposal: Evidence provenance and targeted implementation review

## Status and authority

This documentation-only investigation contributes to [issue 39](https://github.com/gordonpn/merge-verdict/issues/39). It specifies a proposed future evidence-review contract. No evidence gate, schema, evaluator, review automation, or publishing behavior is implemented or activated by this document. Adoption requires explicit protected-base policy review and implementation with enforcement tests.

[AGENTS.md](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/AGENTS.md), the [verification policy](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/verification-policy.md), and [ADR 0002](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/adr/0002-authoritative-status-check-vs-pr-approval.md) remain authoritative. The required Checks API check named `merge-verdict` remains the automated merge gate. Verification assessment, approval eligibility, and GitHub recognition of approval remain separate decisions. Evidence review establishes support for declared criteria, not code correctness or permission to bypass required human review.

The [commit-scoped approval proposal](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/commit-scoped-approval.md) defines a candidate evidence envelope and invalidation lifecycle. This document supplies evidence acceptance and review judgment criteria for that proposal without defining a competing envelope. The pending [issue 38 evidence matrix, PR 60](https://github.com/gordonpn/merge-verdict/pull/60) inventories requirements, predicates, and implementation gaps; this document does not duplicate that inventory or treat unmerged work as coverage. The [architecture](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/architecture.md) and [testing strategy](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/testing.md) describe intended subsystem boundaries and verification scenarios.

## Commit-bound evidence contract

A future assessment must bind its evidence to the repository, PR, target kind, full PR head SHA, event evaluation SHA, exact protected-base policy revision, verifier implementation revision, and captured review-state digest. For PR events the evaluation SHA is the head SHA. Merge-group checks instead bind to the synthetic evaluation SHA; they do not substitute for review of the PR head or authorize approval of that synthetic commit. Record both identities explicitly.

Each evidence item must retain:

- A stable evidence ID, source record ID and locator, producer identity and role, collector identity, capture time, source update time, and content digest. A collector observing an author's artifact does not become its producer.
- The evaluated commit, run ID and attempt where applicable, actual result, relevant assertion or reviewer disposition, and links to retained logs or artifacts with integrity metadata. Record expected application/workflow identity and how authenticated source data establishes it.
- The requirement or finding IDs it supports, commit-pinned changed paths and relevant implementation/test locations, command and environment identity needed to reproduce it, and declared limitations or uncovered behavior.
- Its provenance class, independence assessment and rationale, shared inputs or assumptions, and any rejected or superseded evidence IDs. Preserve contrary observations rather than selecting only favorable runs.

Use full commit-pinned code links, not moving branch links. Mutable conversation URLs locate sources; they require captured content, timestamps, and digests for audit. Collect all pages of relevant source data through authenticated APIs and retain the complete report when a rendered summary is truncated. A pasted JSON record, badge, screenshot, or claimed check URL cannot authenticate itself. Missing, inaccessible, expired, or digest-mismatched required artifacts leave the requirement unsatisfied.

Before publication, re-read the current head, protected policy revision, and every mutable decision input. Any changed relevant source invalidates the assessment even at the same head. Returning to an old head after a force-push requires a new assessment. Historical evidence remains traceable but cannot silently satisfy current requirements. The complete canonical digest and ownership protocol still require implementation; the existing normalized fingerprint alone must not be presented as this contract.

## Independence classifications

Independence is relative to a specific claim and plausible failure mechanism. More output does not necessarily provide another independent source. Record producer independence and mechanism independence separately; unknown independence never satisfies a requirement for independent evidence.

| Class                                    | Example                                                                                                                   | Permitted interpretation                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Author assertion                         | Author says a race is fixed or supplies a test report                                                                     | A claim requiring verification, not independent confirmation                                                                       |
| Repeated or correlated evidence          | Same author reruns their test; another agent summarizes the same report; two tools use the same assertion and fixture     | Additional observations, not independent evidence for the claim                                                                    |
| Independently executed, shared mechanism | Trusted CI runs an author-written test on the current SHA                                                                 | Independently observed execution, but assertion design and blind spots remain shared; not an independent implementation assessment |
| Independent author, shared mechanism     | Another reviewer reruns or rewrites the same mocked test with the same oracle                                             | Independent authorship alone does not remove common failure modes                                                                  |
| Independent, complementary assessment    | A separate reviewer examines actual state transitions and adds an adversarial scenario using a distinct observable oracle | Candidate independent corroboration for the stated claim, subject to scope and shared-assumption disclosure                        |

The same author is not an independent reviewer of their own change. The same verification mechanism is not an independent mechanism, even under a different account, model, process, or brand. Two model reviews can share prompts, generated summaries, and assumptions; identities alone do not establish independence. An independent collector authenticates provenance and execution, not the truth of the underlying assertion. An independent reviewer must consult primary source evidence and the implementation relevant to the claim rather than merely endorse the author's summary.

## Traceability and acceptance questions

A reviewer follows the chain: protected policy rule or finding -> claimed behavior -> changed implementation -> assertion and oracle -> authenticated current-target run or explicit authorized disposition -> remaining limits. Each required rule needs a recorded result, supporting evidence IDs, reason, and unresolved gaps. A requirement-to-test link alone is insufficient if the test never asserts the behavior.

| Property            | Required review question                                                                                                   | Refusal condition                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fresh               | Does each result evaluate the exact required target, with unchanged policy and mutable review state at final revalidation? | Old or absent SHA, wrong target kind, changed source state, or unverified freshness                           |
| Complete            | Are all required rules, changed risk surfaces, blocking findings, check attempts, and source pages accounted for?          | Missing required review, omitted finding, partial pagination, or inaccessible required evidence               |
| Reproducible        | Can an authorized reviewer identify the source, command, environment, fixtures, oracle, and retained result?               | Undocumented manual assertion, untraceable output, or unverifiable artifact integrity                         |
| Consistent          | Do source identity, timestamps, target, assertions, results, and reviewer decisions agree?                                 | Contradictory results, mismatched artifact/run metadata, or unexplained supersession                          |
| Relevant and strong | Would the assertion detect the reported failure, including the important boundary or adverse path?                         | Only checks a mock call, happy path, snapshot, test count, or unrelated suite while claiming a behavioral fix |

Reproducible does not mean deterministic scheduling or identical timing. For concurrency and external integration evidence, record the controllable schedule, observations, tolerances, and limits; inability to reproduce a reported failure remains an open concern. Coverage percentages and green suites establish only their measured assertions. A reviewer must state why the selected oracle detects the concern and what it cannot establish.

## Refusal and escalation

Refusal here means withholding a passing recommendation and approval until required evidence or review is sufficient. It does not invent a new engine verdict or override existing policy. Report the expected evidence, observed source IDs, exact target, gap, owner or requested review role, and concrete next action. Never convert missing evidence into an advisory exemption by inference.

- Missing or in-flight required evidence: retain a non-passing assessment and request the specific current-target run, artifact, or reviewer assessment. Existing policy uses `PENDING` for incomplete required review/checks.
- Stale evidence: retain the old record as historical, request current evidence, and re-evaluate. An old reviewer SHA is pending freshness; a changed snapshot during evaluation is `STALE`, following existing publication ownership rules.
- Contradictory evidence or an active blocking decision: preserve both sources, identify the conflicting assertion, and request targeted independent implementation review. A demonstrated current defect or active required-reviewer `CHANGES_REQUESTED` remains blocking under policy; a favorable reviewer cannot erase it.
- Weak assertions or a gap between the claim and test: require an observable regression assertion and targeted inspection of the relevant implementation. Rerunning the same weak test does not close the gap.
- Retrieval, authentication, parsing, or integrity failure: surface the diagnostic and follow existing `ERROR` behavior where applicable. Unknown provenance cannot authorize a pass.

Simultaneous causes must remain visible; this proposal does not resolve the existing policy's incomplete verdict precedence cross-product. Optional semantic escalation remains bounded by the verification policy and fails closed for uncertainty. A model recommendation cannot authenticate artifacts, waive required human review, change base policy, or establish branch-protection recognition.

## Mandatory targeted implementation review by risk

Evidence review narrows and informs code review; it does not eliminate it. The proposed contract requires targeted implementation review before accepting evidence whenever a required assertion lacks a convincing oracle, independence is required but unestablished, evidence conflicts, or the changed behavior crosses a sensitive boundary. Review the code and relevant callers, state transitions, trust boundaries, failure recovery, and test assumptions identified by the concern.

Apply the protected-base path risk policy with the strictest matching tier governing the PR. High-risk changes, such as authentication, authorization, workflow permissions, policy loading, evidence trust, stale-result ownership, or approval publication, require independent targeted implementation review in this proposed contract. Any configured mandatory human review remains mandatory, including when tests and automated reviews pass. Unknown or unmatched risk uses the strictest repository baseline. Record reviewer identity, evaluated SHA, inspected paths and scenarios, disposition, and residual risks.

Low-risk documentation or mechanical changes can receive proportionate review of factual accuracy, links, scope, and unintended behavioral impact. Escalate if inspection reveals a policy or security consequence despite a low-risk filename. This proposal does not silently add risk rules to current configuration; maintainers must approve concrete rule predicates and enforcement before activation.

## Worked examples

All identities, repository names, IDs, timestamps, commits, results, and behavior below are synthetic. They are reasoning examples, not executed tests, production artifacts, implementation coverage, or reports of existing enforcement. `H1` denotes the full SHA `1111111111111111111111111111111111111111`, `H2` denotes `2222222222222222222222222222222222222222`, and `B1` denotes the protected policy revision `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` in the fictional repository `example/evidence-demo`.

### Positive: bounded support after independent inspection

Synthetic PR 7 at H1 uses B1 and proposes rejecting duplicate delivery before dispatch. Finding F7 requires that a replay cannot dispatch twice. Evidence E1 is the author's claim and regression test, labeled author-provided. The synthetic trace points to `src/replay.ts:32` and `tests/replay.test.ts:18`, both pinned to H1. E2 is authenticated workflow `ci/replay`, run 701 attempt 1 on H1, completed at `2026-11-12T12:00:00Z`: command `pnpm exec vitest run tests/replay.test.ts`, Node 22, lockfile from H1, and a fixed clock fixture. Artifact `replay-701.json` has synthetic digest `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. Its retained assertion log shows the same signed event delivered twice and exactly one dispatch observed. CI execution is independent of the author; the test oracle is still author-designed.

Independent reviewer Morgan examines the actual replay-key scope, insertion order, expiry, and failure path at H1. Review R7 links F7, the changed implementation and test locations, and E2. Morgan supplies a separate harness that injects one dispatch failure and then retries the event, observing the real dispatch boundary rather than mocking the replay decision. E3 records authenticated run 702 on H1 with one failed attempt followed by exactly one successful dispatch and retained harness inputs, command, environment, and artifact digest. R7 records the inspected scenario and the process-local lifetime limit. The reviewer does not claim durable cross-process deduplication.

If all other required policy conditions are satisfied, current source collection is complete, required human review is present, and final revalidation still matches H1/B1 and the review-state digest, the proposed contract can accept the bounded replay claim. The audit records F7 -> implementation -> E2/E3 -> R7 and the durability limitation. This supports policy satisfaction for H1 only, with approval eligibility assessed separately; it proves neither universal correctness nor deployment readiness.

### Refusal: passing tests do not test the claim

At synthetic PR 8/H1, E8 reports a green test that mocks authorization as allowed and asserts a handler was called. The author claims unauthorized users are rejected. The run is current and reproducible, but its oracle never observes rejection and its mock bypasses the relevant boundary. Another agent restating E8 is correlated evidence. Refuse the claim, identify the missing denied-access assertion, and require a real authorization-path regression scenario plus independent targeted implementation review. No additional rerun count can repair the assertion gap.

### Refusal: freshness, contradiction, and missing provenance

At synthetic PR 9/H2, E9 is an otherwise strong run on H1; E10 is an unretained screenshot claiming a passing H2 run. Required reviewer R9 evaluated H1. A current authenticated H2 finding F9 demonstrates an unauthorized request succeeds, while the author marks its thread resolved. E9 and R9 are stale, E10 cannot authenticate the claimed result, and F9 contradicts resolution. Retain all observations, withhold approval, and require a current authenticated regression run and independent security review of H2. Thread closure and the stale green suite cannot clear F9.

If an H2 run and review later address F9 but a new blocking comment arrives before publication, final revalidation invalidates that assessment even with unchanged H2. Follow the existing `STALE` and check-ownership rules; recollect and re-evaluate instead of publishing the earlier passing recommendation.
