/** A separate replacement capability. Original grants and original receipts keep
 * their identities; no startup/death receipt alone permits a new process. */
import { randomUUID } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { Client } from '@temporalio/client';
import { Context } from '@temporalio/activity';
import type { MediaJobRef, MediaOutcome } from '../../../process-audio/src/temporal/types';
import type { mediaRecoveryKernelContext } from './media-recovery-capability';
import { workerReadinessDigest as hash } from './readiness-probe';
import { mediaRecoveryPinnedVersion } from './media-recovery-pin';
import { diagnosticComputeIdentity } from './worker-witness';
import { originalMediaArtifacts, superviseOriginalMediaFault } from './media-recovery-original-fault';
import { readMediaRecoveryReplacementKernelBirth, superviseMediaRecoveryReplacement } from './media-kernel-supervisor';
type Cap = Awaited<ReturnType<typeof mediaRecoveryKernelContext>>;
type LineageBase = Pick<Cap, 'context' | 'plan'>;
const fail = (): never => {
  throw new Error('MEDIA_RECOVERY_REPLACEMENT_UNCONFIRMED');
};
const name = (kind: string, cap: LineageBase) => `_control/temporalMediaRecovery${kind}-${cap.context.operationId}`;
const uuid = (x: unknown) =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const bounded = async <T>(p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_REPLACEMENT_UNCONFIRMED')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
/** Exact immutable original preimages, independently read before every grant. */
async function originals(db: Firestore, base: LineageBase, tx: Transaction) {
  const [readySnap, signalSnap, kernelSnap, deathSnap, workSnap] = await Promise.all(
    ['OriginalReady', 'OriginalSignal', 'Kernel', 'OriginalDeath', 'Work'].map((k) => tx.get(db.doc(name(k, base))))
  );
  const ready = readySnap.data(),
    signal = signalSnap.data(),
    kernel = kernelSnap.data(),
    death = deathSnap.data(),
    work = workSnap.data();
  if (!ready || !signal || !kernel || !death || !work) fail();
  const { close, ...beforeClose } = kernel!;
  const bornAt = Date.parse(kernel!.birth?.spawnedAt),
    readyAt = Date.parse(ready!.observedAt),
    signalAt = Date.parse(signal!.attemptedAt),
    closedAt = Date.parse(close?.observedAt),
    deathAt = Date.parse(death!.observedAt);
  if (
    ready!.schemaVersion !== 1 ||
    ready!.kind !== 'settled-original-acquire-before-completion-ack' ||
    ready!.operationId !== base.context.operationId ||
    ready!.intentSHA256 !== base.context.intentSHA256 ||
    ready!.attempt !== 1 ||
    ready!.activityId !== 'media-recovery-acquire' ||
    ready!.workflowId !== `media-recovery-${base.context.operationId}` ||
    !uuid(ready!.runId) ||
    !/^\d+$/.test(ready!.nativeAttempt?.scheduledEventId ?? '') ||
    ready!.nativeAttempt?.attempt !== 1 ||
    ready!.nativeAttempt?.workerIdentity !== `media-recovery-${kernel!.worker?.instanceId}` ||
    hash(ready!.worker) !== hash(kernel!.worker) ||
    ready!.birthDigest !==
      hash({ context: kernel!.context, intent: kernel!.intent, birth: kernel!.birth, worker: kernel!.worker }) ||
    kernel!.schemaVersion !== 1 ||
    kernel!.stage !== 'closed' ||
    kernel!.context?.intentSHA256 !== base.context.intentSHA256 ||
    kernel!.context?.operationId !== base.context.operationId ||
    close?.code !== null ||
    close?.signal !== 'SIGKILL' ||
    close?.descendantsAbsent !== true ||
    close.observerFailed === true ||
    signal!.schemaVersion !== 1 ||
    signal!.kind !== 'original-handle-signal-attempt-no-death-proof' ||
    signal!.operationId !== base.context.operationId ||
    signal!.intentSHA256 !== base.context.intentSHA256 ||
    signal!.signal !== 'SIGKILL' ||
    signal!.readySHA256 !== hash(ready) ||
    signal!.originalKernelSHA256 !== hash({ ...beforeClose, stage: 'running' }) ||
    hash(signal!.nativeAttempt) !== hash(ready!.nativeAttempt) ||
    death!.schemaVersion !== 1 ||
    death!.kind !== 'original-application-child-death-only-no-replacement-authority' ||
    death!.operationId !== base.context.operationId ||
    death!.closedKernelSHA256 !== hash(kernel) ||
    death!.readySHA256 !== hash(ready) ||
    death!.originalRunId !== ready!.runId ||
    death!.originalActivityId !== ready!.activityId ||
    death!.inventorySHA256 !== hash(ready!.inventory) ||
    work!.stage !== 'admitted' ||
    hash(work!.worker) !== hash(kernel!.worker) ||
    work!.grant?.runId !== ready!.runId ||
    hash(work!.grant?.ref) !== hash(ready!.ref) ||
    hash(work!.grant) !== ready!.grantSHA256 ||
    [bornAt, readyAt, signalAt, closedAt, deathAt].some((x) => !Number.isFinite(x)) ||
    bornAt > readyAt ||
    readyAt > signalAt ||
    signalAt > closedAt ||
    closedAt > deathAt ||
    signalAt >= base.plan.expiresAt ||
    deathAt > Date.now() + 1000
  )
    fail();
  return { ready: ready!, signal: signal!, kernel: kernel!, death: death!, work: work! };
}
async function intentRecord(db: Firestore, base: LineageBase, tx: Transaction) {
  const original = await originals(db, base, tx);
  const intent = (await tx.get(db.doc(name('ReplacementIntent', base)))).data();
  if (
    !intent ||
    intent.schemaVersion !== 1 ||
    intent.kind !== 'confirmed-original-death-one-replacement-birth' ||
    intent.operationId !== base.context.operationId ||
    intent.baseIntentSHA256 !== base.context.intentSHA256 ||
    intent.readySHA256 !== hash(original.ready) ||
    intent.signalSHA256 !== hash(original.signal) ||
    intent.closedKernelSHA256 !== hash(original.kernel) ||
    intent.deathSHA256 !== hash(original.death) ||
    intent.originalRunId !== original.ready.runId ||
    intent.originalActivityId !== original.ready.activityId ||
    intent.originalScheduledEventId !== original.ready.nativeAttempt.scheduledEventId ||
    intent.inventorySHA256 !== hash(original.ready.inventory) ||
    intent.grantSHA256 !== original.ready.grantSHA256 ||
    hash(intent.ref) !== hash(original.ready.ref) ||
    intent.expiresAt !== base.plan.expiresAt ||
    intent.birth?.parentPid !== original.kernel.intent?.parentPid ||
    !uuid(intent.birth?.launchId) ||
    intent.birth.launchId === original.kernel.intent.launchId ||
    !Number.isFinite(Date.parse(intent.birth?.createdAt)) ||
    Date.parse(intent.birth.createdAt) < Date.parse(original.death.observedAt) ||
    Date.parse(intent.birth.createdAt) >= base.plan.expiresAt
  )
    fail();
  return { ...original, intent: intent! };
}
/** GET-only historical lineage validation; no authorize callback, signal or birth authority. */
export const readMediaRecoveryOriginalLineage = intentRecord;
export async function mediaReplacementCapability(db: Firestore, base: Cap) {
  let original: any;
  const read = async (tx: Transaction) => {
    await base.authorize(tx);
    const current = await intentRecord(db, base, tx);
    if (original && hash(current) !== hash(original)) fail();
    original = current;
  };
  await bounded(db.runTransaction(read, { readOnly: true }));
  base.checkFresh();
  const derived = hash({
    kind: 'explicit-original-death-replacement-v1',
    baseIntentSHA256: base.context.intentSHA256,
    intentSHA256: hash(original.intent),
    deathSHA256: hash(original.death),
  });
  return { ...base, context: { ...base.context, intentSHA256: derived }, authorize: read, replacement: original };
}
/** Original live parent only. An unknown create ACK fences rather than forking,
 * even if a GET later finds the exact intent. Re-entry never adopts that intent. */
async function saveReplacementIntent(db: Firestore, base: Cap) {
  let saved: any;
  try {
    await bounded(
      db.runTransaction(
        async (tx) => {
          await base.authorize(tx);
          const original = await originals(db, base, tx);
          if (
            original.kernel.intent.parentPid !== process.pid ||
            hash(original.kernel.context.parent) !== hash(base.context.parent)
          )
            fail();
          const [intent, kernel] = await Promise.all(
            ['ReplacementIntent', 'ReplacementKernel'].map((k) => tx.get(db.doc(name(k, base))))
          );
          if (intent.exists || kernel.exists) fail();
          saved = {
            schemaVersion: 1,
            kind: 'confirmed-original-death-one-replacement-birth',
            operationId: base.context.operationId,
            baseIntentSHA256: base.context.intentSHA256,
            readySHA256: hash(original.ready),
            signalSHA256: hash(original.signal),
            closedKernelSHA256: hash(original.kernel),
            deathSHA256: hash(original.death),
            originalRunId: original.ready.runId,
            originalActivityId: original.ready.activityId,
            originalScheduledEventId: original.ready.nativeAttempt.scheduledEventId,
            inventorySHA256: hash(original.ready.inventory),
            grantSHA256: original.ready.grantSHA256,
            ref: original.ready.ref,
            expiresAt: base.plan.expiresAt,
            birth: { parentPid: process.pid, launchId: randomUUID(), createdAt: new Date().toISOString() },
          };
          base.checkFresh();
          tx.create(db.doc(name('ReplacementIntent', base)), saved);
        },
        { maxAttempts: 1 }
      )
    );
  } catch {
    await bounded(db.doc(name('ReplacementIntent', base)).get()).catch(() => undefined);
    fail();
  }
  base.checkFresh();
  return saved;
}
async function receipt(
  db: Firestore,
  cap: Cap,
  kind: string,
  value: any,
  authorize?: (tx: Transaction) => Promise<void>
) {
  const ref = db.doc(name(kind, cap));
  try {
    await bounded(
      db.runTransaction(
        async (tx) => {
          if (authorize) await authorize(tx);
          if ((await tx.get(ref)).exists) fail();
          tx.create(ref, value);
        },
        { maxAttempts: 1 }
      )
    );
  } catch (e) {
    if ([3, 5, 6, 7, 9, 11, 12, 16].includes(Number((e as { code?: unknown })?.code))) fail();
    if (hash((await bounded(ref.get())).data() ?? null) !== hash(value)) fail();
  }
}
async function pendingReplacement(
  client: Client,
  cap: Awaited<ReturnType<typeof mediaReplacementCapability>>,
  worker: any
) {
  const began = Date.now(),
    mono = performance.now(),
    original = cap.replacement.ready;
  const h = await bounded(
    client.connection.withDeadline(began + 5000, () =>
      client.workflowService.getWorkflowExecutionHistory({
        namespace: 'urm-app-staging.qwejt',
        execution: { workflowId: original.workflowId, runId: original.runId },
        maximumPageSize: 64,
      })
    )
  );
  if (h.nextPageToken?.length || !h.history?.events || h.history.events.length > 64) fail();
  const schedules = h.history!.events!.filter(
    (e) => e.activityTaskScheduledEventAttributes?.activityId === original.activityId
  );
  if (
    schedules.length !== 1 ||
    String(schedules[0].eventId) !== original.nativeAttempt.scheduledEventId ||
    schedules[0].activityTaskScheduledEventAttributes?.taskQueue?.name !== 'urm-media-kernel-recovery'
  )
    fail();
  const d = await bounded(
    client.connection.withDeadline(began + 5000, () =>
      client.workflow.getHandle(original.workflowId, original.runId, { followRuns: false }).describe()
    )
  );
  const wi = d.raw.workflowExecutionInfo,
    vi = wi?.versioningInfo,
    a = d.raw.pendingActivities?.filter((x) => x.activityId === original.activityId),
    expected = { deploymentName: 'urm-worker-media-recovery-staging', buildId: worker.buildId };
  if (
    wi?.status !== 1 ||
    wi.execution?.runId !== original.runId ||
    vi?.behavior !== 1 ||
    hash(vi.deploymentVersion) !== hash(expected) ||
    a?.length !== 1 ||
    a[0].state !== 2 ||
    a[0].attempt !== 2 ||
    a[0].activityType?.name !== 'acquireMedia' ||
    a[0].lastWorkerIdentity !== `media-recovery-${worker.instanceId}` ||
    (a[0].lastDeploymentVersion && hash(a[0].lastDeploymentVersion) !== hash(expected))
  )
    fail();
  mediaRecoveryPinnedVersion(vi!.versioningOverride, expected);
  const timestamp = (v: any) => Number(v?.seconds) * 1000 + Number(v?.nanos ?? 0) / 1e6;
  const started = timestamp(a![0].lastStartedTime),
    beat = a![0].lastHeartbeatTime ? Math.max(started, timestamp(a![0].lastHeartbeatTime)) : started,
    deadline = Math.min(began + 5000, started + 30000, beat + 15000) - 1000;
  const assertFresh = () => {
    if (
      !Number.isFinite(deadline) ||
      !Number.isFinite(started) ||
      started > Date.now() + 1000 ||
      Date.now() >= deadline ||
      performance.now() - mono >= 4000
    )
      fail();
  };
  assertFresh();
  return assertFresh;
}
/** Same scheduled Activity, attempt2 only; its successful return is independently
 * joined to unchanged complete artifacts before persisting adoption evidence. */
export function replacementMediaAcquisition(o: {
  db: Firestore;
  bucket: Bucket;
  client: Client;
  cap: Awaited<ReturnType<typeof mediaReplacementCapability>>;
  birth: any;
  acquire: (ref: MediaJobRef) => Promise<MediaOutcome>;
}) {
  return async (ref: MediaJobRef): Promise<MediaOutcome> => {
    try {
      const c = Context.current(),
        i = c.info,
        original = o.cap.replacement.ready;
      if (
        i.attempt !== 2 ||
        i.activityId !== original.activityId ||
        i.workflowExecution?.workflowId !== original.workflowId ||
        i.workflowExecution?.runId !== original.runId ||
        hash(ref) !== hash(original.ref) ||
        c.cancellationSignal.aborted
      )
        fail();
      await bounded(o.db.runTransaction(o.cap.authorize, { readOnly: true }));
      o.cap.checkFresh();
      if (hash(await originalMediaArtifacts(o.db, o.bucket, o.cap.context.operationId)) !== hash(original.inventory))
        fail();
      const pendingFresh = await pendingReplacement(o.client, o.cap, o.birth.value.worker);
      await bounded(o.db.runTransaction(o.cap.authorize, { readOnly: true }));
      o.cap.checkFresh();
      pendingFresh();
      if (c.cancellationSignal.aborted) fail();
      const result = await o.acquire(ref);
      if (result.kind !== 'ready' || c.cancellationSignal.aborted) fail();
      const after = await originalMediaArtifacts(o.db, o.bucket, o.cap.context.operationId);
      if (hash(after) !== hash(original.inventory)) fail();
      const value = {
        schemaVersion: 1,
        kind: 'replacement-source-artifact-adoption-only',
        operationId: o.cap.context.operationId,
        replacementIntentSHA256: hash(o.cap.replacement.intent),
        deathSHA256: hash(o.cap.replacement.death),
        replacementBirthDigest: o.birth.birthDigest,
        worker: o.birth.value.worker,
        workflowId: original.workflowId,
        runId: original.runId,
        activityId: original.activityId,
        scheduledEventId: original.nativeAttempt.scheduledEventId,
        attempt: 2,
        inventorySHA256: hash(after),
        observedAt: new Date().toISOString(),
      };
      await receipt(o.db, o.cap, 'ReplacementAdoption', value, o.cap.authorize);
      return result;
    } catch {
      return fail();
    }
  };
}
/** One parent-owned replacement, always stopped and drained through that live
 * handle. Completion and cleanup facts do not grant promotion/restoration. */
export async function superviseMediaRecoveryReplacementCycle(
  db: Firestore,
  bucket: Bucket,
  base: Cap,
  entrypoint: string,
  client: Client
) {
  let draining = false;
  const onDrain = () => {
    draining = true;
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGUSR2'];
  signals.forEach((s) => process.on(s, onDrain));
  try {
    await superviseOriginalMediaFault(db, bucket, base, entrypoint, client);
    if (draining) fail();
    const intent = await saveReplacementIntent(db, base);
    if (draining) fail();
    const cap = await mediaReplacementCapability(db, base);
    const checkFresh = () => {
      base.checkFresh();
      if (draining) fail();
    };
    let observed: any;
    const close = await superviseMediaRecoveryReplacement(
      db,
      { ...cap, checkFresh },
      entrypoint,
      intent.birth,
      async (control, state) => {
        try {
          if (
            state.birth.pid === cap.replacement.kernel.birth.pid ||
            state.worker.instanceId === cap.replacement.kernel.worker.instanceId ||
            state.birth.nonce === cap.replacement.kernel.birth.nonce ||
            hash(diagnosticComputeIdentity(state.worker)) !==
              hash(diagnosticComputeIdentity(cap.replacement.kernel.worker))
          )
            fail();
          while (!control.exited()) {
            checkFresh();
            const adoption = (await bounded(db.doc(name('ReplacementAdoption', cap)).get())).data();
            if (adoption) {
              const birthDigest = hash({
                context: state.context,
                intent: state.intent,
                birth: state.birth,
                worker: state.worker,
              });
              if (
                adoption.schemaVersion !== 1 ||
                adoption.kind !== 'replacement-source-artifact-adoption-only' ||
                adoption.replacementIntentSHA256 !== hash(intent) ||
                adoption.deathSHA256 !== hash(cap.replacement.death) ||
                adoption.replacementBirthDigest !== birthDigest ||
                hash(adoption.worker) !== hash(state.worker) ||
                adoption.runId !== cap.replacement.ready.runId ||
                adoption.activityId !== cap.replacement.ready.activityId ||
                adoption.scheduledEventId !== cap.replacement.ready.nativeAttempt.scheduledEventId ||
                adoption.attempt !== 2 ||
                adoption.inventorySHA256 !== hash(cap.replacement.ready.inventory)
              )
                fail();
              const h = client.workflow.getHandle(cap.replacement.ready.workflowId, adoption.runId, {
                followRuns: false,
              });
              const d = await bounded(h.describe());
              if (d.raw.workflowExecutionInfo?.execution?.runId !== adoption.runId) fail();
              const vi = d.raw.workflowExecutionInfo?.versioningInfo,
                expected = {
                  deploymentName: 'urm-worker-media-recovery-staging',
                  buildId: base.context.parent.buildId,
                };
              if (vi?.behavior !== 1 || hash(vi.deploymentVersion) !== hash(expected)) fail();
              mediaRecoveryPinnedVersion(vi!.versioningOverride, expected);
              if (d.raw.workflowExecutionInfo?.status === 2) {
                const response = await bounded(
                  client.connection.withDeadline(Date.now() + 5000, () =>
                    client.workflowService.getWorkflowExecutionHistory({
                      namespace: 'urm-app-staging.qwejt',
                      execution: { workflowId: cap.replacement.ready.workflowId, runId: adoption.runId },
                      maximumPageSize: 64,
                    })
                  )
                );
                const result = await bounded(h.result());
                if (
                  !result ||
                  Object.keys(result).sort().join(',') !== 'grantSHA256,operationId,runId' ||
                  result.operationId !== base.context.operationId ||
                  result.runId !== adoption.runId ||
                  result.grantSHA256 !== cap.replacement.ready.grantSHA256
                )
                  fail();
                const history = response.history;
                if (response.nextPageToken?.length || !history?.events || history.events.length > 64) fail();
                const schedules = history!.events!.filter(
                  (e) => e.activityTaskScheduledEventAttributes?.activityId === adoption.activityId
                );
                if (
                  schedules.length !== 1 ||
                  String(schedules[0].eventId) !== adoption.scheduledEventId ||
                  !history!.events!.some(
                    (e) =>
                      String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === adoption.scheduledEventId
                  )
                )
                  fail();
                const completed = history!.events!.filter(
                  (e) => String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === adoption.scheduledEventId
                );
                if (completed.length !== 1) fail();
                const start = history!.events!.find(
                  (e) => String(e.eventId) === String(completed[0].activityTaskCompletedEventAttributes?.startedEventId)
                )?.activityTaskStartedEventAttributes;
                if (start?.attempt !== 2 || start.identity !== `media-recovery-${state.worker.instanceId}`) fail();
                if (
                  hash(await originalMediaArtifacts(db, bucket, base.context.operationId)) !==
                  hash(cap.replacement.ready.inventory)
                )
                  fail();
                observed = {
                  schemaVersion: 1,
                  kind: 'replacement-original-workflow-completed-only',
                  operationId: base.context.operationId,
                  adoptionSHA256: hash(adoption),
                  runId: adoption.runId,
                  scheduledEventId: adoption.scheduledEventId,
                  historyEvents: history!.events!.length,
                  observedAt: new Date().toISOString(),
                };
                await receipt(db, cap, 'ReplacementCompleted', observed, cap.authorize);
                break;
              }
              if (d.raw.workflowExecutionInfo?.status !== 1) fail();
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!observed) fail();
        } finally {
          // This exact in-memory child is stopped even after authority expiry or a
          // failed observer. Its separate close fact cannot become recovery proof.
          try {
            await receipt(db, cap, 'ReplacementStop', {
              schemaVersion: 1,
              kind: 'owned-replacement-stop-intent',
              operationId: base.context.operationId,
              kernelSHA256: hash(state),
              observedAt: new Date().toISOString(),
            });
          } finally {
            control.stop();
          }
        }
      }
    );
    if (!observed || close.code !== 0 || close.signal !== null) fail();
    return close;
  } finally {
    signals.forEach((s) => process.removeListener(s, onDrain));
  }
}
/** Child selection is explicit and cannot broaden original-worker equality. */
export async function readReplacementBirth(
  db: Firestore,
  cap: Awaited<ReturnType<typeof mediaReplacementCapability>>,
  link: unknown,
  witness: any
) {
  const birth = await readMediaRecoveryReplacementKernelBirth(
      db,
      cap.context.operationId,
      cap.context.intentSHA256,
      link,
      witness
    ),
    old = cap.replacement.kernel;
  if (
    birth.value.stage !== 'running' ||
    hash(birth.value.intent) !== hash(cap.replacement.intent.birth) ||
    birth.value.birth.pid === old.birth.pid ||
    birth.value.birth.nonce === old.birth.nonce ||
    witness.instanceId === old.worker.instanceId ||
    hash(diagnosticComputeIdentity(witness)) !== hash(diagnosticComputeIdentity(old.worker))
  )
    fail();
  return birth;
}
