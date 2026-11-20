import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { executeWithTimeout } from '../../../process-audio/src/utils';
import { CancelToken } from '../../../process-audio/src/CancelToken';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
test('successful pipeline clears timeout instead of cancelling later unrelated work', async () => {
  let cancelled = 0;
  expect(
    await executeWithTimeout(
      async () => 7,
      () => {
        cancelled++;
      },
      20
    )
  ).toBe(7);
  await pause(50);
  expect(cancelled).toBe(0);
});
test('timeout cannot settle before original native child CLOSE and original operation settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-pipeline-'));
  const path = join(root, 'child.cjs');
  await writeFile(
    path,
    'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150)); process.send({ready:true}); setInterval(() => {}, 1000);'
  );
  const child = fork(path, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const token = new CancelToken();
  token.trackProcess(child);
  let closed = false,
    originalSettled = false;
  const close = once(child, 'close').then(() => {
    closed = true;
  });
  try {
    await once(child, 'message');
    const original = close.then(async () => {
      await pause(25);
      originalSettled = true;
      return 42;
    });
    await expect(executeWithTimeout(() => original, token.cancel, 20)).rejects.toThrow('Timeout');
    expect(closed).toBe(true);
    expect(originalSettled).toBe(true);
  } finally {
    if (!closed) child.kill('SIGKILL');
    await close;
    await token.waitForProcesses();
    await rm(root, { recursive: true, force: true });
  }
});
test('blocked event loop cannot convert an elapsed timeout into pipeline success', async () => {
  let cancelled = 0;
  await expect(
    executeWithTimeout(
      async () => {
        const end = performance.now() + 60;
        while (performance.now() < end) {
          /* Actual event-loop stall: timer cannot fire. */
        }
        return 42;
      },
      () => {
        cancelled++;
      },
      10
    )
  ).rejects.toThrow('Timeout');
  expect(cancelled).toBe(1);
});

test('failed signals and repeated cancellation never fabricate settlement or prevent escalation', async () => {
  jest.useFakeTimers();
  try {
    const native = new EventEmitter();
    const kill = jest.fn(() => {
      throw Error('CONTROLLED_SIGNAL_FAILURE');
    });
    Object.assign(native, { kill });
    const token = new CancelToken();
    token.trackProcess(native as ChildProcess);
    token.cancel();
    token.cancel();
    expect(kill.mock.calls).toEqual([['SIGTERM']]);
    let closed = false;
    const pending = token.waitForProcesses().then(() => {
      closed = true;
    });
    jest.advanceTimersByTime(5000);
    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    await Promise.resolve();
    expect(closed).toBe(false);
    native.emit('close');
    await pending;
    expect(closed).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
