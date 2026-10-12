/**
 * Run async work over a list with bounded concurrency while preserving input order in results.
 * On failure, stop taking new work and drain in-flight workers before rejecting so
 * callers can safely release locks or roll back without concurrent mutations.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.floor(concurrency) || 1);
  const workerCount = Math.min(safeConcurrency, items.length);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;

  const runners = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });

  await Promise.all(runners);
  if (failed) {
    throw firstError;
  }
  return results;
}
