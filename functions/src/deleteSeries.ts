/**
 * Firebase callable function to delete a media series
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import { deleteSubsplashSeries } from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

const firestoreDB = firebaseAdmin.firestore();

export interface DeleteSeriesInputType {
  firestoreId: string;
}

export interface DeleteSeriesOutputType {
  status: 'success' | 'error';
  error?: string;
}

const deleteSeries = onCall(
  async (request: CallableRequest<DeleteSeriesInputType>): Promise<DeleteSeriesOutputType> => {
    logger.log('deleteSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { firestoreId } = request.data;

    // Validation
    if (!firestoreId || !firestoreId.trim()) {
      throw new HttpsError('invalid-argument', 'Firestore ID is required.');
    }

    try {
      // Get the series document from Firestore
      const seriesRef = firestoreDB.collection('series').doc(firestoreId).withConverter(firestoreAdminSeriesConverter);
      const seriesDoc = await seriesRef.get();

      if (!seriesDoc.exists) {
        throw new HttpsError('not-found', `Series with Firestore ID ${firestoreId} not found.`);
      }

      const seriesData = seriesDoc.data()!;
      const subsplashId = seriesData.subsplashId;

      // If published to Subsplash, delete from there first
      if (subsplashId) {
        // Authenticate with Subsplash
        const token = await authenticateSubsplash();

        // Delete from Subsplash (this also unassigns items from the series)
        // The helper handles 404 gracefully (series already deleted)
        await deleteSubsplashSeries(subsplashId, token);
      }

      // Clean up: Get all seriesItems and clear seriesId from associated sermons
      const seriesItemsRef = firestoreDB.collection('series').doc(firestoreId).collection('seriesItems');
      const seriesItemsSnapshot = await seriesItemsRef.get();
      
      const batch = firestoreDB.batch();
      
      // Clear seriesId from all sermons that were in this series
      for (const itemDoc of seriesItemsSnapshot.docs) {
        const sermonId = itemDoc.id;
        const sermonRef = firestoreDB.collection('sermons').doc(sermonId);
        batch.update(sermonRef, { seriesId: firebaseAdmin.firestore.FieldValue.delete() });
        // Delete the seriesItem document
        batch.delete(itemDoc.ref);
      }
      
      // Delete the series document
      batch.delete(seriesRef);
      
      await batch.commit();

      logger.log(`Deleted series: Firestore ID=${firestoreId}, Subsplash ID=${subsplashId}, cleaned up ${seriesItemsSnapshot.size} sermon references`);

      return {
        status: 'success',
      };
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default deleteSeries;
