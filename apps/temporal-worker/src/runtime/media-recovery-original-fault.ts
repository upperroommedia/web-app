/** Original application-child fault phase only. It grants no replacement birth,
 * diagnostic completion, normal revision restoration or promotion authority. */
import { createHash } from 'node:crypto';
import { Context } from '@temporalio/activity';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { Client } from '@temporalio/client';
import type { MediaJobRef, MediaOutcome } from '../../../process-audio/src/temporal/types';
import { workerReadinessDigest as hash } from './readiness-probe';
import { superviseMediaRecoveryOriginal } from './media-kernel-supervisor';
import { mediaRecoveryPinnedVersion } from './media-recovery-pin';
import { mediaRecoveryBucketName, type MediaRecoveryStoragePlan } from './media-recovery-storage';
import { CRC32C } from '@google-cloud/storage';
const MEDIA_RECOVERY_DEPLOYMENT = 'urm-worker-media-recovery-staging';
import type { mediaRecoveryKernelContext } from './media-recovery-capability';
type Capability = Awaited<ReturnType<typeof mediaRecoveryKernelContext>>;
const fail = (): never => {
  throw new Error('MEDIA_RECOVERY_ORIGINAL_FAULT_UNCONFIRMED');
};
const bounded = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_ORIGINAL_FAULT_UNCONFIRMED')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const digestBytes = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const path = (kind: string, cap: Capability) => `_control/temporalMediaRecovery${kind}-${cap.context.operationId}`;
/** All versions, current identities and bytes of BOTH source/processed objects.
 * Fixed diagnostic input only; bounds never permit a business-media download. */
