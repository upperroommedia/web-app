import { releaseProvenanceDigest } from './release-provenance';
import { mediaJobPhase, tagMediaJobFailure } from './media-job-launch-failure';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { WorkerWitness } from './worker-witness';
import { workerReadinessDigest as hash } from './readiness-probe';
import { recheckMediaRecoveryTaskAttestation } from './media-recovery-task-attestation-reader';
import { matchMediaRecoveryJobRun } from './media-recovery-job-witness';
import { mediaRecoveryBucketName } from './media-recovery-storage';
import { mediaRecoveryExecutionExpiry, mediaRecoveryLaunchWindow } from './media-recovery-execution-window';
function fail(): never {
  throw new Error('MEDIA_RECOVERY_CAPABILITY_UNCONFIRMED');
}
class PendingMediaRecoveryJobIdentity extends Error {}
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
const stamp = (s: any) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return {
    dataDigest: releaseProvenanceDigest(s.data()),
    createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
    updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
  };
};
const version = (s: any) => (s.updateTime ? `${s.updateTime.seconds}:${s.updateTime.nanoseconds}` : fail());
/** Distinct diagnostic capability; never a normal media birth/capacity intent.
 * Native startup can precede scale completion, while work admission separately
 * requires completed start authority and the causal original SDK intent. */
