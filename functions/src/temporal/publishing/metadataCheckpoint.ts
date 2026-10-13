import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { PublishingJobRef, PrivatePublishingIntent } from './types';
import { capturePublishingAllocationSource } from './allocationBarrier';
import { providerPayloadFingerprint } from './providerReceipts';
const changed = (): never => {
  throw Object.assign(
    new Error('The synchronized publication targets changed; start a new edit after reviewing the current publication'),
    { code: 'PUBLISHING_METADATA_DESTINATIONS_CHANGED' }
  );
};
const identity = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const checkpoint = (db: Firestore, ref: PublishingJobRef) =>
  db.doc(`durableJobIntents/${ref.jobId}/publishingCheckpoints/metadata`);
/** Captures actual synchronized identities, including absence, before provider effects. */
export async function preparePublishingMetadataCheckpoint(
  tx: Transaction,
  db: Firestore,
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  sermon: Record<string, unknown>,
  state: 'prepared' | 'completed'
): Promise<() => void> {
  const target = checkpoint(db, ref),
    saved = await tx.get(target),
    source = capturePublishingAllocationSource(sermon);
  const fixed = {
    schemaVersion: 1,
    ...ref,
    sermonId: intent.sermonId,
    generation: intent.generation,
    subsplashId: identity(sermon.subsplashId),
    soundCloudTrackId: identity(sermon.soundCloudTrackId),
    desiredFingerprint: providerPayloadFingerprint(intent.payload.patch ?? {}),
  };
  if (saved.exists) {
    for (const [key, value] of Object.entries(fixed)) if (saved.get(key) !== value) changed();
    if (saved.get('state') === 'completed') return () => {};
    if (saved.get('state') !== 'prepared') changed();
  }
  const record = { ...fixed, state, source };
  return () => {
    if (saved.exists) tx.set(target, record);
    else tx.create(target, record);
  };
}
/** An already bound allocation does not prove this edit synchronized that provider. */
export async function assertPublishingMetadataCheckpoint(
  tx: Transaction,
  db: Firestore,
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  sermon: Record<string, unknown>
): Promise<void> {
  const saved = await tx.get(checkpoint(db, ref));
  if (
    !saved.exists ||
    saved.get('state') !== 'completed' ||
    saved.get('projectId') !== ref.projectId ||
    saved.get('jobId') !== ref.jobId ||
    saved.get('sermonId') !== intent.sermonId ||
    saved.get('generation') !== intent.generation ||
    saved.get('desiredFingerprint') !== providerPayloadFingerprint(intent.payload.patch ?? {}) ||
    saved.get('subsplashId') !== identity(sermon.subsplashId) ||
    saved.get('soundCloudTrackId') !== identity(sermon.soundCloudTrackId) ||
    providerPayloadFingerprint(saved.get('source')) !==
      providerPayloadFingerprint(capturePublishingAllocationSource(sermon))
  )
    changed();
}
