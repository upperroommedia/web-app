import firestore, {
  collection,
  collectionGroup,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  runTransaction,
  increment,
  orderBy,
  limit,
  updateDoc,
} from '../../firebase/firestore';

import { sermonConverter } from '../../types/Sermon';
import { Sermon, uploadStatus } from '../../types/SermonTypes';
import { createFunctionV2 } from '../../utils/createFunction';
import { EDIT_SUBSPLASH_SERMON_INCOMING_DATA } from '@upperroom/contracts/editSubsplashSermon';
import {
  EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA,
  EditSoundCloudSermonReturnType,
} from '@upperroom/contracts/editSoundCloudSermon';
import type { AddtoListInputType, AddToListOutputType } from '@upperroom/contracts/addToList';
import type { RemoveFromListInputType, RemoveFromListOutputType } from '@upperroom/contracts/removeFromList';
import type { AddToSeriesInputType, AddToSeriesOutputType } from '@upperroom/contracts/addToSeries';
import type { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '@upperroom/contracts/removeFromSeries';
import type { CreateSeriesInputType, CreateSeriesOutputType } from '@upperroom/contracts/createSeries';
import type {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '@upperroom/contracts/createNewSubsplashList';
import type {
  UPLOAD_TO_SUBSPLASH_INCOMING_DATA,
} from '@upperroom/contracts/uploadToSubsplash';
import type {
  ReorderSeriesItemsInputType,
  ReorderSeriesItemsOutputType,
} from '@upperroom/contracts/reorderSeriesItems';
import { getSquareImageDownloadLink } from '../../utils/utils';
import { List, listConverter } from '../../types/List';
import { SermonList, sermonListConverter } from '../../types/SermonList';
import { buildEditableSermonPatch } from '../../utils/buildEditableSermonPatch';
import { createOperationKey, parseLockBusyDetails } from '../../utils/callableConcurrency';
import { resolveCanonicalSermonLists } from '../../utils/resolveCanonicalSermonLists';
import { reportHandledError } from '../../utils/reportHandledError';
import { getSubsplashUnpublishStrategy } from '../../utils/getSubsplashUnpublishStrategy';
import {
  createSubsplashListAddIntentKey,
  createSubsplashListCreateIntentKey,
  createSubsplashListRemoveIntentKey,
  createSubsplashSeriesCreateIntentKey,
  createSubsplashSeriesPublishIntentKey,
  createSubsplashSeriesReorderIntentKey,
  createSubsplashSeriesUnpublishIntentKey,
  createSubsplashUploadIntentKey,
} from '../../utils/subsplashPublishFlow';
import { resolveCanonicalFirestoreList } from '../../utils/resolveCanonicalFirestoreList';
import { seriesConverter } from '../../types/Series';
import firebase, { isDevelopment } from '../../firebase/firebase';
import { getDownloadURL, getStorage, ref } from '../../firebase/storage';
import { UNPROCESSED_SERMONS_BUCKET } from '../../constants/storage_constants';

interface EditSermonOptions {
  originalSermon?: Sermon;
}

type AddedPublishedListResult = {
  list: List;
  uploadStatus: { status: uploadStatus.UPLOADED; listItemId: string };
  physicalPlacement?: {
    firestoreListId: string;
    subsplashListId: string;
    overflowDepth: number;
    position: number;
    listItemId?: string;
  };
};

type SeriesPublicationState = {
  published: boolean;
  mediaItemId?: string;
};

const storage = getStorage(firebase);

const normalizeString = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const stableJson = (value: unknown): string => JSON.stringify(value ?? null);

const hasRemoteMetadataChanges = (original: Sermon, updated: Sermon): boolean => {
  return (
    original.title !== updated.title ||
    original.subtitle !== updated.subtitle ||
    original.description !== updated.description ||
    original.dateMillis !== updated.dateMillis ||
    stableJson(original.speakers) !== stableJson(updated.speakers) ||
    stableJson(original.topics) !== stableJson(updated.topics) ||
    stableJson(original.images) !== stableJson(updated.images)
  );
};

const getListIdFromListItemDoc = (listItemDoc: { ref: { parent: { parent: { id: string } | null } } }): string | undefined =>
  listItemDoc.ref.parent.parent?.id;

const getNextSeriesPosition = async (seriesId: string): Promise<number> => {
  const latestPositionSnapshot = await getDocs(
    query(collection(firestore, `series/${seriesId}/seriesItems`), orderBy('position', 'desc'), limit(1))
  );
  const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
  return typeof latestPosition === 'number' ? latestPosition + 1 : 1;
};

const getSeriesPublicationState = async (seriesId: string | undefined, sermonId: string): Promise<SeriesPublicationState> => {
  if (!seriesId) {
    return { published: false };
  }

  const seriesItemSnapshot = await getDoc(doc(firestore, `series/${seriesId}/seriesItems/${sermonId}`));
  if (!seriesItemSnapshot.exists()) {
    return { published: false };
  }

  const data = seriesItemSnapshot.data() as {
    publishedToSubsplash?: boolean;
    sermonSubsplashId?: string;
  };

  return {
    published: data.publishedToSubsplash === true,
    mediaItemId: normalizeString(data.sermonSubsplashId),
  };
};

const ensureSubsplashMediaItem = async (sermon: Sermon): Promise<string> => {
  const uploadToSubsplashCallable = createFunctionV2<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, { id: string }>('uploadToSubsplash');
  const audioUrl = await getDownloadURL(ref(storage, `${UNPROCESSED_SERMONS_BUCKET}/${sermon.id}`));

  const response = await uploadToSubsplashCallable({
    title: sermon.title,
    subtitle: sermon.subtitle,
    speakers: sermon.speakers,
    autoPublish: !isDevelopment,
    audioTitle: sermon.title,
    audioUrl,
    topics: sermon.topics,
    description: sermon.description,
    images: sermon.images,
    date: new Date(sermon.dateMillis),
    operationKey: createSubsplashUploadIntentKey('edit-sermon-upload', sermon.id, sermon.subsplashUploadGeneration),
    lockKey: sermon.id,
  });

  return response.id;
};

const ensureSubsplashList = async (list: List, sermonId: string): Promise<List> => {
  const canonicalList = await resolveCanonicalFirestoreList(list);
  if (!canonicalList) {
    throw new Error(`List "${list.name}" could not be resolved to a Firestore list document.`);
  }

  if (canonicalList.subsplashId) {
    return canonicalList;
  }

  const createNewSubsplashList = createFunctionV2<CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType>(
    'createnewsubsplashlist'
  );
  const { listId } = await createNewSubsplashList({
    title: canonicalList.name,
    subtitle: '',
    images: canonicalList.images,
    operationKey: createSubsplashListCreateIntentKey('edit-sermon-list-create', sermonId, canonicalList.id),
  });
  await updateDoc(doc(firestore, 'lists', canonicalList.id), { subsplashId: listId });

  return { ...canonicalList, subsplashId: listId };
};

const addSermonToLists = async (
  sermon: Sermon,
  mediaItemId: string,
  listsToAdd: List[]
): Promise<Map<string, AddedPublishedListResult>> => {
  const results = new Map<string, AddedPublishedListResult>();
  if (listsToAdd.length === 0) {
    return results;
  }

  const resolvedLists = await Promise.all(listsToAdd.map((list) => ensureSubsplashList(list, sermon.id)));
  const addToList = createFunctionV2<AddtoListInputType, AddToListOutputType>('addtolist');
  const addResults = await addToList({
    destinationListIds: resolvedLists.map((list) => list.subsplashId as string),
    mediaItem: { id: mediaItemId, type: 'media-item' },
    operationKey: createSubsplashListAddIntentKey(
      'edit-sermon-list-add',
      sermon.id,
      resolvedLists.map((list) => ({
        id: list.id,
        publishGeneration: (list as SermonList).publishGeneration ?? 0,
      }))
    ),
  });

  const resolvedBySubsplashId = new Map(
    resolvedLists.map((list) => [list.subsplashId as string, list])
  );

  for (const result of addResults) {
    if (result.status !== 'success') {
      throw new Error(result.error || `Failed to publish list ${result.listId}.`);
    }

    const resolvedList = resolvedBySubsplashId.get(result.listId);
    if (!resolvedList) {
      throw new Error(`ListId for Subsplash list ${result.listId} was not found.`);
    }

    const resolvedListItemId = result.actualPlacement?.listItemId ?? result.listItemId;
    if (!resolvedListItemId) {
      throw new Error(`Successful list publish for ${resolvedList.id} did not return a resolved listItemId.`);
    }

    results.set(resolvedList.id, {
      list: resolvedList,
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: resolvedListItemId },
      physicalPlacement: result.actualPlacement,
    });
  }

  return results;
};

const removeSermonFromLists = async (
  sermonId: string,
  mediaItemId: string,
  listsToRemove: SermonList[]
): Promise<void> => {
  if (listsToRemove.length === 0) {
    return;
  }

  const removeFromListCallable = createFunctionV2<RemoveFromListInputType, RemoveFromListOutputType>('removefromlist');
  const subsplashListIds = listsToRemove.map((list) => normalizeString(list.subsplashId));
  const listItemIds = listsToRemove.map((list) =>
    list.uploadStatus?.status === uploadStatus.UPLOADED ? list.uploadStatus.listItemId : undefined
  );

  if (subsplashListIds.some((value) => !value) || listItemIds.some((value) => !value)) {
    throw new Error('Cannot remove sermon from Subsplash lists without list ids and list row ids.');
  }

  const response = await removeFromListCallable({
    listIds: subsplashListIds as string[],
    listItemIds: listItemIds as string[],
    itemIds: listsToRemove.map(() => mediaItemId),
    itemTypes: listsToRemove.map(() => 'media-item'),
    sermonIds: listsToRemove.map(() => sermonId),
    operationKey: createSubsplashListRemoveIntentKey(
      'edit-sermon-list-remove',
      sermonId,
      subsplashListIds as string[]
    ),
  });

  for (const result of response) {
    if (result.status !== 'success') {
      throw new Error(result.error || `Failed to remove sermon from list ${result.listId}.`);
    }
  }
};

const ensureSeriesSubsplashId = async (seriesId: string): Promise<string> => {
  const seriesSnapshot = await getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter));
  if (!seriesSnapshot.exists()) {
    throw new Error('Selected series no longer exists.');
  }

  const series = seriesSnapshot.data();
  if (series.subsplashId) {
    return series.subsplashId;
  }

  const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
  const createResult = await createSeriesFunction({
    title: series.name,
    summary: series.summary,
    ownerId: series.ownerId,
    firestoreId: series.id,
    skipSubsplash: false,
    images: series.images,
    operationKey: createSubsplashSeriesCreateIntentKey('edit-sermon-series-create', series.id),
  });

  if (createResult.status !== 'success' || !createResult.subsplashId) {
    throw new Error(createResult.error || 'Failed to create series in Subsplash');
  }

  await updateDoc(doc(firestore, 'series', series.id), {
    subsplashId: createResult.subsplashId,
    status: 'published',
  });

  return createResult.subsplashId;
};

