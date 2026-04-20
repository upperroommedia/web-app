import type { Series } from '../../types/Series';

const updateDocMock = jest.fn();
const docMock = jest.fn();
const createFunctionV2Mock = jest.fn();
const serverTimestampMock = jest.fn(() => 'SERVER_TIMESTAMP');

jest.mock('../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  doc: (...args: string[]) => docMock(...args),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  serverTimestamp: () => serverTimestampMock(),
}));

jest.mock('../../utils/createFunction', () => ({
  __esModule: true,
  createFunctionV2: (...args: unknown[]) => createFunctionV2Mock(...args),
}));

const buildSeries = (overrides: Partial<Series>): Series => ({
  id: overrides.id ?? 'series-1',
  name: overrides.name ?? 'Series Name',
  subtitle: overrides.subtitle ?? '0 part series',
  summary: overrides.summary,
  images: overrides.images ?? [],
  itemCount: overrides.itemCount ?? 0,
  publishedItemCount: overrides.publishedItemCount ?? 0,
  status: overrides.status ?? 'draft',
  subsplashId: overrides.subsplashId ?? '',
  ownerId: overrides.ownerId ?? 'owner-1',
  slug: overrides.slug,
  shortCode: overrides.shortCode,
  position: overrides.position,
  createdAt: overrides.createdAt ?? null,
  updatedAt: overrides.updatedAt ?? null,
});

describe('saveSeriesMetadata', () => {
  beforeEach(() => {
    jest.resetModules();
    updateDocMock.mockReset().mockResolvedValue(undefined);
    docMock.mockReset().mockImplementation((...segments: string[]) => ({
      path: segments.filter((segment) => typeof segment === 'string').join('/'),
      id: segments[segments.length - 1],
    }));
    createFunctionV2Mock.mockReset();
    serverTimestampMock.mockClear();
  });

  it('updates draft series locally without calling the remote sync callable', async () => {
    const { saveSeriesMetadata } = await import('../../utils/saveSeriesMetadata');
    const series = buildSeries({
      subsplashId: '',
      publishedItemCount: 3,
      images: [{ id: 'image-1', type: 'square' } as Series['images'][number]],
    });

    const updatedSeries = await saveSeriesMetadata({
      series,
      name: '  Updated Draft Series  ',
      summary: '   ',
      images: series.images,
    });

    expect(createFunctionV2Mock).not.toHaveBeenCalled();
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'series/series-1', id: 'series-1' },
      {
        name: 'Updated Draft Series',
        subtitle: '3 part series',
        summary: null,
        images: series.images,
        updatedAt: 'SERVER_TIMESTAMP',
      }
    );
    expect(updatedSeries.name).toBe('Updated Draft Series');
    expect(updatedSeries.subtitle).toBe('3 part series');
    expect(updatedSeries.summary).toBeUndefined();
  });

  it('routes published series saves through the series metadata callable', async () => {
    const updateSeriesMetadataCallable = jest.fn().mockResolvedValue({
      status: 'success',
      firestoreId: 'series-1',
      subsplashId: 'subsplash-series-1',
      title: 'Published Series',
      subtitle: '4 part series',
      summary: undefined,
      images: [{ id: 'image-1', type: 'square' }],
      remoteStatus: 'published',
      slug: 'published-series',
      shortCode: 'short-code',
      position: 4,
    });
    createFunctionV2Mock.mockReturnValue(updateSeriesMetadataCallable);

    const { saveSeriesMetadata } = await import('../../utils/saveSeriesMetadata');
    const series = buildSeries({
      name: 'Before Save',
      subsplashId: 'subsplash-series-1',
      status: 'published',
      publishedItemCount: 4,
      images: [{ id: 'image-1', type: 'square' } as Series['images'][number]],
    });

    const updatedSeries = await saveSeriesMetadata({
      series,
      name: '  Published Series  ',
      summary: '   ',
      images: series.images,
    });

    expect(updateDocMock).not.toHaveBeenCalled();
    expect(createFunctionV2Mock).toHaveBeenCalledWith('updateseriesmetadata');
    expect(updateSeriesMetadataCallable).toHaveBeenCalledWith({
      firestoreId: 'series-1',
      title: 'Published Series',
      summary: null,
      images: series.images,
    });
    expect(updatedSeries.name).toBe('Published Series');
    expect(updatedSeries.subtitle).toBe('4 part series');
    expect(updatedSeries.summary).toBeUndefined();
    expect(updatedSeries.status).toBe('published');
    expect(updatedSeries.slug).toBe('published-series');
  });

  it('preserves full local image metadata when the remote callable returns minimal image refs', async () => {
    const updateSeriesMetadataCallable = jest.fn().mockResolvedValue({
      status: 'success',
      firestoreId: 'series-1',
      subsplashId: 'subsplash-series-1',
      title: 'Published Series',
      subtitle: '4 part series',
      summary: 'Remote summary',
      images: [{ id: 'image-1', type: 'square', subsplashId: 'subsplash-image-1' }],
      remoteStatus: 'published',
    });
    createFunctionV2Mock.mockReturnValue(updateSeriesMetadataCallable);

    const { saveSeriesMetadata } = await import('../../utils/saveSeriesMetadata');
    const seriesImages = [
      {
        id: 'image-1',
        type: 'square',
        size: 'original',
        width: 1024,
        height: 1024,
        downloadLink: 'https://example.com/square.jpg',
        name: 'square.jpg',
        dateAddedMillis: 1,
      } as Series['images'][number],
    ];
    const series = buildSeries({
      name: 'Before Save',
      subsplashId: 'subsplash-series-1',
      status: 'published',
      publishedItemCount: 4,
      images: seriesImages,
    });

    const updatedSeries = await saveSeriesMetadata({
      series,
      name: 'Published Series',
      summary: 'Remote summary',
      images: seriesImages,
    });

    expect(updatedSeries.images).toEqual([
      {
        ...seriesImages[0],
        subsplashId: 'subsplash-image-1',
      },
    ]);
  });
});
