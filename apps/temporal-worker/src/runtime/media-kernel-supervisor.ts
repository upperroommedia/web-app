import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { diagnosticComputeIdentity, type WorkerWitness } from './worker-witness';
import { workerReadinessDigest as digest } from './readiness-probe';
import { mediaJobPhase, tagMediaJobFailure } from './media-job-launch-failure';
const fail = (): never => {
  throw new Error('MEDIA_KERNEL_SUPERVISION_UNCONFIRMED');
};
const uuid = (x: unknown) =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
export const MEDIA_KERNEL_KIND = 'owned-application-child-v1';
// Leave room before Cloud Run's ten-second deadline while allowing the
// worker's configured eight-second SDK shutdown grace period.
const childShutdownGraceMs = 8500;
const path = (id: string) => {
  if (!uuid(id)) fail();
  return `_control/temporalMediaKernel-${id}`;
};
const version = (s: any) => (s.updateTime ? `${s.updateTime.seconds}:${s.updateTime.nanoseconds}` : fail());
function sameCloud(a: WorkerWitness, b: WorkerWitness) {
  if (a.buildId !== b?.buildId) fail();
  const expected = diagnosticComputeIdentity(a);
  const actual = diagnosticComputeIdentity(b);
  if (!expected || !actual || digest(expected) !== digest(actual)) fail();
}
function worker(raw: unknown): WorkerWitness {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !['buildId,cloudRun,instanceId', 'buildId,cloudRunJob,instanceId'].includes(Object.keys(raw).sort().join(',')) ||
    Buffer.byteLength(JSON.stringify(raw)) > 8192
  )
    fail();
  const w = raw as WorkerWitness;
  if (!uuid(w.instanceId) || !/^[a-f0-9]{40}$/.test(w.buildId ?? '')) fail();
  return w;
}
/** A matching canonical attempted start is the capability. Ordinary cold starts
 * have no kernel journal, no additional child and no restart authority. */
