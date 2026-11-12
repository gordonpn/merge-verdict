/** Inputs for an injected workflow dispatcher, not a GitHub API payload. */
export interface DispatchInput {
  repository: string;
  prNumber: number;
  headSha: string;
}

export interface DebouncerOptions {
  dispatch: (input: DispatchInput) => void | Promise<void>;
  windowMs?: number;
}

interface Window {
  input: DispatchInput;
  completion: Promise<void>;
}

/** Process-local fixed windows. Callers must observe enqueue's returned promise. */
export function createDebouncer(options: DebouncerOptions): {
  enqueue(input: DispatchInput): Promise<void>;
} {
  const windowMs = options.windowMs ?? 5000;
  if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > 2147483647) {
    throw new RangeError("windowMs must be an integer from 1 to 2147483647");
  }
  const windows = new Map<string, Window>();
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue(input) {
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
        !Number.isSafeInteger(input.prNumber) ||
        input.prNumber < 1 ||
        !input.headSha ||
        /\s/.test(input.headSha)
      ) {
        throw new TypeError(
          "Expected owner/repo, a positive safe PR number, and a nonempty head SHA without whitespace",
        );
      }
      const key = `${input.repository.toLowerCase()}:${input.prNumber}`;
      const existing = windows.get(key);
      if (existing) {
        existing.input = { ...input };
        return existing.completion;
      }
      let resolve = () => {};
      let reject: (reason: unknown) => void = () => {};
      const completion = new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      const window = { input: { ...input }, completion };
      windows.set(key, window);
      setTimeout(() => {
        windows.delete(key);
        const previous = tails.get(key) ?? Promise.resolve();
        const tail = previous.then(() => options.dispatch(window.input)).then(resolve, reject);
        tails.set(key, tail);
        void tail.then(() => {
          if (tails.get(key) === tail) tails.delete(key);
        });
      }, windowMs);
      return completion;
    },
  };
}
