import { randomBytes } from 'node:crypto';

const stagingHealth = 'https://yt-worker-staging.upperroommedia.org/healthz';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const hetznerActivationPath = (releaseId) => `_control/temporalHetznerYouTubeActivation-${releaseId}`;

export function assertHetznerActivationReceipt(snapshot, release, expected = {}) {
  const receipt = snapshot.data();
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.releaseId !== release.releaseId ||
    receipt.commit !== release.compatibilityCommit ||
    receipt.mode !== 'enabled' ||
    !uuid.test(receipt.runtimeId) ||
    !uuid.test(receipt.operationId) ||
    !/^[a-f0-9]{64}$/.test(receipt.brokerDigest) ||
    !/^[a-f0-9]{32}$/.test(receipt.brokerInvocation) ||
    /^0+$/.test(receipt.brokerInvocation) ||
    !/^[a-f0-9]{64}$/.test(receipt.candidateId) ||
    !/^[a-f0-9]{64}$/.test(receipt.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId) ||
    !/^[a-f0-9]{12}-\d{8}T\d{6}Z-\d+$/.test(receipt.deploymentId) ||
    !receipt.deploymentId.startsWith(receipt.commit.slice(0, 12)) ||
    !Number.isSafeInteger(receipt.controlRevision) ||
    receipt.controlRevision < 1 ||
    Object.entries(expected).some(([key, value]) => receipt[key] !== value) ||
    !snapshot.createTime?.isEqual(snapshot.updateTime)
  )
    throw new Error('Exact immutable staging Hetzner activation receipt required');
  return receipt;
}

export async function confirmLiveHetznerActivation(receipt, request = fetch, { requireRenderPin = false } = {}) {
  // Each release check must contact the enabled process even if an ingress
  // serves a cached health document for the same runtime.
  const challenge = randomBytes(32).toString('hex');
  const url = new URL(stagingHealth);
  url.searchParams.set('releaseChallenge', challenge);
  const response = await request(url.href, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const health = response.ok ? await response.json() : undefined;
  if (
    health?.ok !== true ||
    health.service !== 'process-audio' ||
    health.releaseChallenge !== challenge ||
    health.temporalYouTubeRenderMode !== 'enabled' ||
    (requireRenderPin && (health.temporalYouTubeRenderPinProtocol !== 1 || health.temporalYouTubeRenderTarget !== 'hetzner')) ||
    health.temporalYouTubeRuntimeId !== receipt.runtimeId ||
    health.sentryEnabled !== true ||
    health.sentryEnvironment !== 'staging' ||
    health.sentryRelease !== `process-audio-hetzner@staging-${receipt.commit}`
  )
    throw new Error('Live staging Hetzner runtime does not match its activation receipt');
}
