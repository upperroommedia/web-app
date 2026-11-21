import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableMediaRecoveryJobIdentity } from '@upperroom/orchestration/job-store';
import { releaseProvenanceDigest as hash } from './release-provenance';
import {
  matchesMediaRecoveryTaskAttestationEnv,
  mediaRecoveryTaskAttestationKey,
  verifyMediaRecoveryTaskAttestation,
} from './media-recovery-task-attestation';

type Binding = { operationId: string; buildId: string; runner: string; image: string; job: string; execution: string };
type Metadata = { projectId: string; projectNumber: string; serviceAccount: string; instanceId: string };
function deny(): never {
  throw new Error('MEDIA_RECOVERY_TASK_ATTESTATION_UNCONFIRMED');
}
type CertificateProof = { digest: string; seconds: number; nanoseconds: number };
const observedCertificates = new WeakMap<DurableMediaRecoveryJobIdentity, CertificateProof>();
export const observedTaskAttestation = (identity: DurableMediaRecoveryJobIdentity) =>
  observedCertificates.get(identity);

export const mediaRecoveryTaskAttestationPath = (op: string) => '_control/temporalMediaRecoveryTaskAttestation-' + op;

export function joinMediaRecoveryTaskAttestation(
  trustedKey: string,
  binding: Binding,
  metadata: Metadata,
  op: DocumentSnapshot,
  arming: DocumentSnapshot,
  certificate: DocumentSnapshot,
  now: number
) {
  const plan = op.get('cloudMediaRecovery.plan'),
    native = op.get('mediaRecoveryJobProvider');
  const pointer = op.get('mediaRecoveryTaskAttestation'),
    journal = arming.data();
  const run = native?.runIdentity;
  if (
    op.ref.path !== '_control/temporalReleaseOperation' ||
    !op.exists ||
    op.get('action') !== 'diagnose-cloud-run-media-recovery' ||
    op.get('operationId') !== binding.operationId ||
    op.get('cloudMediaRecovery.stage') !== 'prepared' ||
    op.get('cloudMediaRecovery.stop') ||
    op.get('cloudMediaRecovery.recoveryFailed') ||
    op.get('cloudMediaRecovery.drained') ||
    plan?.role !== 'media' ||
    plan.operationId !== binding.operationId ||
    plan.buildId !== binding.buildId ||
    plan.runner !== binding.runner ||
    plan.image !== binding.image ||
    plan.job?.name !== binding.job ||
    plan.bindingDigest !== op.get('bindingDigest') ||
    plan.releaseId !== op.get('releaseId') ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    plan.expiresAt !== Date.parse(plan.createdAt) + 300000 ||
    now < Date.parse(plan.createdAt) ||
    now >= plan.expiresAt ||
    !matchesMediaRecoveryTaskAttestationEnv(plan.job.template?.template?.containers?.[0]?.env, trustedKey) ||
    arming.ref.path !== '_control/temporalMediaRecoveryJournal-' + binding.operationId ||
    !arming.exists ||
    journal?.operationId !== binding.operationId ||
    journal.scope !== 'arming-only-no-execution-authority' ||
    journal.planSHA256 !== hash(plan) ||
    journal.bindingDigest !== plan.bindingDigest ||
    journal.releaseId !== plan.releaseId ||
    op.get('mediaRecoveryJournalAttempt.stage') !== 'completed' ||
    op.get('mediaRecoveryJournalAttempt.recordSHA256') !== hash(journal) ||
    op.get('cloudMediaRecovery.prepared.proofSHA256') !== hash(journal) ||
    native?.create?.stage !== 'acknowledged' ||
    !['attempted', 'acknowledged'].includes(native.run?.stage) ||
    metadata.projectId !== 'urm-app-staging' ||
    metadata.projectNumber !== '251680231116' ||
    metadata.serviceAccount !== binding.runner ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(metadata.instanceId) ||
    certificate.ref.path !== mediaRecoveryTaskAttestationPath(binding.operationId)
  )
    return deny();
  // A Job can be executing before its RUN ACK and attestation become visible.
  if (!certificate.exists && pointer === undefined) {
    if (op.get('mediaRecoveryWorkflowStart') !== undefined) return deny();
    return undefined;
  }
  const record = certificate.data();
  if (
    !certificate.exists ||
    !certificate.createTime ||
    !certificate.updateTime ||
    !certificate.createTime.isEqual(certificate.updateTime) ||
    hash(pointer) !== hash({ certificateSHA256: hash(record) })
  )
    return deny();
  const p = verifyMediaRecoveryTaskAttestation(record, trustedKey);
  if (
    p.operationId !== binding.operationId ||
    p.releaseId !== plan.releaseId ||
    p.bindingDigest !== plan.bindingDigest ||
    p.buildId !== binding.buildId ||
    p.image !== binding.image ||
    p.runner !== binding.runner ||
    p.job !== binding.job ||
    p.execution !== binding.execution ||
    p.planSHA256 !== hash(plan) ||
    p.jobPlanSHA256 !== hash(plan.job) ||
    p.armingSHA256 !== hash(journal) ||
    p.authoritySHA256 !== hash(journal.authority) ||
    p.expiresAt !== plan.expiresAt ||
    Date.parse(p.issuedAt) > now ||
    native.jobPlanSHA256 !== p.jobPlanSHA256 ||
    native.create.operation !== p.createOperation ||
    native.run.stage !== 'acknowledged' ||
    native.run.operation !== p.runOperation ||
    native.run.intentSHA256 !== p.runIntentSHA256 ||
    run?.stage !== 'acknowledged' ||
    run.operation !== p.runOperation ||
    run.intentSHA256 !== p.runIntentSHA256 ||
    run.jobPlanSHA256 !== p.jobPlanSHA256 ||
    run.jobUid !== p.jobUid ||
    run.execution !== p.execution ||
    run.executionUid !== p.executionUid ||
    run.attemptedAt !== native.run.attemptedAt ||
    !Number.isFinite(Date.parse(run.attemptedAt)) ||
    Date.parse(run.attemptedAt) < Date.parse(plan.createdAt) ||
    Date.parse(run.attemptedAt) > Date.parse(p.taskCreateTime)
  )
    return deny();
  const identity: DurableMediaRecoveryJobIdentity = {
    projectId: 'urm-app-staging',
    region: 'us-central1',
    job: p.job,
    execution: p.execution,
    executionUid: p.executionUid,
    task: p.task,
    taskCreateTime: p.taskCreateTime,
    ...(p.taskUid !== null && { taskUid: p.taskUid }),
    serviceAccount: p.runner,
    imageDigest: p.image.split('@')[1],
    instanceId: metadata.instanceId,
  };
  const proof = {
    digest: hash(record),
    seconds: certificate.createTime.seconds,
    nanoseconds: certificate.createTime.nanoseconds,
  };
  return { identity, proof };
}

