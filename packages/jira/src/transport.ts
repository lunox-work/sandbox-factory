/** Deadlines cover headers and body consumption, even for injected fetches ignoring abort. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000;
export async function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return promise;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
  timeoutMs = JIRA_REQUEST_TIMEOUT_MS,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Jira request timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  try {
    return await waitFor(
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", abort);
  }
}
export async function abortableSleep(
  ms: number,
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  if (sleep !== undefined) return waitFor(sleep(ms), signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitFor(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
