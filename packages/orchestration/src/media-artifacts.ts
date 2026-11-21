import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

export const MEDIA_ARTIFACTS = 'temporalMediaArtifacts';
export const MEDIA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export interface MediaArtifactRecord {
  ownerJobId?: string;
  projectId: string;
  sermonId: string;
  path: string;
  generation: string | null;
  createdAt: number;
  lastReferenceReleasedAt?: number;
  eligibleAfter: number;
  status: 'uploading' | 'retained' | 'deleting' | 'deleted';
  leaseOwner?: string;
  leaseExpiresAt?: number;
  backupProtectedUntil?: number;
}
export const mediaArtifactId = (projectId: string, path: string) =>
  createHash('sha256')
    .update(JSON.stringify([projectId, path]))
    .digest('hex');
export const mediaReferenceId = (type: string, id: string, slot = '') =>
  createHash('sha256')
    .update(JSON.stringify([type, id, slot]))
    .digest('hex');

/** The finite worker obtains this binding from its authenticated release plan. */
export interface MediaRecoveryArtifactRegistry {
  readonly operationId: string;
  readonly releaseId: string;
  readonly bucketName: string;
}

const recoveryUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function assertMediaArtifactBucket(
  projectId: string,
  bucketName: string,
  registry?: MediaRecoveryArtifactRegistry
) {
  if (registry === undefined) {
    if (bucketName?.startsWith('urm-app-staging-mr-')) throw new Error('Private media artifact registry required.');
    return;
  }
  if (
    !registry ||
    projectId !== 'urm-app-staging' ||
    !recoveryUuid.test(registry.releaseId) ||
    !recoveryUuid.test(registry.operationId) ||
    registry.operationId === registry.releaseId ||
    bucketName !== registry.bucketName ||
    bucketName !== 'urm-app-staging-mr-' + registry.releaseId.replaceAll('-', '')
  )
    throw new Error('Invalid private media artifact registry.');
}

export function isRecoveryArtifactPath(
  registry: MediaRecoveryArtifactRegistry,
  requestVersion: string,
  path: string,
  stage: 'source' | 'processed'
) {
  const prefix = 'workflow-audio/media-recovery-' + registry.operationId + '/' + requestVersion + '/' + stage + '-';
  const suffix = stage === 'source' ? '.wav' : '.mp3';
  return (
    /^[a-f0-9]{16}$/.test(requestVersion) &&
    path.startsWith(prefix) &&
    path.endsWith(suffix) &&
    recoveryUuid.test(path.slice(prefix.length, -suffix.length))
  );
}

export function mediaRecoveryArtifactRecord(
  firestore: Firestore,
  registry: MediaRecoveryArtifactRegistry,
  path: string
) {
  return firestore
    .doc('_control/temporalMediaRecoveryArtifacts-' + registry.operationId)
    .collection('artifacts')
    .doc(mediaArtifactId('urm-app-staging', path));
}

type UploadIntent = { projectId: string; sermonId: string; jobId: string; path: string; createdAt: number };

/** Historical callers receive the same artifact ID and use the ordinary registry. */
export function writeMediaUploadIntent(transaction: Transaction, firestore: Firestore, input: UploadIntent) {
  return createMediaUploadRecord(transaction, firestore, input).id;
}

/** Register before upload. Later retain/delete receipts use this exact reference. */
export function createMediaUploadRecord(
  transaction: Transaction,
  firestore: Firestore,
  input: UploadIntent,
  recovery?: { registry: MediaRecoveryArtifactRegistry; requestVersion: string; bucketName: string }
) {
  const id = mediaArtifactId(input.projectId, input.path);
  const registry = recovery?.registry;
  if (recovery) {
    assertMediaArtifactBucket(input.projectId, recovery.bucketName, recovery.registry);
    if (
      input.jobId !== 'media-recovery-' + recovery.registry.operationId ||
      input.sermonId !== input.jobId ||
      !(['source', 'processed'] as const).some((stage) =>
        isRecoveryArtifactPath(recovery.registry, recovery.requestVersion, input.path, stage)
      )
    )
      throw new Error('Private media artifact path is outside the admitted job.');
  }
  const artifact = registry
    ? mediaRecoveryArtifactRecord(firestore, registry, input.path)
    : firestore.collection(MEDIA_ARTIFACTS).doc(id);
  const jobs = registry
    ? firestore.doc('_control/temporalMediaRecoveryArtifacts-' + registry.operationId).collection('jobs')
    : firestore.collection('temporalMediaJobArtifacts');
  const jobIndex = jobs.doc(input.jobId).collection('artifacts').doc(id);
  const custody = registry
    ? { operationId: registry.operationId, releaseId: registry.releaseId, bucketName: registry.bucketName }
    : {};
  transaction.create(artifact, {
    ...custody,
    projectId: input.projectId,
    sermonId: input.sermonId,
    path: input.path,
    ownerJobId: input.jobId,
    generation: null,
    status: 'uploading',
    createdAt: input.createdAt,
    eligibleAfter: input.createdAt + MEDIA_RETENTION_MS,
  });
  transaction.create(artifact.collection('references').doc(mediaReferenceId('media_job', input.jobId)), {
    ...custody,
    projectId: input.projectId,
    type: 'media_job',
    jobId: input.jobId,
    state: 'active',
    createdAt: input.createdAt,
  });
  transaction.set(jobIndex, { ...custody, artifactId: id });
  return artifact;
}

