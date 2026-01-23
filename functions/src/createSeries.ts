/**
 * Firebase callable function to create a new media series
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticateSubsplash } from './subsplashUtils';
import { createSubsplashSeries } from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

const firestoreDB = firebaseAdmin.firestore();

export interface CreateSeriesInputType {
  title: string;
  subtitle?: string;
  summary?: string;
  ownerId: string;              // User ID who owns the series
  skipSubsplash?: boolean;      // If true, only create in Firestore (for upload time)
  images?: Array<{              // Optional images for the series
    id: string;
    type: string;
    downloadLink: string;
    name?: string;
  }>;
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

    // Authentication check - uploaders can create series locally, publishers can sync to Subsplash
    const userRole = request.auth?.token.role;
    if (!userRole) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { title, subtitle, summary, ownerId, skipSubsplash, images } = request.data;

    // Validation
    if (!title || !title.trim()) {
      throw new HttpsError('invalid-argument', 'Title is required and cannot be empty.');
    }
    if (!ownerId || !ownerId.trim()) {
      throw new HttpsError('invalid-argument', 'ownerId is required.');
    }

    try {
      const seriesRef = firestoreDB.collection('series').doc();

      // If skipSubsplash is true, only create in Firestore (for upload time)
      if (skipSubsplash) {
        const firestoreData: Record<string, unknown> = {
          id: seriesRef.id,
          name: title.trim(),
          images: images || [],
          itemCount: 0,
          publishedItemCount: 0,
          status: 'draft',
          subsplashId: '',  // Empty until published
          ownerId: ownerId.trim(),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };

        // Only add optional fields if they have values
        if (subtitle?.trim()) {
          firestoreData.subtitle = subtitle.trim();
        }
        if (summary?.trim()) {
          firestoreData.summary = summary.trim();
        }

        await seriesRef.set(firestoreData);

        logger.log(`Created local series: Firestore ID=${seriesRef.id} (no Subsplash sync)`);

        return {
          status: 'success',
          firestoreId: seriesRef.id,
          subsplashId: '',  // Not yet created in Subsplash
        };
      }

      // Full creation with Subsplash sync (requires publish permissions)
      if (!canUserRolePublish(userRole)) {
        throw new HttpsError('permission-denied', 'Publishing to Subsplash requires publish permissions.');
      }

      // Authenticate with Subsplash
      const token = await authenticateSubsplash();

      // Create series in Subsplash
      const subsplashSeries = await createSubsplashSeries(title.trim(), token, {
        subtitle: subtitle?.trim(),
        summary: summary?.trim(),
      });

      // Create Firestore document with Subsplash data
      const firestoreData: Record<string, unknown> = {
        id: seriesRef.id,
        name: subsplashSeries.title,
        images: [],
        itemCount: subsplashSeries.media_items_count,
        publishedItemCount: subsplashSeries.published_media_items_count,
        status: subsplashSeries.status,
        subsplashId: subsplashSeries.id,
        ownerId: ownerId.trim(),
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
