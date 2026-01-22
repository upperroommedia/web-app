/**
 * Firebase callable function to create a new media series
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import { createSubsplashSeries } from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { canUserRolePublish } from '../../types/User';

// Use FieldValue from the same firebaseAdmin instance to ensure proper serialization
const FieldValue = firebaseAdmin.firestore.FieldValue;
import handleError from './handleError';

const firestoreDB = firebaseAdmin.firestore();

export interface CreateSeriesInputType {
  title: string;
  subtitle?: string;
  summary?: string;
}

export interface CreateSeriesOutputType {
  status: 'success' | 'error';
  firestoreId?: string;
  subsplashId?: string;
  slug?: string;
  error?: string;
}

const createSeries = onCall(
  async (request: CallableRequest<CreateSeriesInputType>): Promise<CreateSeriesOutputType> => {
    logger.log('createSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { title, subtitle, summary } = request.data;

    // Validation
    if (!title || !title.trim()) {
      throw new HttpsError('invalid-argument', 'Title is required and cannot be empty.');
    }

    try {
      // Authenticate with Subsplash
      const token = await authenticateSubsplash();

      // Create series in Subsplash
      const subsplashSeries = await createSubsplashSeries(title.trim(), token, {
        subtitle: subtitle?.trim(),
        summary: summary?.trim(),
      });

      // Create Firestore document
      const seriesRef = firestoreDB.collection('series').doc();
      const firestoreData: Record<string, unknown> = {
        id: seriesRef.id,
        name: subsplashSeries.title,
        images: [],
        itemCount: subsplashSeries.media_items_count,
        publishedItemCount: subsplashSeries.published_media_items_count,
        status: subsplashSeries.status,
        subsplashId: subsplashSeries.id,
        slug: subsplashSeries.slug,
        shortCode: subsplashSeries.short_code,
        position: subsplashSeries.position,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      // Only add optional fields if they have values (Firestore doesn't allow undefined)
      if (subsplashSeries.subtitle) {
        firestoreData.subtitle = subsplashSeries.subtitle;
      }
      if (subsplashSeries.summary) {
        firestoreData.summary = subsplashSeries.summary;
      }

      await seriesRef.set(firestoreData);

      logger.log(`Created series: Firestore ID=${seriesRef.id}, Subsplash ID=${subsplashSeries.id}`);

      return {
        status: 'success',
        firestoreId: seriesRef.id,
        subsplashId: subsplashSeries.id,
        slug: subsplashSeries.slug,
      };
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default createSeries;
