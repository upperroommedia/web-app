import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import { assertLegacyAdmissionAllowed } from '../../temporal/releaseControl';
import { enqueueSystemImage } from '../../temporal/images/admission';
import { firestoreAdminImagesConverter } from '../../firestoreDataConverter';
import { getFirebaseImagesBucket } from '@upperroom/shared/shared/firebaseProjectConfig';
import { extractStoragePathFromDownloadUrl } from '@upperroom/shared/shared/firebaseStorageUrls';

const imagesBucket = getFirebaseImagesBucket();

const imageOnDelete = onDocumentDeleted('images/{imageId}', async (event) => {
  const { imageId } = event.params;
  const snapshot = event.data;

  if (!snapshot) {
    logger.warn(`No snapshot data found for deleted image ${imageId}`);
    return;
  }

  try {
    const image = firestoreAdminImagesConverter.fromFirestore(snapshot);
    const storagePath = extractStoragePathFromDownloadUrl(image.downloadLink, imagesBucket);
    if (!storagePath) {
      logger.warn(`No storage path found for image ${imageId}: ${image.downloadLink}`);
      return;
    }
    const bucket = firebaseAdmin.storage().bucket(imagesBucket);
    const file = bucket.file(storagePath);
    if (process.env.TASK_ORCHESTRATOR_IMAGES === 'temporal') {
      // Durable deletion already removed these destinations before deleting the document.
      const saved = snapshot.data();
      if (saved?.durableJobId && !(await file.exists())[0]) return;
      if (!saved?.source?.generation) throw new Error('Legacy image source generation must be reconciled before durable cleanup');
      await enqueueSystemImage({firestore: firebaseAdmin.firestore(), projectId: firebaseAdmin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? '', eventId: event.id,
        intent: {operation: 'delete', imageId, name: image.name, type: image.type,
          source: {bucket: imagesBucket, path: storagePath, generation: String(saved.source.generation), contentType: String(saved.source.contentType)},
          ...(image.subsplashId ? {remoteId: image.subsplashId} : {})}});
      return;
    }
    await assertLegacyAdmissionAllowed(firebaseAdmin.firestore(), 'images', {continuation: true});
    // Firestore events can be delivered more than once; missing files are already cleaned up.
    await file.delete({ ignoreNotFound: true });

    logger.log(`Deleted storage file at ${storagePath} for image ${imageId}`);
  } catch (error) {
    logger.error(`Failed to delete storage file for image ${imageId}:`, error);
    throw handleError(error);
  }
});

export default imageOnDelete;
