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

/** Register before upload so even an upload/receipt acknowledgement failure remains discoverable. */
export function writeMediaUploadIntent(
  transaction: Transaction,
  firestore: Firestore,
  input: { projectId: string; sermonId: string; jobId: string; path: string; createdAt: number }
) {
  const id = mediaArtifactId(input.projectId, input.path);
  const artifact = firestore.collection(MEDIA_ARTIFACTS).doc(id);
  transaction.create(artifact, {
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
    projectId: input.projectId,
    type: 'media_job',
    jobId: input.jobId,
    state: 'active',
    createdAt: input.createdAt,
  });
  transaction.set(firestore.collection('temporalMediaJobArtifacts').doc(input.jobId).collection('artifacts').doc(id), {
    artifactId: id,
  });
  return id;
}

/** Preparation performs reads only; caller executes all returned writes after completing every read. */
export async function prepareMediaReference(
  transaction: Transaction,
  firestore: Firestore,
  input: {
    artifactId: string;
    projectId: string;
    type: 'media_job' | 'canonical' | 'publishing_job' | 'backup';
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
