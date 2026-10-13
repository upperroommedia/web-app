import { createHash, randomUUID } from 'node:crypto';

const TERMINAL_ROLLOUTS = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);
const FAILED_BUILDS = new Set(['FAILED', 'SKIPPED', 'EXPIRED']);

function uuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function rolloutIdentity({ parent, releaseId, uiCommit }) {
  if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/backends\/[a-z0-9-]+$/.test(parent))
    throw new Error('Invalid App Hosting backend identity');
  if (
    !/^[a-f0-9]{40}$/.test(uiCommit) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(releaseId)
  )
    throw new Error('Immutable commit and release UUID are required');
  const seed = `${parent}:${releaseId}:${uiCommit}`;
  const id = `temporal-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
  return {
    schemaVersion: 1,
    parent,
    releaseId,
    uiCommit,
    buildName: `${parent}/builds/${id}`,
    rolloutName: `${parent}/rollouts/${id}`,
    buildRequestId: uuid(`${seed}:build`),
    rolloutRequestId: uuid(`${seed}:rollout`),
  };
}

function status(error) {
  return error?.status ?? error?.statusCode;
}

// API callbacks must preserve HTTP status. Only an authoritative 404 proves absence.
async function lookup(api, name) {
  try {
    return await api(name);
  } catch (error) {
    if (status(error) === 404) return undefined;
    throw error;
  }
}

async function createOrObserve(api, name, requestId, queryKey, body) {
  try {
    const operation = await api(
      `${name.slice(0, name.lastIndexOf('/'))}?${queryKey}=${encodeURIComponent(
        name.split('/').at(-1)
      )}&requestId=${requestId}`,
      'POST',
      body
    );
    if (operation.error) throw Object.assign(new Error('App Hosting creation operation failed'), { status: 400 });
  } catch (error) {
    // A transport timeout may follow acceptance. The immutable resource name and
    // identical request UUID make a later retry safe, even after UUID dedup expiry.
    if (status(error) && status(error) !== 409 && status(error) < 500 && status(error) !== 408 && status(error) !== 429)
      throw error;
    const existing = await lookup(api, name);
    return existing;
  }
  return lookup(api, name);
}

function verifyBuild(build, identity) {
  if (
    build.name !== identity.buildName ||
    (build.source?.codebase?.hash ?? build.source?.codebase?.commit) !== identity.uiCommit
  )
    throw new Error('App Hosting build identity or immutable commit changed');
  if (FAILED_BUILDS.has(build.state)) throw new Error(`Reviewed App Hosting build is ${build.state}`);
}

/**
 * One resumable reconciliation pass; never waits or invokes a non-idempotent CLI.
 * saveIdentity must durably commit ui-rollout-started plus this complete identity
 * before returning. Persist that identity unchanged on every later invocation.
 * Official REST create exposes IDs that the Firebase rollout CLI does not expose.
 */
export async function reconcileAppHostingRollout({ config, checkpoint, api, saveIdentity }) {
  const identity = rolloutIdentity(config);
  if (
    checkpoint &&
    (Object.keys(checkpoint).length !== Object.keys(identity).length ||
      Object.entries(identity).some(([key, value]) => checkpoint[key] !== value))
  )
    throw new Error('Saved UI rollout identity does not match this reviewed release');
  const traffic = await api(`${identity.parent}/traffic`);
  if (traffic.rolloutPolicy?.disabled !== true) throw new Error('Automatic UI rollout must remain paused');

  let pageToken;
  do {
    const page = await api(
      `${identity.parent}/rollouts?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    );
    if (
      (page.rollouts ?? []).some(
        (rollout) => rollout.name !== identity.rolloutName && !TERMINAL_ROLLOUTS.has(rollout.state)
      )
    )
      throw new Error('Unexpected concurrent App Hosting rollout; admissions remain paused');
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (!checkpoint) await saveIdentity(identity);
  let build = await lookup(api, identity.buildName);
  if (!build)
    build = await createOrObserve(api, identity.buildName, identity.buildRequestId, 'buildId', {
      source: { codebase: { commit: identity.uiCommit } },
      labels: { 'temporal-release': identity.releaseId.toLowerCase() },
    });
  if (!build) return { status: 'pending', identity };
  verifyBuild(build, identity);

  let rollout = await lookup(api, identity.rolloutName);
  if (!rollout)
    rollout = await createOrObserve(api, identity.rolloutName, identity.rolloutRequestId, 'rolloutId', {
      build: identity.buildName,
      labels: { 'temporal-release': identity.releaseId.toLowerCase() },
    });
  if (!rollout) return { status: 'pending', identity };
  if (rollout.name !== identity.rolloutName || rollout.build !== identity.buildName)
    throw new Error('App Hosting rollout identity changed');
  if (TERMINAL_ROLLOUTS.has(rollout.state) && rollout.state !== 'SUCCEEDED')
    throw new Error(`Reviewed App Hosting rollout is ${rollout.state}`);

  const current = await api(`${identity.parent}/traffic`);
  if (current.rolloutPolicy?.disabled !== true) throw new Error('Automatic UI rollout policy changed');
  const splits = current.current?.splits ?? [];
  if (
    rollout.state !== 'SUCCEEDED' ||
    rollout.reconciling ||
    current.reconciling ||
    splits.length !== 1 ||
    splits[0].build !== identity.buildName ||
    splits[0].percent !== 100
  )
    return { status: 'pending', identity };
  build = await api(identity.buildName);
  verifyBuild(build, identity);
  if (build.state !== 'READY' || build.reconciling) return { status: 'pending', identity };
  return { status: 'ready', identity, buildName: identity.buildName, rolloutName: identity.rolloutName };
}