export async function mediaKernelContext(db: Firestore, witness: WorkerWitness) {
  if (!('projectId' in db) || db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)') fail();
  const refs = ['_control/temporalReleaseOperation', '_control/temporalRelease', '_control/temporalReleaseState'].map(
    (p) => db.doc(p)
  );
  const snaps = await db.getAll(...refs),
    [op, c, s] = snaps;
  if (!['bootstrap-stop-cloud-run-media', 'activate-cloud-run-media-pool'].includes(op.get('action'))) return undefined;
  const { mediaStartupIntent } = await import('./media-startup-capacity');
  const owned = mediaStartupIntent(op.data());
  const cloud = witness.cloudRun;
  if (
    owned.plan.mediaStartup.kernel !== MEDIA_KERNEL_KIND ||
    !cloud ||
    !uuid(witness.instanceId) ||
    cloud.projectId !== 'urm-app-staging' ||
    cloud.region !== 'us-central1' ||
    cloud.pool !== owned.plan.name.split('/').at(-1) ||
    cloud.revision !== owned.start.before.revision.split('/').at(-1) ||
    cloud.serviceAccount !== owned.plan.mediaStartup.runner ||
    cloud.imageDigest !== owned.plan.mediaStartup.image.split('@')[1] ||
    witness.buildId !== owned.plan.buildId ||
    !cloud.revisionUid ||
    !cloud.instanceId ||
    !Number.isFinite(Date.parse(owned.start.attemptedAt)) ||
    Date.now() - Date.parse(owned.start.attemptedAt) > 120000
  )
    fail();
  const context = {
    operationId: owned.intent.operationId,
    intentSHA256: owned.intentSHA256,
    controlVersion: version(c),
    stateVersion: version(s),
    parent: witness,
  };
  const checkFresh = () => {
    if (
      Date.now() >= Date.parse(owned.start.attemptedAt) + 120000 ||
      Date.parse(owned.start.attemptedAt) > Date.now() + 5000
    )
      fail();
  };
  const authorize = async (tx: any) => {
    const [o, a, b] = await Promise.all(refs.map((r) => tx.get(r)));
    if (
      mediaStartupIntent(o.data()).intentSHA256 !== context.intentSHA256 ||
      version(a) !== context.controlVersion ||
      version(b) !== context.stateVersion ||
      Date.now() - Date.parse(owned.start.attemptedAt) > 120000 ||
      Date.parse(owned.start.attemptedAt) > Date.now() + 5000 ||
      a.get('releaseId') !== owned.plan.releaseId ||
      b.get('releaseId') !== owned.plan.releaseId ||
      a.get('admission') !== 'paused' ||
      b.get('phase') !== 'provider-usage-ready' ||
      domains.some((d) => a.get(`domains.${d}.admission`) !== 'paused')
    )
      fail();
  };
  return { context, authorize, checkFresh };
}
async function writeOnce(
  db: Firestore,
  ref: DocumentReference,
  expected: any,
  next: any,
  authorize?: (tx: any) => Promise<void>,
  initialJobBirth = false
) {
  try {
    await db.runTransaction(
      async (tx) => {
        if (authorize) await authorize(tx);
        const current = await tx.get(ref);
        if (expected === undefined) {
          if (current.exists) fail();
          tx.create(ref, next);
        } else {
          if (!current.exists || digest(current.data()) !== digest(expected)) fail();
          tx.set(ref, next);
        }
      },
      { maxAttempts: 1 }
    );
  } catch (e) {
    const code = Number((e as { code?: unknown })?.code);
    if ([3, 5, 6, 7, 9, 11, 12, 16].includes(code)) {
      if (!initialJobBirth) return fail();
      const denied = new Error('MEDIA_KERNEL_SUPERVISION_UNCONFIRMED');
      tagMediaJobFailure('kernel-create', e, denied);
      throw denied;
    }
    // Same in-memory parent only: unknown commit acknowledgement is exact GET-only.
    const reconcile = async () => {
      const current = await ref.get();
      if (!current.exists || digest(current.data()) !== digest(next)) fail();
    };
    if (initialJobBirth) await mediaJobPhase('kernel-reconcile', reconcile);
    else await reconcile();
  }
}
async function readKernelBirth(
  db: Firestore,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness,
  journalPath: string
) {
  const value = (await db.doc(journalPath).get()).data() ?? fail();
  return validateMediaKernelBirthRecord(value, operationId, intentSHA256, link, witness);
}
/** Pure historical identity check shared by GET-only collectors. No live handle,
 * signal, journal write or polling authority can be obtained from this reader. */
export function validateMediaKernelBirthRecord(
  value: any,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness
) {
  const x = link as { operationId?: string; birthDigest?: string };
  if (
    !x ||
    Object.keys(x).sort().join(',') !== 'birthDigest,operationId' ||
    x.operationId !== operationId ||
    value?.schemaVersion !== 1 ||
    value.context?.intentSHA256 !== intentSHA256 ||
    !['running', 'closed'].includes(value.stage) ||
    value.context?.operationId !== operationId ||
    !value.intent ||
    Object.keys(value.intent).sort().join(',') !== 'createdAt,launchId,parentPid' ||
    !uuid(value.intent.launchId) ||
    !Number.isSafeInteger(value.intent.parentPid) ||
    value.intent.parentPid <= 0 ||
    !Number.isFinite(Date.parse(value.intent.createdAt)) ||
    !value.birth ||
    Object.keys(value.birth).sort().join(',') !== 'nonce,pid,spawnedAt' ||
    !uuid(value.birth.nonce) ||
    !Number.isSafeInteger(value.birth.pid) ||
    value.birth.pid <= 0 ||
    value.birth.pid === value.intent.parentPid ||
    !Number.isFinite(Date.parse(value.birth.spawnedAt)) ||
    Date.parse(value.birth.spawnedAt) < Date.parse(value.intent.createdAt) ||
    !value.worker ||
    x.birthDigest !==
      digest({ context: value.context, intent: value.intent, birth: value.birth, worker: value.worker }) ||
    digest(value.worker) !== digest(witness)
  )
    fail();
  worker(value.context.parent);
  worker(value.worker);
  if (value.context.parent.instanceId === witness.instanceId) fail();
  sameCloud(value.context.parent, witness);
  return { value, birthDigest: x.birthDigest };
}
async function absent(child: ChildProcess) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      process.kill(-child.pid!, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
      return fail();
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return fail();
}
/** One original ChildProcess, no replacement/restart capability. Native close
 * plus group absence is required for a closed fact; never signal a saved PID. */
