/** Historical GET-only recovery episode collector. It grants no polling, signal,
 * replacement, drain, restoration, promotion or platform-instance authority. */
import type { Firestore } from 'firebase-admin/firestore';
import type { Client } from '@temporalio/client';
import { Storage } from '@google-cloud/storage';
import { workerReadinessDigest as hash } from './readiness-probe';
import { validateMediaKernelBirthRecord } from './media-kernel-supervisor';
import { readMediaRecoveryOriginalLineage } from './media-recovery-replacement';
import { originalMediaArtifacts } from './media-recovery-original-fault';
import { mediaRecoveryNativeStart } from './media-recovery-work';
import { mediaRecoveryPinnedVersion } from './media-recovery-pin';
import {
  releaseProvenanceDigest,
  readCompletedMediaRecoverySnapshot,
  readMediaPromotionRecoverySnapshot,
  type MediaPromotionRecoveryOptions,
  type CompletedMediaRecoveryOptions,
} from './media-recovery-history';
import { validateHistoricalMediaRecoveryCapacity } from './media-startup-capacity';
const fail = (): never => {
  throw new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED');
};
const exact = (v: any, keys: string) => {
  if (!v || Object.keys(v).sort().join(',') !== keys) fail();
};
const birth = (k: any) => hash({ context: k.context, intent: k.intent, birth: k.birth, worker: k.worker });
const time = (v: unknown) => {
  const at = Date.parse(typeof v === 'string' ? v : '');
  if (!Number.isFinite(at) || at > Date.now() + 5000) fail();
  return at;
};
const kinds = [
  'Journal',
  'Start',
  'Kernel',
  'Startup',
  'OriginalReady',
  'OriginalSignal',
  'OriginalDeath',
  'Work',
  'ReplacementIntent',
  'ReplacementKernel',
  'ReplacementStartup',
  'ReplacementAdoption',
  'ReplacementCompleted',
  'ReplacementStop',
] as const;
type Options = {
  db: Firestore;
  client: Client;
  operationId: string;
  plan: any;
  expectedRootSHA256: string;
  expectedControlSHA256: string;
  expectedStateSHA256: string;
  image: { bundleSHA256: string; tools: { pythonSHA256: string; ffmpegSHA256: string; ffprobeSHA256: string } };
};
async function collect(o: Options, deadline: number) {
  const fresh = () => {
    if (Date.now() >= deadline) fail();
  };
  fresh();
  const { db, plan: p, operationId: id } = o;
  if (
    !('projectId' in db) ||
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
    p.operationId !== id ||
    p.role !== 'media' ||
    p.expiresAt !== time(p.createdAt) + 300000 ||
    !Object.values(o.image.tools).every((x) => /^[a-f0-9]{64}$/.test(x)) ||
    !/^[a-f0-9]{64}$/.test(o.image.bundleSHA256)
  )
    fail();
  const read = () =>
    db.runTransaction(
      async (tx) => {
        fresh();
        const refs = [
          '_control/temporalReleaseOperation',
          '_control/temporalRelease',
          '_control/temporalReleaseState',
          ...kinds.map((k) => `_control/temporalMediaRecovery${k}-${id}`),
        ].map((x) => db.doc(x));
        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        if (snaps.some((s) => !s.exists || !s.createTime || !s.updateTime)) fail();
        const [root, control, state] = snaps,
          op = root.data()!;
        const facts = Object.fromEntries(kinds.map((k, i) => [k, snaps[i + 3].data()!])) as Record<
          (typeof kinds)[number],
          any
        >;
        const c = op.cloudMediaRecovery,
          j = facts.Journal,
          start = op.mediaRecoveryWorkflowStart,
          ack = facts.Start;
        if (
          releaseProvenanceDigest(op) !== o.expectedRootSHA256 ||
          releaseProvenanceDigest(control.data()) !== o.expectedControlSHA256 ||
          releaseProvenanceDigest(state.data()) !== o.expectedStateSHA256 ||
          op.action !== 'diagnose-cloud-run-media-recovery' ||
          op.operationId !== id ||
          op.releaseId !== p.releaseId ||
          op.bindingDigest !== p.bindingDigest ||
          hash(c?.plan) !== hash(p) ||
          c.stage !== 'prepared' ||
          c.start?.stage !== 'completed' ||
          c.start.pool?.desiredManualInstanceCount !== 1 ||
          c.stop ||
          c.recovery ||
          c.recoveryFailed ||
          c.drained ||
          j.scope !== 'arming-only-no-execution-authority' ||
          j.planSHA256 !== hash(p) ||
          c.prepared?.proofSHA256 !== hash(j) ||
          op.mediaRecoveryJournalAttempt?.stage !== 'completed' ||
          op.mediaRecoveryJournalAttempt.recordSHA256 !== hash(j) ||
          op.mediaRecoveryJournalAttempt.attemptedAt !== j.attemptedAt ||
          j.expiresAt !== p.expiresAt ||
          j.authority.control.dataDigest !== releaseProvenanceDigest(control.data()) ||
          j.authority.state.dataDigest !== releaseProvenanceDigest(state.data()) ||
          start?.stage !== 'attempted' ||
          start.planSHA256 !== hash(p) ||
          start.poolSHA256 !== hash(c.start.pool) ||
          start.preparedSHA256 !== hash(c.prepared) ||
          start.cycleSHA256 !== hash(c) ||
          start.expiresAt !== p.expiresAt ||
          ack.stage !== 'confirmed' ||
          ack.operationId !== id ||
          ack.intentSHA256 !== hash(start) ||
          ack.poolSHA256 !== hash(c.start.pool)
        )
          fail();
        exact(
          ack,
          'ack,confirmedAt,intentSHA256,nativeStartSHA256,operationId,poolSHA256,recordedAt,runId,schemaVersion,stage'
        );
        if (
          ack.schemaVersion !== 1 ||
          !['native-start-response', 'unknown-ack-native-get-only'].includes(ack.ack) ||
          time(ack.confirmedAt) < time(ack.recordedAt) ||
          time(ack.recordedAt) < time(start.attemptedAt)
        )
          fail();
        const kernel = facts.Kernel,
          work = facts.Work;
        const intent = {
          kind: 'canonical-private-media-worker-v1',
          operationId: id,
          planSHA256: hash(p),
          armingSHA256: hash(j),
          startPlan: c.start.plan,
          startRequest: c.start.request,
          startAttemptedAt: c.start.attemptedAt,
          control: j.authority.control,
          state: j.authority.state,
          actorUid: work.actorUid,
        };
        if (kernel.context?.intentSHA256 !== hash(intent) || kernel.context.operationId !== id) fail();
        const originals = await readMediaRecoveryOriginalLineage(db, { context: kernel.context, plan: p }, tx);
        if (
          hash(originals.ready) !== hash(facts.OriginalReady) ||
          hash(originals.intent) !== hash(facts.ReplacementIntent)
        )
          fail();
        const stamps = snaps.map((s) => ({
          path: s.ref.path,
          created: s.createTime,
          updated: s.updateTime,
          data: hash(s.data()),
        }));
        return { facts, originals, start, pool: c.start.pool, stampsSHA256: hash(stamps) };
      },
      { readOnly: true }
    );
  return collectWithEpisodeReader(o, deadline, read);
}
/** Both readers are constructed by fixed source entrypoints. No public option
 * can inject a reader or substitute a historical parent for current authority. */
