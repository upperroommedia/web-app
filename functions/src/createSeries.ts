/**
 * Firebase callable function to create a new media series
 */

import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticateSubsplash } from './subsplashUtils';
import {
  createSubsplashSeries,
  getSeriesSubtitleFromPublishedCount,
  patchSeriesMetadata,
} from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecrets } from './subsplashSecrets';

const firestoreDB = firebaseAdmin.firestore();

export interface CreateSeriesInputType {
  title: string;
  summary?: string;
  ownerId: string;              // User ID who owns the series
  firestoreId?: string;         // Optional existing Firestore series ID to sync
  skipSubsplash?: boolean;      // If true, only create in Firestore (for upload time)
  operationKey?: string;
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
  { secrets: subsplashSecrets },
  async (request: CallableRequest<CreateSeriesInputType>): Promise<CreateSeriesOutputType> => {
    logger.log('createSeries');

    // Authentication check - uploaders can create series locally, publishers can sync to Subsplash
    const userRole = request.auth?.token.role;
    if (!userRole) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { title, summary, ownerId, skipSubsplash, images, operationKey } = request.data;
    const firestoreId = request.data.firestoreId?.trim();
    const seriesRef = firestoreId
      ? firestoreDB.collection('series').doc(firestoreId)
      : firestoreDB.collection('series').doc();

    // Validation
    if (!title || !title.trim()) {
      throw new HttpsError('invalid-argument', 'Title is required and cannot be empty.');
    }
    if (!ownerId || !ownerId.trim()) {
      throw new HttpsError('invalid-argument', 'ownerId is required.');
    }

    const normalizedOperationKey = operationKey?.trim() || `create-series:${seriesRef.id}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        const existingSeriesDoc = await seriesRef.get();
        const existingSubsplashId = existingSeriesDoc.exists
          ? (existingSeriesDoc.data()?.subsplashId as string | undefined)
          : undefined;
        const seriesLockKeys = existingSubsplashId ? [`series:${existingSubsplashId}`] : [];

        return withSubsplashLocks(
          seriesLockKeys,
          async () => {
            const existingSeriesImages = existingSeriesDoc.exists
              ? (existingSeriesDoc.data()?.images as CreateSeriesInputType['images'] | undefined)
              : undefined;
            const inputImages = images?.filter((image) => Boolean(image?.id && image?.type)) || [];
            const imagesToPersist = inputImages.length > 0 ? inputImages : (existingSeriesImages || []);
            const initialSubtitle = getSeriesSubtitleFromPublishedCount(0);

            // If skipSubsplash is true, only create in Firestore (for upload time)
            if (skipSubsplash) {
              const firestoreData: Record<string, unknown> = {
                id: seriesRef.id,
                name: title.trim(),
                subtitle: initialSubtitle,
                images: imagesToPersist,
                itemCount: 0,
                publishedItemCount: 0,
                status: 'draft',
                subsplashId: '',  // Empty until published
                ownerId: ownerId.trim(),
                updatedAt: FieldValue.serverTimestamp(),
              };
              if (!existingSeriesDoc.exists) {
                firestoreData.createdAt = FieldValue.serverTimestamp();
              }

              // Only add optional fields if they have values
              if (summary?.trim()) {
                firestoreData.summary = summary.trim();
              }

              await seriesRef.set(firestoreData, { merge: existingSeriesDoc.exists });

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
              subtitle: initialSubtitle,
              summary: summary?.trim(),
            });
            if (imagesToPersist.length > 0) {
              await patchSeriesMetadata(
                subsplashSeries.id,
                {
                  images: imagesToPersist.map((image) => ({
                    id: image.id,
                    type: image.type,
                  })),
                },
                token
              );
            }

            // Create Firestore document with Subsplash data
            const firestoreData: Record<string, unknown> = {
              id: seriesRef.id,
              name: subsplashSeries.title,
              subtitle: subsplashSeries.subtitle || initialSubtitle,
              images: imagesToPersist,
              itemCount: subsplashSeries.media_items_count,
              publishedItemCount: subsplashSeries.published_media_items_count,
              status: subsplashSeries.status,
              subsplashId: subsplashSeries.id,
              ownerId: ownerId.trim(),
              slug: subsplashSeries.slug,
              shortCode: subsplashSeries.short_code,
              position: subsplashSeries.position,
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (!existingSeriesDoc.exists) {
              firestoreData.createdAt = FieldValue.serverTimestamp();
            }

            // Only add optional fields if they have values (Firestore doesn't allow undefined)
            if (subsplashSeries.summary) {
              firestoreData.summary = subsplashSeries.summary;
            }

            await seriesRef.set(firestoreData, { merge: existingSeriesDoc.exists });

            logger.log(`Created series: Firestore ID=${seriesRef.id}, Subsplash ID=${subsplashSeries.id}`);

            return {
              status: 'success',
              firestoreId: seriesRef.id,
              subsplashId: subsplashSeries.id,
              slug: subsplashSeries.slug,
            };
          },
          {
            operationKey: normalizedOperationKey,
          }
        );
      });
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default createSeries;
