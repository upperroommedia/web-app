import type { DurableAdmissionReceipt } from '@upperroom/contracts/temporal';
import { submitDurableIntent } from './durableJobs';

export interface DeleteSermonWithExternalCleanupInput {
  sermonId: string;
  seriesId?: string;
  subsplashId?: string;
  soundCloudTrackId?: string;
}

/** The server resolves all remote references and cleans up after durable admission. */
export async function deleteSermonWithExternalCleanup({
  sermonId,
}: DeleteSermonWithExternalCleanupInput): Promise<DurableAdmissionReceipt> {
  if (!sermonId.trim()) throw new Error('Missing sermon id');
  return submitDurableIntent({ kind: 'sermon.delete', entity: { type: 'sermon', id: sermonId }, payload: {} });
}
