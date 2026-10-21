import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMEOUT_SECONDS } from '../consts';
import { CancelToken } from '../CancelToken';
import { hostResourceRequest } from './resources';
import { consumeHostOutcome } from './outcome';
import { legacyHostInput, hostContext, type HostInput } from './input';
import type { ProcessAudioResult } from '../processAudio';
import type { ProcessAudioInputType } from '../types';
import type { LegacyOriginalSource } from '@upperroom/orchestration/legacy-media-execution';
import type { LogContext } from '../context';
import type { YouTubeMediaByteCanaryReport } from '../youtubeReadiness';
const unavailable = () => new Error('HOST_ISOLATED_WORK_UNCONFIRMED');
async function getOnly(id: string): Promise<void> {
  await hostResourceRequest(id, 'get').catch(() => undefined);
}
async function run(
  input: HostInput,
  token: CancelToken,
  ctx: LogContext
): Promise<ProcessAudioResult | YouTubeMediaByteCanaryReport> {
  token.signal.throwIfAborted();
  let reservation: Awaited<ReturnType<typeof hostResourceRequest>>;
  try {
    reservation = await hostResourceRequest(input.id, 'reserve', { kind: input.kind });
  } catch {
    await getOnly(input.id);
    throw unavailable();
  } // NEVER resend/fork on unknown ACK.
  if (reservation.state !== 'reserved' || reservation.directory !== `/workspace/host-resource/${input.id}`)
    throw unavailable();
  if (token.signal.aborted) {
    await hostResourceRequest(input.id, 'unstarted');
    throw unavailable();
  }
  const env = { ...process.env, TMPDIR: reservation.directory, FIREBASE_SERVICE_ACCOUNT_JSON: '' };
  // Credentials remain the existing fixed mounted ADC; no new token or serialized
  // SDK identity enters IPC. Commands and helper paths are source-fixed.
  let child: ChildProcess;
  try {
    child = fork(join(__dirname, 'helper.js'), [], {
      detached: true,
      execArgv: [],
      silent: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
    });
  } catch {
    throw unavailable();
  } // Uncertain fork never becomes an unused receipt.
  const startedWall = Date.now(),
    startedMono = performance.now();
  const deadline = setTimeout(() => token.cancel(), TIMEOUT_SECONDS * 1000);
  deadline.unref();
  let code: number | null = null,
    nativeClosed = false,
    sent = false,
    invalid = false,
    outcome: unknown;
  let messageCount = 0;
  const closed = new Promise<void>((resolve) => {
    child.once('close', (exit) => {
      code = exit;
      nativeClosed = true;
      clearTimeout(deadline);
      resolve();
    });
  });
  child.once('error', () => {
    invalid = true;
    token.cancel();
  });
  child.on('message', (message) => {
    if (!sent || ++messageCount !== 1 || Buffer.byteLength(JSON.stringify(message)) > 8192) {
      invalid = true;
      token.cancel();
      return;
    }
    outcome = message;
  });
  token.trackProcess(child);
  let stopped: Promise<unknown> | undefined;
  const stop = () => {
    if (nativeClosed) return; // Never signal an old numeric PID during durable ACK waits.
    stopped ??= hostResourceRequest(input.id, 'stop').catch(async () => {
      await getOnly(input.id);
    });
  };
  token.signal.addEventListener('abort', stop, { once: true });
  if (token.signal.aborted) stop();
  let executionError = false;
  try {
    if (!child.pid) throw unavailable();
    let enrollment: Awaited<ReturnType<typeof hostResourceRequest>>;
    try {
      enrollment = await hostResourceRequest(input.id, 'enroll', { childPid: child.pid });
    } catch {
      await getOnly(input.id);
      throw unavailable();
    }
    if (
      enrollment.state !== 'enrolled' ||
      enrollment.directory !== reservation.directory ||
      token.signal.aborted ||
      nativeClosed
    )
      throw unavailable();
    sent = true;
    await new Promise<void>((resolve, reject) =>
      child.send(input, (error) => (error ? reject(unavailable()) : resolve()))
    );
    await closed;
  } catch {
    executionError = true;
    token.cancel();
    stop();
    await closed;
  } finally {
    token.signal.removeEventListener('abort', stop);
  }
  // The coordinator retains an original cgroup handle after direct CLOSE.
  // Stop remaining descendants before attempting the one completion mutation.
  stopped ??= hostResourceRequest(input.id, 'stop').catch(() => getOnly(input.id));
  await stopped;
  // Direct CLOSE never substitutes for the root coordinator's exact original
  // pidfd + operation-cgroup drain and immutable completion acknowledgement.
  let receipt: Awaited<ReturnType<typeof hostResourceRequest>>;
  try {
    receipt = await hostResourceRequest(input.id, 'close');
    if (receipt.state !== 'closed' || receipt.groupAbsent !== true || !receipt.receiptHash) throw unavailable();
  } catch {
    // Keep the existing parent's native admission/lease until its original
    // operation is authoritatively settled. Socket loss or a direct-child exit
    // cannot permit a second operation. GET never repeats close or adopts work.
    for (;;) {
      try {
        receipt = await hostResourceRequest(input.id, 'get');
        if (receipt.state === 'closed' && receipt.groupAbsent === true && receipt.receiptHash) break;
      } catch {
        /* Unknown cleanup retains the original pending authority. */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (receipt.state !== 'closed' || receipt.groupAbsent !== true || !receipt.receiptHash) throw unavailable();
  if (
    receipt.descendantsStopped === true ||
    executionError ||
    invalid ||
    code !== 0 ||
    messageCount !== 1 ||
    token.signal.aborted ||
    Date.now() < startedWall ||
    Date.now() - startedWall >= TIMEOUT_SECONDS * 1000 ||
    performance.now() - startedMono >= TIMEOUT_SECONDS * 1000
  )
    throw unavailable();
  return consumeHostOutcome(outcome, input.id, ctx, input.kind);
}
export async function runIsolatedLegacyWork(o: {
  projectId: 'urm-app' | 'urm-app-staging';
  data: ProcessAudioInputType;
  bucketName: string;
  originalSource?: LegacyOriginalSource;
  taskId: string | null;
  ctx: LogContext;
  cancelToken: CancelToken;
}): Promise<ProcessAudioResult> {
  const input = legacyHostInput({ ...o, id: randomUUID() });
  return (await run(input, o.cancelToken, o.ctx)) as ProcessAudioResult;
}
export async function runIsolatedHostCanary(o: {
  projectId: 'urm-app' | 'urm-app-staging';
  scope: 'guest' | 'authenticated';
  ctx: LogContext;
}): Promise<YouTubeMediaByteCanaryReport> {
  return (await run(
    { v: 1, id: randomUUID(), kind: 'canary', projectId: o.projectId, scope: o.scope, ctx: hostContext(o.ctx) },
    new CancelToken(),
    o.ctx
  )) as YouTubeMediaByteCanaryReport;
}
