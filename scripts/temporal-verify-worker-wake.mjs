import { setTimeout as wait } from 'node:timers/promises';
import { proofDigest } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('WORKER_WAKE_RELEASE_UNCONFIRMED');
};
const sha256 = /^[a-f0-9]{64}$/;
const same = (a, b) => proofDigest(a) === proofDigest(b);
const hour = 60 * 60 * 1000;

/** Own exactly one original Workflow. A later invocation continues the
 * same probe and a terminal run without retry-wait evidence stays unverified. */
export async function verifyWorkerWake({
  operationId,
  releaseId,
  bindingDigest,
  evidenceDigest,
  buildId,
  role,
  protectionSHA256,
  saved,
  assertAuthority,
  beforeStart,
  save,
  start,
  status,
  observeRetry,
  collect,
}) {
  if (
    ![assertAuthority, beforeStart, save, start, status, observeRetry, collect].every(
      (fn) => typeof fn === 'function'
    ) ||
    !sha256.test(protectionSHA256 ?? '')
  )
    fail();
  const plan = {
    schemaVersion: 1,
    operationId,
    releaseId,
    bindingDigest,
    evidenceDigest,
    buildId,
    role,
    protectionSHA256,
  };
  const nonce = operationId.replaceAll('-', '');
  let state = saved;
  if (state && (!same(state.plan, plan) || !['attempted', 'started', 'retry-wait', 'completed'].includes(state.stage)))
    fail();
  const put = async (next) => {
    await save(next);
    state = next;
  };
  await assertAuthority();
  if (state?.stage === 'completed') return state;
  if (!state || state.stage === 'attempted') {
    if (!state) await beforeStart();
    const run = await start({
      nonce,
      role,
      assertAuthority,
      saveAttempt: async (attempt) => {
        if (state) fail();
        await put({ plan, stage: 'attempted', attempt });
      },
      ...(state ? { saved: state.attempt } : {}),
    });
    if (!state || run?.workflowId !== state.attempt.workflowId || !same(run.input, state.attempt.input)) fail();
    await put({ ...state, stage: 'started', run });
  }
  const { run, attempt } = state;
  if (
    !Number.isSafeInteger(attempt?.input?.delayMs) ||
    attempt.input.delayMs < 1000 ||
    attempt.input.delayMs > 3 * hour ||
    !Number.isSafeInteger(attempt.attemptedAt)
  )
    fail();
  const deadline = attempt.attemptedAt + 3 * attempt.input.delayMs + 22 * 60 * 1000;
  while (Date.now() < deadline) {
    await assertAuthority();
    let observed;
    try {
      observed = await status(run);
    } catch (error) {
      if (![4, 8, 14].includes(error?.code)) throw error;
      await wait(5000);
      continue;
    }
    if (observed !== 1 && observed !== 2) fail();
    if (state.stage === 'started') {
      if (observed === 2) fail();
      const retryWait = await observeRetry(run).catch(() => undefined);
      if (retryWait) await put({ ...state, stage: 'retry-wait', retryWait });
    }
    if (state.stage === 'retry-wait' && observed === 2) {
      const to = Date.now(),
        from = Math.max(1, to - 8 * hour);
      const proof = await collect({ run, retryWait: state.retryWait, from, to }).catch(() => undefined);
      if (proof) {
        await assertAuthority();
        await put({ ...state, stage: 'completed', proof });
        return state;
      }
    }
    const earliest =
      state.stage === 'started' ? attempt.attemptedAt + attempt.input.delayMs : state.retryWait.eligibleAt;
    await wait(Math.min(30000, Math.max(observed === 2 ? 15000 : 5000, earliest - Date.now())));
  }
  return fail();
}
