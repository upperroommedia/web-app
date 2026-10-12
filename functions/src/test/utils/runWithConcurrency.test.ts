import { runWithConcurrency } from '../../utils/runWithConcurrency';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('runWithConcurrency', () => {
  it('bounds active work and preserves input order when workers finish out of order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const result = runWithConcurrency([0, 1, 2], 2, async (item) => {
      started.push(item);
      await gates[item].promise;
      return `result-${item}`;
    });
    expect(started).toEqual([0, 1]);

    gates[1].resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve();
    gates[0].resolve();

    await expect(result).resolves.toEqual(['result-0', 'result-1', 'result-2']);
  });

  it('waits for in-flight mutations and stops queued work after the first failure', async () => {
    const failure = new Error('upstream mutation failed');
    const failGate = deferred();
    const inFlightGate = deferred();
    const started: number[] = [];
    let mutationCompleted = false;
    let settled = false;
    const result = runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await failGate.promise;
        throw failure;
      }
      await inFlightGate.promise;
      mutationCompleted = true;
      throw new Error('later failure');
    });
    const observed = result.catch((error: unknown) => {
      settled = true;
      expect(mutationCompleted).toBe(true);
      return error;
    });

    failGate.resolve();
    // Give the first error time to propagate through all promise continuations.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);

    inFlightGate.resolve();
    await expect(observed).resolves.toBe(failure);
    expect(started).toEqual([0, 1]);
  });

  it('preserves even an undefined rejection reason', async () => {
    const worker = jest.fn(async () => { throw undefined; });
    await expect(runWithConcurrency([0, 1], 1, worker)).rejects.toBeUndefined();
    expect(worker).toHaveBeenCalledTimes(1);
  });
});
