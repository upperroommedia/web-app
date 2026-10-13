import { normalizeSubsplashListPatchAck } from './subsplashMutationAck';

describe('Subsplash list mutation ACK normalization', () => {
  it('preserves 200 row identities and placement while excluding huge content expansions', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: `row-${index}`,
      position: index + 1,
      type: index % 2 ? 'media-series' : 'media-item',
      method: 'static',
      app_key: '9XTSHD',
      _links: { self: { href: 'https://provider.invalid/private' } },
      _embedded: {
        'source-list': { id: 'list-1', title: 'Expanded private list', _links: { self: { href: 'secret' } } },
        [index % 2 ? 'media-series' : 'media-item']: {
          id: `media-${index}`,
          title: 'Expanded title',
          description: 'x'.repeat(10_000),
          _embedded: { images: [{ id: 'art', bytes: 'x'.repeat(10_000), private: 'secret' }] },
        },
      },
    }));
    const raw = { description: 'private', _embedded: { 'list-rows': rows } };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(128 * 1024);
    const result = normalizeSubsplashListPatchAck(raw, 'list-1')!;
    expect(
      Buffer.byteLength(
        JSON.stringify({ state: 'acknowledged', result, target: { provider: 'subsplash', resourceId: 'list-1' } })
      )
    ).toBeLessThan(128 * 1024);
    const ackRows = result._embedded['list-rows'];
    expect(
      ackRows.map((row) => ({
        id: row.id,
        type: row.type,
        position: row.position,
        resourceId: row._embedded[row.type]?.id,
        sourceListId: row._embedded['source-list'].id,
      }))
    ).toEqual(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        position: row.position,
        resourceId: row._embedded[row.type].id,
        sourceListId: row._embedded['source-list'].id,
      }))
    );
    expect(JSON.stringify(result)).not.toMatch(/description|Expanded|private|secret|_links|bytes/);
    expect(rows[0]._embedded['media-item'].description).toHaveLength(10_000);
  });
  it('retains media types and dynamic row methods needed by follow-up list operations', () => {
    const raw = {
      _embedded: {
        'list-rows': [
          {
            id: 'row',
            type: 'list',
            position: 3,
            method: 'most_recent',
            app_key: '9XTSHD',
            _embedded: { list: { id: 'overflow-list', title: 'large expansion' }, 'source-list': { id: 'root-list' } },
          },
        ],
      },
    };
    expect(normalizeSubsplashListPatchAck(raw, 'root-list')).toEqual({
      _embedded: {
        'list-rows': [
          {
            id: 'row',
            type: 'list',
            position: 3,
            method: 'most_recent',
            app_key: '9XTSHD',
            _embedded: { list: { id: 'overflow-list' }, 'source-list': { id: 'root-list' } },
          },
        ],
      },
    });
  });
  it('returns null for a response without row expansions so existing request-row fallback remains available', () => {
    expect(normalizeSubsplashListPatchAck({ id: 'list-1' }, 'list-1')).toBeNull();
    expect(normalizeSubsplashListPatchAck(null, 'list-1')).toBeNull();
  });
  it.each([
    { id: 'row', type: 'unknown', position: 1, method: 'static', app_key: '9XTSHD', _embedded: {} },
    {
      id: 'row',
      type: 'list',
      position: 1,
      method: 'static',
      app_key: 'OTHER',
      _embedded: { list: { id: 'x' }, 'source-list': { id: 'y' } },
    },
    { id: 'row', type: 'list', position: 1, method: 'static', app_key: '9XTSHD', _embedded: { list: { id: 'x' } } },
  ])('fails closed for a response that cannot preserve authoritative routing %p', (row) => {
    expect(() => normalizeSubsplashListPatchAck({ _embedded: { 'list-rows': [row] } }, 'list-1')).toThrow(
      'ACK_INVALID'
    );
  });
});
