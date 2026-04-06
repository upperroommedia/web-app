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
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

const firestoreDB = firebaseAdmin.firestore();

const toSubsplashSeriesImageRefs = (
  images: Array<Pick<NonNullable<CreateSeriesInputType['images']>[number], 'id' | 'type' | 'subsplashId'>>
): Array<{ id: string; type: string }> =>
  images
    .map((image) => {
      const remoteImageId = image.subsplashId || image.id;
      if (!remoteImageId) {
        return undefined;
      }

      return {
        id: remoteImageId,
        type: image.type,
      };
    })
    .filter((image): image is { id: string; type: string } => image !== undefined);

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
    subsplashId?: string;
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
  { secrets: subsplashSecretsWithRuntimeAlerts },
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
            const repairedImagesToPersist =
              imagesToPersist.length > 0
                ? await repairMismatchedSubsplashImageRefs(imagesToPersist, token)
                : imagesToPersist;

            // Create series in Subsplash
            let syncedSubsplashSeries = await createSubsplashSeries(title.trim(), token, {
              subtitle: initialSubtitle,
              summary: summary?.trim(),
            });
            if (repairedImagesToPersist.length > 0) {
              syncedSubsplashSeries = await patchSeriesMetadata(
                syncedSubsplashSeries.id,
                {
                  images: toSubsplashSeriesImageRefs(repairedImagesToPersist),
                },
                token
              );
            }
            syncedSubsplashSeries = await patchSeriesMetadata(
              syncedSubsplashSeries.id,
              {
                publishedAt: new Date().toISOString(),
              },
              token
            );

            // Create Firestore document with Subsplash data
            const firestoreData: Record<string, unknown> = {
              id: seriesRef.id,
              name: syncedSubsplashSeries.title,
              subtitle: syncedSubsplashSeries.subtitle || initialSubtitle,
              images: repairedImagesToPersist,
              itemCount: syncedSubsplashSeries.media_items_count,
              publishedItemCount: syncedSubsplashSeries.published_media_items_count,
              status: syncedSubsplashSeries.status,
              subsplashId: syncedSubsplashSeries.id,
              ownerId: ownerId.trim(),
              slug: syncedSubsplashSeries.slug,
              shortCode: syncedSubsplashSeries.short_code,
              position: syncedSubsplashSeries.position,
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (!existingSeriesDoc.exists) {
              firestoreData.createdAt = FieldValue.serverTimestamp();
            }

            // Only add optional fields if they have values (Firestore doesn't allow undefined)
            if (syncedSubsplashSeries.summary) {
              firestoreData.summary = syncedSubsplashSeries.summary;
            }

            await seriesRef.set(firestoreData, { merge: existingSeriesDoc.exists });
            const repairedImageWrites = repairedImagesToPersist.filter((image) => image.subsplashId && image.subsplashId !== image.id);
            await Promise.all(
              repairedImageWrites.map((image) =>
                firestoreDB.collection('images').doc(image.id).set(
                  {
                    subsplashId: image.subsplashId,
                  },
                  { merge: true }
                )
              )
            );

            logger.log(`Created series: Firestore ID=${seriesRef.id}, Subsplash ID=${syncedSubsplashSeries.id}`);

            return {
              status: 'success',
              firestoreId: seriesRef.id,
              subsplashId: syncedSubsplashSeries.id,
              slug: syncedSubsplashSeries.slug,
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
