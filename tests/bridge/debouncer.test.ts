import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer, type DispatchInput } from "../../src/bridge/debouncer.js";

const event = (prNumber = 1, headSha = "abc", repository = "owner/repo") => ({
  repository,
  prNumber,
  headSha,
});

describe("bridge debouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses a fixed five-second window and the latest received head", async () => {
    const calls: unknown[] = [];
    const debounce = createDebouncer({
      dispatch: async (input) => {
        calls.push(input);
      },
    });
    const first = debounce.enqueue(event());
    await vi.advanceTimersByTimeAsync(4999);
    const second = debounce.enqueue(event(1, "new"));
    expect(second).toBe(first);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(calls).toEqual([event(1, "new")]);
  });

  it("isolates repository and PR keys and opens new windows", async () => {
    const calls: unknown[] = [];
    const debounce = createDebouncer({
      windowMs: 10,
      dispatch: async (input) => {
        calls.push(input);
      },
    });
    const pending = [
      debounce.enqueue(event()),
      debounce.enqueue(event(2)),
      debounce.enqueue(event(1, "abc", "other/repo")),
    ];
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pending);
    const next = debounce.enqueue(event(1, "next"));
    await vi.advanceTimersByTimeAsync(10);
    await next;
    expect(calls).toEqual([event(), event(2), event(1, "abc", "other/repo"), event(1, "next")]);
  });

  it("serializes one PR while allowing another PR to dispatch", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: unknown[] = [];
    const debounce = createDebouncer({
      windowMs: 10,
      dispatch: async (input) => {
        calls.push(input);
        if (input.headSha === "abc" && input.prNumber === 1) await blocked;
      },
    });
    const first = debounce.enqueue(event());
    await vi.advanceTimersByTimeAsync(10);
    const second = debounce.enqueue(event(1, "next"));
    const other = debounce.enqueue(event(2));
    await vi.advanceTimersByTimeAsync(10);
    await other;
    expect(calls).toEqual([event(), event(2)]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([event(), event(2), event(1, "next")]);
  });

  it.each(["sync", "async"])("exposes %s failures and recovers on later windows", async (mode) => {
    const failure = new Error("dispatch failed");
    let fail = true;
    const debounce = createDebouncer({
      windowMs: 10,
      dispatch: () => {
        if (fail) {
          if (mode === "sync") throw failure;
          return Promise.reject(failure);
        }
        return undefined;
      },
    });
    const first = debounce.enqueue(event());
    const rejected = expect(first).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    fail = false;
    const next = debounce.enqueue(event());
    await vi.advanceTimersByTimeAsync(10);
    await expect(next).resolves.toBeUndefined();
  });

  it("copies inputs so caller mutation cannot change the dispatch", async () => {
    const calls: unknown[] = [];
    const debounce = createDebouncer({
      dispatch: (input) => {
        calls.push(input);
      },
    });
    const input = event();
    const pending = debounce.enqueue(input);
    input.headSha = "mutated";
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(calls).toEqual([event()]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2147483648])(
    "rejects invalid window %s",
    (windowMs) => {
      expect(() => createDebouncer({ windowMs, dispatch: () => {} })).toThrow();
    },
  );

  it.each([
    event(0),
    event(1.5),
    event(Number.MAX_SAFE_INTEGER + 1),
    event(1, ""),
    event(1, " abc"),
    event(1, "abc", "bad"),
    event(1, "abc", " owner/repo"),
  ])("rejects invalid event %# without scheduling", (input) => {
    const debounce = createDebouncer({ dispatch: () => {} });
    expect(() => debounce.enqueue(input)).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { headSha: [] },
    { headSha: {} },
    { headSha: 123 },
    { repository: { toString: () => "owner/repo" } },
  ])("rejects malformed runtime strings without replacing pending work %#", async (malformed) => {
    const calls: DispatchInput[] = [];
    const debounce = createDebouncer({
      dispatch: (input) => {
        calls.push(input);
      },
    });
    const pending = debounce.enqueue(event());
    expect(() =>
      debounce.enqueue({ ...event(), ...malformed } as unknown as DispatchInput),
    ).toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(calls).toEqual([event()]);
  });
});
