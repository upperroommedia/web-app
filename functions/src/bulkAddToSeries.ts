/**
 * Firebase callable function to add many media items to a series safely.
 * - Performs controlled concurrent add operations
 * - Verifies series assignment from Subsplash response
 * - Reorders once at the end using caller-provided published order
 * - Optionally rolls back successful additions if any add/reorder fails
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';
import { authenticateSubsplash } from './subsplashUtils';
import { getSeriesItems, patchMediaItemSeries, patchSeriesItemPositions } from './helpers/seriesHelpers';
import { runWithConcurrency } from './utils/runWithConcurrency';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';

type AddStatus = 'success' | 'error';

export interface BulkAddToSeriesInputType {
  firestoreSeriesId: string;
  seriesSubsplashId: string;
  operationKey: string;
  expectedPublishedMembershipHash: string;
  adds: Array<{
    mediaItemId: string;
    sermonId?: string;
  }>;
  // Ordered top-to-bottom. Position 1 is bottom in Subsplash.
  publishedItemOrder: string[];
  maxConcurrency?: number;
  rollbackOnFailure?: boolean;
}

export interface BulkAddToSeriesResultItem {
  mediaItemId: string;
  sermonId?: string;
  status: AddStatus;
  confirmedSeriesId?: string | null;
  position?: number | null;
  alreadyInSeries?: boolean;
  error?: string;
}

export interface BulkAddToSeriesOutputType {
  status: 'success' | 'partial' | 'error';
  message: string;
  firestoreSeriesId: string;
  seriesSubsplashId: string;
  processed: number;
  succeeded: number;
  failed: number;
  reorderApplied: boolean;
  results: BulkAddToSeriesResultItem[];
  rolledBackMediaItemIds: string[];
  rollbackFailures: Array<{ mediaItemId: string; error: string }>;
}

interface RemoteSeriesItem {
  id: string;
  position: number | null;
}

const MAX_CONCURRENCY = 5;
const DEFAULT_CONCURRENCY = 4;
const MAX_BULK_ADDS = 200;
const MAX_PUBLISHED_ORDER_ITEMS = 1000;

const normalizeOperationKey = (operationKey: string): string => {
  const normalized = operationKey?.trim();
  if (!normalized) {
    throw new HttpsError('invalid-argument', 'operationKey is required.');
  }

  return normalized;
};

const normalizeMembershipHash = (expectedHash: string): string => {
  const normalized = expectedHash?.trim();
  if (!normalized) {
    throw new HttpsError('invalid-argument', 'expectedPublishedMembershipHash is required.');
  }

  return normalized;
};

const toMembershipHash = (mediaItemIds: string[]): string => {
  const normalized = Array.from(new Set(mediaItemIds.map((mediaItemId) => mediaItemId.trim()).filter(Boolean))).sort();
  return normalized.length > 0 ? normalized.join('|') : 'empty';
};

const getErrorMessage = (error: unknown): string => {
  if (error && typeof error === 'object') {
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }

    if ('details' in error && typeof (error as { details?: unknown }).details === 'string') {
      return (error as { details: string }).details;
    }
  }

  return 'Unknown error';
};

const fetchRemoteSeriesMembership = async (
  seriesSubsplashId: string,
  token: string
): Promise<Map<string, RemoteSeriesItem>> => {
  const [publishedItems, draftItems, scheduledItems] = await Promise.all([
    getSeriesItems(seriesSubsplashId, token, { status: 'published' }),
    getSeriesItems(seriesSubsplashId, token, { status: 'draft' }),
    getSeriesItems(seriesSubsplashId, token, { status: 'scheduled' }),
  ]);

  const remoteItems = new Map<string, RemoteSeriesItem>();
  [...publishedItems, ...draftItems, ...scheduledItems].forEach((item) => {
    remoteItems.set(item.id, {
      id: item.id,
      position: item.position ?? null,
    });
  });

  return remoteItems;
};

const rollbackAddedItems = async (
  token: string,
  successfulAdds: BulkAddToSeriesResultItem[],
  rollbackAllowedMediaItemIds: Set<string>
): Promise<{ rolledBackMediaItemIds: string[]; rollbackFailures: Array<{ mediaItemId: string; error: string }> }> => {
  const rollbackTargets = successfulAdds.filter((item) => rollbackAllowedMediaItemIds.has(item.mediaItemId));
  if (rollbackTargets.length === 0) {
    return { rolledBackMediaItemIds: [], rollbackFailures: [] };
  }

  const rollbackResults = await runWithConcurrency(rollbackTargets, 2, async (target) => {
      try {
        await patchMediaItemSeries(target.mediaItemId, null, token);
        return {
          mediaItemId: target.mediaItemId,
          status: 'success' as const,
        };
      } catch (error) {
        return {
          mediaItemId: target.mediaItemId,
          status: 'error' as const,
          error: getErrorMessage(error),
        };
      }
  });

  const rolledBackMediaItemIds = rollbackResults
    .filter((result) => result.status === 'success')
    .map((result) => result.mediaItemId);
  const rollbackFailures = rollbackResults
    .filter((result) => result.status === 'error')
    .map((result) => ({
      mediaItemId: result.mediaItemId,
      error: result.error || 'Unknown rollback error',
    }));

  return { rolledBackMediaItemIds, rollbackFailures };
};

const bulkAddToSeries = onCall(
  async (request: CallableRequest<BulkAddToSeriesInputType>): Promise<BulkAddToSeriesOutputType> => {
    logger.log('bulkAddToSeries');

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const {
      firestoreSeriesId,
      seriesSubsplashId,
      operationKey,
      expectedPublishedMembershipHash,
      adds,
      publishedItemOrder,
      maxConcurrency,
      rollbackOnFailure = true,
    } = request.data;

    if (!firestoreSeriesId || !firestoreSeriesId.trim()) {
      throw new HttpsError('invalid-argument', 'firestoreSeriesId is required.');
    }

    if (!seriesSubsplashId || !seriesSubsplashId.trim()) {
      throw new HttpsError('invalid-argument', 'seriesSubsplashId is required.');
    }

    const normalizedOperationKey = normalizeOperationKey(operationKey);
    const normalizedExpectedMembershipHash = normalizeMembershipHash(expectedPublishedMembershipHash);

    if (!Array.isArray(adds) || adds.length === 0) {
      throw new HttpsError('invalid-argument', 'adds must contain at least one media item.');
    }

    if (!Array.isArray(publishedItemOrder) || publishedItemOrder.length === 0) {
      throw new HttpsError('invalid-argument', 'publishedItemOrder must contain at least one media item.');
    }

    const uniqueAdds = Array.from(
      new Map(
        adds
          .filter((entry) => entry?.mediaItemId && entry.mediaItemId.trim())
          .map((entry) => [
            entry.mediaItemId.trim(),
            {
              mediaItemId: entry.mediaItemId.trim(),
              sermonId: entry.sermonId,
            },
          ])
      ).values()
    );

    if (uniqueAdds.length === 0) {
      throw new HttpsError('invalid-argument', 'adds contains no valid media item IDs.');
    }
    if (uniqueAdds.length > MAX_BULK_ADDS) {
      throw new HttpsError(
        'invalid-argument',
        `adds exceeds the maximum supported bulk size of ${MAX_BULK_ADDS} media items.`
      );
    }

    const uniquePublishedOrder = Array.from(
      new Set(
        publishedItemOrder
          .map((mediaItemId) => mediaItemId?.trim())
          .filter((mediaItemId): mediaItemId is string => Boolean(mediaItemId))
      )
    );

    if (uniquePublishedOrder.length === 0) {
      throw new HttpsError('invalid-argument', 'publishedItemOrder contains no valid media item IDs.');
    }
    if (uniquePublishedOrder.length > MAX_PUBLISHED_ORDER_ITEMS) {
      throw new HttpsError(
        'invalid-argument',
        `publishedItemOrder exceeds the maximum supported size of ${MAX_PUBLISHED_ORDER_ITEMS} media items.`
      );
    }

    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, maxConcurrency ?? DEFAULT_CONCURRENCY));

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        const lockMediaItemIds = Array.from(
          new Set([
            ...uniqueAdds.map((entry) => entry.mediaItemId),
            ...uniquePublishedOrder,
          ])
        ).sort();
        const lockKeys = [
          `series:${seriesSubsplashId.trim()}`,
          ...lockMediaItemIds.map((mediaItemId) => `media-item:${mediaItemId}`),
        ];

        return withSubsplashLocks(
          lockKeys,
          async () => {
            const token = await authenticateSubsplash();
            const remoteMembershipBeforeAdds = await fetchRemoteSeriesMembership(seriesSubsplashId, token);
            const remoteMembershipHash = toMembershipHash(Array.from(remoteMembershipBeforeAdds.keys()));
            if (normalizedExpectedMembershipHash !== remoteMembershipHash) {
              throw new HttpsError(
                'failed-precondition',
                'Published membership changed in Subsplash. Refresh the series and retry with a fresh snapshot hash.',
                {
                  expected_hash: normalizedExpectedMembershipHash,
                  actual_hash: remoteMembershipHash,
                }
              );
            }

            const existingMediaItemIds = new Set(remoteMembershipBeforeAdds.keys());
            const results = await runWithConcurrency(uniqueAdds, concurrency, async (entry): Promise<BulkAddToSeriesResultItem> => {
                try {
                  const patchedItem = await patchMediaItemSeries(entry.mediaItemId, seriesSubsplashId.trim(), token);
                  const confirmedSeriesId = patchedItem._embedded?.['media-series']?.id ?? null;
                  if (confirmedSeriesId !== seriesSubsplashId.trim()) {
                    return {
                      mediaItemId: entry.mediaItemId,
                      sermonId: entry.sermonId,
                      status: 'error',
                      error: `Subsplash did not confirm series assignment. Expected ${seriesSubsplashId}, got ${confirmedSeriesId ?? 'null'}.`,
                    };
                  }

                  return {
                    mediaItemId: entry.mediaItemId,
                    sermonId: entry.sermonId,
                    status: 'success',
                    confirmedSeriesId,
                    position: patchedItem.position ?? null,
                    alreadyInSeries: existingMediaItemIds.has(entry.mediaItemId),
                  };
                } catch (error) {
                  return {
                    mediaItemId: entry.mediaItemId,
                    sermonId: entry.sermonId,
                    status: 'error',
                    error: getErrorMessage(error),
                  };
                }
            });

            const successfulAdds = results.filter((result) => result.status === 'success');
            const failedAdds = results.filter((result) => result.status === 'error');
            const rollbackEligibleMediaItemIds = new Set(
              successfulAdds
                .filter((result) => result.alreadyInSeries !== true)
                .map((result) => result.mediaItemId)
            );

            if (failedAdds.length > 0) {
              const rollback = rollbackOnFailure
                ? await rollbackAddedItems(token, successfulAdds, rollbackEligibleMediaItemIds)
                : { rolledBackMediaItemIds: [], rollbackFailures: [] };

              return {
                status: successfulAdds.length > 0 ? 'partial' : 'error',
                message: `Failed to add ${failedAdds.length} of ${results.length} item(s) to Subsplash series.`,
                firestoreSeriesId,
                seriesSubsplashId: seriesSubsplashId.trim(),
                processed: results.length,
                succeeded: successfulAdds.length,
                failed: failedAdds.length,
                reorderApplied: false,
                results,
                rolledBackMediaItemIds: rollback.rolledBackMediaItemIds,
                rollbackFailures: rollback.rollbackFailures,
              };
            }

            const remoteMembershipAfterAdds = await fetchRemoteSeriesMembership(seriesSubsplashId, token);
            const missingOrderedIds = uniquePublishedOrder.filter((mediaItemId) => !remoteMembershipAfterAdds.has(mediaItemId));
            if (missingOrderedIds.length > 0) {
              const rollback = rollbackOnFailure
                ? await rollbackAddedItems(token, successfulAdds, rollbackEligibleMediaItemIds)
                : { rolledBackMediaItemIds: [], rollbackFailures: [] };

              return {
                status: 'error',
                message: `Cannot reorder series because ${missingOrderedIds.length} ordered item(s) are missing in Subsplash membership.`,
                firestoreSeriesId,
                seriesSubsplashId: seriesSubsplashId.trim(),
                processed: results.length,
                succeeded: successfulAdds.length,
                failed: 0,
                reorderApplied: false,
                results,
                rolledBackMediaItemIds: rollback.rolledBackMediaItemIds,
                rollbackFailures: rollback.rollbackFailures,
              };
            }

            const requestedPositions = new Map(
              uniquePublishedOrder.map((mediaItemId, index) => [
                mediaItemId,
                // Subsplash semantics: position 1 is the bottom item.
                uniquePublishedOrder.length - index,
              ])
            );
            const itemsToUpdate = Array.from(remoteMembershipAfterAdds.values()).map((item) => ({
              id: item.id,
              position: requestedPositions.get(item.id) ?? item.position,
            }));

            await patchSeriesItemPositions(seriesSubsplashId.trim(), itemsToUpdate, token);

            return {
              status: 'success',
              message: `Added ${successfulAdds.length} item(s) and applied series reorder.`,
              firestoreSeriesId,
              seriesSubsplashId: seriesSubsplashId.trim(),
              processed: results.length,
              succeeded: successfulAdds.length,
              failed: 0,
              reorderApplied: true,
              results,
              rolledBackMediaItemIds: [],
              rollbackFailures: [],
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

export default bulkAddToSeries;
