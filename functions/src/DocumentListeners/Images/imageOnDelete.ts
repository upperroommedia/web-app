import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
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
    // Firestore events can be delivered more than once; missing files are already cleaned up.
    await file.delete({ ignoreNotFound: true });

    logger.log(`Deleted storage file at ${storagePath} for image ${imageId}`);
  } catch (error) {
    logger.error(`Failed to delete storage file for image ${imageId}:`, error);
    throw handleError(error);
  }
});

export default imageOnDelete;
