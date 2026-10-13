jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { freezeSeriesMutationProjection } from './seriesMutationProjection';
import { runDurablePublishingOperation, type PublishingAcknowledgedProjectionPlan } from './durableOperationContext';
const getField = (data: Record<string, unknown>, field: string) =>
  field
    .split('.')
    .reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
      data
    );
function fixture(rows: Record<string, Record<string, unknown>>) {
  const document = (path: string): unknown => ({
    path,
    id: path.split('/').slice(-1)[0],
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string): unknown => ({
    path,
    doc: (id: string) => document(`${path}/${id}`),
    where: (field: string, _operator: string, value: unknown) => ({ path, field, value }),
  });
  const snapshot = (path: string) => ({
    ref: document(path),
    id: path.split('/').slice(-1)[0],
    exists: !!rows[path],
    data: () => rows[path],
    get: (field: string) => getField(rows[path] ?? {}, field),
  });
  const tx = {
    get: async (reference: unknown) => {
      const ref = reference as { path: string; field?: string; value?: unknown };
      if (ref.path.split('/').length % 2 === 0) return snapshot(ref.path);
      const docs = Object.keys(rows)
        .filter(
          (path) =>
            path.startsWith(`${ref.path}/`) &&
            path.split('/').length === ref.path.split('/').length + 1 &&
            (!ref.field || getField(rows[path], ref.field) === ref.value)
        )
        .map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  const db = { doc: document, collection };
  (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue(db);
  const plans: PublishingAcknowledgedProjectionPlan[] = [];
  // The same trusted scope persists its complete plan before invoking the helper.
  const execute = (
    resourceType: 'media' | 'series',
    resourceId: string,
    payload: unknown,
    patch: Record<string, unknown> = {}
  ) =>
    runDurablePublishingOperation(
      'job',
      async () => {
        const { beginProviderMutationPlan } = await import('./durableOperationContext');
        await beginProviderMutationPlan({
          operation: 'series',
          resources: [{ provider: 'subsplash', account: 'app:9XTSHD', resourceType, resourceId }],
        });
        await freezeSeriesMutationProjection(
          { provider: 'subsplash', account: 'app:9XTSHD', resourceType, resourceId },
          'request',
          'PATCH',
          payload,
          patch
        );
      },
      async (mutate) => {
        await mutate(tx as never);
      },
      {
        beginProviderMutationPlan: async () => {},
        prepareAcknowledgedProjectionPlan: async (_tx, plan) => {
          plans.push(plan);
          return { projectionDigest: 'a'.repeat(64), commit: () => {} };
        },
      }
    );
  return { plans, execute };
}
describe('series factual projection programs', () => {
  it('freezes canonical metadata and old field guards before the request', async () => {
    const { plans, execute } = fixture({ 'series/local': { subsplashId: 'remote', name: 'Before', images: [] } });
    await execute('series', 'remote', { id: 'remote', title: 'After' }, { images: [{ id: 'image' }] });
    expect(plans[0].completesActivity).toBe(false);
    expect(plans[0].writes[0]).toMatchObject({
      path: 'series/local',
      expectedFields: { subsplashId: 'remote', name: 'Before', images: [] },
      patch: { name: 'After', images: [{ id: 'image' }] },
    });
    expect(plans[0].requests[0].target?.resourceId).toBe('remote');
  });
  it('records confirmed association truth in a new local row without claiming the full parent finished', async () => {
    const { plans, execute } = fixture({
      'sermons/sermon': { subsplashId: 'media', seriesId: 'old' },
      'series/next': { subsplashId: 'new-series' },
      'series/old/seriesItems/sermon': { publishedToSubsplash: true },
    });
    await execute('media', 'media', { id: 'media', _embedded: { 'media-series': { id: 'new-series' } } });
    expect(plans[0].writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'sermons/sermon',
          patch: expect.objectContaining({ seriesId: 'next', seriesPublishedToSubsplash: true }),
        }),
        expect.objectContaining({ path: 'series/next/seriesItems/sermon', mode: 'set', expectedExists: false }),
        expect.objectContaining({ path: 'series/old/seriesItems/sermon', patch: { publishedToSubsplash: false } }),
      ])
    );
  });
  it('rejects a position program for an untracked external media item before any request', async () => {
    const { plans, execute } = fixture({ 'series/local': { subsplashId: 'remote' } });
    await expect(
      execute('series', 'remote', { id: 'remote', _embedded: { 'media-items': [{ id: 'foreign', position: 1 }] } })
    ).rejects.toThrow('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
    expect(plans).toHaveLength(0);
  });
});