export async function originalMediaArtifacts(
  db: Firestore,
  bucket: Bucket,
  operationId: string,
  plan?: MediaRecoveryStoragePlan
) {
  if (
    !/^[a-f0-9-]{36}$/.test(operationId) ||
    (plan && plan.operationId !== operationId) ||
    bucket.name !== mediaRecoveryBucketName(plan)
  )
    fail();
  const id = `media-recovery-${operationId}`,
    prefix = `workflow-audio/${id}/`;
  const request = await bounded(db.doc(`temporalMediaRequests/${id}`).get());
  const artifacts = [request.get('artifacts.source'), request.get('artifacts.processed')];
  if (
    !request.exists ||
    !request.updateTime ||
    artifacts.some((x) => !x?.path?.startsWith(prefix) || !/^\d+$/.test(x.generation)) ||
    artifacts[0].path === artifacts[1].path
  )
    fail();
  const [files, next] = await bounded(bucket.getFiles({ prefix, versions: true, autoPaginate: false, maxResults: 8 }));
  if (next || files.length !== 2) fail();
  const rows = [];
  for (const file of files) {
    const [metadata] = await bounded(file.getMetadata());
    const artifact = artifacts.find((x) => x.path === file.name && x.generation === String(metadata.generation));
    if (
      !artifact ||
      !Number.isSafeInteger(Number(metadata.size)) ||
      Number(metadata.size) < 1 ||
      Number(metadata.size) > 1048576 ||
      (!metadata.md5Hash && !metadata.crc32c)
    )
      fail();
    const [current] = await bounded(bucket.file(file.name).getMetadata());
    const project = (m: typeof metadata) => ({
      name: file.name,
      generation: String(m.generation),
      size: String(m.size),
      md5: m.md5Hash ?? null,
      crc32c: m.crc32c ?? null,
    });
    if (hash(project(current)) !== hash(project(metadata))) fail();
    const [bytes] = await bounded(
      bucket.file(file.name, { generation: metadata.generation }).download({ start: 0, end: 1048576 })
    );
    if (
      bytes.length !== Number(metadata.size) ||
      (metadata.md5Hash && createHash('md5').update(bytes).digest('base64') !== metadata.md5Hash)
    )
      fail();
    if (metadata.crc32c) {
      const crc = new CRC32C();
      crc.update(bytes);
      if (crc.toString() !== metadata.crc32c) fail();
    }
    rows.push({ ...project(metadata), bytesSHA256: digestBytes(bytes) });
  }
  const after = await bounded(db.doc(`temporalMediaRequests/${id}`).get());
  if (!after.updateTime?.isEqual(request.updateTime!) || hash(after.data()) !== hash(request.data())) fail();
  return {
    requestSHA256: hash(request.data()),
    requestVersion: `${request.updateTime!.seconds}:${request.updateTime!.nanoseconds}`,
    objects: rows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
async function createOnce(db: Firestore, name: string, value: unknown, authorize?: Capability['authorize']) {
  const ref = db.doc(name);
  try {
    await bounded(
      db.runTransaction(
        async (tx) => {
          if (authorize) await authorize(tx);
          if ((await tx.get(ref)).exists) fail();
          tx.create(ref, value as Record<string, unknown>);
        },
        { maxAttempts: 1 }
      )
    );
  } catch (e) {
    if ([3, 5, 6, 7, 9, 11, 12, 16].includes(Number((e as { code?: unknown })?.code))) fail();
    if (hash((await bounded(ref.get())).data() ?? null) !== hash(value)) fail();
  }
}
const time = (t: any) => Number(t?.seconds) * 1000 + Number(t?.nanos ?? 0) / 1e6;
/** Fresh native pending-attempt fence; a running Workflow alone is insufficient. */
export async function originalPendingAttempt(client: Client, cap: Capability, ready: any) {
  const began = Date.now(),
    monotonic = performance.now();
  const h = await bounded(
    client.connection.withDeadline(began + 5000, () =>
      client.workflowService.getWorkflowExecutionHistory({
        namespace: 'urm-app-staging.qwejt',
        execution: { workflowId: ready.workflowId, runId: ready.runId },
        maximumPageSize: 64,
      })
    )
  );
  if (h.nextPageToken?.length || !h.history?.events || h.history.events.length > 64) fail();
  const scheduled = h.history!.events!.filter(
    (e) => e.activityTaskScheduledEventAttributes?.activityId === 'media-recovery-acquire'
  );
  if (
    scheduled.length !== 1 ||
    scheduled[0].activityTaskScheduledEventAttributes?.activityType?.name !== 'acquireMedia' ||
    scheduled[0].activityTaskScheduledEventAttributes?.taskQueue?.name !== 'urm-media-kernel-recovery'
  )
    fail();
  const scheduledEventId = String(scheduled[0].eventId);
  if (
    h.history!.events!.some((e) =>
      [
        e.activityTaskCompletedEventAttributes,
        e.activityTaskFailedEventAttributes,
        e.activityTaskTimedOutEventAttributes,
        e.activityTaskCanceledEventAttributes,
      ].some((a) => a && String(a.scheduledEventId) === scheduledEventId)
    )
  )
    fail();
  const d = await bounded(
    client.connection.withDeadline(began + 5000, () =>
      client.workflow.getHandle(ready.workflowId, ready.runId, { followRuns: false }).describe()
    )
  );
  const wi = d.raw.workflowExecutionInfo,
    vi = wi?.versioningInfo,
    pending = d.raw.pendingActivities?.filter((a) => a.activityId === 'media-recovery-acquire');
  const expected = { deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: cap.context.parent.buildId };
  if (
    wi?.execution?.runId !== ready.runId ||
    wi!.status !== 1 ||
    vi?.behavior !== 1 ||
    hash(vi.deploymentVersion) !== hash(expected) ||
    pending?.length !== 1
  )
    fail();
  mediaRecoveryPinnedVersion(vi!.versioningOverride, expected);
  const a = pending![0];
  if (
    a.state !== 2 ||
    a.attempt !== 1 ||
    a.activityType?.name !== 'acquireMedia' ||
    a.lastWorkerIdentity !== `media-recovery-${ready.worker.instanceId}` ||
    (a.lastDeploymentVersion && hash(a.lastDeploymentVersion) !== hash(expected)) ||
    a.lastAttemptCompleteTime ||
    a.nextAttemptScheduleTime ||
    a.paused
  )
    fail();
  const started = time(a.lastStartedTime),
    heartbeat = a.lastHeartbeatTime ? time(a.lastHeartbeatTime) : started;
  const deadline = Math.min(began + 5000, started + 30000, heartbeat + 15000) - 1000;
  if (
    !Number.isFinite(started) ||
    started > Date.now() + 1000 ||
    !Number.isFinite(deadline) ||
    Date.now() >= deadline ||
    performance.now() - monotonic >= 4000
  )
    fail();
  const proof = { scheduledEventId, startedAt: started, workerIdentity: a.lastWorkerIdentity, attempt: 1 };
  return {
    proof,
    assertFresh: () => {
      if (Date.now() >= deadline || performance.now() - monotonic >= 4000) fail();
    },
  };
}
/** Source acquisition has settled. Withhold only this Activity's completion ACK;
 * no heartbeats or further provider/media work are performed during the hold. */
export function holdOriginalMediaCompletion(o: {
  db: Firestore;
  bucket: Bucket;
  client: Client;
  cap: Capability;
  birth: any;
  acquire: (ref: MediaJobRef) => Promise<MediaOutcome>;
}) {
  return async (ref: MediaJobRef): Promise<MediaOutcome> => {
    const context = Context.current(),
      info = context.info;
    if (
      process.env.TEMPORAL_MEDIA_RECOVERY_CHILD !== 'original' ||
      info.attempt !== 1 ||
      info.activityId !== 'media-recovery-acquire' ||
      info.activityType !== 'acquireMedia' ||
      info.workflowExecution?.workflowId !== `media-recovery-${o.cap.context.operationId}`
    )
      fail();
    let phase = 'acquire';
    try {
      const result = await o.acquire(ref);
      if (result.kind !== 'ready' || context.cancellationSignal.aborted) fail();
      phase = 'verify-artifacts';
      const inventory = await originalMediaArtifacts(o.db, o.bucket, o.cap.context.operationId, o.cap.plan);
      phase = 'verify-workflow';
      const description = await bounded(
        o.client.workflow
          .getHandle(info.workflowExecution!.workflowId, info.workflowExecution!.runId, { followRuns: false })
          .describe()
      );
      const wi = description.raw.workflowExecutionInfo,
        vi = wi?.versioningInfo;
      if (
        wi?.status !== 1 ||
        wi.execution?.runId !== info.workflowExecution!.runId ||
        vi?.behavior !== 1 ||
        hash(vi.deploymentVersion) !==
          hash({ deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: o.cap.context.parent.buildId })
      )
        fail();
      mediaRecoveryPinnedVersion(vi!.versioningOverride, vi!.deploymentVersion);
      phase = 'verify-admitted-work';
      await bounded(o.db.runTransaction(o.cap.authorize, { readOnly: true }));
      o.cap.checkFresh();
      const work = (await bounded(o.db.doc(path('Work', o.cap)).get())).data();
      if (
        work?.stage !== 'admitted' ||
        work.grant?.runId !== info.workflowExecution!.runId ||
        hash(work.grant.ref) !== hash(ref) ||
        hash(work.worker) !== hash(o.birth.value.worker)
      )
        fail();
      if (context.cancellationSignal.aborted) fail();
      phase = 'verify-pending-attempt';
      const nativeAttempt = await originalPendingAttempt(o.client, o.cap, {
        workflowId: info.workflowExecution!.workflowId,
        runId: info.workflowExecution!.runId,
        worker: o.birth.value.worker,
      });
      const record = {
        schemaVersion: 1,
        kind: 'settled-original-acquire-before-completion-ack',
        operationId: o.cap.context.operationId,
        intentSHA256: o.cap.context.intentSHA256,
        birthDigest: o.birth.birthDigest,
        grantSHA256: hash(work!.grant),
        nativeAttempt: nativeAttempt.proof,
        worker: o.birth.value.worker,
        workflowId: info.workflowExecution!.workflowId,
        runId: info.workflowExecution!.runId,
        activityId: info.activityId,
        attempt: 1,
        ref,
        inventory,
        observedAt: new Date().toISOString(),
      };
      phase = 'record-original-readiness';
      await createOnce(o.db, path('OriginalReady', o.cap), record, async (tx) => {
        await o.cap.authorize(tx);
        const current = (await tx.get(o.db.doc(path('Work', o.cap)))).data();
        if (hash(current ?? null) !== hash(work)) fail();
      });
      nativeAttempt.assertFresh();
      if (context.cancellationSignal.aborted) fail();
      // The original source call and subprocesses have returned. Cancellation is
      // still observed, but only actual parent-held SIGKILL can prove this fault.
      await context.cancelled;
      return fail();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      console.warn(
        JSON.stringify({
          event: 'temporal_media_recovery_original_fault_unconfirmed',
          operationId: o.cap.context.operationId,
          phase,
          ...(typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 599 ? { code } : {}),
        })
      );
      return fail();
    }
  };
}
/** Persisted intent -> sole live ChildProcess signal -> actual close/group drain
 * -> immutable death fact. Re-entry cannot adopt a name, PID or ready receipt. */
export async function superviseOriginalMediaFault(
  db: Firestore,
  bucket: Bucket,
  cap: Capability,
  entrypoint: string,
  client: Client
) {
  let signalled = false,
    ready: any,
    original: any;
  const result = await superviseMediaRecoveryOriginal(db, cap, entrypoint, async (control, state) => {
    original = state;
    try {
      while (!control.exited()) {
        cap.checkFresh();
        ready = (await bounded(db.doc(path('OriginalReady', cap)).get())).data();
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const birthDigest = hash({
        context: state.context,
        intent: state.intent,
        birth: state.birth,
        worker: state.worker,
      });
      if (
        !ready ||
        ready.schemaVersion !== 1 ||
        ready.kind !== 'settled-original-acquire-before-completion-ack' ||
        ready.operationId !== cap.context.operationId ||
        ready.intentSHA256 !== cap.context.intentSHA256 ||
        ready.birthDigest !== birthDigest ||
        hash(ready.worker) !== hash(state.worker) ||
        ready.workflowId !== `media-recovery-${cap.context.operationId}` ||
        !/^[a-f0-9-]{36}$/.test(ready.runId) ||
        ready.activityId !== 'media-recovery-acquire' ||
        ready.attempt !== 1 ||
        !Number.isFinite(Date.parse(ready.observedAt)) ||
        Date.parse(ready.observedAt) < Date.parse(state.birth.spawnedAt) ||
        Date.now() - Date.parse(ready.observedAt) > 5000 ||
        Date.parse(ready.observedAt) > Date.now() + 1000
      )
        fail();
      if (hash(await originalMediaArtifacts(db, bucket, cap.context.operationId, cap.plan)) !== hash(ready.inventory))
        fail();
      const nativeBefore = await originalPendingAttempt(client, cap, ready);
      if (hash(nativeBefore.proof) !== hash(ready.nativeAttempt)) fail();
      const attempt = {
        schemaVersion: 1,
        kind: 'original-handle-signal-attempt-no-death-proof',
        operationId: cap.context.operationId,
        intentSHA256: cap.context.intentSHA256,
        originalKernelSHA256: hash(state),
        nativeAttempt: nativeBefore.proof,
        readySHA256: hash(ready),
        signal: 'SIGKILL',
        attemptedAt: new Date().toISOString(),
      };
      const authorizeSignal = async (tx: any) => {
        await cap.authorize(tx);
        const [settled, work, kernel] = await Promise.all(
          ['OriginalReady', 'Work', 'Kernel'].map((k) => tx.get(db.doc(path(k, cap))))
        );
        const w = work.data();
        if (
          hash(settled.data() ?? null) !== hash(ready) ||
          hash(kernel.data() ?? null) !== hash(state) ||
          w?.stage !== 'admitted' ||
          hash(w.worker) !== hash(state.worker) ||
          w.grant?.runId !== ready.runId ||
          hash(w.grant.ref) !== hash(ready.ref) ||
          hash(w.grant) !== ready.grantSHA256
        )
          fail();
      };
      await createOnce(db, path('OriginalSignal', cap), attempt, authorizeSignal);
      await bounded(db.runTransaction(authorizeSignal, { readOnly: true }));
      cap.checkFresh();
      nativeBefore.assertFresh();
      const finalNative = await originalPendingAttempt(client, cap, ready);
      if (hash(finalNative.proof) !== hash(ready.nativeAttempt)) fail();
      await bounded(db.runTransaction(authorizeSignal, { readOnly: true }));
      cap.checkFresh();
      finalNative.assertFresh();
      if (Date.now() - Date.parse(ready.observedAt) > 5000 || control.exited()) fail();
      signalled = control.fault();
      if (!signalled) fail();
    } catch {
      control.stop();
      fail();
    }
  });
  const closed = (await bounded(db.doc(path('Kernel', cap)).get())).data();
  if (!signalled || result.code !== null || result.signal !== 'SIGKILL') fail();
  if (
    closed?.stage !== 'closed' ||
    closed.close?.descendantsAbsent !== true ||
    closed.close.observerFailed === true ||
    closed.close.signal !== 'SIGKILL' ||
    closed.close.code !== null ||
    hash({ context: closed.context, intent: closed.intent, birth: closed.birth, worker: closed.worker }) !==
      hash({ context: original.context, intent: original.intent, birth: original.birth, worker: original.worker })
  )
    fail();
  const death = {
    schemaVersion: 1,
    kind: 'original-application-child-death-only-no-replacement-authority',
    operationId: cap.context.operationId,
    readySHA256: hash(ready),
    closedKernelSHA256: hash(closed),
    originalRunId: ready.runId,
    originalActivityId: ready.activityId,
    inventorySHA256: hash(ready.inventory),
    observedAt: new Date().toISOString(),
  };
  // Owned death cleanup remains valid after work expiry; it cannot create work.
  await createOnce(db, path('OriginalDeath', cap), death, async (tx) => {
    const [kernel, signal, settled] = await Promise.all(
      ['Kernel', 'OriginalSignal', 'OriginalReady'].map((k) => tx.get(db.doc(path(k, cap))))
    );
    if (
      hash(kernel.data() ?? null) !== hash(closed) ||
      hash(settled.data() ?? null) !== hash(ready) ||
      signal.get('readySHA256') !== hash(ready) ||
      signal.get('originalKernelSHA256') !== hash(original) ||
      signal.get('signal') !== 'SIGKILL' ||
      signal.get('intentSHA256') !== cap.context.intentSHA256
    )
      fail();
  });
  return result;
}
