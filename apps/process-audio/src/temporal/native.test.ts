import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { CancelToken } from '../CancelToken';
import { runMediaCommand } from './native';

test('quiet native media work is cancelled and drained before rejection', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 150);
  await assert.rejects(
    runMediaCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal),
    /cancelled/
  );
  clearTimeout(timer);
});

test('provider diagnostics are excluded from durable errors', async () => {
  const controller = new AbortController();
  await assert.rejects(
    runMediaCommand(
      process.execPath,
      ['-e', 'process.stderr.write("https://provider.invalid/?token=SECRET");process.exit(4)'],
      controller.signal
    ),
    (error) => {
      assert(error instanceof Error);
      assert(!error.message.includes('SECRET'));
      assert(!error.message.includes('provider.invalid'));
      return true;
    }
  );
});

test('native ffmpeg progress parses measured microseconds', async () => {
  const seconds: number[] = [];
  await runMediaCommand(
    process.execPath,
    ['-e', 'process.stdout.write("out_time_us=1250000\\n")'],
    new AbortController().signal,
    (value) => seconds.push(value)
  );
  assert.deepEqual(seconds, [1.25]);
});

test('provider process registry cancels silent child and waits for close', async () => {
  const token = new CancelToken();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  token.trackProcess(child);
  token.cancel();
  await token.waitForProcesses();
  assert(closed);
});

test('already cancelled process registry immediately kills newly started child', async () => {
  const token = new CancelToken();
  token.cancel();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  token.trackProcess(child);
  await token.waitForProcesses();
  assert.notEqual(child.signalCode, null);
});