const reorderSeriesFromFirebaseOrder = async (
  seriesId: string,
  sermonId: string,
  mediaItemId: string,
  pendingPosition?: number
): Promise<void> => {
  const orderedItemsSnapshot = await getDocs(
    query(collection(firestore, `series/${seriesId}/seriesItems`), orderBy('position', 'desc'))
  );
  const orderedItems = orderedItemsSnapshot.docs.map((seriesItemDoc) => {
    const data = seriesItemDoc.data() as {
      publishedToSubsplash?: boolean;
      sermonSubsplashId?: string;
      position?: number;
    };

    const isPublished = seriesItemDoc.id === sermonId ? true : data.publishedToSubsplash === true;
    const resolvedMediaItemId = seriesItemDoc.id === sermonId ? mediaItemId : normalizeString(data.sermonSubsplashId);
    return {
      sermonId: seriesItemDoc.id,
      isPublished,
      mediaItemId: resolvedMediaItemId,
      position: typeof data.position === 'number' ? data.position : 0,
    };
  });

  if (!orderedItems.some((item) => item.sermonId === sermonId)) {
    if (typeof pendingPosition === 'number') {
      console.warn('editSermon.reorderSeries.pendingInsertion', {
        seriesId,
        sermonId,
        pendingPosition,
      });
      orderedItems.push({
        sermonId,
        isPublished: true,
        mediaItemId,
        position: pendingPosition,
      });
      orderedItems.sort((left, right) => right.position - left.position);
    } else {
      throw new Error('Series item is missing from Firestore order. Refresh and try again.');
    }
  }

  const publishedItems = orderedItems.filter((item) => item.isPublished);
  const missingMediaId = publishedItems.find((item) => !item.mediaItemId);
  if (missingMediaId) {
    throw new Error(`Published series item ${missingMediaId.sermonId} is missing a Subsplash media ID.`);
  }

  const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>('reorderseriesitems');
  const reorderResult = await reorderFunction({
    firestoreSeriesId: seriesId,
    itemOrder: publishedItems.map((item, index) => ({
      mediaItemId: item.mediaItemId as string,
      position: publishedItems.length - index,
    })),
    operationKey: createSubsplashSeriesReorderIntentKey(
      'edit-sermon-series-reorder',
      seriesId,
      publishedItems.map((item) => item.mediaItemId as string)
    ),
  });

  if (reorderResult.status !== 'success') {
    throw new Error(reorderResult.message || 'Subsplash reorder failed.');
  }
};

