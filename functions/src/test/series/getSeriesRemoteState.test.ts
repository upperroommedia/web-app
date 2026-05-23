import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import getSeriesRemoteState from '../../getSeriesRemoteState';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import { firestoreAdminSeriesItemConverter, firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { createEmptySermon } from '../../models/defaults';
import type {
  GetSeriesRemoteStateInputType,
  GetSeriesRemoteStateOutputType,
} from '../../../../packages/contracts/getSeriesRemoteState';

type GetSeriesRemoteStateHandler = (
  request: TestRequest<GetSeriesRemoteStateInputType>
) => Promise<GetSeriesRemoteStateOutputType>;

const getSeriesRemoteStateHandler = getSeriesRemoteState as unknown as GetSeriesRemoteStateHandler;
const firestoreDB = firebaseAdmin.firestore();

describe('getSeriesRemoteState', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('returns tracked items and remote-only placeholders from Subsplash', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Remote State Series');
    const trackedRemoteItem = subsplashSeriesMock.createMediaItem('Tracked Remote Item', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const remoteOnlyItem = subsplashSeriesMock.createMediaItem('Remote Only Item', {
      seriesId: subsplashSeries.id,
      position: 2,
    });
    remoteOnlyItem._embedded = {
      ...remoteOnlyItem._embedded,
      images: [{ id: 'remote-image-1', type: 'square' }],
    };

    const firestoreSeriesId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Remote State Series',
      itemCount: 1,
    });

    const sermon = {
      ...createEmptySermon('test-user'),
      id: 'sermon-tracked',
      title: 'Tracked Remote Item',
      subsplashId: trackedRemoteItem.id,
      dateMillis: Date.now(),
      createdAtMillis: Date.now(),
      editedAtMillis: Date.now(),
    };

    await firestoreDB
      .collection('sermons')
      .doc(sermon.id)
      .withConverter(firestoreAdminSermonConverter)
      .set(sermon);

    await firestoreDB
      .collection(`series/${firestoreSeriesId}/seriesItems`)
      .doc(sermon.id)
      .withConverter(firestoreAdminSeriesItemConverter)
      .set({
        id: sermon.id,
        position: 1,
        addedAt: null,
        publishedToSubsplash: true,
        sermonSubsplashId: trackedRemoteItem.id,
      });

    const request: TestRequest<GetSeriesRemoteStateInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreSeriesId,
      },
    };

    const result = await getSeriesRemoteStateHandler(request);

    expect(result.remoteItems).toHaveLength(2);
    expect(result.remoteOnlyItemCount).toBe(1);
    expect(result.trackedFirebaseItems).toBe(1);
    expect(result.remoteMembershipHash).toContain(remoteOnlyItem.id);
    expect(result.mediaItemMembershipHash).toBe([remoteOnlyItem.id, trackedRemoteItem.id].sort().join('|'));

    const trackedItem = result.remoteItems.find((item) => item.mediaItemId === trackedRemoteItem.id);
    expect(trackedItem).toMatchObject({
      matchedSermonId: sermon.id,
      isTrackedInFirebase: true,
      isSubsplashOnlyPlaceholder: false,
    });

    const placeholderItem = result.remoteItems.find((item) => item.mediaItemId === remoteOnlyItem.id);
    expect(placeholderItem).toMatchObject({
      isTrackedInFirebase: false,
      isSubsplashOnlyPlaceholder: true,
      imageUrl: 'https://images.subsplash.com/image.jpg?id=remote-image-1',
    });
  });
});
