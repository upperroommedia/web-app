import { randomUUID } from 'node:crypto';
import { mediaStartupIntent, runMediaFilesystemCanary, mediaStartupBudget } from './media-startup-capacity';
const mockProcessing = jest.fn(async () => ({
  schemaVersion: 1 as const,
  ffmpegSHA256: 'a'.repeat(64),
  ffprobeSHA256: 'b'.repeat(64),
  sourceBytes: 32044,
  outputBytes: 32044,
  sampleRate: 16000 as const,
  channels: 1 as const,
  durationSeconds: 1,
  pcmSamplesVerified: 16000 as const,
  progressBeforeCancellation: true as const,
  cancelledChildDrained: true as const,
  retryCompleted: true as const,
}));
const GiB = 1024 ** 3;
const disk = { blocks: (100 * GiB) / 4096, bavail: (90 * GiB) / 4096, bsize: 4096 };
let mockDisk = { ...disk },
  mockSameDevice = false,
  mockJumpTime = false,
  mockNowBefore = 0;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    realpath: jest.fn(async () => '/tmp'),
    stat: jest.fn(async (p: string) => ({ dev: p === '/' || mockSameDevice ? 1 : 2 })),
    statfs: jest.fn(async () => {
      if (mockJumpTime) jest.spyOn(Date, 'now').mockReturnValue(mockNowBefore + 11000);
      return mockDisk;
    }),
  };
});
function operation() {
  const operationId = randomUUID(),
    releaseId = randomUUID(),
    buildId = 'a'.repeat(40),
    name = `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${buildId.slice(0, 20)}`;
  const origin = { name, uid: 'owned', revision: `${name}/revisions/original`, desiredManualInstanceCount: 0 };
  return {
    operationId,
    releaseId,
    bindingDigest: 'c'.repeat(64),
    action: 'bootstrap-stop-cloud-run-media',
    cloudMediaBootstrapCycle: {
      stage: 'starting',
      plan: {
        operationId,
        releaseId,
        buildId,
        role: 'media',
        evidenceDigest: 'd'.repeat(64),
        name,
        mediaStartup: {
          canary: 'filesystem-and-native-audio-v2',
          budgets: { ...mediaStartupBudget },
          image: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
          runner: `tw-m-${buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`,
        },
      },
      start: {
        stage: 'attempted',
        plan: { operationId, mode: 'start', target: 1, origin },
        attemptedAt: new Date().toISOString(),
        before: origin,
        request: {
          url: `https://run.googleapis.com/v2/${name}?updateMask=scaling`,
          method: 'PATCH',
          body: { name, scaling: { manualInstanceCount: 1 } },
        },
        access: {},
        protection: {},
      },
    },
  };
}
afterEach(() => {
  mockDisk = { ...disk };
  mockSameDevice = false;
  mockJumpTime = false;
  jest.restoreAllMocks();
});
test('attempted source startup intent binds original authority and survives ACK progression', () => {
  const o = operation(),
    first = mediaStartupIntent(o);
  o.cloudMediaBootstrapCycle.start.stage = 'acknowledged';
  expect(mediaStartupIntent(o).intentSHA256).toBe(first.intentSHA256);
});
for (const bad of ['role', 'no-attempt', 'rejected', 'stop', 'runner', 'budget', 'source', 'array', 'filesystem-only'])
  test(`startup intent rejects ${bad}`, () => {
    const o = operation(),
      s = o.cloudMediaBootstrapCycle;
    if (bad === 'role') s.plan.role = 'controls';
    if (bad === 'no-attempt') s.start.stage = 'planned';
    if (bad === 'rejected') s.start.stage = 'rejected';
    if (bad === 'stop') Object.assign(s, { stop: {} });
    if (bad === 'runner') s.plan.mediaStartup.runner = 'foreign@example.test';
    if (bad === 'budget') s.plan.mediaStartup.budgets.workspaceBytes = GiB;
    if (bad === 'filesystem-only') s.plan.mediaStartup.canary = 'filesystem-only-v1';
    if (bad === 'source') s.plan.name = 'foreign';
    expect(() => mediaStartupIntent(bad === 'array' ? [] : o)).toThrow('MEDIA_STARTUP_CAPACITY_UNCONFIRMED');
  });
test('actual private filesystem canary writes reads fsyncs cleans and releases reservations under controlled mount metadata', async () => {
  const a = await runMediaFilesystemCanary(undefined, mockProcessing),
    b = await runMediaFilesystemCanary(undefined, mockProcessing);
  expect(a.canaryBytes).toBe(1024 * 1024);
  expect(a.cleanupConfirmed).toBe(true);
  expect(b.reservationReleased).toBe(true);
  expect(a.budgets).toEqual(mediaStartupBudget);
});
for (const bad of ['root', 'low', 'nan', 'oversize', 'draining'])
  test(`filesystem canary denies ${bad}`, async () => {
    if (bad === 'root') mockSameDevice = true;
    if (bad === 'low') mockDisk.bavail = 1024;
    if (bad === 'nan') mockDisk.bavail = NaN;
    if (bad === 'oversize') mockDisk.bavail = Number.MAX_SAFE_INTEGER;
    await expect(runMediaFilesystemCanary(() => bad === 'draining', mockProcessing)).rejects.toThrow();
  });

test('wall-clock expiry after filesystem settlement cannot pass before timeout callback runs', async () => {
  mockNowBefore = Date.now();
  mockJumpTime = true;
  await expect(runMediaFilesystemCanary(undefined, mockProcessing)).rejects.toThrow();
});

test('processing failure releases the real application reservation before a later canary', async () => {
  await expect(
    runMediaFilesystemCanary(undefined, async () => {
      throw new Error('Controlled processing failure');
    })
  ).rejects.toThrow('Controlled processing failure');
  const result = await runMediaFilesystemCanary(undefined, mockProcessing);
  expect(result.reservationReleased).toBe(true);
});