async function collectWithEpisodeReader(
  o: Pick<Options, 'db' | 'client' | 'operationId' | 'plan' | 'image'>,
  deadline: number,
  read: () => Promise<any>
) {
  const fresh = () => {
    if (Date.now() >= deadline) fail();
  };
  const { db, plan: p, operationId: id } = o;
  const before = await read();
  fresh();
  const f = before.facts,
    old = f.Kernel,
    k = f.ReplacementKernel,
    i = f.ReplacementIntent,
    a = f.ReplacementAdoption,
    done = f.ReplacementCompleted,
    stop = f.ReplacementStop,
    ready = f.OriginalReady;
  const derived = hash({
    kind: 'explicit-original-death-replacement-v1',
    baseIntentSHA256: old.context.intentSHA256,
    intentSHA256: hash(i),
    deathSHA256: hash(f.OriginalDeath),
  });
  const { close, ...preClose } = k;
  if (
    k.schemaVersion !== 1 ||
    k.stage !== 'closed' ||
    k.context?.intentSHA256 !== derived ||
    k.context.operationId !== id ||
    hash(k.intent) !== hash(i.birth) ||
    hash(k.context.parent) !== hash(old.context.parent) ||
    k.birth?.pid === old.birth.pid ||
    k.birth?.nonce === old.birth.nonce ||
    k.worker?.instanceId === old.worker.instanceId ||
    hash(k.worker?.cloudRun) !== hash(old.worker.cloudRun) ||
    close?.code !== 0 ||
    close.signal !== null ||
    close.descendantsAbsent !== true ||
    close.observerFailed === true ||
    stop.kernelSHA256 !== hash({ ...preClose, stage: 'running' })
  )
    fail();
  exact(close, 'code,descendantsAbsent,observedAt,signal');
  exact(stop, 'kernelSHA256,kind,observedAt,operationId,schemaVersion');
  if (stop.schemaVersion !== 1 || stop.kind !== 'owned-replacement-stop-intent' || stop.operationId !== id) fail();
  for (const kernel of [old, k]) {
    exact(kernel, 'birth,close,context,intent,schemaVersion,stage,worker');
    exact(kernel.context, 'controlVersion,intentSHA256,operationId,parent,stateVersion');
    validateMediaKernelBirthRecord(
      kernel,
      id,
      kernel.context.intentSHA256,
      { operationId: id, birthDigest: birth(kernel) },
      kernel.worker
    );
  }
  exact(
    f.OriginalReady,
    'activityId,attempt,birthDigest,grantSHA256,intentSHA256,inventory,kind,nativeAttempt,observedAt,operationId,ref,runId,schemaVersion,worker,workflowId'
  );
  exact(
    f.OriginalDeath,
    'closedKernelSHA256,inventorySHA256,kind,observedAt,operationId,originalActivityId,originalRunId,readySHA256,schemaVersion'
  );
  exact(old.close, 'code,descendantsAbsent,observedAt,signal');
  if (
    time(before.start.attemptedAt) < time(p.createdAt) ||
    time(before.start.attemptedAt) >= p.expiresAt ||
    before.start.operationId !== id ||
    before.start.workflowId !== `media-recovery-${id}` ||
    before.start.workflowType !== 'MediaRecoveryProbe' ||
    before.start.taskQueue !== 'urm-media-kernel-recovery'
  )
    fail();
  const pool = before.pool;
  for (const worker of [old.context.parent, old.worker, k.worker]) {
    const cloud = worker?.cloudRun;
    if (
      worker.buildId !== p.buildId ||
      !cloud ||
      cloud.projectId !== 'urm-app-staging' ||
      cloud.region !== 'us-central1' ||
      cloud.pool !== p.name.split('/').at(-1) ||
      cloud.revision !== pool.revision.split('/').at(-1) ||
      cloud.revisionUid !== pool.revisionUid ||
      cloud.serviceAccount !== p.runner ||
      cloud.imageDigest !== p.image.split('@')[1] ||
      !cloud.instanceId ||
      hash(cloud) !== hash(old.worker.cloudRun)
    )
      fail();
  }
  for (const [startup, kernel, expectedIntent] of [
    [f.Startup, old, old.context.intentSHA256],
    [f.ReplacementStartup, k, derived],
  ]) {
    exact(startup, 'bundle,capacity,intentSHA256,kernel,kind,observedAt,operationId,schemaVersion,worker');
    exact(startup.bundle, 'buildId,bundleBytes,bundleSHA256,schemaVersion');
    exact(startup.kernel, 'birthDigest,operationId');
    if (
      startup.schemaVersion !== 1 ||
      startup.kind !== 'private-diagnostic-startup-only-no-recovery-proof' ||
      startup.operationId !== id ||
      startup.intentSHA256 !== expectedIntent ||
      hash(startup.worker) !== hash(kernel.worker) ||
      startup.kernel.operationId !== id ||
      startup.kernel.birthDigest !== birth(kernel) ||
      startup.bundle.schemaVersion !== 1 ||
      startup.bundle.buildId !== p.buildId ||
      startup.bundle.bundleSHA256 !== o.image.bundleSHA256 ||
      !Number.isSafeInteger(startup.bundle.bundleBytes) ||
      startup.bundle.bundleBytes < 1 ||
      startup.bundle.bundleBytes > 64 * 1024 * 1024 ||
      time(startup.observedAt) < time(kernel.birth.spawnedAt) ||
      time(startup.observedAt) >= p.expiresAt
    )
      fail();
    const capacity = validateHistoricalMediaRecoveryCapacity(
      startup.capacity,
      kernel.birth.spawnedAt,
      startup.observedAt
    );
    if (
      capacity.allocation.pythonSHA256 !== o.image.tools.pythonSHA256 ||
      capacity.processing.ffmpegSHA256 !== o.image.tools.ffmpegSHA256 ||
      capacity.processing.ffprobeSHA256 !== o.image.tools.ffprobeSHA256
    )
      fail();
  }
  exact(
    a,
    'activityId,attempt,deathSHA256,inventorySHA256,kind,observedAt,operationId,replacementBirthDigest,replacementIntentSHA256,runId,scheduledEventId,schemaVersion,worker,workflowId'
  );
  exact(done, 'adoptionSHA256,historyEvents,kind,observedAt,operationId,runId,scheduledEventId,schemaVersion');
  if (
    a.schemaVersion !== 1 ||
    a.kind !== 'replacement-source-artifact-adoption-only' ||
    a.operationId !== id ||
    a.replacementIntentSHA256 !== hash(i) ||
    a.deathSHA256 !== hash(f.OriginalDeath) ||
    a.replacementBirthDigest !== birth(k) ||
    hash(a.worker) !== hash(k.worker) ||
    a.workflowId !== ready.workflowId ||
    a.runId !== ready.runId ||
    a.activityId !== ready.activityId ||
    a.scheduledEventId !== ready.nativeAttempt.scheduledEventId ||
    a.attempt !== 2 ||
    a.inventorySHA256 !== hash(ready.inventory) ||
    done.schemaVersion !== 1 ||
    done.kind !== 'replacement-original-workflow-completed-only' ||
    done.operationId !== id ||
    done.adoptionSHA256 !== hash(a) ||
    done.runId !== a.runId ||
    done.scheduledEventId !== a.scheduledEventId ||
    ready.runId !== f.Start.runId ||
    f.Work.nativeStartSHA256 !== f.Start.nativeStartSHA256 ||
    time(f.Startup.observedAt) > time(ready.observedAt) ||
    time(f.ReplacementStartup.observedAt) > time(a.observedAt) ||
    time(a.observedAt) > time(done.observedAt) ||
    time(done.observedAt) >= p.expiresAt ||
    time(done.observedAt) > time(stop.observedAt) ||
    time(stop.observedAt) > time(close.observedAt)
  )
    fail();
  const bucket = new Storage({ projectId: 'urm-app-staging', retryOptions: { autoRetry: false } }).bucket(
    'urm-app-staging.firebasestorage.app'
  );
  if (hash(await originalMediaArtifacts(db, bucket, id)) !== hash(ready.inventory)) fail();
  const handle = o.client.workflow.getHandle(ready.workflowId, ready.runId, { followRuns: false });
  const describe = async () => {
    fresh();
    const d = await o.client.connection.withDeadline(Date.now() + 5000, () => handle.describe());
    fresh();
    const wi = d.raw.workflowExecutionInfo,
      vi = wi?.versioningInfo,
      expected = { deploymentName: 'urm-worker-media-recovery-staging', buildId: p.buildId };
    if (
      wi?.status !== 2 ||
      wi.execution?.workflowId !== ready.workflowId ||
      wi.execution?.runId !== ready.runId ||
      vi?.behavior !== 1 ||
      hash(vi.deploymentVersion) !== hash(expected) ||
      d.raw.pendingActivities?.length ||
      d.raw.pendingChildren?.length ||
      d.raw.pendingNexusOperations?.length
    )
      fail();
    mediaRecoveryPinnedVersion(vi!.versioningOverride, expected);
    return hash(wi);
  };
  const nativeBefore = await describe();
  fresh();
  const response = await o.client.connection.withDeadline(Date.now() + 5000, () =>
    o.client.workflowService.getWorkflowExecutionHistory({
      namespace: 'urm-app-staging.qwejt',
      execution: { workflowId: ready.workflowId, runId: ready.runId },
      maximumPageSize: 64,
    })
  );
  fresh();
  const history = response.history,
    events = history?.events;
  if (
    response.nextPageToken?.length ||
    !events ||
    events.length < 1 ||
    events.length > 64 ||
    done.historyEvents !== events.length
  )
    fail();
  if (
    mediaRecoveryNativeStart(
      events![0],
      before.start,
      { operationId: id, startNonce: before.start.nonce },
      ready.runId
    ) !== f.Start.nativeStartSHA256
  )
    fail();
  const firstTime = events![0].eventTime!;
  if (BigInt(String(firstTime.seconds)) * 1000000000n + BigInt(firstTime.nanos ?? 0) >= BigInt(p.expiresAt) * 1000000n)
    fail();
  const schedules = events!.filter((e) => e.activityTaskScheduledEventAttributes);
  if (
    schedules.length !== 2 ||
    schedules.some((e) => e.activityTaskScheduledEventAttributes!.taskQueue?.name !== 'urm-media-kernel-recovery') ||
    schedules.filter((e) => e.activityTaskScheduledEventAttributes!.activityId === 'media-recovery-admit').length !==
      1 ||
    schedules.filter(
      (e) =>
        e.activityTaskScheduledEventAttributes!.activityId === ready.activityId &&
        String(e.eventId) === a.scheduledEventId
    ).length !== 1 ||
    events!.some(
      (e) =>
        e.startChildWorkflowExecutionInitiatedEventAttributes ||
        e.workflowExecutionContinuedAsNewEventAttributes ||
        e.nexusOperationScheduledEventAttributes
    ) ||
    events!.filter((e) => e.workflowExecutionStartedEventAttributes).length !== 1 ||
    events!.filter((e) => e.workflowExecutionCompletedEventAttributes).length !== 1 ||
    !events!.at(-1)?.workflowExecutionCompletedEventAttributes
  )
    fail();
  const completed = events!.filter(
    (e) => String(e.activityTaskCompletedEventAttributes?.scheduledEventId) === a.scheduledEventId
  );
  if (completed.length !== 1) fail();
  const started = events!.find(
    (e) => String(e.eventId) === String(completed[0].activityTaskCompletedEventAttributes?.startedEventId)
  )?.activityTaskStartedEventAttributes;
  if (started?.attempt !== 2 || started.identity !== `media-recovery-${k.worker.instanceId}`) fail();
  fresh();
  const result = await o.client.connection.withDeadline(Date.now() + 5000, () => handle.result());
  fresh();
  exact(result, 'grantSHA256,operationId,runId');
  if (result.operationId !== id || result.runId !== ready.runId || result.grantSHA256 !== ready.grantSHA256) fail();
  if (
    hash(await originalMediaArtifacts(db, bucket, id)) !== hash(ready.inventory) ||
    (await describe()) !== nativeBefore
  )
    fail();
  const after = await read();
  fresh();
  if (after.stampsSHA256 !== before.stampsSHA256) fail();
  // Raw native history remains in-memory solely for exact-image offline replay.
  return {
    history,
    provenanceSHA256: before.stampsSHA256,
    workflowId: ready.workflowId,
    runId: ready.runId,
    evidenceSHA256: hash({
      journals: before.stampsSHA256,
      image: o.image,
      native: nativeBefore,
      history: hash(history),
      inventory: hash(ready.inventory),
    }),
  };
}
export async function collectMediaRecoveryExecution(o: Options) {
  const deadline = Date.now() + 20000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collect(o, deadline).then((v) => {
        if (Date.now() >= deadline) fail();
        return v;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED')), 20000);
      }),
    ]);
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}

