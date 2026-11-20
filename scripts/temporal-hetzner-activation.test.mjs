import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHetznerActivationReceipt, confirmLiveHetznerActivation } from './temporal-hetzner-activation.mjs';

const release = { releaseId: 'release', compatibilityCommit: 'a'.repeat(40) };
const receipt = {
  schemaVersion: 2,
  releaseId: release.releaseId,
  commit: release.compatibilityCommit,
  operationId: '38e0d97d-9e38-4748-89ef-6263a68977bd',
  deploymentId: 'aaaaaaaaaaaa-20261118T101501Z-12',
  candidateId: 'b'.repeat(64),
  imageId: 'sha256:' + 'c'.repeat(64),
  containerId: 'd'.repeat(64),
  runtimeId: '184c16b7-9bd0-4eac-b24e-1ec55a12e9de',
  brokerDigest: 'e'.repeat(64),
  brokerInvocation: 'f'.repeat(32),
  controlRevision: 42,
  mode: 'enabled',
};
const snapshot = (data, unchanged = true) => ({
  data: () => data,
  createTime: { isEqual: () => unchanged },
  updateTime: {},
});

test('staging receipt must match the exact guarded operation, source, revision and native immutable snapshot', () => {
  const expected = { operationId: receipt.operationId, controlRevision: receipt.controlRevision };
  assert.equal(assertHetznerActivationReceipt(snapshot(receipt), release, expected), receipt);
  for (const invalid of [
    snapshot(undefined),
    snapshot({ ...receipt, commit: 'e'.repeat(40) }),
    snapshot({ ...receipt, mode: 'verify' }),
    snapshot({ ...receipt, brokerDigest: undefined }),
    snapshot({ ...receipt, brokerInvocation: '0'.repeat(32) }),
    snapshot({ ...receipt, controlRevision: 41 }),
    snapshot({ ...receipt, operationId: receipt.runtimeId }),
    snapshot({ ...receipt, imageId: 'candidate:latest' }),
    snapshot(receipt, false),
  ])
    assert.throws(() => assertHetznerActivationReceipt(invalid, release, expected), /immutable staging/);
});

test('fresh staging ingress must serve the same boot identity and release observed on the deployed image', async () => {
  const health = {
    ok: true,
    service: 'process-audio',
    temporalYouTubeRenderMode: 'enabled',
    temporalYouTubeRuntimeId: receipt.runtimeId,
    sentryEnabled: true,
    sentryEnvironment: 'staging',
    sentryRelease: `process-audio-hetzner@staging-${receipt.commit}`,
  };
  const challenges = [];
  const request = (buildResponse) => async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://yt-worker-staging.upperroommedia.org/healthz');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.signal.aborted, false);
    const challenge = url.searchParams.get('releaseChallenge');
    assert.match(challenge, /^[a-f0-9]{64}$/);
    challenges.push(challenge);
    return { ok: true, json: async () => buildResponse(challenge) };
  };
  await confirmLiveHetznerActivation(
    receipt,
    request((releaseChallenge) => ({ ...health, releaseChallenge }))
  );
  await assert.rejects(
    confirmLiveHetznerActivation(
      receipt,
      request((releaseChallenge) => ({ ...health, releaseChallenge, temporalYouTubeRuntimeId: receipt.operationId }))
    ),
    /Live staging/
  );
  await assert.rejects(
    confirmLiveHetznerActivation(
      receipt,
      request(() => ({ ...health, releaseChallenge: challenges[0] }))
    ),
    /Live staging/
  );
  assert.equal(new Set(challenges).size, 3);
});
