import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminImagesConverter } from '../../firestoreDataConverter';

const imageOnDelete = onDocumentDeleted('images/{imageId}', async (event) => {
  const { imageId } = event.params;
  const snapshot = event.data;

  if (!snapshot) {
    logger.warn(`No snapshot data found for deleted image ${imageId}`);
    return;
  }

  try {
    const image = firestoreAdminImagesConverter.fromFirestore(snapshot);
    if (!image.downloadLink.includes('urm-app-images')) {
      logger.warn(`Image ${imageId} does not have a valid download link for deletion: ${image.downloadLink}`);
      return;
    }
    const storagePath = decodeURIComponent(image.downloadLink).split('urm-app-images/').pop();
    if (!storagePath) {
      logger.warn(`No storage path found for image ${imageId}`);
      return;
    }
    const bucket = firebaseAdmin.storage().bucket('urm-app-images');
    const file = bucket.file(storagePath);
    await file.delete();

    logger.log(`Deleted storage file at ${storagePath} for image ${imageId}`);
  } catch (error) {
    logger.error(`Failed to delete storage file for image ${imageId}:`, error);
    throw handleError(error);
  }
});

export default imageOnDelete;