/** A START ACK precedes recovery. Wait only on the same original run and owned
 * private journal; this API cannot start, signal, fork, adopt or renew work. */
export async function waitForMediaRecoveryEpisode(o: Omit<Options, 'image'> & { runId: string }) {
  let active = true;
  const overall = Date.now() + 90000,
    pollUntil = Math.min(overall, o.plan.expiresAt + 30000);
  const boundedRead = async <T>(promise: Promise<T>): Promise<T> => {
    const end = Math.min(overall, Date.now() + 5000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED')),
            Math.max(0, end - Date.now())
          );
        }),
      ]);
      if (Date.now() >= end) fail();
      return value;
    } catch {
      active = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (!/^[a-f0-9-]{36}$/.test(o.runId) || !Number.isFinite(pollUntil)) fail();
    const handle = o.client.workflow.getHandle(`media-recovery-${o.operationId}`, o.runId, { followRuns: false });
    let first = true;
    while (first || Date.now() < pollUntil) {
      first = false;
      const ready = await boundedRead(
        o.db.runTransaction(
          async (tx) => {
            if (!active || Date.now() >= overall) fail();
            const paths = [
              '_control/temporalReleaseOperation',
              '_control/temporalRelease',
              '_control/temporalReleaseState',
              ...['Start', 'Kernel', 'ReplacementKernel', 'ReplacementCompleted', 'ReplacementStop'].map(
                (k) => `_control/temporalMediaRecovery${k}-${o.operationId}`
              ),
            ];
            const [op, c, s, start, old, kernel, completed, stop] = await Promise.all(
              paths.map((p) => tx.get(o.db.doc(p)))
            );
            if (
              releaseProvenanceDigest(op.data()) !== o.expectedRootSHA256 ||
              releaseProvenanceDigest(c.data()) !== o.expectedControlSHA256 ||
              releaseProvenanceDigest(s.data()) !== o.expectedStateSHA256 ||
              start.get('stage') !== 'confirmed' ||
              start.get('runId') !== o.runId ||
              start.get('intentSHA256') !== hash(op.get('mediaRecoveryWorkflowStart'))
            )
              fail();
            if (
              old.get('stage') === 'closed' &&
              (old.get('close.signal') !== 'SIGKILL' ||
                old.get('close.descendantsAbsent') !== true ||
                old.get('close.observerFailed') === true)
            )
              fail();
            if (
              kernel.get('stage') === 'closed' &&
              (kernel.get('close.code') !== 0 ||
                kernel.get('close.signal') !== null ||
                kernel.get('close.descendantsAbsent') !== true ||
                kernel.get('close.observerFailed') === true)
            )
              fail();
            return kernel.get('stage') === 'closed' && completed.exists && stop.exists;
          },
          { readOnly: true }
        )
      );
      // One historical GET-only check is always allowed. Incomplete work cannot
      // obtain more polling time after its original window has ended.
      if (!ready && Date.now() >= pollUntil) fail();
      const d = await boundedRead(
        o.client.connection.withDeadline(Math.min(overall, Date.now() + 5000), () => handle.describe())
      );
      const wi = d.raw.workflowExecutionInfo,
        vi = wi?.versioningInfo,
        version = { deploymentName: 'urm-worker-media-recovery-staging', buildId: o.plan.buildId };
      if (
        wi?.execution?.runId !== o.runId ||
        wi.execution.workflowId !== `media-recovery-${o.operationId}` ||
        ![1, 2].includes(wi.status!) ||
        vi?.behavior !== 1 ||
        hash(vi.deploymentVersion) !== hash(version)
      )
        fail();
      mediaRecoveryPinnedVersion(vi!.versioningOverride, version);
      if (ready) {
        if (wi!.status !== 2) fail();
        return;
      }
      if (Date.now() >= pollUntil) fail();
      await new Promise((r) => setTimeout(r, Math.min(250, pollUntil - Date.now())));
    }
    return fail();
  } catch {
    return fail();
  }
}

