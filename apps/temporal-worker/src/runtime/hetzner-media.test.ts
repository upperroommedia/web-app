import { createRuntimeYouTubeAcquisition } from './hetzner-media';
import type { Firestore } from 'firebase-admin/firestore';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
const setup = (projectId = 'urm-app-staging') =>
  createRuntimeYouTubeAcquisition({
    projectId,
    // Any attempt to reach a database before validating the binding must fail.
    firestore: new Proxy(
      {},
      {
        get() {
          throw Error('Unexpected database access');
        },
      }
    ) as Firestore,
    assertCurrent: async () => {
      throw Error('Unexpected admission');
    },
  });
test('ordinary workers never initialize remote authority or transport', () => {
  delete process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION;
  expect(setup()).toBeUndefined();
});
test.each([
  ['unknown', 'cloud-run', 'urm-app-staging'],
  ['hetzner-v1', 'traditional', 'urm-app-staging'],
  ['hetzner-v1', 'cloud-run', 'urm-app'],
])('invalid explicit binding is fenced before database access (%s/%s/%s)', (mode, hosting, project) => {
  process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION = mode;
  process.env.TEMPORAL_WORKER_HOSTING = hosting;
  expect(() => setup(project)).toThrow(expect.objectContaining({ type: 'YOUTUBE_ACQUISITION_BINDING_REQUIRED' }));
});
test('explicit binding without an authentic worker witness cannot prepare or send', async () => {
  process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION = 'hetzner-v1';
  process.env.TEMPORAL_WORKER_HOSTING = 'cloud-run';
  const acquire = setup()!;
  await expect(acquire({} as never, new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_ACQUISITION_BINDING_REQUIRED',
  });
  const aborted = new AbortController();
  aborted.abort();
  await expect(acquire({} as never, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
