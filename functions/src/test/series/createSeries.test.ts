/**
 * Tests for createSeries Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument, getSeriesBySubsplashId, getAllSeries } from './firestoreHelpers';
import createSeries, { CreateSeriesInputType, CreateSeriesOutputType } from '../../createSeries';
import * as seriesHelpers from '../../helpers/seriesHelpers';
import { claimOperation } from '../../locks/withIdempotency';

// Type for the handler function
type CreateSeriesHandler = (request: TestRequest<CreateSeriesInputType>) => Promise<CreateSeriesOutputType>;
const createSeriesHandler = createSeries as unknown as CreateSeriesHandler;

const TEST_USER_ID = 'test-user-123';

describe('createSeries - Basic Functionality', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should create a new series with title', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'My Test Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    expect(result.firestoreId).toBeDefined();
    expect(result.subsplashId).toBeDefined();

    // Verify Firestore document was created
    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries).not.toBeNull();
    expect(firestoreSeries?.name).toBe('My Test Series');
    expect(firestoreSeries?.subsplashId).toBe(result.subsplashId);
    expect(firestoreSeries?.ownerId).toBe(TEST_USER_ID);
  });

  it('should create a series with derived subtitle and summary', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Complete Series',
        summary: '<p>This is the summary</p>',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.name).toBe('Complete Series');
    expect(firestoreSeries?.subtitle).toBe('0 part series');
    expect(firestoreSeries?.summary).toBe('<p>This is the summary</p>');
  });

  it('should return subsplash metadata in the response', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Metadata Test Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    expect(result.slug).toBeDefined();
    expect(result.slug).toBe('metadata-test-series');
  });

  it('should initialize series with zero item counts', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Empty Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.itemCount).toBe(0);
    expect(firestoreSeries?.publishedItemCount).toBe(0);
    expect(firestoreSeries?.subtitle).toBe('0 part series');
  });

  it('should publish the remote series immediately after creation', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Draft Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.status).toBe('published');
  });

  it('should persist provided images when syncing to Subsplash', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Series With Synced Images',
        ownerId: TEST_USER_ID,
        images: [
          { id: 'img-square', type: 'square', downloadLink: 'https://example.com/square.jpg', name: 'Square' },
          { id: 'img-wide', type: 'wide', downloadLink: 'https://example.com/wide.jpg', name: 'Wide' },
        ],
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries).not.toBeNull();
    expect(firestoreSeries?.images).toHaveLength(2);
    expect(firestoreSeries?.images[0].id).toBe('img-square');
    expect(firestoreSeries?.images[1].id).toBe('img-wide');
  });

  it('should patch Subsplash series images using subsplashId when local image ids differ', async () => {
    subsplashSeriesMock.createImage('square', { id: 'subsplash-square', title: 'Square' });
    subsplashSeriesMock.createImage('wide', { id: 'subsplash-wide', title: 'Wide' });
    subsplashSeriesMock.createImage('banner', { id: 'subsplash-banner', title: 'Banner' });

    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Series With Remote Image Refs',
        ownerId: TEST_USER_ID,
        images: [
          {
            id: 'firestore-square',
            subsplashId: 'subsplash-square',
            type: 'square',
            downloadLink: 'https://example.com/square.jpg',
            name: 'Square',
          },
          {
            id: 'firestore-wide',
            subsplashId: 'subsplash-wide',
            type: 'wide',
            downloadLink: 'https://example.com/wide.jpg',
            name: 'Wide',
          },
          {
            id: 'firestore-banner',
            subsplashId: 'subsplash-banner',
            type: 'banner',
            downloadLink: 'https://example.com/banner.jpg',
            name: 'Banner',
          },
        ],
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');

    const remoteSeries = subsplashSeriesMock.getSeries(result.subsplashId!);
    expect(remoteSeries?._embedded?.images).toEqual([
      { id: 'subsplash-square', type: 'square' },
      { id: 'subsplash-wide', type: 'wide' },
      { id: 'subsplash-banner', type: 'banner' },
    ]);
  });

  it('should repair remote image refs when the stored Subsplash image type does not match Firebase', async () => {
    subsplashSeriesMock.createImage('square', { id: 'subsplash-square', title: 'Square' });
    subsplashSeriesMock.createImage('square', { id: 'subsplash-wide', title: 'Wide But Wrong Type' });
    subsplashSeriesMock.createImage('square', { id: 'subsplash-banner', title: 'Banner But Wrong Type' });

    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Series With Repaired Image Refs',
        ownerId: TEST_USER_ID,
        images: [
          {
            id: 'firebase-square',
            subsplashId: 'subsplash-square',
            type: 'square',
            downloadLink: 'https://example.com/square.jpg',
            name: 'Square',
          },
          {
            id: 'firebase-wide',
            subsplashId: 'subsplash-wide',
            type: 'wide',
            downloadLink: 'https://example.com/wide.jpg',
            name: 'Wide',
          },
          {
            id: 'firebase-banner',
            subsplashId: 'subsplash-banner',
            type: 'banner',
            downloadLink: 'https://example.com/banner.jpg',
            name: 'Banner',
          },
        ],
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');

    const remoteSeries = subsplashSeriesMock.getSeries(result.subsplashId!);
    expect(remoteSeries?._embedded?.images).toHaveLength(3);
    expect(remoteSeries?._embedded?.images?.[0]).toEqual({ id: 'subsplash-square', type: 'square' });
    expect(remoteSeries?._embedded?.images?.[1].id).not.toBe('subsplash-wide');
    expect(remoteSeries?._embedded?.images?.[1].type).toBe('wide');
    expect(remoteSeries?._embedded?.images?.[2].id).not.toBe('subsplash-banner');
    expect(remoteSeries?._embedded?.images?.[2].type).toBe('banner');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.images[0].subsplashId).toBe('subsplash-square');
    expect(firestoreSeries?.images[1].subsplashId).toBe(remoteSeries?._embedded?.images?.[1].id);
    expect(firestoreSeries?.images[2].subsplashId).toBe(remoteSeries?._embedded?.images?.[2].id);
  });

  it('should update existing firestore series when firestoreId is provided', async () => {
    const existingSeriesId = await createSeriesDocument({
      subsplashId: '',
      name: 'Local Draft Series',
      summary: 'Local summary',
      images: [{ id: 'existing-img', type: 'square', downloadLink: 'https://example.com/existing.jpg' }],
      status: 'draft',
    });

    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId: existingSeriesId,
        title: 'Local Draft Series',
        summary: 'Local summary',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.firestoreId).toBe(existingSeriesId);

    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(1);
    expect(allSeries[0].id).toBe(existingSeriesId);
    expect(allSeries[0].subsplashId).toBe(result.subsplashId);
    expect(allSeries[0].images).toHaveLength(1);
    expect(allSeries[0].images[0].id).toBe('existing-img');
  });
});

describe('createSeries - Authentication', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject unauthenticated requests', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: undefined,
      data: {
        title: 'Unauthorized Series',
        ownerId: TEST_USER_ID,
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role when syncing to Subsplash', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'viewer' } },
      data: {
        title: 'Viewer Series',
        ownerId: TEST_USER_ID,
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should allow admin role to create series', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Admin Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');
  });

  it('should allow publisher role to create series', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'publisher' } },
      data: {
        title: 'Publisher Series',
        ownerId: TEST_USER_ID,
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');
  });

  it('should allow uploader role to create local-only series with skipSubsplash', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'uploader' } },
      data: {
        title: 'Uploader Series',
        ownerId: TEST_USER_ID,
        skipSubsplash: true,
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');
    expect(result.subsplashId).toBe('');  // Not synced to Subsplash
  });
});

describe('createSeries - Validation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should reject requests without title', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: '',
        ownerId: TEST_USER_ID,
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should handle whitespace-only title as invalid', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: '   ',
        ownerId: TEST_USER_ID,
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests without ownerId', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Missing Owner Series',
        ownerId: '',
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });
});

describe('createSeries - Error Handling', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should handle Subsplash API failure gracefully', async () => {
    // Inject network failure
    networkFailureInjector.registerFailure('createSeries', () => true);

    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Failing Series',
        ownerId: TEST_USER_ID,
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();

    // Verify no Firestore document was created
    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(0);
  });
});

describe('createSeries - Local Only (skipSubsplash)', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('should create a local-only series without calling Subsplash', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Local Only Series',
        ownerId: TEST_USER_ID,
        skipSubsplash: true,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    expect(result.firestoreId).toBeDefined();
    expect(result.subsplashId).toBe('');

    // Verify Firestore document was created with empty subsplashId
    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(1);
    expect(allSeries[0].name).toBe('Local Only Series');
    expect(allSeries[0].subsplashId).toBe('');
    expect(allSeries[0].ownerId).toBe(TEST_USER_ID);
  });

  it('should create local-only series with derived subtitle and summary', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'uploader' } },
      data: {
        title: 'Full Local Series',
        summary: 'A local summary',
        ownerId: TEST_USER_ID,
        skipSubsplash: true,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    
    const allSeries = await getAllSeries();
    expect(allSeries[0].subtitle).toBe('0 part series');
    expect(allSeries[0].summary).toBe('A local summary');
  });

  it('should create local-only series with images', async () => {
    const testImages = [
      { id: 'img-1', type: 'square', downloadLink: 'https://example.com/square.jpg', name: 'square' },
      { id: 'img-2', type: 'wide', downloadLink: 'https://example.com/wide.jpg', name: 'wide' },
    ];

    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'uploader' } },
      data: {
        title: 'Series With Images',
        ownerId: TEST_USER_ID,
        skipSubsplash: true,
        images: testImages,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    
    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(1);
    expect(allSeries[0].images).toHaveLength(2);
    expect(allSeries[0].images[0].type).toBe('square');
    expect(allSeries[0].images[1].type).toBe('wide');
  });

  it('should create local-only series with empty images array when not provided', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'uploader' } },
      data: {
        title: 'Series Without Images',
        ownerId: TEST_USER_ID,
        skipSubsplash: true,
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');
    
    const allSeries = await getAllSeries();
    expect(allSeries[0].images).toEqual([]);
  });
});

describe('createSeries - Locking and Idempotency', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
    jest.restoreAllMocks();
  });

  it('should replay prior terminal result for duplicate operation key', async () => {
    const createSpy = jest.spyOn(seriesHelpers, 'createSubsplashSeries');
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Replay Create Series',
        ownerId: TEST_USER_ID,
        operationKey: 'create-op-replay-1',
      } as CreateSeriesInputType,
    };

    const firstResult = await createSeriesHandler(request);
    const secondResult = await createSeriesHandler(request);

    expect(firstResult).toEqual(secondResult);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('should return busy payload details when operation key is already in progress', async () => {
    const createSpy = jest.spyOn(seriesHelpers, 'createSubsplashSeries');
    await claimOperation('create-op-busy-1');
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Busy Create Series',
        ownerId: TEST_USER_ID,
        operationKey: 'create-op-busy-1',
      } as CreateSeriesInputType,
    };

    await expect(createSeriesHandler(request)).rejects.toMatchObject({
      code: 'aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['operation:create-op-busy-1'],
        wait_ms: 10000,
        retry_after_ms: 1000,
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('should release lock after failure so next operation key can proceed', async () => {
    let createCallCount = 0;
    networkFailureInjector.registerFailure('createSeries', () => {
      createCallCount += 1;
      return createCallCount === 1;
    });

    const firstRequest: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Create Lock Release',
        ownerId: TEST_USER_ID,
        operationKey: 'create-op-fail-1',
      } as CreateSeriesInputType,
    };

    await expect(createSeriesHandler(firstRequest)).rejects.toMatchObject({
      code: 'internal',
    });

    const secondRequest: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Create Lock Release',
        ownerId: TEST_USER_ID,
        operationKey: 'create-op-fail-2',
      } as CreateSeriesInputType,
    };

    await expect(createSeriesHandler(secondRequest)).resolves.toMatchObject({
      status: 'success',
    });
  });
});
