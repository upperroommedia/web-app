import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

/** No expiry: an unacknowledged Auth RPC can still complete after an Activity timeout. */
export const accountClaimsResourceRef = (projectId: string, uid: string) =>
  firebaseAdmin
    .firestore()
    .collection('_durableAccountClaimResources')
    .doc(createHash('sha256').update(`${projectId}:${uid}`).digest('hex'));
export async function assertAccountClaimsResourceAvailable(
  tx: Transaction,
  projectId: string,
  uid: string,
  jobId: string
): Promise<void> {
  const resource = (await tx.get(accountClaimsResourceRef(projectId, uid))).data();
  if (
    (resource?.state === 'started' || ['pending', 'started'].includes(resource?.sessionState)) &&
    resource?.jobId !== jobId
  )
    throw new HttpsError(
      'failed-precondition',
      'An earlier account change requires reconciliation before another role change.'
    );
}