const publishSeriesMembership = async (seriesId: string, sermonId: string, mediaItemId: string): Promise<void> => {
  const seriesSubsplashId = await ensureSeriesSubsplashId(seriesId);
  const pendingPosition = await getNextSeriesPosition(seriesId);
  const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
  const addResult = await addToSeriesFunction({
    seriesSubsplashId,
    mediaItemId,
    operationKey: createSubsplashSeriesPublishIntentKey('edit-sermon-series-publish', sermonId, seriesId),
  });

  if (addResult.status !== 'success') {
    throw new Error(addResult.error || 'Failed to add sermon to series.');
  }

  await reorderSeriesFromFirebaseOrder(seriesId, sermonId, mediaItemId, pendingPosition);
};

const unpublishSeriesMembership = async (seriesId: string, sermonId: string, mediaItemId: string): Promise<void> => {
  const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
  const removeResult = await removeFromSeriesFunction({
    mediaItemId,
    operationKey: createSubsplashSeriesUnpublishIntentKey('edit-sermon-series-unpublish', sermonId, seriesId),
  });

  if (removeResult.status !== 'success') {
    throw new Error(removeResult.message || 'Failed to remove sermon from series.');
  }
};

const persistSeriesMembershipChange = async (
  sermon: Sermon,
  previousSeriesId: string | undefined,
  nextSeriesId: string | undefined,
  finalSubsplashId: string | undefined,
  nextSeriesPublished: boolean
): Promise<void> => {
  if (previousSeriesId === nextSeriesId) {
    return;
  }

  let newSeriesPosition = 1;
  if (nextSeriesId) {
    newSeriesPosition = await getNextSeriesPosition(nextSeriesId);
  }

  await runTransaction(firestore, async (transaction) => {
    const oldSeriesRef = previousSeriesId ? doc(firestore, 'series', previousSeriesId) : null;
    const oldSeriesItemRef = previousSeriesId
      ? doc(firestore, 'series', previousSeriesId, 'seriesItems', sermon.id)
      : null;
    const newSeriesRef = nextSeriesId ? doc(firestore, 'series', nextSeriesId) : null;
    const newSeriesItemRef = nextSeriesId
      ? doc(firestore, 'series', nextSeriesId, 'seriesItems', sermon.id)
      : null;

    const oldSeriesDoc = oldSeriesRef ? await transaction.get(oldSeriesRef) : null;
    const newSeriesDoc = newSeriesRef ? await transaction.get(newSeriesRef) : null;

    if (oldSeriesItemRef) {
      transaction.delete(oldSeriesItemRef);
    }
    if (oldSeriesDoc?.exists()) {
      transaction.update(oldSeriesRef!, {
        itemCount: increment(-1),
        updatedAt: new Date(),
      });
    }

    if (newSeriesItemRef && newSeriesDoc?.exists()) {
      transaction.set(newSeriesItemRef, {
        id: sermon.id,
        position: newSeriesPosition,
        publishedToSubsplash: nextSeriesPublished,
        sermonSubsplashId: nextSeriesPublished ? finalSubsplashId || null : null,
        addedAt: new Date(),
      });
      transaction.update(newSeriesRef!, {
        itemCount: increment(1),
        updatedAt: new Date(),
      });
    }
  });
};

