/**
 * Tests for deleteSeries Firebase function
 */

import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import {
  clearFirestore,
  createSeriesDocument,
  getAllSeries,
  getSeriesBySubsplashId,
} from './firestoreHelpers';
import deleteSeries, { DeleteSeriesInputType, DeleteSeriesOutputType } from '../../deleteSeries';

type DeleteSeriesHandler = (request: TestRequest<DeleteSeriesInputType>) => Promise<DeleteSeriesOutputType>;
const deleteSeriesHandler = deleteSeries as unknown as DeleteSeriesHandler;
const firestoreDB = firebaseAdmin.firestore();

const seedLocalSeriesMembership = async (firestoreSeriesId: string, sermonIds: string[]) => {
  const batch = firestoreDB.batch();
  sermonIds.forEach((sermonId, index) => {
    const seriesItemRef = firestoreDB.collection('series').doc(firestoreSeriesId).collection('seriesItems').doc(sermonId);
    const sermonRef = firestoreDB.collection('sermons').doc(sermonId);

    batch.set(seriesItemRef, {
      id: sermonId,
      position: index + 1,
      publishedToSubsplash: true,
      sermonSubsplashId: sermonId,
      addedAt: null,
    });
    batch.set(sermonRef, {
      id: sermonId,
      title: `Sermon ${sermonId}`,
      seriesId: firestoreSeriesId,
    });
  });
  await batch.commit();
};

const getSeriesItemsCount = async (firestoreSeriesId: string): Promise<number> => {
  const snapshot = await firestoreDB.collection('series').doc(firestoreSeriesId).collection('seriesItems').get();
  return snapshot.size;
};

const getSermonSeriesId = async (sermonId: string): Promise<string | undefined> => {
  const snapshot = await firestoreDB.collection('sermons').doc(sermonId).get();
  return snapshot.exists ? snapshot.data()?.seriesId : undefined;
};

