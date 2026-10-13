import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { ProviderReceipt } from './providerReceipts';
const remoteId = (receipt: ProviderReceipt): string => {
  const result =
    receipt.result && typeof receipt.result === 'object' ? (receipt.result as Record<string, unknown>) : {};
  const id =
    typeof receipt.result === 'string'
      ? receipt.result
      : result.id ?? result.listId ?? result.tagId ?? result.soundCloudTrackId ?? result.trackIdentifier;
  return typeof id === 'string' ? id : '';
};
export const PUBLISHING_CANCELLATION_RECEIPTS = 'temporalPublishingCancellationReceipts';
/** A fenced terminal GET was observed before the job resource was deleted. */
export async function verifyPublishingCancellationFetchSettled(
  ref: DurableJobRef,
  receiptId: string,
  receipt: ProviderReceipt
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) return false;
  const checkpoint = await firebaseAdmin
    .firestore()
    .collection(PUBLISHING_CANCELLATION_RECEIPTS)
    .doc(`${ref.jobId}-${receiptId}`)
    .get();
  return (
    checkpoint.get('projectId') === ref.projectId &&
    checkpoint.get('jobId') === ref.jobId &&
    checkpoint.get('receiptId') === receiptId &&
    checkpoint.get('fetchSettled') === true &&
    checkpoint.get('remoteId') === remoteId(receipt) &&
    checkpoint.get('providerReceiptFingerprint') === receipt.fingerprint &&
    checkpoint.get('receiptRevision') === (receipt.revision ?? 0) &&
    ['deleted', 'retained'].includes(checkpoint.get('state'))
  );
}
