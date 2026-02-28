import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { authenticateSubsplash } from '../../subsplashUtils';
import { deriveSeriesMetadata, patchSeriesMetadata } from '../../helpers/seriesHelpers';
import handleError from '../../handleError';

const firestore = firebaseAdmin.firestore();

const seriesItemOnWrite = onDocumentWritten('series/{seriesId}/seriesItems/{itemId}', async (event) => {
  const { seriesId } = event.params;

  try {
    const seriesRef = firestore.collection('series').doc(seriesId);
    const seriesSnapshot = await seriesRef.get();
    if (!seriesSnapshot.exists) {
      logger.warn(`seriesItemOnWrite: series/${seriesId} not found, skipping metadata recalculation.`);
      return;
    }
    const seriesData = seriesSnapshot.data() as { subsplashId?: string; subtitle?: string } | undefined;

    const itemsSnapshot = await firestore.collection(`series/${seriesId}/seriesItems`).get();
    const metadata = deriveSeriesMetadata(
      itemsSnapshot.docs.map((itemDoc) => {
        const data = itemDoc.data() as { publishedToSubsplash?: boolean };
        return { publishedToSubsplash: data.publishedToSubsplash === true };
      })
    );

    await seriesRef.update({
      itemCount: metadata.itemCount,
      publishedItemCount: metadata.publishedItemCount,
      subtitle: metadata.subtitle,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (
      seriesData?.subsplashId &&
      seriesData.subtitle !== metadata.subtitle
    ) {
      const token = await authenticateSubsplash();
      await patchSeriesMetadata(
        seriesData.subsplashId,
        { subtitle: metadata.subtitle },
        token
      );
      logger.info(`seriesItemOnWrite: synced subtitle to Subsplash for series/${seriesId}`, {
        subsplashId: seriesData.subsplashId,
        subtitle: metadata.subtitle,
      });
    }

    logger.info(`seriesItemOnWrite: recalculated metadata for series/${seriesId}`, metadata);
  } catch (error) {
    throw handleError(error);
  }
});

export default seriesItemOnWrite;