async function superviseKernel(
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>> & { bindArm?: (record: unknown) => Promise<void> },
  entrypoint: string,
  journalPath: string,
  recovery?: {
    onRunning: (
      control: { fault: () => boolean; stop: () => void; exited: () => boolean },
      state: any
    ) => Promise<void>;
    replacementIntent?: { parentPid: number; launchId: string; createdAt: string };
  }
) {
  const ref = db.doc(journalPath);
  const grant = async () => {
    await db.runTransaction(cap.authorize, { readOnly: true });
    cap.checkFresh();
  };
  let state: any = {
    schemaVersion: 1,
    stage: 'armed',
    context: cap.context,
    intent: recovery?.replacementIntent ?? {
      parentPid: process.pid,
      launchId: randomUUID(),
      createdAt: new Date().toISOString(),
    },
  };
  let child: ChildProcess | undefined,
    exited = false,
    draining = false,
    forwarded = false,
    faultAttempted = false,
    protocolError = false,
    launchAcknowledged = false;
  let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    draining = true;
    if (child && !exited && !forwarded) {
      forwarded = true;
      child.kill('SIGTERM');
      forceStopTimer = setTimeout(() => {
        if (!child || exited) return;
        // An escalated cleanup must never qualify as the planned recovery fault
        // or as a clean drain. Signal only the live original ChildProcess.
        protocolError = true;
        child.kill('SIGKILL');
      }, childShutdownGraceMs);
    }
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGUSR2'];
  signals.forEach((s) => process.on(s, stop));
  try {
    const initialJobBirth = Boolean(recovery && !recovery.replacementIntent && cap.context.parent.cloudRunJob);
    if (initialJobBirth)
      await mediaJobPhase('kernel-create', () => writeOnce(db, ref, undefined, state, cap.authorize, true));
    else await writeOnce(db, ref, undefined, state, cap.authorize);
    if (cap.bindArm) await cap.bindArm(state);
    if (initialJobBirth) await mediaJobPhase('kernel-authorize', grant);
    else await grant();
    if (draining) fail();
    if (
      state.intent.parentPid !== process.pid ||
      !uuid(state.intent.launchId) ||
      !Number.isFinite(Date.parse(state.intent.createdAt))
    )
      fail();
    child = fork(entrypoint, [], {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
      ...(recovery
        ? {
            env: {
              ...process.env,
              TEMPORAL_MEDIA_RECOVERY_CHILD: recovery.replacementIntent ? 'replacement' : 'original',
            },
          }
        : {}),
    });
    let pending = Promise.resolve();
    let launchTimer: ReturnType<typeof setTimeout> | undefined;
    const put = async (next: any, authorized = true) => {
      await writeOnce(db, ref, state, next, authorized ? cap.authorize : undefined);
      state = next;
    };
    const send = (message: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        child!.send(message, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    const onMessage = (raw: unknown) => {
      pending = pending
        .then(async () => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 8192)
            fail();
          const m = raw as Record<string, any>;
          if (
            m.kind === 'media-kernel-ready' &&
            Object.keys(m).sort().join(',') === 'kind,nonce,pid' &&
            state.stage === 'armed' &&
            m.pid === child!.pid &&
            uuid(m.nonce)
          ) {
            await put({
              ...state,
              stage: 'born',
              birth: { pid: child!.pid, nonce: m.nonce, spawnedAt: new Date().toISOString() },
            });
            await grant();
            if (draining || exited) fail();
            await send({ kind: 'media-kernel-start', nonce: m.nonce });
            return;
          }
          if (
            m.kind === 'media-kernel-witness' &&
            Object.keys(m).sort().join(',') === 'kind,nonce,worker' &&
            state.stage === 'born' &&
            m.nonce === state.birth.nonce
          ) {
            const w = worker(m.worker);
            sameCloud(cap.context.parent, w);
            if (cap.context.parent.instanceId === w.instanceId) fail();
            await put({ ...state, stage: 'running', worker: w });
            await grant();
            if (draining || exited) fail();
            await send({
              kind: 'media-kernel-witness-ack',
              nonce: m.nonce,
              operationId: cap.context.operationId,
              birthDigest: digest({
                context: state.context,
                intent: state.intent,
                birth: state.birth,
                worker: state.worker,
              }),
            });
            if (draining || exited || !child!.connected) fail();
            launchAcknowledged = true;
            clearTimeout(launchTimer);
            if (recovery)
              await recovery.onRunning(
                {
                  exited: () => exited,
                  stop,
                  fault: () => {
                    cap.checkFresh();
                    if (draining || exited || forwarded || faultAttempted || state.stage !== 'running') fail();
                    faultAttempted = true;
                    const sent = child!.kill('SIGKILL');
                    if (sent) forwarded = true;
                    return sent;
                  },
                },
                structuredClone(state)
              );
            return;
          }
          fail();
        })
        .catch(() => {
          protocolError = true;
          stop();
        });
    };
    child.on('message', onMessage);
    launchTimer = setTimeout(stop, 30000);
    launchTimer.unref();
    const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.on('error', () => {
        protocolError = true;
        stop();
      });
      child!.once('disconnect', () => {
        if (!launchAcknowledged) {
          protocolError = true;
          stop();
        }
      });
      child!.once('exit', () => {
        exited = true;
        clearTimeout(forceStopTimer);
      });
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(launchTimer);
    child.removeListener('message', onMessage);
    await pending;
    await absent(child);
    if (protocolError && recovery && state.stage === 'running') {
      await put(
        {
          ...state,
          stage: 'closed',
          close: {
            ...close,
            observedAt: new Date().toISOString(),
            descendantsAbsent: true,
            observerFailed: true,
            scope: 'owned-cleanup-only-no-recovery-authority',
          },
        },
        false
      );
      fail();
    }
    if (protocolError || state.stage !== 'running') fail();
    // Cleanup facts remain writable after work expiry/control drift, but only over
    // this parent's exact original journal. They grant no polling/restart authority.
    await put(
      { ...state, stage: 'closed', close: { ...close, observedAt: new Date().toISOString(), descendantsAbsent: true } },
      false
    );
    return close;
  } finally {
    clearTimeout(forceStopTimer);
    signals.forEach((s) => process.removeListener(s, stop));
  }
}