describe('deleteSeries - Safe unlink then delete workflow', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should delete a series with no linked remote members', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);

    expect(result.status).toBe('success');
    expect(result.remoteUnlinkAttempted).toBe(0);
    expect(result.remoteUnlinkSucceeded).toBe(0);
    expect(result.remoteUnlinkSkippedNotFound).toBe(0);
    expect(result.remoteRemainingLinkedCount).toBe(0);
    expect(result.localSeriesItemsDeleted).toBe(0);
    expect(result.localSermonsUnlinked).toBe(0);

    expect(await getSeriesBySubsplashId(subsplashSeries.id)).toBeNull();
    expect(subsplashSeriesMock.getSeries(subsplashSeries.id)).toBeUndefined();
  });

  it('should unlink all remote members before deleting the series', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Series With Items');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      id: 'media-1',
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      id: 'media-2',
      seriesId: subsplashSeries.id,
      position: 2,
    });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Series With Items',
      itemCount: 2,
    });
    await seedLocalSeriesMembership(firestoreId, [item1.id, item2.id]);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);

    expect(result.status).toBe('success');
    expect(result.remoteUnlinkAttempted).toBe(2);
    expect(result.remoteUnlinkSucceeded).toBe(2);
    expect(result.remoteUnlinkSkippedNotFound).toBe(0);
    expect(result.remoteRemainingLinkedCount).toBe(0);
    expect(result.localSeriesItemsDeleted).toBe(2);
    expect(result.localSermonsUnlinked).toBe(2);

    expect(subsplashSeriesMock.getMediaItem(item1.id)?._embedded?.['media-series']).toBeNull();
    expect(subsplashSeriesMock.getMediaItem(item2.id)?._embedded?.['media-series']).toBeNull();
    expect(subsplashSeriesMock.getSeries(subsplashSeries.id)).toBeUndefined();
    expect(await getSeriesBySubsplashId(subsplashSeries.id)).toBeNull();

    const operationLog = subsplashSeriesMock.getOperationLog();
    const firstDeleteIndex = operationLog.findIndex((entry) => entry.type === 'deleteSeries');
    const lastUnlinkIndex = Math.max(...operationLog
      .map((entry, index) => (entry.type === 'unlink' ? index : -1))
      .filter((index) => index >= 0));
    expect(firstDeleteIndex).toBeGreaterThan(lastUnlinkIndex);

    expect(await getSermonSeriesId(item1.id)).toBeNull();
    expect(await getSermonSeriesId(item2.id)).toBeNull();
  });

  it('should abort when any unlink fails with non-404 error and keep local data unchanged', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Failure Series');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', { id: 'unlink-fail-1', seriesId: subsplashSeries.id });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', { id: 'unlink-fail-2', seriesId: subsplashSeries.id });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Failure Series',
      itemCount: 2,
    });
    await seedLocalSeriesMembership(firestoreId, [item1.id, item2.id]);

    networkFailureInjector.registerFailure(`patchMediaItem:${item2.id}`, () => true);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();

    expect(subsplashSeriesMock.getSeries(subsplashSeries.id)).toBeDefined();
    expect(await getSeriesBySubsplashId(subsplashSeries.id)).not.toBeNull();
    expect(await getSeriesItemsCount(firestoreId)).toBe(2);
    expect(await getSermonSeriesId(item1.id)).toBe(firestoreId);
    expect(await getSermonSeriesId(item2.id)).toBe(firestoreId);
    expect(subsplashSeriesMock.getOperationLog().some((entry) => entry.type === 'deleteSeries')).toBe(false);
  });

  it('should treat 404 while unlinking as already unlinked and continue when verification is clean', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('404 Series');
    const item = subsplashSeriesMock.createMediaItem('Item 404', {
      id: 'unlink-404-item',
      seriesId: subsplashSeries.id,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: '404 Series',
      itemCount: 1,
    });
    await seedLocalSeriesMembership(firestoreId, [item.id]);

    networkFailureInjector.registerFailure(`patchMediaItemNotFound:${item.id}`, () => {
      subsplashSeriesMock.mediaItems.delete(item.id);
      return true;
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.remoteUnlinkAttempted).toBe(1);
    expect(result.remoteUnlinkSucceeded).toBe(0);
    expect(result.remoteUnlinkSkippedNotFound).toBe(1);
    expect(result.remoteRemainingLinkedCount).toBe(0);
    expect(await getSeriesBySubsplashId(subsplashSeries.id)).toBeNull();
  });

  it('should abort if verification finds remaining linked remote items', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Verification Failure Series');
    const item = subsplashSeriesMock.createMediaItem('Primary Item', {
      id: 'verify-main',
      seriesId: subsplashSeries.id,
    });
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Verification Failure Series',
      itemCount: 1,
    });
    await seedLocalSeriesMembership(firestoreId, [item.id]);

    let getSeriesItemsCallCount = 0;
    networkFailureInjector.registerFailure(`getSeriesItems:${subsplashSeries.id}`, () => {
      getSeriesItemsCallCount += 1;
      if (getSeriesItemsCallCount === 4) {
        subsplashSeriesMock.createMediaItem('Late Linked Item', {
          id: 'verify-late-item',
          seriesId: subsplashSeries.id,
          position: 99,
        });
      }
      return false;
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();

    expect(subsplashSeriesMock.getSeries(subsplashSeries.id)).toBeDefined();
    expect(await getSeriesBySubsplashId(subsplashSeries.id)).not.toBeNull();
    expect(subsplashSeriesMock.getOperationLog().some((entry) => entry.type === 'deleteSeries')).toBe(false);
  });

  it('should still succeed when subsplash series is already missing', async () => {
    const firestoreId = await createSeriesDocument({
      subsplashId: 'non-existent-subsplash-id',
      name: 'Orphaned Series',
    });
    await seedLocalSeriesMembership(firestoreId, ['orphan-sermon-1']);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.remoteUnlinkAttempted).toBe(0);
    expect(result.remoteRemainingLinkedCount).toBe(0);
    expect(result.localSeriesItemsDeleted).toBe(1);
    expect(result.localSermonsUnlinked).toBe(1);
    expect((await getAllSeries())).toHaveLength(0);
  });

  it('should clean up local-only series (no subsplashId)', async () => {
    const firestoreId = await createSeriesDocument({
      subsplashId: '',
      name: 'Local Only Series',
      itemCount: 2,
    });
    await seedLocalSeriesMembership(firestoreId, ['local-sermon-1', 'local-sermon-2']);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.remoteUnlinkAttempted).toBe(0);
    expect(result.remoteUnlinkSucceeded).toBe(0);
    expect(result.remoteUnlinkSkippedNotFound).toBe(0);
    expect(result.remoteRemainingLinkedCount).toBe(0);
    expect(result.localSeriesItemsDeleted).toBe(2);
    expect(result.localSermonsUnlinked).toBe(2);
    expect(await getSeriesItemsCount(firestoreId)).toBe(0);
    expect(await getSermonSeriesId('local-sermon-1')).toBeNull();
    expect(await getSermonSeriesId('local-sermon-2')).toBeNull();
  });

  it('should support large local cleanup without hitting batch limits', async () => {
    const firestoreId = await createSeriesDocument({
      subsplashId: '',
      name: 'Large Series',
      itemCount: 260,
    });
    const sermonIds = Array.from({ length: 260 }, (_, index) => `large-sermon-${index + 1}`);
    await seedLocalSeriesMembership(firestoreId, sermonIds);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.localSeriesItemsDeleted).toBe(260);
    expect(result.localSermonsUnlinked).toBe(260);
    expect(await getSeriesItemsCount(firestoreId)).toBe(0);
  });
});

describe('deleteSeries - Authentication and validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject unauthenticated requests', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: undefined,
      data: { firestoreId },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'viewer' } },
      data: { firestoreId },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests without firestoreId', async () => {
    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId: '' },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });
});

describe('deleteSeries - Error handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should keep Firestore data when Subsplash delete fails', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Delete Failure Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Delete Failure Series',
    });
    await seedLocalSeriesMembership(firestoreId, ['delete-failure-sermon']);

    networkFailureInjector.registerFailure(`deleteSeries:${subsplashSeries.id}`, () => true);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: { firestoreId },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();

    expect(await getSeriesBySubsplashId(subsplashSeries.id)).not.toBeNull();
    expect(await getSeriesItemsCount(firestoreId)).toBe(1);
    expect(await getSermonSeriesId('delete-failure-sermon')).toBe(firestoreId);
  });
});
