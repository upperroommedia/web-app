import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createStagingYouTubeRenderAuthority, createStagingYouTubeRenderSelector } from './youtube-render-selection';

const mosesId = 'd3b3e2f1-abcd-4e11-8ecd-123456789abc';
const hetznerId = 'ea0e2137-abcd-4e11-8ecd-123456789abc';
const mosesCommit = 'a'.repeat(40);
const hetznerCommit = 'b'.repeat(40);
const load = async () => ({
  moses: { runtimeId: mosesId, commit: mosesCommit },
  hetzner: { runtimeId: hetznerId, commit: hetznerCommit },
});

function activeRenderer(input: URL, target: 'moses' | 'hetzner', extra?: object) {
  return Response.json({
    ok: true,
    service: 'process-audio',
    releaseChallenge: input.searchParams.get('releaseChallenge'),
    temporalYouTubeRenderMode: 'enabled',
    temporalYouTubeRenderPinProtocol: 1,
    temporalYouTubeRenderTarget: target,
    temporalYouTubeGuestOnly: target === 'moses',
    temporalYouTubeRuntimeId: target === 'moses' ? mosesId : hetznerId,
    sentryEnabled: true,
    sentryEnvironment: 'staging',
    sentryRelease: `process-audio-hetzner@staging-${target === 'moses' ? mosesCommit : hetznerCommit}`,
    ...extra,
  });
}

test('chooses the attested primary without contacting the backup', async () => {
  const request = jest.fn(async (url: URL) => activeRenderer(url, 'moses'));
  const select = createStagingYouTubeRenderSelector(load, request as unknown as typeof fetch);
  expect(await select(new AbortController().signal)).toEqual({
    target: 'moses',
    runtimeId: mosesId,
    commit: mosesCommit,
  });
  expect(request.mock.calls.map(([url]) => url.origin)).toEqual(['https://yt-moses-staging.upperroommedia.org']);
});

test('chooses the attested pin-aware backup when the home connector cannot reach the renderer', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockImplementationOnce(async (url: URL) => activeRenderer(url, 'hetzner'));
  const select = createStagingYouTubeRenderSelector(load, request);
  expect(await select(new AbortController().signal)).toEqual({
    target: 'hetzner',
    runtimeId: hetznerId,
    commit: hetznerCommit,
  });
  expect(request.mock.calls.map(([url]) => url.origin)).toEqual([
    'https://yt-moses-staging.upperroommedia.org',
    'https://yt-worker-staging.upperroommedia.org',
  ]);
});

test('does not send a pinned episode to a backup that only understands historical episodes', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockImplementationOnce(async (url: URL) =>
      activeRenderer(url, 'hetzner', { temporalYouTubeRenderPinProtocol: undefined })
    );
  await expect(createStagingYouTubeRenderSelector(load, request)(new AbortController().signal)).rejects.toHaveProperty(
    'type',
    'YOUTUBE_RENDER_TARGET_UNAVAILABLE'
  );
});

test('requires both pins and retries without dispatch when neither renderer matches', async () => {
  const invalid = async () => ({ ...(await load()), hetzner: { runtimeId: '', commit: hetznerCommit } });
  const neverFetch = jest.fn();
  await expect(
    createStagingYouTubeRenderSelector(invalid, neverFetch)(new AbortController().signal)
  ).rejects.toHaveProperty('type', 'YOUTUBE_RENDER_TARGET_UNAVAILABLE');
  expect(neverFetch).not.toHaveBeenCalled();
  const request = jest
    .fn()
    .mockImplementationOnce(async (url: URL) => activeRenderer(url, 'moses', { temporalYouTubeGuestOnly: undefined }))
    .mockImplementationOnce(async (url: URL) => activeRenderer(url, 'hetzner', { temporalYouTubeRuntimeId: mosesId }));
  const select = createStagingYouTubeRenderSelector(load, request);
  await expect(select(new AbortController().signal)).rejects.toMatchObject({
    type: 'YOUTUBE_RENDER_TARGET_UNAVAILABLE',
    nonRetryable: false,
  });
});

test('cancellation during the primary check prevents the backup check', async () => {
  const controller = new AbortController();
  const request = jest.fn(async () => {
    controller.abort();
    return new Response(null, { status: 502 });
  });
  const select = createStagingYouTubeRenderSelector(load, request);
  await expect(select(controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  expect(request).toHaveBeenCalledTimes(1);
});

test('a non-media release can carry the exact active renderer receipts forward without reauthorizing altered data', async () => {
  const releaseId = '98f75345-abcd-4e11-8ecd-123456789abc';
  const globalReleaseId = '438c1f6a-abcd-4e11-8ecd-123456789abc';
  const commit = mosesCommit;
  const timestamp = { seconds: 7, nanoseconds: 5, isEqual: (other: unknown) => other === timestamp };
  const receipt = (target: 'moses' | 'hetzner', runtimeId: string) => ({
    commit,
    guestOnly: target === 'moses',
    mode: 'enabled',
    releaseId,
    runtimeId,
    target,
  });
  const moses = receipt('moses', mosesId);
  const hetzner = receipt('hetzner', hetznerId);
  const proof = (data: ReturnType<typeof receipt>) => ({
    createTime: timestamp,
    updateTime: timestamp,
    dataDigest: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  });
  const control = {
    releaseId: globalReleaseId,
    revision: 21,
    admission: 'open',
    domains: {
      media: { owner: 'temporal', admission: 'open' },
    },
  };
  const release = {
    releaseId: globalReleaseId,
    controlRevision: 21,
    phase: 'complete',
    mediaRenderBinding: {
      releaseId,
      workerBuildId: mosesCommit,
      compatibilityCommit: commit,
      mosesActivation: proof(moses),
      hetznerActivation: proof(hetzner),
    },
  };
  const getAll = jest.fn(async () => [
    { data: () => control },
    { data: () => release },
    {
      data: () => moses,
      get: (field: 'target' | 'guestOnly') => moses[field],
      createTime: timestamp,
      updateTime: timestamp,
    },
    { data: () => hetzner, createTime: timestamp, updateTime: timestamp },
  ]);
  const firestore = {
    doc: (path: string) => path,
    runTransaction: (read: (tx: { getAll: typeof getAll }) => unknown) => read({ getAll }),
  };
  const authority = createStagingYouTubeRenderAuthority(
    {
      TEMPORAL_MEDIA_YOUTUBE_RENDER_TARGET: 'moses',
      TEMPORAL_MEDIA_YOUTUBE_RENDER_RELEASE_ID: releaseId,
      TEMPORAL_BUILD_ID: mosesCommit,
    },
    firestore as unknown as Firestore
  )!;
  await expect(authority.load()).resolves.toEqual({
    moses: { runtimeId: mosesId, commit },
    hetzner: { runtimeId: hetznerId, commit },
  });
  control.admission = 'paused';
  await expect(authority.load()).rejects.toHaveProperty('type', 'YOUTUBE_RENDER_TARGET_UNAVAILABLE');
  control.admission = 'open';
  moses.runtimeId = hetznerId;
  await expect(authority.load()).rejects.toHaveProperty('type', 'YOUTUBE_RENDER_TARGET_UNAVAILABLE');
});