export async function mediaRecoveryKernelContext(
  db: Firestore,
  auth: Auth,
  witness: WorkerWitness,
  operationId: string
) {
  if (
    !('projectId' in db) ||
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
  )
    fail();
  const refs = [
    '_control/temporalReleaseOperation',
    '_control/temporalRelease',
    '_control/temporalReleaseState',
    `_control/temporalMediaRecoveryJournal-${operationId}`,
  ].map((p) => db.doc(p));
  let original: any;
  let initialRead = true;
  const read = async (tx: Transaction) => {
    const documents = () => Promise.all(refs.map((r) => tx.get(r)));
    const [op, c, s, journal] = await (initialRead ? mediaJobPhase('capability-firestore', documents) : documents()),
      cycle = op.get('cloudMediaRecovery'),
      p = cycle?.plan,
      start = cycle?.start,
      j = journal.data(),
      before = start?.plan?.before,
      cloud = witness.cloudRun;
    const window = mediaRecoveryLaunchWindow(p);
    if (
      op.get('action') !== 'diagnose-cloud-run-media-recovery' ||
      op.get('operationId') !== operationId ||
      op.get('bindingDigest') !== p?.bindingDigest ||
      op.get('releaseId') !== p?.releaseId ||
      op.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
      p?.operationId !== operationId ||
      p.role !== 'media' ||
      cycle.stage !== 'prepared' ||
      cycle.stop ||
      cycle.recovery ||
      cycle.recoveryFailed ||
      cycle.drained ||
      p.schemaVersion !== 1 ||
      !/^([a-f0-9]{40})$/.test(p.buildId ?? '') ||
      p.name !==
        `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${p.buildId.slice(0, 20)}` ||
      p.runner !== `tw-m-${p.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
      !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(
        p.image ?? ''
      ) ||
      hash(p.contract) !==
        hash({
          deploymentName: 'urm-worker-media-recovery-staging',
          queue: 'urm-media-kernel-recovery',
          workflowType: 'MediaRecoveryProbe',
          protocol: 'owned-media-recovery-v1',
        }) ||
      !j ||
      j.schemaVersion !== 1 ||
      j.scope !== 'arming-only-no-execution-authority' ||
      j.operationId !== operationId ||
      j.planSHA256 !== hash(p) ||
      j.buildId !== p.buildId ||
      j.image !== p.image ||
      j.runner !== p.runner ||
      j.pool !== p.name ||
      cycle.prepared?.kind !== 'prepared' ||
      cycle.prepared.proofSHA256 !== hash(j) ||
      op.get('mediaRecoveryJournalAttempt.stage') !== 'completed' ||
      op.get('mediaRecoveryJournalAttempt.recordSHA256') !== hash(j) ||
      hash(j.authority?.control) !== hash(stamp(c)) ||
      hash(j.authority?.state) !== hash(stamp(s)) ||
      c.get('admission') !== 'paused' ||
      c.get('releaseId') !== p.releaseId ||
      s.get('releaseId') !== p.releaseId ||
      s.get('phase') !== 'provider-usage-ready' ||
      domains.some((d) => c.get(`domains.${d}.admission`) !== 'paused') ||
      witness.buildId !== p.buildId ||
      !window || window.startedAt > Date.now() + 5000
    )
      fail();
    const job = witness.cloudRunJob;
    if (p.diagnosticStorage !== undefined) mediaRecoveryBucketName(p, true);
    let computeIntent;
    let attestedExpiry: number | undefined;
    if (job) {
      const native = op.get('mediaRecoveryJobProvider');
      if (
        cloud ||
        cycle.diagnostic ||
        cycle.start ||
        cycle.restore ||
        !p.job ||
        p.job.name !== job.job ||
        job.projectId !== 'urm-app-staging' ||
        job.region !== 'us-central1' ||
        job.serviceAccount !== p.runner ||
        job.imageDigest !== p.image.split('@')[1] ||
        native?.jobPlanSHA256 !== hash(p.job) ||
        native.create?.stage !== 'acknowledged' ||
        !['attempted', 'acknowledged'].includes(native.run?.stage)
      )
        fail();
      if (!native.runIdentity && !original) throw new PendingMediaRecoveryJobIdentity();
      if (!matchMediaRecoveryJobRun(job, p, native)) fail();
      const certificate = await recheckMediaRecoveryTaskAttestation(
        db, tx, operationId, job, p, op.get('mediaRecoveryTaskAttestation')
      );
      attestedExpiry = certificate?.executionExpiresAt;
      computeIntent = { jobProviderSHA256: hash(native), jobIdentity: job };
    } else {
      if (
        cycle.diagnostic?.stage !== 'completed' ||
        !['attempted', 'acknowledged', 'completed'].includes(start?.stage) ||
        start.plan?.key !== 'start' ||
        start.plan.operationId !== operationId ||
        start.plan.target !== 1 ||
        start.request?.method !== 'PATCH' ||
        start.request.body?.scaling?.manualInstanceCount !== 1 ||
        start.request.body.name !== p.name ||
        start.request.body.etag !== before?.etag ||
        hash(cycle.diagnostic.pool) !== hash(before) ||
        !cloud ||
        cloud.projectId !== 'urm-app-staging' ||
        cloud.region !== 'us-central1' ||
        cloud.pool !== p.name.split('/').at(-1) ||
        cloud.revision !== before.revision?.split('/').at(-1) ||
        cloud.revisionUid !== before.revisionUid ||
        cloud.serviceAccount !== p.runner ||
        cloud.imageDigest !== p.image.split('@')[1] ||
        !cloud.instanceId ||
        !Number.isFinite(Date.parse(start.attemptedAt)) ||
        Date.parse(start.attemptedAt) < Date.parse(p.createdAt) ||
        Date.parse(start.attemptedAt) >= p.expiresAt
      )
        fail();
      if (
        start.stage === 'completed' &&
        (start.pool?.uid !== before.uid ||
          start.pool.revision !== before.revision ||
          start.pool.revisionUid !== before.revisionUid ||
          start.pool.desiredManualInstanceCount !== 1)
      )
        fail();
      computeIntent = { startPlan: start.plan, startRequest: start.request, startAttemptedAt: start.attemptedAt };
    }
    const executionExpiresAt = mediaRecoveryExecutionExpiry(p, attestedExpiry);
    if (executionExpiresAt === undefined || Date.now() >= executionExpiresAt) fail();
    const attempt = op.get('mediaRecoveryJournalAttempt');
    if (
      j.releaseId !== p.releaseId ||
      j.bindingDigest !== p.bindingDigest ||
      j.createdAt !== p.createdAt ||
      j.expiresAt !== p.expiresAt ||
      hash(j.contract) !== hash(p.contract) ||
      attempt?.schemaVersion !== 1 ||
      attempt.planSHA256 !== hash(p) ||
      attempt.attemptedAt !== j.attemptedAt ||
      !Number.isFinite(Date.parse(j.attemptedAt)) ||
      Date.parse(j.attemptedAt) < Date.parse(p.createdAt) ||
      Date.parse(j.attemptedAt) >= p.expiresAt ||
      cycle.prepared.operationId !== operationId ||
      cycle.prepared.bindingDigest !== p.bindingDigest ||
      cycle.prepared.buildId !== p.buildId ||
      cycle.prepared.image !== p.image ||
      (!job &&
        (before.desiredManualInstanceCount !== 0 ||
          !before.uid ||
          !before.revisionUid ||
          start.plan.templateSHA256 !== hash(p.diagnosticTemplate) ||
          start.request.url !== `https://run.googleapis.com/v2/${p.name}?updateMask=scaling`)) ||
      p.normalTemplate?.containers?.length !== 1 ||
      p.normalTemplate.containers[0].image !== p.image
    )
      fail();
    const template = structuredClone(p.normalTemplate),
      env = template.containers[0].env;
    if (
      !Array.isArray(env) ||
      env.some((v: any) => ['TEMPORAL_MEDIA_RECOVERY_OPERATION', 'TEMPORAL_WORKFLOW_BUNDLE'].includes(v.name))
    )
      fail();
    for (const [name, value] of Object.entries({
      TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-recovery-staging',
      TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
    })) {
      const rows = env.filter((v: any) => v.name === name);
      if (rows.length !== 1 || typeof rows[0].value !== 'string') fail();
      rows[0].value = value;
    }
    env.push(
      {
        name: 'TEMPORAL_WORKFLOW_BUNDLE',
        value: '/workspace/apps/temporal-worker/lib/media-recovery-workflow-bundle.js',
      },
      { name: 'TEMPORAL_MEDIA_RECOVERY_OPERATION', value: operationId }
    );
    if (hash(template) !== hash(p.diagnosticTemplate)) fail();
    const readActor = async () => {
      const actor = await auth.getUserByEmail(op.get('operatorPrincipal.email'));
      if (actor.disabled || actor.customClaims?.role !== 'admin' || actor.email !== op.get('operatorPrincipal.email'))
        fail();
      return actor;
    };
    const actor = await (initialRead ? mediaJobPhase('capability-auth', readActor) : readActor());
    const intent = {
      kind: 'canonical-private-media-worker-v1',
      operationId,
      planSHA256: hash(p),
      armingSHA256: hash(j),
      ...computeIntent,
      control: stamp(c),
      state: stamp(s),
      actorUid: actor.uid,
    };
    const current = { intent, plan: p, executionExpiresAt, controlVersion: version(c), stateVersion: version(s) };
    if (original && hash(current) !== hash(original)) fail();
    original = current;
    if (Date.now() >= executionExpiresAt) fail();
  };
  const began = performance.now();
  for (;;) {
    try {
      await db.runTransaction(read, { readOnly: true });
      initialRead = false;
      break;
    } catch (error) {
      if (!(error instanceof PendingMediaRecoveryJobIdentity)) {
        // Transaction setup/commit can reject outside the callback's document reads.
        tagMediaJobFailure('capability-firestore', error, error, 'grpc');
        throw error;
      }
      if (performance.now() - began >= 25000) fail();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const intentSHA256 = hash(original.intent);
  const checkFresh = () => {
    if (Date.now() >= original.executionExpiresAt || Date.parse(original.plan.createdAt) > Date.now() + 5000) fail();
  };
  return {
    context: {
      operationId,
      intentSHA256,
      controlVersion: original.controlVersion,
      stateVersion: original.stateVersion,
      parent: witness,
    },
    authorize: read,
    checkFresh,
    plan: original.plan,
    executionExpiresAt: original.executionExpiresAt as number,
  };
}