/** Fixed new-parent historical read. Never waits for, starts or renews work. */
export async function collectCompletedMediaRecoveryExecution(o: CompletedMediaRecoveryOptions) {
  return collectHistorical(o, (fresh) => readCompletedMediaRecoverySnapshot(o, fresh));
}
/** Fixed promotion parent; current and both historical operations stay distinct. */
export async function collectMediaPromotionRecoveryExecution(o: MediaPromotionRecoveryOptions) {
  return collectHistorical(o, (fresh) => readMediaPromotionRecoverySnapshot(o, fresh));
}
async function collectHistorical(
  o: CompletedMediaRecoveryOptions,
  snapshot: (fresh: () => void) => ReturnType<typeof readCompletedMediaRecoverySnapshot>
) {
  const began = Date.now(),
    mono = performance.now(),
    deadline = began + 20000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fresh = () => {
    if (Date.now() < began || Date.now() >= deadline || performance.now() - mono >= 20000) fail();
  };
  try {
    const task = async () => {
      const read = () => snapshot(fresh);
      const first = await read();
      fresh();
      const result = await collectWithEpisodeReader(
        { db: o.db, client: o.client, operationId: o.recoveryOperationId, plan: first.plan, image: o.image },
        deadline,
        read
      );
      fresh();
      if (result.provenanceSHA256 !== first.stampsSHA256) fail();
      return result;
    };
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED')), 20000);
      }),
    ]);
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}

/** Final fixed GET-only provenance fence after native/image external reads. */
export async function confirmCompletedMediaRecoveryProvenance(o: CompletedMediaRecoveryOptions) {
  return confirmHistorical((fresh) => readCompletedMediaRecoverySnapshot(o, fresh));
}
export async function confirmMediaPromotionRecoveryProvenance(o: MediaPromotionRecoveryOptions) {
  return confirmHistorical((fresh) => readMediaPromotionRecoverySnapshot(o, fresh));
}
async function confirmHistorical(
  snapshot: (fresh: () => void) => ReturnType<typeof readCompletedMediaRecoverySnapshot>
) {
  const at = Date.now(),
    mono = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fresh = () => {
    if (Date.now() < at || Date.now() - at >= 5000 || performance.now() - mono >= 5000) fail();
  };
  try {
    const result = await Promise.race([
      snapshot(fresh),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
    return { provenanceSHA256: result.stampsSHA256 };
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}
