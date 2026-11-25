import { historicalMediaRecoveryExecutionWindow, mediaRecoveryTaskAttestationPath } from './media-recovery-task-attestation-reader';
import { releaseProvenanceDigest } from './release-provenance';
/** Fixed historical authorization reader. Current authority and immutable
 * original provenance are independent; no Firestore or parent overlays. */
import { readRetainedMediaPromotionAuthority, type MediaPromotionAuthorityOptions } from './media-promotion-history';
import type { Firestore } from 'firebase-admin/firestore';
import type { Client } from '@temporalio/client';
import { workerReadinessDigest as hash } from './readiness-probe';
import { readMediaRecoveryOriginalLineage } from './media-recovery-replacement';
const fail = (): never => {
  throw new Error('MEDIA_RECOVERY_HISTORY_UNCONFIRMED');
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
const exact = (v: any, keys: string) => {
  if (!v || Object.keys(v).sort().join(',') !== keys) fail();
};
const uuid = (v: any) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export { releaseProvenanceDigest } from './release-provenance';

const nativeTime = (t: any) => {
  if (
    !t ||
    typeof t.toDate !== 'function' ||
    !Number.isSafeInteger(t.seconds) ||
    !Number.isInteger(t.nanoseconds) ||
    t.nanoseconds < 0 ||
    t.nanoseconds >= 1e9
  )
    fail();
  return { seconds: t.seconds, nanoseconds: t.nanoseconds };
};
export type CompletedMediaRecoveryOptions = {
  db: Firestore;
  client: Client;
  recoveryOperationId: string;
  activationOperationId: string;
  activationBindingDigest: string;
  releaseId: string;
  expectedRootSHA256: string;
  expectedControlSHA256: string;
  expectedStateSHA256: string;
  buildId: string;
  imageDigest: string;
  image: { bundleSHA256: string; tools: { pythonSHA256: string; ffmpegSHA256: string; ffprobeSHA256: string } };
};
export type MediaPromotionRecoveryOptions = CompletedMediaRecoveryOptions & MediaPromotionAuthorityOptions;
export async function readCompletedMediaRecoverySnapshot(o: CompletedMediaRecoveryOptions, fresh: () => void) {
  return readSnapshot(o, fresh);
}
export async function readMediaPromotionRecoverySnapshot(o: MediaPromotionRecoveryOptions, fresh: () => void) {
  return readSnapshot(o, fresh, o);
}
async function readSnapshot(
  o: CompletedMediaRecoveryOptions,
  fresh: () => void,
  promotion?: MediaPromotionRecoveryOptions
) {
  fresh();
  const id = o.recoveryOperationId;
  if (
    !('projectId' in o.db) ||
    o.db.projectId !== 'urm-app-staging' ||
    o.db.databaseId !== '(default)' ||
    o.client.options.namespace !== 'urm-app-staging.qwejt' ||
    !uuid(id) ||
    !uuid(o.activationOperationId) ||
    id === o.activationOperationId
  )
    fail();
  return o.db.runTransaction(
    async (tx) => {
      fresh();
      const paths = [
        '_control/temporalReleaseOperation',
        '_control/temporalRelease',
        '_control/temporalReleaseState',
        `_control/temporalMediaRecoveryCapsule-${id}`,
        `_control/temporalCloudMediaRecovery-${id}`,
        `_control/temporalMediaRecoveryDrain-${id}`,
        ...kinds.map((k) => `_control/temporalMediaRecovery${k}-${id}`),
      ];
      const snaps = await Promise.all(paths.map((p) => tx.get(o.db.doc(p))));
      if (snaps.some((s) => !s.exists)) fail();
      const [current, control, state, cap, receipt, drain] = snaps,
        c = current.data()!,
        v = cap.data()!,
        original = v.originalParent,
        completed = receipt.get('identityState'),
        p = completed?.plan,
        jobMode = Boolean(p?.job),
        provider = original?.mediaRecoveryJobProvider,
        compute = jobMode ? provider?.runIdentity : completed?.start?.pool,
        computeKey = jobMode ? 'jobRunSHA256' : 'poolSHA256';
      const retained = promotion ? await readRetainedMediaPromotionAuthority(promotion, tx, fresh) : null;
      if (
        releaseProvenanceDigest(c) !== o.expectedRootSHA256 ||
        releaseProvenanceDigest(control.data()) !== o.expectedControlSHA256 ||
        releaseProvenanceDigest(state.data()) !== o.expectedStateSHA256 ||
        (retained
          ? retained.activationPlan.bindingDigest !== o.activationBindingDigest ||
            retained.activationPlan.recoveryOperationId !== id
          : c.action !== 'activate-restored-cloud-run-media' ||
            c.operationId !== o.activationOperationId ||
            c.bindingDigest !== o.activationBindingDigest) ||
        c.releaseId !== o.releaseId ||
        c.operatorPrincipal?.adcAndGcloudAccountMatch !== true ||
        control.get('releaseId') !== o.releaseId ||
        state.get('releaseId') !== o.releaseId ||
        control.get('admission') !== 'paused' ||
        state.get('phase') !== 'provider-usage-ready' ||
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
          (k) => control.get(`domains.${k}.admission`) !== 'paused'
        )
      )
        fail();
      for (const immutable of [cap, receipt, drain])
        if (
          releaseProvenanceDigest(nativeTime(immutable.createTime)) !==
          releaseProvenanceDigest(nativeTime(immutable.updateTime))
        )
          fail();
      if (
        releaseProvenanceDigest(nativeTime(cap.createTime)) !== releaseProvenanceDigest(nativeTime(receipt.createTime))
      )
        fail();
      exact(
        v,
        'bindingDigest,capsuleSHA256,completionSHA256,drainSHA256,facts,kind,operationId,originalAuthority,originalParent,releaseId,restoredPool,schemaVersion,source'
      );
      const { capsuleSHA256, ...preimage } = v;
      if (
        (retained && retained.activationPlan.origin.capsuleSHA256 !== v.capsuleSHA256) ||
        v.schemaVersion !== (jobMode ? 2 : 1) ||
        v.kind !==
          (jobMode ? 'completed-media-recovery-job-provenance-v2' : 'completed-media-recovery-provenance-only-v1') ||
        releaseProvenanceDigest(preimage) !== capsuleSHA256 ||
        v.operationId !== id ||
        v.releaseId !== o.releaseId ||
        v.bindingDigest !== p?.bindingDigest ||
        v.source?.buildId !== o.buildId ||
        v.source.image !== o.imageDigest ||
        p.buildId !== o.buildId ||
        p.image !== o.imageDigest ||
        p.releaseId !== o.releaseId ||
        p.operationId !== id ||
        p.role !== 'media' ||
        v.source.evidenceDigest !== p.evidenceDigest ||
        v.source.ancestorsSHA256 !== p.ancestorsSHA256 ||
        releaseProvenanceDigest(receipt.data()) !== v.completionSHA256 ||
        releaseProvenanceDigest(drain.data()) !== v.drainSHA256 ||
        releaseProvenanceDigest(original?.cloudMediaRecovery) !== releaseProvenanceDigest(completed) ||
        completed.stage !== 'completed' ||
        completed.disposition !== (jobMode ? 'normal-zero-after-job' : 'restored-normal-zero') ||
        !completed.recovery ||
        completed.recoveryFailed ||
        completed.neverStarted ||
        !compute ||
        (jobMode
          ? !completed.jobDrain ||
            !completed.jobTermination ||
            completed.jobDrain.terminationSHA256 !== completed.jobTermination.proofSHA256 ||
            hash(drain.get('proof')) !== hash(completed.jobDrain) ||
            releaseProvenanceDigest(nativeTime(drain.createTime)) !==
              releaseProvenanceDigest(nativeTime(cap.createTime))
          : !completed.drained || !completed.stopped) ||
        releaseProvenanceDigest(v.restoredPool) !==
          releaseProvenanceDigest(jobMode ? p.origin : completed.restore?.pool) ||
        receipt.get('operationId') !== id ||
        receipt.get('releaseId') !== o.releaseId ||
        receipt.get('bindingDigest') !== v.bindingDigest
      )
        fail();
      exact(
        original,
        [
          'action',
          'bindingDigest',
          'cloudMediaRecovery',
          'mediaRecoveryJournalAttempt',
          'mediaRecoveryWorkflowStart',
          'operationId',
          'operatorIdentity',
          'operatorPrincipal',
          'releaseId',
          ...(jobMode ? ['mediaRecoveryJobProvider'] : []),
          ...(p.taskAttestationPublicKey ? ['mediaRecoveryTaskAttestation'] : []),
        ]
          .sort()
          .join(',')
      );
      if (
        original.action !== 'diagnose-cloud-run-media-recovery' ||
        original.operationId !== id ||
        original.bindingDigest !== v.bindingDigest ||
        original.releaseId !== o.releaseId ||
        releaseProvenanceDigest(original.operatorPrincipal) !==
          releaseProvenanceDigest(receipt.get('operatorPrincipal')) ||
        !original.operatorIdentity
      )
        fail();
      const facts = Object.fromEntries(kinds.map((k, i) => [k, snaps[i + 6].data()!])) as Record<
        (typeof kinds)[number],
        any
      >;
      if (!Array.isArray(v.facts) || v.facts.length !== kinds.length + (p.taskAttestationPublicKey ? 1 : 0)) fail();
      const cert = p.taskAttestationPublicKey
        ? await tx.get(o.db.doc(mediaRecoveryTaskAttestationPath(id)))
        : undefined;
      const executionWindow = historicalMediaRecoveryExecutionWindow(p, cert);
      if (cert) {
        if (!cert.exists || !cert.createTime?.isEqual(cert.updateTime!)) fail();
        const dataSHA256 = releaseProvenanceDigest(cert.data());
        const proof = { digest: dataSHA256, seconds: cert.createTime!.seconds,
          nanoseconds: cert.createTime!.nanoseconds };
        if (releaseProvenanceDigest({
          path: cert.ref.path, dataSHA256, createTime: nativeTime(cert.createTime), updateTime: nativeTime(cert.updateTime),
        }) !== releaseProvenanceDigest(v.facts.at(-1)) ||
            original.mediaRecoveryTaskAttestation?.certificateSHA256 !== dataSHA256 ||
            hash(facts.Startup.taskAttestation ?? null) !== hash(proof) ||
            hash(facts.ReplacementStartup.taskAttestation ?? null) !== hash(proof)) fail();
      }
      for (let i = 0; i < kinds.length; i++) {
        const s = snaps[i + 6],
          expected = {
            path: s.ref.path,
            dataSHA256: releaseProvenanceDigest(s.data()),
            createTime: nativeTime(s.createTime),
            updateTime: nativeTime(s.updateTime),
          };
        if (releaseProvenanceDigest(expected) !== releaseProvenanceDigest(v.facts[i])) fail();
      }
      if (
        p.schemaVersion !== 1 ||
        !Number.isFinite(Date.parse(p.createdAt)) ||
        p.expiresAt !== Date.parse(p.createdAt) + 300000
      )
        fail();
      const j = facts.Journal,
        start = original.mediaRecoveryWorkflowStart,
        ack = facts.Start,
        cycle = {
          plan: p,
          stage: 'prepared',
          prepared: completed.prepared,
          ...(jobMode ? {} : { diagnostic: completed.diagnostic, start: completed.start }),
        };
      if (
        j.planSHA256 !== hash(p) ||
        j.scope !== 'arming-only-no-execution-authority' ||
        j.expiresAt !== p.expiresAt ||
        releaseProvenanceDigest(j.authority) !== releaseProvenanceDigest(v.originalAuthority) ||
        original.mediaRecoveryJournalAttempt?.stage !== 'completed' ||
        original.mediaRecoveryJournalAttempt.recordSHA256 !== hash(j) ||
        original.mediaRecoveryJournalAttempt.attemptedAt !== j.attemptedAt ||
        completed.prepared?.proofSHA256 !== hash(j) ||
        start?.stage !== 'attempted' ||
        start.operationId !== id ||
        start.planSHA256 !== hash(p) ||
        start.cycleSHA256 !== hash(cycle) ||
        start[computeKey] !== hash(compute) ||
        start.preparedSHA256 !== hash(completed.prepared) ||
        start.expiresAt !== executionWindow.expiresAt ||
        ack.stage !== 'confirmed' ||
        ack.operationId !== id ||
        ack.intentSHA256 !== hash(start) ||
        ack[computeKey] !== hash(compute) ||
        !uuid(ack.runId)
      )
        fail();
      exact(
        ack,
        [
          'ack',
          'confirmedAt',
          'intentSHA256',
          'nativeStartSHA256',
          'operationId',
          computeKey,
          'recordedAt',
          'runId',
          'schemaVersion',
          'stage',
        ]
          .sort()
          .join(',')
      );
      if (
        ack.schemaVersion !== 1 ||
        !['native-start-response', 'unknown-ack-native-get-only'].includes(ack.ack) ||
        !Number.isFinite(Date.parse(ack.confirmedAt)) ||
        !Number.isFinite(Date.parse(ack.recordedAt)) ||
        Date.parse(ack.confirmedAt) < Date.parse(ack.recordedAt) ||
        Date.parse(ack.recordedAt) < Date.parse(start.attemptedAt)
      )
        fail();
      const kernel = facts.Kernel,
        intent = {
          kind: 'canonical-private-media-worker-v1',
          operationId: id,
          planSHA256: hash(p),
          armingSHA256: hash(j),
          ...(jobMode
            ? { jobProviderSHA256: hash(provider), jobIdentity: kernel.context.parent.cloudRunJob }
            : {
                startPlan: completed.start.plan,
                startRequest: completed.start.request,
                startAttemptedAt: completed.start.attemptedAt,
              }),
          control: j.authority.control,
          state: j.authority.state,
          actorUid: facts.Work.actorUid,
        };
      if (kernel.context?.intentSHA256 !== hash(intent) || kernel.context.operationId !== id) fail();
      const originals = await readMediaRecoveryOriginalLineage(o.db, {
        context: kernel.context, plan: p, executionExpiresAt: executionWindow.expiresAt,
      }, tx);
      if (
        hash(originals.ready) !== hash(facts.OriginalReady) ||
        hash(originals.intent) !== hash(facts.ReplacementIntent)
      )
        fail();
      const stamps = snaps.map((s) => ({
        path: s.ref.path,
        data: releaseProvenanceDigest(s.data()),
        created: nativeTime(s.createTime),
        updated: nativeTime(s.updateTime),
      }));
      fresh();
      return {
        facts,
        originals,
        executionWindow,
        start,
        ...(jobMode ? { jobProvider: provider } : { pool: completed.start.pool }),
        plan: p,
        stampsSHA256: retained ? hash({ episode: stamps, retained: retained.stampsSHA256 }) : hash(stamps),
      };
    },
    { readOnly: true }
  );
}