export async function recheckMediaRecoveryTaskAttestation(
  db: Firestore,
  tx: Transaction,
  operationId: string,
  identity: DurableMediaRecoveryJobIdentity,
  plan: any,
  pointer: unknown,
  env: NodeJS.ProcessEnv = process.env
) {
  const key = mediaRecoveryTaskAttestationKey(env),
    entries = plan?.job?.template?.template?.containers?.[0]?.env;
  if (!key) {
    if (
      pointer !== undefined ||
      entries?.some(
        (entry: { name?: string }) =>
          entry.name === 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_MODE' ||
          entry.name === 'TEMPORAL_MEDIA_RECOVERY_ATTESTATION_KEY'
      )
    )
      return deny();
    return;
  }
  if (!matchesMediaRecoveryTaskAttestationEnv(entries, key)) return deny();
  const proof = observedCertificates.get(identity);
  if (!proof || hash(pointer) !== hash({ certificateSHA256: proof.digest })) return deny();
  const cert = await tx.get(db.doc(mediaRecoveryTaskAttestationPath(operationId)));
  if (
    !cert.exists ||
    !cert.createTime ||
    !cert.updateTime ||
    !cert.createTime.isEqual(cert.updateTime) ||
    cert.createTime.seconds !== proof.seconds ||
    cert.createTime.nanoseconds !== proof.nanoseconds ||
    hash(cert.data()) !== proof.digest
  )
    return deny();
}

/** The worker gets the key from its native template. Firestore supplies only the signed message. */
export async function awaitMediaRecoveryTaskAttestation(
  db: Firestore,
  key: string,
  binding: Binding,
  metadata: Metadata
) {
  if (!('projectId' in db) || db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)') return deny();
  const refs = [
    '_control/temporalReleaseOperation',
    '_control/temporalMediaRecoveryJournal-' + binding.operationId,
    mediaRecoveryTaskAttestationPath(binding.operationId),
  ].map((path) => db.doc(path));
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_TASK_ATTESTATION_UNCONFIRMED')), 25000);
  });
  try {
    for (;;) {
      const result = await Promise.race([
        deadline,
        db.runTransaction(
          async (tx: Transaction) => {
            const [op, journal, certificate] = await tx.getAll(...refs);
            return joinMediaRecoveryTaskAttestation(key, binding, metadata, op, journal, certificate, Date.now());
          },
          { readOnly: true }
        ),
      ]);
      if (performance.now() - started >= 25000) return deny();
      if (result) {
        observedCertificates.set(result.identity, result.proof);
        return result.identity;
      }
      await Promise.race([deadline, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
  } finally {
    clearTimeout(timer);
  }
}