const showMutationFailure = (error: unknown, sermonId: string): never => {
  const busyDetails = parseLockBusyDetails(error);
  if (busyDetails) {
    const retryInSeconds = Math.max(1, Math.ceil(busyDetails.retry_after_ms / 1000));
    const lockedKeys = busyDetails.locked_keys.length > 0 ? ` Locked keys: ${busyDetails.locked_keys.join(', ')}.` : '';
    reportHandledError(error, {
      area: 'edit-sermon',
      action: 'mutation-busy',
      level: 'warning',
      extras: {
        sermonId,
        retryInSeconds,
        lockedKeys: busyDetails.locked_keys,
      },
    });
    alert(`Subsplash is busy processing another mutation.${lockedKeys} Retry in about ${retryInSeconds}s.`);
  } else {
    reportHandledError(error, {
      area: 'edit-sermon',
      action: 'mutation-failed',
      extras: {
        sermonId,
      },
    });
    alert(error instanceof Error ? error.message : String(error));
  }

  throw error instanceof Error ? error : new Error(String(error));
};

const buildMirroredListItemData = (
  sermon: Sermon,
  options?: {
    uploadStatus?: SermonList['uploadStatus'];
    physicalPlacement?: AddedPublishedListResult['physicalPlacement'];
  }
): Record<string, unknown> => {
  return {
    ...sermonConverter.toFirestore(sermon),
    ...(options?.uploadStatus?.status === uploadStatus.UPLOADED ? { uploadStatus: options.uploadStatus } : {}),
    ...(options?.physicalPlacement ? { physicalPlacement: options.physicalPlacement } : {}),
  };
};