let gate: { nonce: string; link?: { operationId: string; birthDigest: string } } | undefined;
export async function awaitMediaKernelLaunch() {
  if (!process.send) return;
  const nonce = randomUUID();
  gate = { nonce };
  await message('media-kernel-start', nonce, () =>
    process.send!({ kind: 'media-kernel-ready', nonce, pid: process.pid })
  );
}
function message(kind: string, nonce: string, send: () => void): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(undefined), 10000);
    const finish = (value: Record<string, any> | undefined) => {
      clearTimeout(timer);
      process.removeListener('message', receive);
      value ? resolve(value) : reject(new Error('MEDIA_KERNEL_IPC_UNCONFIRMED'));
    };
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 8192)
        return finish(undefined);
      const m = raw as Record<string, any>;
      if (
        m.kind !== kind ||
        m.nonce !== nonce ||
        (kind === 'media-kernel-start' && Object.keys(m).sort().join(',') !== 'kind,nonce')
      )
        return finish(undefined);
      finish(m);
    };
    process.on('message', receive);
    try {
      send();
    } catch {
      finish(undefined);
    }
  });
}
export async function reportMediaKernelWitness(witness: WorkerWitness) {
  if (!gate) return undefined;
  const m = await message('media-kernel-witness-ack', gate.nonce, () =>
    process.send!({ kind: 'media-kernel-witness', nonce: gate!.nonce, worker: witness })
  );
  if (
    Object.keys(m).sort().join(',') !== 'birthDigest,kind,nonce,operationId' ||
    !uuid(m.operationId) ||
    !/^[a-f0-9]{64}$/.test(m.birthDigest)
  )
    fail();
  gate.link = { operationId: m.operationId, birthDigest: m.birthDigest };
  return gate.link;
}

