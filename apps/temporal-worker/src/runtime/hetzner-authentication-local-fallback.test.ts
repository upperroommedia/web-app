import type { Firestore } from 'firebase-admin/firestore';
import type { Database } from 'firebase-admin/database';
import type { Bucket } from '@google-cloud/storage';
import { createMediaActivities } from '../../../process-audio/src/temporal/activities';
import { createMediaAuthenticationProbe } from '../../../process-audio/src/temporal/authentication';
jest.mock('../../../process-audio/src/temporal/authentication', () => ({
  createMediaAuthenticationProbe: jest.fn(),
}));
const ref = {
  projectId: 'urm-app-staging',
  jobId: 'owned-auth',
  sermonId: 'owned-sermon',
  revision: 1,
  requestVersion: 'a'.repeat(16),
};
// Controlled native request/actor/probe responses. This exercises the actual
// production Activity factory, not a host canary, Google token or SDK Activity.
const local = jest.fn(async () => ({ ready: true, generation: 'LOCAL_CLOUD_RUN_GENERATION' }));
const get = jest.fn(async () => ({
  exists: true,
  data: () => ({ owner: 'temporal', ref }),
  get: (key: string) => (key === 'state' ? 'running' : undefined),
}));
const assertAuthorized = jest.fn(async () => undefined);
const setup = (remote: boolean, custom: boolean) =>
  createMediaActivities({
    projectId: ref.projectId,
    firestore: { collection: () => ({ doc: () => ({ get }) }) } as unknown as Firestore,
    database: {} as Database,
    bucket: {} as Bucket,
    ytdlpPath: '/CONTROLLED/yt-dlp',
    assertAuthorized,
    projectJob: async () => undefined,
    ...(remote
      ? { acquireYouTubeSource: async () => ({ kind: 'waiting_auth' as const, recoveryGeneration: null }) }
      : {}),
    ...(custom ? { checkAuthenticatedMedia: local } : {}),
  });
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(createMediaAuthenticationProbe).mockReturnValue(local);
});
test.each([false, true])('remote acquisition refuses local recovery generation, custom=%s', async (custom) => {
  const activities = setup(true, custom);
  await expect(activities.recoverMediaAuthentication(ref)).rejects.toMatchObject({
    type: 'YOUTUBE_SAME_HOST_AUTHENTICATION_REQUIRED',
    message: 'YouTube authentication requires verified recovery on the acquisition host.',
  });
  expect(createMediaAuthenticationProbe).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(assertAuthorized).not.toHaveBeenCalled();
});
test.each([false, true])('ordinary local authentication keeps existing probe behavior, custom=%s', async (custom) => {
  await expect(setup(false, custom).recoverMediaAuthentication(ref)).resolves.toEqual({
    ready: true,
    generation: 'LOCAL_CLOUD_RUN_GENERATION',
  });
  expect(local).toHaveBeenCalledWith(ref);
  expect(assertAuthorized).toHaveBeenCalledWith(ref);
  expect(createMediaAuthenticationProbe).toHaveBeenCalledTimes(custom ? 0 : 1);
});
