import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { ensureImageAcknowledgementReview } from './activities';
/** Retries survive a paused/importing release; the immutable fact never depends on admission. */
export const imageAcknowledgementCreated = onDocumentCreated(
  { document: 'temporalImageAllocationAcknowledgements/{acknowledgementId}', retry: true },
  async (event) => {
    const fact = event.data?.data();
    if (!fact || fact.disposition !== 'additional_original_allocation') return;
    const projectId = firebaseAdmin.app().options.projectId ?? process.env.GCLOUD_PROJECT;
    if (!projectId || fact.projectId !== projectId || typeof fact.jobId !== 'string')
      throw new Error('Image acknowledgement project identity is invalid');
    await ensureImageAcknowledgementReview(
      firebaseAdmin.firestore(),
      { projectId, jobId: fact.jobId },
      event.params.acknowledgementId
    );
  }
);
