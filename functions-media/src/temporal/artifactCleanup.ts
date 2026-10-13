import { randomUUID } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  MEDIA_ARTIFACTS,
  MEDIA_RETENTION_MS,
  type MediaArtifactRecord,
} from '../../../packages/orchestration/src/media-artifacts';

import { normalizeMediaCleanupInput } from './artifactCleanupInput';
export { normalizeMediaCleanupInput } from './artifactCleanupInput';
export function mediaArtifactProtection(
  record: MediaArtifactRecord,
  options: { projectId: string; now: number; retentionMs: number; hasActiveReference: boolean }
): string | null {
  if (record.projectId !== options.projectId) return 'PROJECT_MISMATCH';
  if (!record.path.startsWith(`workflow-audio/${record.sermonId}/`) || record.path.includes('..'))
    return 'INVALID_ARTIFACT_PATH';
  if (record.status === 'deleted') return 'ALREADY_DELETED';
  if (options.hasActiveReference) return 'ACTIVE_REFERENCE';
  if ((record.backupProtectedUntil ?? 0) > options.now) return 'BACKUP_RESTORE_HOLD';
  const retainedFrom = Math.max(record.createdAt, record.lastReferenceReleasedAt ?? record.createdAt);
  if (!Number.isFinite(retainedFrom) || options.now - retainedFrom < Math.max(MEDIA_RETENTION_MS, options.retentionMs))
    return 'RETENTION_WINDOW';
  if (record.status === 'deleting' && (record.leaseExpiresAt ?? 0) > options.now) return 'DELETION_LEASE';
  return null;
}
interface Options {
  firestore: Firestore;
  bucket: Bucket;
  projectId: string;
  loadIntent: (ref: DurableJobRef) => Promise<{ actorUid: string; payload: Record<string, unknown> }>;
  assertAuthorized: (ref: DurableJobRef) => Promise<void>;
  assertCurrentInTransaction: (transaction: Transaction, ref: DurableJobRef) => Promise<unknown>;
  now?: () => number;
}
export function createMediaArtifactCleanupActivities(options: Options) {
  const { firestore: db, bucket, projectId } = options;
  const now = options.now ?? Date.now;
  return {
    loadMediaCleanupPlan: async (ref: DurableJobRef) => {
      if (ref.projectId !== projectId) throw new Error('Media cleanup project mismatch.');
      await options.assertAuthorized(ref);
      const input = normalizeMediaCleanupInput((await options.loadIntent(ref)).payload);
      return { maxPages: input.maxPages };
    },
    cleanupMediaArtifactPage: async (ref: DurableJobRef, cursor?: string) => {
      if (ref.projectId !== projectId || (cursor && !/^[a-f0-9]{64}$/.test(cursor)))
        throw new Error('Invalid media cleanup reference.');
      await options.assertAuthorized(ref);
      const input = normalizeMediaCleanupInput((await options.loadIntent(ref)).payload);
      const policy = (await db.doc('_control/temporalMediaRetention').get()).data();
      if (policy && policy.projectId !== projectId) throw new Error('Media retention policy project mismatch.');
      if (policy?.hold === true || Number(policy?.restoreProtectedUntil ?? 0) > now())
        throw new Error('Media cleanup is paused for backup restoration.');
      const backupDays = policy?.backupRestoreWindowDays ?? 90;
      if (!Number.isInteger(backupDays) || backupDays < 90 || backupDays > 3650)
        throw new Error('Invalid backup restore window.');
      const retentionMs = Math.max(input.retentionDays, backupDays) * 24 * 60 * 60 * 1000;
      let query = db
        .collection(MEDIA_ARTIFACTS)
        .where('status', 'in', ['uploading', 'retained', 'deleting'])
        .where('eligibleAfter', '<=', now())
        .orderBy('eligibleAfter')
        .orderBy(FieldPath.documentId())
        .limit(25);
      if (cursor) {
        const after = await db
          .collection('temporalMediaRetentionAudits')
          .doc(ref.jobId)
          .collection('checkpoints')
          .doc(cursor)
          .get();
        if (!after.exists || after.get('projectId') !== projectId)
          throw new Error('Cleanup checkpoint is unavailable.');
        query = query.startAfter(after.get('eligibleAfter'), cursor);
      }
      const page = await query.get();
      const summary = {
        scanned: page.size,
        eligible: 0,
        deleted: 0,
        protected: 0,
        dryRun: input.dryRun,
        ...(page.size === 25 ? { nextCursor: page.docs[page.docs.length - 1].id } : {}),
      };
      if (summary.nextCursor)
        await db
          .collection('temporalMediaRetentionAudits')
          .doc(ref.jobId)
          .collection('checkpoints')
          .doc(summary.nextCursor)
          .set({
            projectId,
            eligibleAfter: page.docs[page.docs.length - 1].get('eligibleAfter'),
            createdAt: now(),
          });
      const owner = `${ref.jobId}:${randomUUID()}`;
      const evidence: Array<{ artifactId: string; outcome: string }> = [];
      const context = Context.current();
      const timer = setInterval(
        () => context.heartbeat({ jobId: ref.jobId, scanned: summary.scanned, deleted: summary.deleted }),
        10_000
      );
      timer.unref();
      try {
        for (const candidate of page.docs) {
          context.cancellationSignal.throwIfAborted();
          context.heartbeat({ jobId: ref.jobId, artifactId: candidate.id });
          const claimed = await db.runTransaction(async (transaction) => {
            await options.assertCurrentInTransaction(transaction, ref);
            const snapshot = await transaction.get(candidate.ref);
            const active = await transaction.get(
              candidate.ref.collection('references').where('state', '==', 'active').limit(1)
            );
            const record = snapshot.data() as MediaArtifactRecord;
            if (!record) return { record, protectedBy: 'ALREADY_REMOVED' };
            const protectedBy = mediaArtifactProtection(record, {
              projectId,
              now: now(),
              retentionMs,
              hasActiveReference: !active.empty,
            });
            if (protectedBy) return { record, protectedBy };
            if (!input.dryRun)
              transaction.update(candidate.ref, {
                status: 'deleting',
                leaseOwner: owner,
                leaseExpiresAt: now() + 20 * 60_000,
              });
            return { record, protectedBy: null };
          });
          if (claimed.protectedBy) {
            summary.protected++;
            evidence.push({ artifactId: candidate.id, outcome: claimed.protectedBy });
            continue;
          }
          summary.eligible++;
          if (input.dryRun) {
            evidence.push({ artifactId: candidate.id, outcome: 'WOULD_DELETE' });
            continue;
          }
          let generation = claimed.record.generation;
          try {
            const file = bucket.file(claimed.record.path, generation ? { generation } : undefined);
            if (!generation) {
              const [metadata] = await file.getMetadata();
              if (!claimed.record.ownerJobId || metadata.metadata?.jobId !== claimed.record.ownerJobId)
                throw Object.assign(new Error('Artifact generation requires review'), { code: 'GENERATION_UNKNOWN' });
              generation = String(metadata.generation);
            }
            await file.delete({ ifGenerationMatch: generation!, ignoreNotFound: true });
            await db.runTransaction(async (transaction) => {
              const current = await transaction.get(candidate.ref);
              if (current.get('leaseOwner') !== owner) throw new Error('Artifact cleanup lease changed.');
              transaction.update(candidate.ref, {
                status: 'deleted',
                generation,
                deletedAt: now(),
                deletionJobId: ref.jobId,
                leaseExpiresAt: 0,
              });
              transaction.set(
                db.collection('temporalMediaRetentionAudits').doc(ref.jobId).collection('artifacts').doc(candidate.id),
                {
                  projectId,
                  artifactId: candidate.id,
                  generation,
                  outcome: 'DELETED',
                  deletedAt: now(),
                }
              );
            });
            summary.deleted++;
            evidence.push({ artifactId: candidate.id, outcome: 'DELETED' });
          } catch (error) {
            const code = String((error as { code?: unknown }).code ?? 'UNKNOWN');
            if (code === '404') {
              await db.runTransaction(async (transaction) => {
                const current = await transaction.get(candidate.ref);
                if (current.get('leaseOwner') !== owner) throw new Error('Artifact cleanup lease changed.');
                transaction.update(candidate.ref, {
                  status: 'deleted',
                  deletedAt: now(),
                  deletionJobId: ref.jobId,
                  leaseExpiresAt: 0,
                });
              });
              summary.deleted++;
              evidence.push({ artifactId: candidate.id, outcome: 'ALREADY_ABSENT' });
            } else {
              const reason =
                code === '412' ? 'GENERATION_CHANGED' : code === 'GENERATION_UNKNOWN' ? code : 'DELETE_NOT_CONFIRMED';
              await db.runTransaction(async (transaction) => {
                const current = await transaction.get(candidate.ref);
                if (current.get('leaseOwner') !== owner) throw new Error('Artifact cleanup lease changed.');
                transaction.update(candidate.ref, {
                  status: 'retained',
                  eligibleAfter: Number.MAX_SAFE_INTEGER,
                  cleanupAttention: reason,
                  leaseExpiresAt: 0,
                });
              });
              summary.protected++;
              evidence.push({ artifactId: candidate.id, outcome: reason });
            }
          }
        }
        await db
          .collection('temporalMediaRetentionAudits')
          .doc(ref.jobId)
          .collection('pages')
          .doc(cursor ?? 'first')
          .set({
            projectId,
            ...summary,
            retentionDays: Math.max(input.retentionDays, backupDays),
            evidence,
            completedAt: now(),
          });
        return summary;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
