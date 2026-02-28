/**
 * Tests for createSeries Firebase function
 * TDD approach: Tests written first
 */

import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, getSeriesBySubsplashId, getAllSeries } from './firestoreHelpers';
import createSeries, { CreateSeriesInputType, CreateSeriesOutputType } from '../../createSeries';

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

  it('should set status to draft by default', async () => {
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
    expect(firestoreSeries?.status).toBe('draft');
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