function recoveryPolicy(traffic, savedRolloutPolicy) {
  if (!savedRolloutPolicy?.codebaseBranch) throw new Error('Saved recovery branch policy is required');
  const policy = traffic.rolloutPolicy ?? savedRolloutPolicy;
  if (policy.codebaseBranch !== savedRolloutPolicy.codebaseBranch)
    throw new Error('Recovery rollout branch policy changed; do not overwrite independent policy');
  if (!traffic.etag) throw new Error('Fresh App Hosting traffic etag is required');
  return policy;
}

/** Restore the union member removed by a target update, keeping automation disabled. */
export async function ensureFrozenRecoveryPolicy({ parent, savedRolloutPolicy, api, settleOperation }) {
  const traffic = await api(`${parent}/traffic`);
  const policy = recoveryPolicy(traffic, savedRolloutPolicy);
  if (traffic.reconciling) throw new Error('Recovery traffic is still pending; retry after it settles');
  if (traffic.rolloutPolicy?.disabled !== true) {
    await settleOperation(
      await api(`${parent}/traffic?updateMask=rollout_policy&requestId=${randomUUID()}`, 'PATCH', {
        name: `${parent}/traffic`,
        etag: traffic.etag,
        rolloutPolicy: { ...policy, disabled: true },
      })
    );
  }
  const frozen = await api(`${parent}/traffic`);
  recoveryPolicy(frozen, savedRolloutPolicy);
  if (frozen.reconciling || frozen.rolloutPolicy?.disabled !== true)
    throw new Error('Recovery automatic rollout policy is not frozen yet');
  return frozen;
}

/** Restore the already verified build rather than replaying a completed rollout. */
export async function restoreReviewedUiRecovery({
  parent,
  uiCommit,
  buildName,
  savedRolloutPolicy,
  api,
  settleOperation,
}) {
  if (!buildName?.startsWith(`${parent}/builds/`) || !/^[a-f0-9]{40}$/.test(uiCommit))
    throw new Error('Reviewed recovery build identity is required');
  const checkBuild = (build) => {
    if (
      build.name !== buildName ||
      build.state !== 'READY' ||
      build.reconciling ||
      (build.source?.codebase?.hash ?? build.source?.codebase?.commit) !== uiCommit
    )
      throw new Error('Recovery build is not the verified READY immutable commit');
  };
  checkBuild(await api(buildName));
  let traffic = await api(`${parent}/traffic`);
  recoveryPolicy(traffic, savedRolloutPolicy);
  if (traffic.reconciling) throw new Error('Recovery traffic is still pending; retry after it settles');
  const matches = (value) =>
    value.current?.splits?.length === 1 &&
    value.current.splits[0].build === buildName &&
    value.current.splits[0].percent === 100;
  if (!matches(traffic)) {
    await settleOperation(
      await api(`${parent}/traffic?updateMask=target&requestId=${randomUUID()}`, 'PATCH', {
        name: `${parent}/traffic`,
        etag: traffic.etag,
        target: { splits: [{ build: buildName, percent: 100 }] },
      })
    );
    traffic = await api(`${parent}/traffic`);
    if (traffic.reconciling || !matches(traffic)) throw new Error('Reviewed recovery build is not serving 100% yet');
  }
  traffic = await ensureFrozenRecoveryPolicy({ parent, savedRolloutPolicy, api, settleOperation });
  if (!matches(traffic)) throw new Error('Recovery traffic changed while restoring the frozen policy');
  checkBuild(await api(buildName));
  return { buildName, uiCommit, rolloutPolicy: traffic.rolloutPolicy };
}
