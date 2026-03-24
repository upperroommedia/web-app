import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminSeriesItemConverter, firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { getAllSeriesItemsAcrossStatuses } from './seriesHelpers';
import type {
  GetSeriesRemoteStateOutputType,
  GetSeriesRemoteStateRemoteItem,
} from '../../../packages/contracts/getSeriesRemoteState';
import type { SeriesItem } from '@upperroom/shared/types/SeriesItem';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';

const firestoreDB = firebaseAdmin.firestore();

const createRemoteMembershipHash = (remoteItems: Array<{ id: string; status: string }>): string => {
  if (remoteItems.length === 0) {
    return 'empty';
  }

  return remoteItems
    .map((item) => `${item.id}:${item.status}`)
    .join('|');
};

const compareRemoteItems = (
  left: { position: number | null; updated_at?: string; id: string },
  right: { position: number | null; updated_at?: string; id: string }
): number => {
  const leftPosition = left.position ?? Number.NEGATIVE_INFINITY;
  const rightPosition = right.position ?? Number.NEGATIVE_INFINITY;
  if (leftPosition !== rightPosition) {
    return rightPosition - leftPosition;
  }

  const leftUpdatedAt = left.updated_at ?? '';
  const rightUpdatedAt = right.updated_at ?? '';
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt.localeCompare(leftUpdatedAt);
  }

  return left.id.localeCompare(right.id);
};

const getRemoteSeriesItemPrimaryImage = (
  remoteItem: {
    _embedded?: {
      images?: Array<{
        id: string;
        type?: string;
      }>;
    };
  }
): { imageUrl?: string; imageType?: string } | undefined => {
  const image = remoteItem._embedded?.images?.find((candidate) => candidate.type === 'square')
    || remoteItem._embedded?.images?.find((candidate) => candidate.type === 'wide')
    || remoteItem._embedded?.images?.find((candidate) => candidate.type === 'banner')
    || remoteItem._embedded?.images?.[0];

  if (!image?.id) {
    return undefined;
  }

  return {
    imageUrl: `https://images.subsplash.com/image.jpg?id=${image.id}`,
    imageType: image.type,
  };
};

export const loadSeriesRemoteState = async (
  firestoreSeriesId: string,
  subsplashSeriesId: string,
  token: string
): Promise<GetSeriesRemoteStateOutputType> => {
  const [remoteItemsRaw, localSeriesItemsSnapshot] = await Promise.all([
    getAllSeriesItemsAcrossStatuses(subsplashSeriesId, token),
    firestoreDB
      .collection(`series/${firestoreSeriesId}/seriesItems`)
      .withConverter(firestoreAdminSeriesItemConverter)
      .get(),
  ]);

  const localSeriesItems = localSeriesItemsSnapshot.docs.map((doc) => doc.data());
  const sermonDocs = await Promise.all(
    localSeriesItems.map((item) =>
      firestoreDB
        .collection('sermons')
        .doc(item.id)
        .withConverter(firestoreAdminSermonConverter)
        .get()
    )
  );
  const sermonsById = new Map<string, Sermon>(
    sermonDocs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()!])
  );

  const localSeriesItemByMediaItemId = new Map<string, SeriesItem>();
  localSeriesItems.forEach((item) => {
    const sermon = sermonsById.get(item.id);
    const mediaItemId = item.sermonSubsplashId || sermon?.subsplashId;
    if (mediaItemId) {
      localSeriesItemByMediaItemId.set(mediaItemId, item);
    }
  });

  const remoteItemsSorted = [...remoteItemsRaw].sort(compareRemoteItems);
  const remoteItems: GetSeriesRemoteStateRemoteItem[] = remoteItemsSorted.map((remoteItem, index) => {
    const matchedSeriesItem = localSeriesItemByMediaItemId.get(remoteItem.id);
    const matchedSermon = matchedSeriesItem ? sermonsById.get(matchedSeriesItem.id) : undefined;
    const displayImage = matchedSermon?.images?.find((image) => image.type === 'square')
      || matchedSermon?.images?.find((image) => image.type === 'wide')
      || matchedSermon?.images?.[0];
    const remoteImage = getRemoteSeriesItemPrimaryImage(remoteItem);

    return {
      mediaItemId: remoteItem.id,
      logicalPosition: index + 1,
      remoteStatus: remoteItem.status,
      title: matchedSermon?.title || remoteItem.title,
      subtitle: matchedSermon?.dateString,
      imageUrl: displayImage?.downloadLink || remoteImage?.imageUrl,
      imageType: displayImage?.type || remoteImage?.imageType,
      matchedSermonId: matchedSeriesItem?.id,
      matchedSeriesItemId: matchedSeriesItem?.id,
      isTrackedInFirebase: Boolean(matchedSeriesItem),
      publishedToSubsplashInFirebase: matchedSeriesItem?.publishedToSubsplash === true,
      isSubsplashOnlyPlaceholder: !matchedSeriesItem,
      canReorder: true,
      canUnpublish: true,
      canRemoveLocally: Boolean(matchedSeriesItem),
    };
  });

  return {
    firestoreSeriesId,
    subsplashSeriesId,
    remoteMembershipHash: createRemoteMembershipHash(remoteItemsSorted),
    totalRemoteItems: remoteItems.length,
    trackedFirebaseItems: remoteItems.filter((item) => item.isTrackedInFirebase).length,
    remoteOnlyItemCount: remoteItems.filter((item) => item.isSubsplashOnlyPlaceholder).length,
    canReorder: true,
    remoteItems,
  };
};

export const createSeriesRemoteMembershipHash = createRemoteMembershipHash;
