import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { ensureProviderOrphanReview } from './orphanReview';
/** Immutable ACK creation is independent of the original workflow's terminal status. */
export const providerAcknowledgementCreated = onDocumentCreated(
  { document: 'temporalProviderAcknowledgements/{acknowledgementId}', retry: true },
  async (event) => {
    const fact = event.data?.data();
    if (!fact || fact.disposition !== 'orphaned') return;
    const projectId = firebaseAdmin.app().options.projectId ?? process.env.GCLOUD_PROJECT;
    if (!projectId || fact.projectId !== projectId || typeof fact.jobId !== 'string')
      throw new Error('Provider acknowledgement project identity is invalid');
    await ensureProviderOrphanReview(
      firebaseAdmin.firestore(),
      { projectId, jobId: fact.jobId },
      event.params.acknowledgementId
    );
  }
);
