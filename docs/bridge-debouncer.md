# Process-local bridge debouncer

`src/bridge/debouncer.ts` exports `createDebouncer({ dispatch, windowMs? })`.
The injected dispatcher receives `{ repository, prNumber, headSha }`. A future
webhook adapter can call `enqueue` for authenticated thread resolved and
unresolved events. This module does not authenticate, parse webhooks, call GitHub,
or configure a deployment or workflow.

Each case-insensitive `owner/repo` and PR number has its own fixed window,
defaulting to 5000 milliseconds from the first event. Later arrivals replace the
head SHA without extending the deadline. Latest means latest received, not a
verified ordering of commits. Every caller within that window receives the same
completion promise. Inputs are copied. Invalid repository names, nonpositive or
unsafe PR numbers, empty or whitespace-containing heads, and timer durations
outside integer 1 through 2147483647 are rejected synchronously. Heads are opaque
identifiers; the adapter must validate trusted webhook data and current PR state.

At expiry the window closes and its input is queued for dispatch. Dispatches for
one PR run serially; other PRs can dispatch concurrently. Events arriving during
a dispatch start a fresh window and cannot alter an already queued input. A slow
dispatch can therefore delay later windows for that PR. Timer deadlines are
subject to event-loop scheduling. Sustained traffic or slow dispatches can consume
unbounded memory; deployments must provide admission controls and timeouts.

```typescript
const debouncer = createDebouncer({
  dispatch: async ({ repository, prNumber, headSha }) => {
    await dispatchWorkflow(repository, {
      pr_number: String(prNumber),
      head_sha: headSha,
    });
  },
});
await debouncer.enqueue({ repository: "owner/repo", prNumber: 42, headSha: "abc123" });
```

The example's `dispatchWorkflow` is an adapter supplied by the host, not an
implemented API client. Callers must await or catch completion promises. Both
synchronous throws and rejected dispatcher promises reject the window completion;
there are no automatic retries. A failed dispatch does not block later windows.
The promise confirms only that the injected dispatch function completed, not that
verification succeeded. Verification still requires current-head checks and the
authoritative Checks API gate described in [events and state](docs/events-and-state.md).
Fast invalidation must occur independently before delayed evaluation dispatch.

All timers and queues live in one JavaScript process. Restarts lose pending work;
multiple instances do not coalesce with each other. Serverless hosts must keep
the process alive until completion, or use a durable queue and shared coordination.
This primitive provides neither durable delivery nor distributed deduplication.
