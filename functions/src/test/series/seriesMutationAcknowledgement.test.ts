import {
  normalizeSeriesMutationAcknowledgement,
  normalizeSeriesMediaMutationAcknowledgement,
} from '../../helpers/seriesHelpers';

const huge = 'x'.repeat(2 * 1024 * 1024);
it('drops large descriptions, artwork and transport metadata from series mutation facts while preserving canonical fields', () => {
  const result = normalizeSeriesMutationAcknowledgement({
    id: 'series',
    title: 'Title',
    subtitle: 'Subtitle',
    summary: 'Canonical summary',
    status: 'published',
    slug: 'slug',
    short_code: 'code',
    position: 2,
    media_items_count: 3,
    published_media_items_count: 2,
    description: huge,
    artwork: huge,
    _embedded: { images: [{ id: 'image', original: huge }] },
    _links: { self: { href: 'https://example.test' } },
    config: { headers: { Authorization: 'secret' } },
  });
  expect(result).toEqual({
    id: 'series',
    title: 'Title',
    subtitle: 'Subtitle',
    summary: 'Canonical summary',
    status: 'published',
    slug: 'slug',
    short_code: 'code',
    position: 2,
    media_items_count: 3,
    published_media_items_count: 2,
  });
  expect(JSON.stringify(result).length).toBeLessThan(500);
});
it('retains only minimal embedded references required for media membership predicates', () => {
  const result = normalizeSeriesMediaMutationAcknowledgement({
    id: 'media',
    position: 2,
    subtitle: 'Title',
    description: huge,
    artwork: huge,
    _embedded: {
      'media-series': { id: 'series', description: huge },
      audio: { id: 'audio', metadata: huge },
      images: [{ id: 'image', type: 'square', original: huge }],
      unknown: huge,
    },
  });
  expect(result).toEqual({
    id: 'media',
    position: 2,
    subtitle: 'Title',
    _embedded: {
      'media-series': { id: 'series' },
      audio: { id: 'audio' },
      images: [{ id: 'image', type: 'square' }],
    },
  });
  expect(JSON.stringify(result).length).toBeLessThan(400);
});
it('preserves authoritative series unlink null', () => {
  expect(normalizeSeriesMediaMutationAcknowledgement({ id: 'media', _embedded: { 'media-series': null } })).toEqual({
    id: 'media',
    _embedded: { 'media-series': null },
  });
});
