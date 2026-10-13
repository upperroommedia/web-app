import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { Firestore } from 'firebase-admin/firestore';
import {
  assertMutationResourcePlanCurrent,
  buildEntityMutationResourcePlan,
  buildPublishingMutationResourcePlan,
  firestoreMutationCanonicalReader,
  type MutationCanonicalReader,
} from '../../temporal/publishing/mutationResourcePlan';
import type { PrivatePublishingIntent } from '../../temporal/publishing/types';
const ref = { projectId: 'test-project', jobId: 'job', workflowId: 'workflow', generation: 1 } as DurableJobRef;
function fixture(initial: Record<string, Record<string, unknown>>) {
  const records = new Map(Object.entries(initial));
  const document = (path: string, data: Record<string, unknown>) => ({ path, id: path.split('/').pop()!, data });
  const reader: MutationCanonicalReader = {
    read: async (path) => (records.has(path) ? document(path, records.get(path)!) : undefined),
    collection: async (path) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split('/').length === 1)
        .map(([key, data]) => document(key, data)),
    find: async (collection, field, value) =>
      [...records.entries()]
        .filter(
          ([key, data]) => key.split('/').length === 2 && key.startsWith(`${collection}/`) && data[field] === value
        )
        .map(([key, data]) => document(key, data)),
  };
  return { records, reader };
}
const intent: PrivatePublishingIntent = {
  sermonId: 's',
  action: 'publish',
  generation: 1,
  actorUid: 'actor',
  payload: {},
  destinations: { listIds: ['root'], soundcloud: false },
};
const base = {
  'sermons/s': { subsplashId: 'media-s' },
  'lists/root': { subsplashId: 'list-root', moreSermonsRef: 'list-page' },
  'lists/page': { subsplashId: 'list-page', rootListId: 'root' },
  'sermons/s/sermonLists/root': { subsplashId: 'list-page' },
};
test('canonical root and remote overflow mapping acquire both pages before mutation', async () => {
  const { reader } = fixture(base);
  const plan = await buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'lists' });
  expect(plan.operation).toBe('publishing:job:lists');
  expect(plan.resources.map((r) => r.resourceId).sort()).toEqual(['list-page', 'list-root']);
  expect(plan.resources.every((r) => r.account === 'app:9XTSHD')).toBe(true);
  expect(Object.isFrozen(plan.resources)).toBe(true);
  await expect(
    assertMutationResourcePlanCurrent(plan, () =>
      buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'lists' })
    )
  ).resolves.toBeUndefined();
});
test('fresh canonical reread detects new overflow before any HTTP and never expands held plan', async () => {
  const { reader, records } = fixture(base);
  const options = { reader, ref, intent, logicalStep: 'lists' as const };
  const plan = await buildPublishingMutationResourcePlan(options);
  records.set('lists/page', { subsplashId: 'list-page', rootListId: 'root', moreSermonsRef: 'list-new' });
  records.set('lists/new', { subsplashId: 'list-new', rootListId: 'root' });
  await expect(
    assertMutationResourcePlanCurrent(plan, () => buildPublishingMutationResourcePlan(options))
  ).rejects.toThrow('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
  expect(plan.resources.some((r) => r.resourceId === 'list-new')).toBe(false);
});
test.each(['duplicate', 'missing', 'cycle', 'wrong-root'])('invalid overflow %s fails closed', async (problem) => {
  const { reader, records } = fixture(base);
  if (problem === 'duplicate') records.set('lists/duplicate', { subsplashId: 'list-page', rootListId: 'root' });
  if (problem === 'missing') records.delete('lists/page');
  if (problem === 'cycle')
    records.set('lists/page', { subsplashId: 'list-page', rootListId: 'root', moreSermonsRef: 'list-root' });
  if (problem === 'wrong-root') records.set('lists/page', { subsplashId: 'list-page', rootListId: 'elsewhere' });
  await expect(buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'lists' })).rejects.toThrow(
    'PROVIDER_MUTATION_'
  );
});
test('series reorder seals every current media ID, including rows outside selected intent', async () => {
  const { reader } = fixture({
    'series/series': { subsplashId: 'remote-series' },
    'series/series/seriesItems/a': { publishedToSubsplash: true, sermonSubsplashId: 'media-a' },
    'sermons/a': { subsplashId: 'media-a' },
    'series/series/seriesItems/b': { publishedToSubsplash: true, sermonSubsplashId: 'media-b' },
  });
  const plan = await buildEntityMutationResourcePlan({
    reader,
    ref,
    intent: {
      kind: 'series.reorder',
      entity: { type: 'series', id: 'series' },
      actorUid: 'actor',
      payload: { operation: 'reorder', input: { localItemOrder: [{ sermonId: 'a', position: 1 }] } },
    },
  });
  expect(plan.resources.map((r) => r.resourceId).sort()).toEqual(['media-a', 'media-b', 'remote-series']);
});
test('speaker graph includes original and replacement canonical associated lists', async () => {
  const { reader } = fixture({
    'speakers/sp': { tagId: 'tag', listId: 'old' },
    'lists/old': { subsplashId: 'remote-old' },
    'lists/new': { subsplashId: 'remote-new' },
  });
  const plan = await buildEntityMutationResourcePlan({
    reader,
    ref,
    intent: {
      kind: 'speaker.mutate',
      entity: { type: 'speaker', id: 'sp' },
      actorUid: 'actor',
      payload: { operation: 'update', input: { patch: { associatedListId: 'new' } } },
    },
  });
  expect(plan.resources.map((r) => r.resourceId).sort()).toEqual(['remote-new', 'remote-old', 'tag']);
});
test('SoundCloud namespace requires actual authenticated account; list work does not lock unrelated tracks', async () => {
  const { reader } = fixture({ ...base, 'sermons/s': { subsplashId: 'media-s', soundCloudTrackId: '123' } });
  await expect(buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'metadata' })).rejects.toThrow(
    'PROVIDER_MUTATION_AUTHENTICATED_ACCOUNT_REQUIRED'
  );
  const plan = await buildPublishingMutationResourcePlan({
    reader,
    ref,
    intent,
    logicalStep: 'metadata',
    soundcloudAccount: 'soundcloud:users:42',
  });
  expect(plan.resources.find((r) => r.provider === 'soundcloud')).toMatchObject({
    account: 'soundcloud:users:42',
    resourceId: '123',
  });
  const listPlan = await buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'lists' });
  expect(listPlan.resources.some((r) => r.provider === 'soundcloud')).toBe(false);
});
test('legitimate large graphs are complete rather than silently truncated to 200 resources', async () => {
  const { reader, records } = fixture({ 'series/series': { subsplashId: 'remote-series' } });
  for (let i = 0; i < 605; i++)
    records.set(`series/series/seriesItems/s${i}`, { publishedToSubsplash: true, sermonSubsplashId: `media-${i}` });
  const plan = await buildEntityMutationResourcePlan({
    reader,
    ref,
    intent: {
      kind: 'series.reorder',
      entity: { type: 'series', id: 'series' },
      actorUid: 'actor',
      payload: { operation: 'reorder', input: {} },
    },
  });
  expect(plan.resources).toHaveLength(606);
});
test('collection membership insertion changes fingerprint even without new remote IDs', async () => {
  const { reader, records } = fixture(base);
  const options = { reader, ref, intent, logicalStep: 'lists' as const };
  const plan = await buildPublishingMutationResourcePlan(options);
  records.set('lists/root/listItems/unpublished', { publishedToSubsplash: false });
  await expect(
    assertMutationResourcePlanCurrent(plan, () => buildPublishingMutationResourcePlan(options))
  ).rejects.toThrow('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
});
test('a second selected page cannot hide an orphan behind an already traversed root', async () => {
  const { reader } = fixture({ ...base, 'lists/orphan': { subsplashId: 'remote-orphan', rootListId: 'root' } });
  await expect(
    buildPublishingMutationResourcePlan({
      reader,
      ref,
      intent: { ...intent, destinations: { listIds: ['root', 'orphan'], soundcloud: false } },
      logicalStep: 'lists',
    })
  ).rejects.toThrow('PROVIDER_MUTATION_OVERFLOW_SELECTED_UNREACHABLE');
});
test('Admin canonical collection reader exhausts stable document-ID pages', async () => {
  const documents = Array.from({ length: 605 }, (_, i) => ({
    id: `s${String(i).padStart(4, '0')}`,
    ref: { path: `series/series/seriesItems/s${String(i).padStart(4, '0')}` },
    data: () => ({ sermonSubsplashId: `m${i}` }),
  }));
  const get = jest.fn();
  const query = (offset = 0): unknown => ({
    orderBy: (field: string) => {
      expect(field).toBe('__name__');
      return query(offset);
    },
    limit: (size: number) => {
      expect(size).toBe(400);
      return query(offset);
    },
    startAfter: (cursor: (typeof documents)[number]) => query(documents.indexOf(cursor) + 1),
    get: async () => {
      get();
      const docs = documents.slice(offset, offset + 400);
      return { docs, size: docs.length };
    },
  });
  const fakeDb = { collection: () => query() } as unknown as Firestore;
  const reader = firestoreMutationCanonicalReader(fakeDb);
  const rows = await reader.collection('series/series/seriesItems');
  expect(rows).toHaveLength(605);
  expect(new Set(rows.map((row) => row.id)).size).toBe(605);
  expect(get).toHaveBeenCalledTimes(2);
});
test('600 list members lock only physical list targets and never scan their media graph', async () => {
  const { reader, records } = fixture(base);
  for (let i = 0; i < 600; i++) {
    records.set(`lists/root/listItems/s${i}`, { sermonSubsplashId: `media-${i}` });
    records.set(`sermons/s${i}`, {
      subsplashId: `media-${i}`,
      seriesId: `series-${i}`,
      soundCloudTrackId: `track-${i}`,
      images: [{ id: `image-${i}` }],
    });
  }
  const read = jest.spyOn(reader, 'read');
  const plan = await buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'lists' });
  expect(plan.resources.map((r) => r.resourceId).sort()).toEqual(['list-page', 'list-root']);
  expect(read.mock.calls.some(([path]) => path === 'sermons/s599')).toBe(false);
  expect(plan.canonicalPaths).toContain('lists/root/listItems/s599');
});
test('metadata edit locks media only and never traverses historical list catalog', async () => {
  const { reader, records } = fixture(base);
  records.set('sermons/s', {
    subsplashId: 'media-s',
    seriesId: 'missing-historical-series',
    subsplashAudioId: 'unchanged-audio',
    images: [{ id: 'image' }],
    speakers: [{ id: 'speaker' }],
  });
  records.set('images/image', { subsplashId: 'unchanged-image' });
  records.set('speakers/speaker', { tagId: 'unchanged-tag' });
  const collection = jest.spyOn(reader, 'collection');
  const read = jest.spyOn(reader, 'read');
  const plan = await buildPublishingMutationResourcePlan({ reader, ref, intent, logicalStep: 'metadata' });
  expect(plan.resources.map((r) => r.resourceId)).toEqual(['media-s']);
  expect(collection).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([path]) => path.startsWith('lists/') || path.startsWith('series/'))).toBe(false);
});
test('series metadata edit does not lock unchanged series-member media', async () => {
  const { reader } = fixture({
    'series/series': { subsplashId: 'remote-series' },
    'series/series/seriesItems/a': { publishedToSubsplash: true, sermonSubsplashId: 'media-a' },
  });
  const collection = jest.spyOn(reader, 'collection');
  const plan = await buildEntityMutationResourcePlan({
    reader,
    ref,
    intent: {
      kind: 'series.update',
      entity: { type: 'series', id: 'series' },
      actorUid: 'actor',
      payload: { operation: 'update', input: { title: 'Updated' } },
    },
  });
  expect(plan.resources.map((r) => r.resourceId)).toEqual(['remote-series']);
  expect(collection).not.toHaveBeenCalled();
});
