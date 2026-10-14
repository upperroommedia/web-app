jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app-staging' } }) },
}));
import {
  buildSandboxCatalogPlan,
  assertSandboxImportFrozen,
  assertNoUnprofiledPublishingJobs,
  catalogDigest,
  type CatalogSource,
} from './catalog';
import { STAGING_SANDBOX_PROFILE } from './profile';
const fixture = {
  bucket: 'urm-app-staging.firebasestorage.app',
  path: `_providerSandbox/${STAGING_SANDBOX_PROFILE.profileId}/fixture.wav`,
  generation: '17',
  contentType: 'audio/wav',
  durationSeconds: 20,
  size: 100,
  sha256: 'a'.repeat(64),
};
const row = (path: string, data: Record<string, unknown>): CatalogSource => ({
  path,
  data,
  updateTime: { seconds: 100, nanoseconds: 9 },
});
const sources = [
  row('sermons/s1', {
    title: 'Sermon',
    subsplashId: 'old-media',
    soundCloudTrackId: 'soundcloud:tracks:123',
    speakers: [{ tagId: 'old-tag' }],
    images: [{ subsplashId: 'old-image' }],
  }),
  row('lists/l1', {
    name: 'List',
    subsplashId: 'old-list',
    manualOverflowRowId: 'overflow-row',
    manualOverflowTargetSubsplashId: 'overflow-list',
  }),
  row('series/sr1', { name: 'Series', subsplashId: 'old-series' }),
  row('lists/l1/listItems/s1', { position: 0, uploadStatus: { status: 'UPLOADED', listItemId: 'old-row' } }),
  row('series/sr1/seriesItems/s1', { position: 1, publishedToSubsplash: true, sermonSubsplashId: 'old-media' }),
];
test('import preserves opaque aliases, seeds numeric virtualSCowner, sourceprovenance and relationships without mutating canonicaldata', () => {
  const before = catalogDigest(sources),
    plan = buildSandboxCatalogPlan(STAGING_SANDBOX_PROFILE, sources, fixture, 1000);
  expect(catalogDigest(sources)).toBe(before);
  expect(plan.provenance).toBe('staging-canonical-aliases-with-reviewed-simulation-audio');
  const find = (family: string, id: string) =>
    plan.resources.find((value) => value.family === family && value.id === id)!;
  expect(find('media-items', 'old-media').body._embedded['media-series'].id).toBe('old-series');
  expect(find('list-rows', 'old-row').body._embedded['source-list'].id).toBe('old-list');
  expect(find('list-rows', 'overflow-row').body._embedded.list.id).toBe('overflow-list');
  expect(plan.resources.find((value) => value.family === 'taggings')?.body._embedded.tag.id).toBe('old-tag');
  expect(find('tracks', '123').body.urn).toBe('soundcloud:tracks:123');
  expect(find('tracks', '123').body.user.id).toBe(9000000000001);
  expect(find('accounts', '9000000000001').body.urn).toBe('soundcloud:users:9000000000001');
  expect(
    plan.resources.filter((value) => value.family === 'audios').every((value) => value.source?.generation === '17')
  ).toBe(true);
  expect(buildSandboxCatalogPlan(STAGING_SANDBOX_PROFILE, [...sources].reverse(), fixture, 1000).importId).toBe(
    plan.importId
  );
});
test('foreign/badfixture and missingpublishedrelationships fail ratherthan copying vendors or inventing ownership', () => {
  for (const patch of [
    { bucket: 'urm-app.firebasestorage.app' },
    { path: 'other.wav' },
    { generation: '0' },
    { sha256: '' },
    { contentType: 'text/plain' },
  ])
    expect(() => buildSandboxCatalogPlan(STAGING_SANDBOX_PROFILE, sources, { ...fixture, ...patch }, 1000)).toThrow();
  expect(() =>
    buildSandboxCatalogPlan(
      STAGING_SANDBOX_PROFILE,
      [row('lists/missing/listItems/s1', { uploadStatus: { status: 'UPLOADED' } })],
      fixture,
      1000
    )
  ).toThrow('REFERENCE_MISSING');
});
test('sourceversion/data changes produce newreviewedplan; duplicate sources reject', () => {
  const original = buildSandboxCatalogPlan(STAGING_SANDBOX_PROFILE, sources, fixture, 1000);
  expect(
    buildSandboxCatalogPlan(
      STAGING_SANDBOX_PROFILE,
      [...sources.slice(1), row('sermons/s1', { title: 'Changed', subsplashId: 'old-media' })],
      fixture,
      1000
    ).importId
  ).not.toBe(original.importId);
  expect(() => buildSandboxCatalogPlan(STAGING_SANDBOX_PROFILE, [...sources, sources[0]], fixture, 1000)).toThrow(
    'DUPLICATE'
  );
});
test('effective global pause preserves structurally valid domain flags in the same new release/revision and nonterminal old publishing jobs block activation', () => {
  const control = {
      schemaVersion: 1,
      releaseId: 'release',
      revision: 14,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { owner: 'temporal', admission: 'paused' },
        ])
      ),
    },
    state = { releaseId: 'release', controlRevision: 14, phase: 'ui-frozen' };
  expect(() => assertSandboxImportFrozen(control, state, 'release', 14)).not.toThrow();
  expect(() => assertSandboxImportFrozen({ ...control, revision: 15 }, state, 'release', 14)).toThrow();
  expect(() =>
    assertSandboxImportFrozen(
      { ...control, domains: { ...control.domains, publishing: { owner: 'temporal', admission: 'open' } } },
      state,
      'release',
      14
    )
  ).not.toThrow();
  expect(() => assertSandboxImportFrozen({ ...control, admission: 'open' }, state, 'release', 14)).toThrow();
  expect(() =>
    assertSandboxImportFrozen(
      { ...control, domains: { ...control.domains, publishing: undefined } },
      state,
      'release',
      14
    )
  ).toThrow();
  for (const kind of ['sermon.publish', 'image.ingest', 'speaker.resolve'])
    expect(() => assertNoUnprofiledPublishingJobs([{ id: 'job', data: { kind, state: 'retrying' } }])).toThrow(
      'NONTERMINAL'
    );
  expect(() =>
    assertNoUnprofiledPublishingJobs([{ id: 'job', data: { kind: 'sermon.publish', state: 'failed' } }])
  ).not.toThrow();
});
