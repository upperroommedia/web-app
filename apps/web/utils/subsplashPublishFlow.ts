import { AddToListOutputType } from '@upperroom/contracts/addToList';
import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';
import {
  createPublishedMembershipHash,
  createRetryIntentKey,
} from './callableConcurrency';

export const createSubsplashUploadIntentKey = (
  scope: string,
  sermonId: string,
  uploadGeneration?: number
): string => {
  return createRetryIntentKey(scope, sermonId, `remote-media-upload:${uploadGeneration ?? 0}`);
};

export const createSubsplashListCreateIntentKey = (
  scope: string,
  sermonId: string,
  listId: string
): string => {
  return createRetryIntentKey(scope, listId, `sermon:${sermonId}`);
};

export const createSubsplashListAddIntentKey = (
  scope: string,
  sermonId: string,
  destinationLists: Array<Pick<SermonList, 'id' | 'publishGeneration'>>
): string => {
  return createRetryIntentKey(
    scope,
    sermonId,
    `lists:${createPublishedMembershipHash(
      destinationLists.map((list) => `${list.id}@${list.publishGeneration ?? 0}`)
    )}`
  );
};

export const createSubsplashListRemoveIntentKey = (
  scope: string,
  sermonId: string,
  destinationListIds: string[]
): string => {
  return createRetryIntentKey(
    scope,
    sermonId,
    `remove-lists:${createPublishedMembershipHash(destinationListIds)}`
  );
};

export const getNextPublishGeneration = (currentGeneration?: number): number => {
  return (currentGeneration ?? 0) + 1;
};

export const createSubsplashDeleteIntentKey = (scope: string, sermonId: string): string => {
  return createRetryIntentKey(scope, sermonId, 'remote-media-delete');
};

export const createSubsplashSeriesCreateIntentKey = (scope: string, seriesId: string): string => {
  return createRetryIntentKey(scope, seriesId, 'remote-series-create');
};

export const createSubsplashSeriesPublishIntentKey = (
  scope: string,
  sermonId: string,
  seriesId: string
): string => {
  return createRetryIntentKey(scope, sermonId, `series-publish:${seriesId}`);
};

export const createSubsplashSeriesRollbackIntentKey = (
  scope: string,
  sermonId: string,
  seriesId: string
): string => {
  return createRetryIntentKey(scope, sermonId, `series-rollback:${seriesId}`);
};

export const createSubsplashSeriesUnpublishIntentKey = (
  scope: string,
  sermonId: string,
  seriesId: string
): string => {
  return createRetryIntentKey(scope, sermonId, `series-unpublish:${seriesId}`);
};

export const createSubsplashSeriesReorderIntentKey = (
  scope: string,
  seriesId: string,
  publishedMediaItemIds: string[]
): string => {
  return createRetryIntentKey(
    scope,
    seriesId,
    `series-reorder:${createPublishedMembershipHash(publishedMediaItemIds)}`
  );
};

export interface ListPublishAggregate {
  allSucceeded: boolean;
  status: uploadStatus;
  errorSummary?: string;
}

export const getListPublishAggregate = (
  targetListIds: string[],
  addToListResults: AddToListOutputType
): ListPublishAggregate => {
  if (targetListIds.length === 0) {
    return {
      allSucceeded: true,
      status: uploadStatus.UPLOADED,
    };
  }

  const expectedListIds = new Set(targetListIds);
  const returnedListIds = new Set(addToListResults.map((result) => result.listId));
  const missingListIds = targetListIds.filter((listId) => !returnedListIds.has(listId));
  const unexpectedListIds = addToListResults
    .map((result) => result.listId)
    .filter((listId) => !expectedListIds.has(listId));
  const explicitErrors = addToListResults
    .filter((result): result is Extract<AddToListOutputType[number], { status: 'error' }> => result.status === 'error')
    .map((result) => `${result.listId}: ${result.error}`);

  const errors: string[] = [...explicitErrors];
  if (missingListIds.length > 0) {
    errors.push(`Missing publish result for lists: ${missingListIds.join(', ')}`);
  }
  if (unexpectedListIds.length > 0) {
    errors.push(`Unexpected publish result for lists: ${unexpectedListIds.join(', ')}`);
  }
  if (addToListResults.length !== targetListIds.length) {
    errors.push(
      `Expected ${targetListIds.length} list publish results but received ${addToListResults.length}.`
    );
  }

  return {
    allSucceeded: errors.length === 0,
    status: errors.length === 0 ? uploadStatus.UPLOADED : uploadStatus.ERROR,
    ...(errors.length > 0 ? { errorSummary: errors.join('; ') } : {}),
  };
};

export const didAllListPublishesSucceed = (
  targetListIds: string[],
  addToListResults: AddToListOutputType
): boolean => getListPublishAggregate(targetListIds, addToListResults).allSucceeded;

export const getSermonSubsplashStatusAfterListMutation = (
  targetListIds: string[],
  addToListResults: AddToListOutputType
): uploadStatus => getListPublishAggregate(targetListIds, addToListResults).status;

export const summarizeListPublishErrors = (
  targetListIds: string[],
  addToListResults: AddToListOutputType
): string | undefined => getListPublishAggregate(targetListIds, addToListResults).errorSummary;
