/**
 * Tests for deleteSeries Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import {
  clearFirestore,
  createSeriesDocument,
  getSeriesBySubsplashId,
  getAllSeries,
} from './firestoreHelpers';
import deleteSeries, { DeleteSeriesInputType, DeleteSeriesOutputType } from '../../deleteSeries';

// Type for the handler function
type DeleteSeriesHandler = (request: TestRequest<DeleteSeriesInputType>) => Promise<DeleteSeriesOutputType>;
const deleteSeriesHandler = deleteSeries as unknown as DeleteSeriesHandler;

describe('deleteSeries - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should delete an existing series with no items', async () => {
    // Create series in Subsplash mock and Firestore
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
      },
    };

    const result = await deleteSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify Firestore document was deleted
    const firestoreSeries = await getSeriesBySubsplashId(subsplashSeries.id);
    expect(firestoreSeries).toBeNull();

    // Verify Subsplash series was deleted
    expect(subsplashSeriesMock.getSeries(subsplashSeries.id)).toBeUndefined();
  });

  it('should delete a series with items and unassign them', async () => {
    // Create series with items
    const subsplashSeries = subsplashSeriesMock.createSeries('Series With Items');
    const item1 = subsplashSeriesMock.createMediaItem('Item 1', {
      seriesId: subsplashSeries.id,
      position: 1,
    });
    const item2 = subsplashSeriesMock.createMediaItem('Item 2', {
      seriesId: subsplashSeries.id,
      position: 2,
    });

    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Series With Items',
      itemCount: 2,
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
      },
    };

    const result = await deleteSeriesHandler(request);

    expect(result.status).toBe('success');

    // Verify items were unassigned from series
    const updatedItem1 = subsplashSeriesMock.getMediaItem(item1.id);
    const updatedItem2 = subsplashSeriesMock.getMediaItem(item2.id);
    expect(updatedItem1?._embedded?.['media-series']).toBeNull();
    expect(updatedItem2?._embedded?.['media-series']).toBeNull();
  });

  it('should handle series not found in Firestore', async () => {
    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId: 'non-existent-id',
      },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });

  it('should handle series already deleted in Subsplash', async () => {
    // Create only in Firestore, not in Subsplash mock
    const firestoreId = await createSeriesDocument({
      subsplashId: 'non-existent-subsplash-id',
      name: 'Orphaned Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
      },
    };

    // Should succeed - gracefully handle missing Subsplash series
    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');

    // Firestore doc should still be deleted
    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(0);
  });
});

describe('deleteSeries - Authentication', () => {
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
      data: {
        firestoreId,
      },
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
      data: {
        firestoreId,
      },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });

  it('should allow admin role to delete series', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
      },
    };

    const result = await deleteSeriesHandler(request);
    expect(result.status).toBe('success');
  });
});

describe('deleteSeries - Validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject requests without firestoreId', async () => {
    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId: '',
      },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();
  });
});

describe('deleteSeries - Error Handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should handle Subsplash API failure gracefully', async () => {
    const subsplashSeries = subsplashSeriesMock.createSeries('Test Series');
    const firestoreId = await createSeriesDocument({
      subsplashId: subsplashSeries.id,
      name: 'Test Series',
    });

    // Inject network failure
    networkFailureInjector.registerFailure(`deleteSeries:${subsplashSeries.id}`, () => true);

    const request: TestRequest<DeleteSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
      },
    };

    await expect(deleteSeriesHandler(request)).rejects.toThrow();

    // Verify Firestore document was not deleted
    const firestoreSeries = await getSeriesBySubsplashId(subsplashSeries.id);
    expect(firestoreSeries).not.toBeNull();
  });
});
