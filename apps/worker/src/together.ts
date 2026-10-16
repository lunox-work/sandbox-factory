/**
 * Two pieces of one run's work at once, each given a signal that is cut
 * when the other fails, so neither keeps spending once the run has failed.
 * Settles once both have; rejects with the first failure.
 */
export async function together<A, B>(
  signal: AbortSignal,
  first: (signal: AbortSignal) => Promise<A>,
  second: (signal: AbortSignal) => Promise<B>,
): Promise<[A, B]> {
  const cut = new AbortController();
  const scoped = AbortSignal.any([signal, cut.signal]);
  const guard = async <T>(work: (signal: AbortSignal) => Promise<T>) => {
    try {
      return await work(scoped);
    } catch (error) {
      if (!cut.signal.aborted) cut.abort(error);
      throw error;
    }
  };
  const [a, b] = await Promise.allSettled([guard(first), guard(second)]);
  if (a.status === "rejected" || b.status === "rejected")
    throw cut.signal.reason;
  return [a.value, b.value];
}