const buildMirroredListItemPatch = (
  sermon: Sermon,
  options?: {
    uploadStatus?: SermonList['uploadStatus'];
    physicalPlacement?: AddedPublishedListResult['physicalPlacement'];
  }
): Record<string, unknown> => {
  return {
    ...buildMirroredListItemData(sermon, options),
    youtubeUrl: sermon.youtubeUrl ?? deleteField(),
    seriesId: sermon.seriesId ?? deleteField(),
    subsplashId: sermon.subsplashId ?? deleteField(),
    ...(options?.uploadStatus?.status === uploadStatus.UPLOADED
      ? { uploadStatus: options.uploadStatus }
      : { uploadStatus: deleteField() }),
    ...(options?.physicalPlacement ? { physicalPlacement: options.physicalPlacement } : { physicalPlacement: deleteField() }),
  };
};

const editSermon = async (sermon: Sermon, sermonList: List[], options?: EditSermonOptions) => {
  const originalSermon = options?.originalSermon ?? sermon;
  const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);

  try {
    const currentSermonListSnapshot = await getDocs(
      collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter)
    );
    const currentSermonLists = currentSermonListSnapshot.docs.map((snapshot) => snapshot.data());
    const currentCanonicalSermonLists = await resolveCanonicalSermonLists(originalSermon, currentSermonLists);
    const nextCanonicalSermonLists = await resolveCanonicalSermonLists(sermon, sermonList);

    const currentCanonicalIds = new Set(currentCanonicalSermonLists.map((list) => list.id));
    const nextCanonicalIds = new Set(nextCanonicalSermonLists.map((list) => list.id));
    const listsToAdd = nextCanonicalSermonLists.filter((list) => !currentCanonicalIds.has(list.id));
    const listsToRemove = currentSermonLists.filter(
      (list) => currentCanonicalIds.has(list.id) && !nextCanonicalIds.has(list.id)
    );
    const publishedListsToRemove = listsToRemove.filter(
      (list) =>
        list.uploadStatus?.status === uploadStatus.UPLOADED &&
        Boolean(list.uploadStatus.listItemId) &&
        Boolean(normalizeString(list.subsplashId))
    );

    const previousSeriesId = normalizeString(originalSermon.seriesId);
    const nextSeriesId = normalizeString(sermon.seriesId);
    const previousSeriesPublication = await getSeriesPublicationState(previousSeriesId, sermon.id);
    const unpublishSeries = Boolean(previousSeriesId && previousSeriesPublication.published && previousSeriesId !== nextSeriesId);
    const publishSeries = Boolean(nextSeriesId && previousSeriesId !== nextSeriesId);
    const metadataChanged = hasRemoteMetadataChanges(originalSermon, sermon);

    let activeSubsplashId = normalizeString(originalSermon.subsplashId);
    const unpublishStrategy = getSubsplashUnpublishStrategy({
      hasSubsplashId: Boolean(activeSubsplashId),
      publishedListCount: currentSermonLists.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED).length,
      listCountToUnpublish: publishedListsToRemove.length,
      seriesPublished: previousSeriesPublication.published,
      unpublishSeries,
      publishListCount: listsToAdd.length,
      publishSeries,
    });

    let soundCloudTrackUrlUpdate: string | undefined;
    if (normalizeString(originalSermon.soundCloudTrackId) && metadataChanged) {
      const editSoundCloudSermon = createFunctionV2<
        EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA,
        EditSoundCloudSermonReturnType
      >('editSoundCloudSermon');
      const soundCloudResult = await editSoundCloudSermon({
        trackId: originalSermon.soundCloudTrackId as string,
        title: sermon.title,
        description: sermon.description,
        tags: [sermon.subtitle, ...sermon.topics],
        speakers: sermon.speakers.map((speaker) => speaker.name),
        imageSource: getSquareImageDownloadLink(sermon),
      });
      soundCloudTrackUrlUpdate = soundCloudResult?.soundCloudTrackUrl;
    }

    if (unpublishStrategy === 'delete_media' && activeSubsplashId) {
      const deleteFromSubsplash = createFunctionV2<{ subsplashId: string; operationKey: string }, unknown>('deletefromsubsplash');
      await deleteFromSubsplash({
        subsplashId: activeSubsplashId,
        operationKey: createOperationKey('edit-sermon-delete-subsplash', sermon.id),
      });
      activeSubsplashId = undefined;
    } else {
      if ((listsToAdd.length > 0 || publishSeries) && !activeSubsplashId) {
        activeSubsplashId = await ensureSubsplashMediaItem(sermon);
      }

      if (publishedListsToRemove.length > 0) {
        if (!activeSubsplashId) {
          throw new Error('Cannot remove published list memberships without a Subsplash media item id.');
        }
        await removeSermonFromLists(sermon.id, activeSubsplashId, publishedListsToRemove);
      }

      if (unpublishSeries) {
        const mediaItemIdToRemove = previousSeriesPublication.mediaItemId || activeSubsplashId;
        if (!mediaItemIdToRemove || !previousSeriesId) {
          throw new Error('Cannot remove sermon from series without a Subsplash media item id.');
        }
        await unpublishSeriesMembership(previousSeriesId, sermon.id, mediaItemIdToRemove);
      }

      const addedPublishedLists = activeSubsplashId
        ? await addSermonToLists(sermon, activeSubsplashId, listsToAdd)
        : new Map<string, AddedPublishedListResult>();

      if (publishSeries) {
        if (!activeSubsplashId || !nextSeriesId) {
          throw new Error('Cannot publish sermon to series without a Subsplash media item id.');
        }
        await publishSeriesMembership(nextSeriesId, sermon.id, activeSubsplashId);
      }

      if (activeSubsplashId && metadataChanged) {
        const editSubsplashSermon = createFunctionV2<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>('editSubsplashSermon');
        await editSubsplashSermon({
          subsplashId: activeSubsplashId,
          title: sermon.title,
          subtitle: sermon.subtitle,
          description: sermon.description,
          speakers: sermon.speakers,
          topics: sermon.topics,
          images: sermon.images,
          date: new Date(sermon.dateMillis),
          operationKey: createOperationKey('edit-sermon-subsplash-edit', sermon.id),
        });
      }

      const currentListItemSnapshot = await getDocs(
        query(collectionGroup(firestore, 'listItems'), where('id', '==', sermon.id)).withConverter(listConverter)
      );
      const currentListItemIds = new Set(
        currentListItemSnapshot.docs
          .map((snapshot) => getListIdFromListItemDoc(snapshot))
          .filter((listId): listId is string => Boolean(listId))
      );
      const finalCanonicalListMap = new Map<string, SermonList>();
      const currentSermonListMap = new Map(currentSermonLists.map((list) => [list.id, list]));

      nextCanonicalSermonLists.forEach((list) => {
        const currentList = currentSermonListMap.get(list.id);
        const addedPublishedList = addedPublishedLists.get(list.id);
        if (addedPublishedList) {
          finalCanonicalListMap.set(list.id, {
            ...addedPublishedList.list,
            uploadStatus: addedPublishedList.uploadStatus,
            publishGeneration: currentList?.publishGeneration ?? 0,
          });
          return;
        }

        finalCanonicalListMap.set(list.id, {
          ...currentList,
          ...list,
          uploadStatus: currentList?.uploadStatus ?? { status: uploadStatus.NOT_UPLOADED },
          publishGeneration: currentList?.publishGeneration ?? 0,
        });
      });

      const sermonForLocalWrite: Sermon = {
        ...sermon,
        status: {
          ...sermon.status,
          subsplash: activeSubsplashId ? uploadStatus.UPLOADED : uploadStatus.NOT_UPLOADED,
        },
        ...(activeSubsplashId ? { subsplashId: activeSubsplashId } : {}),
      };
      if (!activeSubsplashId) {
        delete sermonForLocalWrite.subsplashId;
      }
      if (soundCloudTrackUrlUpdate) {
        sermonForLocalWrite.soundCloudTrackUrl = soundCloudTrackUrlUpdate;
      }

      const batch = writeBatch(firestore);
      const staleSermonListIds = currentSermonLists
        .map((list) => list.id)
        .filter((listId) => !finalCanonicalListMap.has(listId));
      const staleListItemIds = Array.from(currentListItemIds).filter((listId) => !finalCanonicalListMap.has(listId));

      batch.update(sermonRef, {
        ...buildEditableSermonPatch(sermonForLocalWrite),
        ...(activeSubsplashId ? { subsplashId: activeSubsplashId } : { subsplashId: deleteField() }),
        ...(soundCloudTrackUrlUpdate
          ? { soundCloudTrackUrl: soundCloudTrackUrlUpdate }
          : {}),
        searchPending: true,
        searchIndexedAtMillis: deleteField(),
        searchSyncError: deleteField(),
      });

      staleSermonListIds.forEach((listId) => {
        batch.delete(doc(firestore, `sermons/${sermon.id}/sermonLists/${listId}`));
      });
      staleListItemIds.forEach((listId) => {
        batch.delete(doc(firestore, `lists/${listId}/listItems/${sermon.id}`));
      });

      finalCanonicalListMap.forEach((finalList, listId) => {
        batch.set(
          doc(firestore, `sermons/${sermon.id}/sermonLists/${listId}`).withConverter(sermonListConverter),
          finalList
        );

        const listItemRef = doc(firestore, `lists/${listId}/listItems/${sermon.id}`);
        const addedPublishedList = addedPublishedLists.get(listId);
        const listItemExists = currentListItemIds.has(listId);
        const mirroredListItemWrite = listItemExists
          ? buildMirroredListItemPatch(sermonForLocalWrite, {
              uploadStatus: finalList.uploadStatus,
              physicalPlacement: addedPublishedList?.physicalPlacement,
            })
          : buildMirroredListItemData(sermonForLocalWrite, {
              uploadStatus: finalList.uploadStatus,
              physicalPlacement: addedPublishedList?.physicalPlacement,
            });

        batch.set(listItemRef, mirroredListItemWrite, { merge: true });
      });

      await batch.commit();
      await persistSeriesMembershipChange(
        sermonForLocalWrite,
        previousSeriesId,
        nextSeriesId,
        activeSubsplashId,
        publishSeries && Boolean(activeSubsplashId)
      );
      return;
    }

    const currentListItemSnapshot = await getDocs(
      query(collectionGroup(firestore, 'listItems'), where('id', '==', sermon.id)).withConverter(listConverter)
    );
    const currentListItemIds = new Set(
      currentListItemSnapshot.docs
        .map((snapshot) => getListIdFromListItemDoc(snapshot))
        .filter((listId): listId is string => Boolean(listId))
    );
    const finalCanonicalIds = new Set(nextCanonicalSermonLists.map((list) => list.id));
    const finalSermonForLocalWrite: Sermon = {
      ...sermon,
      status: {
        ...sermon.status,
        subsplash: uploadStatus.NOT_UPLOADED,
      },
    };
    delete finalSermonForLocalWrite.subsplashId;
    if (soundCloudTrackUrlUpdate) {
      finalSermonForLocalWrite.soundCloudTrackUrl = soundCloudTrackUrlUpdate;
    }

    const batch = writeBatch(firestore);
    batch.update(sermonRef, {
      ...buildEditableSermonPatch(finalSermonForLocalWrite),
      subsplashId: deleteField(),
      ...(soundCloudTrackUrlUpdate ? { soundCloudTrackUrl: soundCloudTrackUrlUpdate } : {}),
      searchPending: true,
      searchIndexedAtMillis: deleteField(),
      searchSyncError: deleteField(),
    });

    currentSermonListSnapshot.docs.forEach((snapshot) => {
      if (!finalCanonicalIds.has(snapshot.id)) {
        batch.delete(snapshot.ref);
      }
    });
    currentListItemIds.forEach((listId) => {
      if (!finalCanonicalIds.has(listId)) {
        batch.delete(doc(firestore, `lists/${listId}/listItems/${sermon.id}`));
      }
    });

    nextCanonicalSermonLists.forEach((list) => {
      batch.set(
        doc(firestore, `sermons/${sermon.id}/sermonLists/${list.id}`).withConverter(sermonListConverter),
        {
          ...list,
          uploadStatus: { status: uploadStatus.NOT_UPLOADED },
          publishGeneration: 0,
        }
      );
      const listItemRef = doc(firestore, `lists/${list.id}/listItems/${sermon.id}`);
      const listItemExists = currentListItemIds.has(list.id);
      batch.set(
        listItemRef,
        listItemExists
          ? buildMirroredListItemPatch(finalSermonForLocalWrite)
          : buildMirroredListItemData(finalSermonForLocalWrite),
        { merge: true }
      );
    });

    await batch.commit();
    await persistSeriesMembershipChange(finalSermonForLocalWrite, previousSeriesId, nextSeriesId, undefined, false);
  } catch (error) {
    showMutationFailure(error, sermon.id);
  }
};

export default editSermon;