/** Preparation performs reads only; caller executes all returned writes after completing every read. */
export async function prepareMediaReference(
  transaction: Transaction,
  firestore: Firestore,
  input: {
    artifactId: string;
    projectId: string;
    type: 'media_job' | 'canonical' | 'publishing_job' | 'backup';
    expectedObject?: { path: string; generation: string; ownerJobId?: string };
    id: string;
    slot?: string;
    createdAt: number;
  }
) {
  const artifact = firestore.collection(MEDIA_ARTIFACTS).doc(input.artifactId);
  const snapshot = await transaction.get(artifact);
  const record = snapshot.data() as MediaArtifactRecord | undefined;
  if (!record || record.projectId !== input.projectId || ['deleting', 'deleted'].includes(record.status))
    throw new Error('Media artifact reference is unavailable.');
  if (
    input.expectedObject &&
    (record.status !== 'retained' ||
      record.path !== input.expectedObject.path ||
      record.generation !== input.expectedObject.generation ||
      (input.expectedObject.ownerJobId !== undefined && record.ownerJobId !== input.expectedObject.ownerJobId))
  )
    throw new Error('Retained media source generation changed.');
  return () => {
    transaction.set(artifact.collection('references').doc(mediaReferenceId(input.type, input.id, input.slot)), {
      projectId: input.projectId,
      type: input.type,
      jobId: input.id,
      slot: input.slot ?? '',
      state: 'active',
      createdAt: input.createdAt,
    });
    if (input.type === 'media_job')
      transaction.set(
        firestore.collection('temporalMediaJobArtifacts').doc(input.id).collection('artifacts').doc(input.artifactId),
        { artifactId: input.artifactId }
      );
  };
}

export async function prepareMediaReferenceRelease(
  transaction: Transaction,
  firestore: Firestore,
  input: { artifactId: string; projectId: string; type: string; id: string; slot?: string; releasedAt: number }
) {
  const artifact = firestore.collection(MEDIA_ARTIFACTS).doc(input.artifactId);
  const snapshot = await transaction.get(artifact);
  if (!snapshot.exists || snapshot.get('projectId') !== input.projectId) return () => {};
  return () => {
    transaction.set(artifact.collection('references').doc(mediaReferenceId(input.type, input.id, input.slot)), {
      projectId: input.projectId,
      type: input.type,
      jobId: input.id,
      slot: input.slot ?? '',
      state: 'released',
      releasedAt: input.releasedAt,
    });
    // Retain for the backup restoration window after the LAST reference was released, not just creation.
    transaction.update(artifact, {
      lastReferenceReleasedAt: input.releasedAt,
      eligibleAfter: input.releasedAt + MEDIA_RETENTION_MS,
    });
  };
}

export async function releaseMediaJobArtifacts(firestore: Firestore, input: { projectId: string; jobId: string }) {
  const refs = await firestore
    .collection('temporalMediaJobArtifacts')
    .doc(input.jobId)
    .collection('artifacts')
    .limit(101)
    .get();
  if (refs.size > 100) throw new Error('Media artifact count requires review.');
  await firestore.runTransaction(async (transaction) => {
    const writes = await Promise.all(
      refs.docs.map((reference) =>
        prepareMediaReferenceRelease(transaction, firestore, {
          artifactId: reference.id,
          projectId: input.projectId,
          type: 'media_job',
          id: input.jobId,
          releasedAt: Date.now(),
        })
      )
    );
    writes.forEach((write) => write());
  });
}
