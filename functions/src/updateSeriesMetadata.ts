import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import {
  getSeriesSubtitleFromPublishedCount,
  patchSeriesMetadata,
} from './helpers/seriesHelpers';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { repairMismatchedSubsplashImageRefs } from './helpers/subsplashImageRefs';
import { authenticateSubsplash } from './subsplashUtils';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import handleError from './handleError';
import type {
  UpdateSeriesMetadataImageInput,
  UpdateSeriesMetadataInputType,
  UpdateSeriesMetadataOutputType,
} from '../../packages/contracts/updateSeriesMetadata';

const firestoreDB = firebaseAdmin.firestore();

const toSubsplashSeriesImageRefs = (
  images: Array<Pick<UpdateSeriesMetadataImageInput, 'id' | 'type' | 'subsplashId'>>
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

const updateSeriesMetadata = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (
    request: CallableRequest<UpdateSeriesMetadataInputType>
  ): Promise<UpdateSeriesMetadataOutputType> => {
    logger.log('updateSeriesMetadata');

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const firestoreId = request.data.firestoreId?.trim();
    const title = request.data.title?.trim();
    const summary = typeof request.data.summary === 'string'
      ? request.data.summary.trim() || null
      : request.data.summary ?? null;

    if (!firestoreId) {
      throw new HttpsError('invalid-argument', 'firestoreId is required.');
    }

    if (!title) {
      throw new HttpsError('invalid-argument', 'title is required.');
    }

    const normalizedOperationKey =
      request.data.operationKey?.trim() || `update-series-metadata:${firestoreId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        const seriesRef = firestoreDB
          .collection('series')
          .doc(firestoreId)
          .withConverter(firestoreAdminSeriesConverter);
        const existingSeriesDoc = await seriesRef.get();

        if (!existingSeriesDoc.exists) {
          throw new HttpsError('not-found', `Series with firestoreId ${firestoreId} not found.`);
        }

        const existingSeries = existingSeriesDoc.data()!;
        const subsplashId = existingSeries.subsplashId?.trim();
        if (!subsplashId) {
          throw new HttpsError(
            'failed-precondition',
            `Series ${firestoreId} is not linked to Subsplash and cannot be updated remotely.`
          );
        }

        return withSubsplashLocks(
          [`series:${subsplashId}`],
          async () => {
            const latestSeriesDoc = await seriesRef.get();
            if (!latestSeriesDoc.exists) {
              throw new HttpsError('not-found', `Series with firestoreId ${firestoreId} not found.`);
            }

            const latestSeries = latestSeriesDoc.data()!;
            const latestSubsplashId = latestSeries.subsplashId?.trim();
            if (!latestSubsplashId) {
              throw new HttpsError(
                'failed-precondition',
                `Series ${firestoreId} is not linked to Subsplash and cannot be updated remotely.`
              );
            }

            const token = await authenticateSubsplash();
            const inputImages = request.data.images?.filter((image) => Boolean(image?.id && image?.type)) || [];
            const imagesToPersist = inputImages.length > 0 ? inputImages : latestSeries.images || [];
            const repairedImagesToPersist =
              imagesToPersist.length > 0
                ? await repairMismatchedSubsplashImageRefs(imagesToPersist, token)
                : imagesToPersist;
            const subtitle = getSeriesSubtitleFromPublishedCount(latestSeries.publishedItemCount || 0);

            const syncedSubsplashSeries = await patchSeriesMetadata(
              latestSubsplashId,
              {
                title,
                subtitle,
                summary,
                images: toSubsplashSeriesImageRefs(repairedImagesToPersist),
              },
              token
            );

            const firestoreUpdate: Record<string, unknown> = {
              name: syncedSubsplashSeries.title,
              subtitle: syncedSubsplashSeries.subtitle || subtitle,
              images: repairedImagesToPersist,
              status: syncedSubsplashSeries.status,
              slug: syncedSubsplashSeries.slug,
              shortCode: syncedSubsplashSeries.short_code,
              position: syncedSubsplashSeries.position,
              updatedAt: FieldValue.serverTimestamp(),
            };

            if (syncedSubsplashSeries.summary) {
              firestoreUpdate.summary = syncedSubsplashSeries.summary;
            } else {
              firestoreUpdate.summary = FieldValue.delete();
            }

            await seriesRef.set(firestoreUpdate, { merge: true });

            const repairedImageWrites = repairedImagesToPersist.filter(
              (image) => image.subsplashId && image.subsplashId !== image.id
            );
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

            return {
              status: 'success',
              firestoreId,
              subsplashId: syncedSubsplashSeries.id,
              title: syncedSubsplashSeries.title,
              subtitle: syncedSubsplashSeries.subtitle || subtitle,
              summary: syncedSubsplashSeries.summary,
              images: repairedImagesToPersist,
              remoteStatus: syncedSubsplashSeries.status,
              slug: syncedSubsplashSeries.slug,
              shortCode: syncedSubsplashSeries.short_code,
              position: syncedSubsplashSeries.position,
            };
          },
          {
            operationKey: normalizedOperationKey,
          }
        );
      });
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default updateSeriesMetadata;
