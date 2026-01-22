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
  });

  it('should create a series with title, subtitle, and summary', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Complete Series',
        subtitle: 'A subtitle for the series',
        summary: '<p>This is the summary</p>',
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.name).toBe('Complete Series');
    expect(firestoreSeries?.subtitle).toBe('A subtitle for the series');
    expect(firestoreSeries?.summary).toBe('<p>This is the summary</p>');
  });

  it('should return subsplash metadata in the response', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Metadata Test Series',
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
      },
    };

    const result = await createSeriesHandler(request);

    expect(result.status).toBe('success');

    const firestoreSeries = await getSeriesBySubsplashId(result.subsplashId!);
    expect(firestoreSeries?.itemCount).toBe(0);
    expect(firestoreSeries?.publishedItemCount).toBe(0);
  });

  it('should set status to draft by default', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Draft Series',
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
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should reject requests from users without publish role', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'viewer' } },
      data: {
        title: 'Viewer Series',
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should allow admin role to create series', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: 'Admin Series',
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
      },
    };

    const result = await createSeriesHandler(request);
    expect(result.status).toBe('success');
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
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();
  });

  it('should handle whitespace-only title as invalid', async () => {
    const request: TestRequest<CreateSeriesInputType> = {
      auth: { token: { role: 'admin' } },
      data: {
        title: '   ',
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
      },
    };

    await expect(createSeriesHandler(request)).rejects.toThrow();

    // Verify no Firestore document was created
    const allSeries = await getAllSeries();
    expect(allSeries).toHaveLength(0);
  });
});
