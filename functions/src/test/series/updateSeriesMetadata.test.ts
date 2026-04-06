import { subsplashSeriesMock, networkFailureInjector, TestRequest } from './mocks';
import { clearFirestore, createSeriesDocument, getSeriesById } from './firestoreHelpers';
import updateSeriesMetadata from '../../updateSeriesMetadata';
import type {
  UpdateSeriesMetadataInputType,
  UpdateSeriesMetadataOutputType,
} from '../../../../packages/contracts/updateSeriesMetadata';

type UpdateSeriesMetadataHandler = (
  request: TestRequest<UpdateSeriesMetadataInputType>
) => Promise<UpdateSeriesMetadataOutputType>;

const updateSeriesMetadataHandler = updateSeriesMetadata as unknown as UpdateSeriesMetadataHandler;

describe('updateSeriesMetadata', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashSeriesMock.reset();
    networkFailureInjector.clear();
  });

  it('updates linked series metadata in Subsplash and Firestore', async () => {
    const remoteImage = subsplashSeriesMock.createImage('square', { id: 'remote-square', title: 'Square' });
    const remoteSeries = subsplashSeriesMock.createSeries('Existing Series', {
      summary: 'Original summary',
    });
    remoteSeries.published_at = new Date().toISOString();
    remoteSeries.status = 'published';

    const firestoreId = await createSeriesDocument({
      subsplashId: remoteSeries.id,
      name: 'Existing Series',
      summary: 'Original summary',
      status: 'published',
      publishedItemCount: 2,
      images: [
        {
          id: 'firebase-square',
          subsplashId: remoteImage.id,
          type: 'square',
          downloadLink: 'https://example.com/square.jpg',
          name: 'Square',
        },
      ],
    });

    const result = await updateSeriesMetadataHandler({
      auth: { token: { role: 'publisher' } },
      data: {
        firestoreId,
        title: 'Updated Series',
        summary: 'Updated summary',
        images: [
          {
            id: 'firebase-square',
            subsplashId: remoteImage.id,
            type: 'square',
            downloadLink: 'https://example.com/square.jpg',
            name: 'Square',
          },
        ],
      },
    });

    expect(result.status).toBe('success');
    expect(result.title).toBe('Updated Series');
    expect(result.subtitle).toBe('2 part series');
    expect(result.summary).toBe('Updated summary');
    expect(result.remoteStatus).toBe('published');

    const updatedRemoteSeries = subsplashSeriesMock.getSeries(remoteSeries.id);
    expect(updatedRemoteSeries?.title).toBe('Updated Series');
    expect(updatedRemoteSeries?.subtitle).toBe('2 part series');
    expect(updatedRemoteSeries?.summary).toBe('Updated summary');
    expect(updatedRemoteSeries?._embedded?.images).toEqual([{ id: remoteImage.id, type: 'square' }]);

    const updatedFirestoreSeries = await getSeriesById(firestoreId);
    expect(updatedFirestoreSeries?.name).toBe('Updated Series');
    expect(updatedFirestoreSeries?.subtitle).toBe('2 part series');
    expect(updatedFirestoreSeries?.summary).toBe('Updated summary');
    expect(updatedFirestoreSeries?.images).toHaveLength(1);
    expect(updatedFirestoreSeries?.images[0].subsplashId).toBe(remoteImage.id);
  });

  it('clears summary remotely and locally when the incoming summary is blank', async () => {
    const remoteSeries = subsplashSeriesMock.createSeries('Series With Summary', {
      summary: 'Summary to clear',
    });
    remoteSeries.published_at = new Date().toISOString();
    remoteSeries.status = 'published';

    const firestoreId = await createSeriesDocument({
      subsplashId: remoteSeries.id,
      name: 'Series With Summary',
      summary: 'Summary to clear',
      status: 'published',
      publishedItemCount: 1,
      images: [],
    });

    const result = await updateSeriesMetadataHandler({
      auth: { token: { role: 'admin' } },
      data: {
        firestoreId,
        title: 'Series With Summary',
        summary: '   ',
        images: [],
      },
    });

    expect(result.status).toBe('success');
    expect(result.summary).toBeUndefined();

    const updatedRemoteSeries = subsplashSeriesMock.getSeries(remoteSeries.id);
    expect(updatedRemoteSeries?.summary).toBeUndefined();

    const updatedFirestoreSeries = await getSeriesById(firestoreId);
    expect(updatedFirestoreSeries?.summary).toBeUndefined();
  });
});
