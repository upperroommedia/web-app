import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { ImageType } from '../../../types/Image';
import computeMetadataForImage from '../computeMetadataForImage';
import { firestoreAdminImagesConverter } from '../firestoreDataConverter';

export const updateImageMetadata = onRequest({ timeoutSeconds: 300, memory: '2GiB' }, async (_req, res) => {
  const limit = (await import('p-limit')).default;
  const limiter = limit(10); // Only 10 at a time
  const firestore = firebaseAdmin.firestore();
  logger.log('Starting to update image metadata...');
  const imagesCollection = firestore.collection('images').withConverter(firestoreAdminImagesConverter);

  // Query 1: averageColorHex does not exist
  const missingColorQuery = imagesCollection.where('averageColorHex', '==', null);

  // Query 2: averageColorHex is '#9fccb9'
  const whiteColorQuery = imagesCollection.where('averageColorHex', '==', '#9fccb9');

  // Fetch both sets
  const [missingColorSnapshot, whiteColorSnapshot] = await Promise.all([
    missingColorQuery.get(),
    whiteColorQuery.get(),
  ]);

  // Merge results
  const imageDocs = [...missingColorSnapshot.docs, ...whiteColorSnapshot.docs];
  logger.log(`Found ${imageDocs.length} images to update metadata for.`);
  let batch = firestore.batch();
  let count = 0;
  await Promise.all(
    imageDocs.map((doc) =>
      limiter(async () => {
        const image = doc.data();
        if (!image || !image.downloadLink) {
          logger.warn(`Skipping image ${image.name}: ${doc.id} due to missing downloadLink or image data.`);
          return;
        }
        try {
          const metadata = await computeMetadataForImage(image.downloadLink);
          const ImageMetadata: Pick<ImageType, 'width' | 'height' | 'averageColorHex' | 'vibrantColorHex'> = {
            width: metadata.width,
            height: metadata.height,
            averageColorHex: metadata.averageColorHex,
            vibrantColorHex: metadata.vibrantColorHex,
          };
          batch.update(doc.ref, ImageMetadata);
          count++;
          if (count % 500 === 0) {
            logger.log(`Committing batch of updates...`);
            await batch.commit();
            batch = firestore.batch(); // Reset the batch after committing
          }
          logger.log(`Updated metadata for ${image.name} image ${doc.id}:`, metadata);
        } catch (error) {
          logger.error(`Failed to compute metadata for image ${doc.id}:`, error);
        }
      })
    )
  );
  batch.commit(); // Commit any remaining updates
  res.status(200).send(`Updated metadata for ${count} images successfully.`);
  logger.log(`Finished updating metadata for ${count} images.`);
});
