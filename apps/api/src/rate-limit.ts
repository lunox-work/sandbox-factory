/**
 * A fixed-window attempt counter, in this process's memory: at most
 * `limit` attempts per key in each `windowMs`. For routes that take a
 * guessable input from a signed-in person (an invite's secret), where the
 * secret's entropy is the real defence and this bounds the noise.
 *
 * Per process, so N API tasks admit N times the limit, and a restart
 * forgets; neither matters for what it guards. Keys whose window has
 * passed are dropped as others are counted, so memory stays bounded by
 * the keys active in one window.
 */

export interface AttemptLimiter {
  /** Counts an attempt for `key`: allowed, or how long until it may retry. */
  take(
    key: string,
  ):
    | { readonly ok: true }
    | { readonly ok: false; readonly retryAfterSeconds: number };
}

export function attemptLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => Date;
}): AttemptLimiter {
  const now = options.now ?? (() => new Date());
  const windows = new Map<string, { startedAt: number; count: number }>();
  const prune = (at: number) => {
    for (const [key, window] of windows)
      if (at - window.startedAt >= options.windowMs) windows.delete(key);
  };
  return {
    take(key) {
      const at = now().getTime();
      prune(at);
      const window = windows.get(key) ?? { startedAt: at, count: 0 };
      if (window.count >= options.limit)
        return {
          ok: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((window.startedAt + options.windowMs - at) / 1000),
          ),
        };
      window.count += 1;
      windows.set(key, window);
      return { ok: true };
    },
  };
}