export const readMediaKernelBirth = (
  db: Firestore,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness
) => readKernelBirth(db, operationId, intentSHA256, link, witness, path(operationId));
export const readMediaRecoveryKernelBirth = (
  db: Firestore,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness
) =>
  readKernelBirth(
    db,
    operationId,
    intentSHA256,
    link,
    witness,
    path(operationId).replace('temporalMediaKernel-', 'temporalMediaRecoveryKernel-')
  );
export const superviseMediaKernel = (
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>>,
  entrypoint: string
) => superviseKernel(db, cap, entrypoint, path(cap.context.operationId));
export const superviseMediaRecoveryKernel = (
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>>,
  entrypoint: string
) =>
  superviseKernel(
    db,
    cap,
    entrypoint,
    path(cap.context.operationId).replace('temporalMediaKernel-', 'temporalMediaRecoveryKernel-')
  );

/** Source-only original-handle controls. Normal supervision has no fault hook. */
export const superviseMediaRecoveryOriginal = (
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>>,
  entrypoint: string,
  onRunning: NonNullable<Parameters<typeof superviseKernel>[4]>['onRunning']
) =>
  superviseKernel(
    db,
    cap,
    entrypoint,
    path(cap.context.operationId).replace('temporalMediaKernel-', 'temporalMediaRecoveryKernel-'),
    { onRunning }
  );

/** Only the separately saved replacement birth intent supplies this fixed path. */
export const superviseMediaRecoveryReplacement = (
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>>,
  entrypoint: string,
  intent: { parentPid: number; launchId: string; createdAt: string },
  onRunning: NonNullable<Parameters<typeof superviseKernel>[4]>['onRunning']
) =>
  superviseKernel(
    db,
    cap,
    entrypoint,
    path(cap.context.operationId).replace('temporalMediaKernel-', 'temporalMediaRecoveryReplacementKernel-'),
    { replacementIntent: intent, onRunning }
  );
export const readMediaRecoveryReplacementKernelBirth = (
  db: Firestore,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness
) =>
  readKernelBirth(
    db,
    operationId,
    intentSHA256,
    link,
    witness,
    path(operationId).replace('temporalMediaKernel-', 'temporalMediaRecoveryReplacementKernel-')
  );

/** Separate fixed restored-normal lineage; no diagnostic fault/restart hooks. */
export const superviseRestoredMediaKernel = (
  db: Firestore,
  cap: NonNullable<Awaited<ReturnType<typeof mediaKernelContext>>> & { bindArm?: (record: unknown) => Promise<void> },
  entrypoint: string
) =>
  superviseKernel(
    db,
    cap,
    entrypoint,
    path(cap.context.operationId).replace('temporalMediaKernel-', 'temporalRestoredMediaKernel-')
  );
export const readRestoredMediaKernelBirth = (
  db: Firestore,
  operationId: string,
  intentSHA256: string,
  link: unknown,
  witness: WorkerWitness
) =>
  readKernelBirth(
    db,
    operationId,
    intentSHA256,
    link,
    witness,
    path(operationId).replace('temporalMediaKernel-', 'temporalRestoredMediaKernel-')
  );
