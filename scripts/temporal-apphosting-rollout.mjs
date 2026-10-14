import { createHash, randomUUID } from 'node:crypto';
const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
const same = (a, b) => stable(a) === stable(b);

const TERMINAL_ROLLOUTS = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);
const FAILED_BUILDS = new Set(['FAILED', 'SKIPPED', 'EXPIRED']);

function uuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function rolloutIdentity({ parent, releaseId, uiCommit }, version = 2) {
  if (![1, 2].includes(version)) throw new Error('Unknown rollout identity version');
  if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/backends\/[a-z0-9-]+$/.test(parent))
    throw new Error('Invalid App Hosting backend identity');
  if (
    !/^[a-f0-9]{40}$/.test(uiCommit) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(releaseId)
  )
    throw new Error('Immutable commit and release UUID are required');
  const originalSeed = `${parent}:${releaseId}:${uiCommit}`;
  const seed = version === 1 ? originalSeed : `v2:${originalSeed}`;
  // App Hosting rejects IDs outside 3..30 characters. V2 is 29 ASCII characters.
  const id = `temporal-${createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, version === 1 ? 32 : 20)}`;
  return {
    schemaVersion: version,
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

/** Read-only proof for the one invalid legacy identity format; never creates resources. */
export async function prepareLegacyRolloutIdentityMigration({ config, checkpoint, api, now = Date.now }) {
  const previousIdentity = rolloutIdentity(config, 1),
    identity = rolloutIdentity(config);
  if (!same(checkpoint, previousIdentity)) throw new Error('Only the exact deterministic schema1 identity can migrate');
  const startedAt = now();
  const before = await api(`${identity.parent}/traffic`);
  if (!before.etag || before.reconciling || before.rolloutPolicy?.disabled !== true)
    throw new Error('Frozen settled traffic with an etag is required for identity migration');
  const absentResources = [];
  for (const name of [
    previousIdentity.buildName,
    previousIdentity.rolloutName,
    identity.buildName,
    identity.rolloutName,
  ]) {
    try {
      await api(name);
      throw new Error('An identity migration resource already exists; inspect it without replacement');
    } catch (error) {
      if (status(error) !== 404) throw error;
    }
    absentResources.push({ name, httpStatus: 404 });
  }
  let pageToken;
  do {
    const page = await api(
      `${identity.parent}/rollouts?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    );
    if ((page.rollouts ?? []).some((row) => !TERMINAL_ROLLOUTS.has(row.state)))
      throw new Error('Concurrent App Hosting rollout prevents identity migration');
    pageToken = page.nextPageToken;
  } while (pageToken);
  const after = await api(`${identity.parent}/traffic`);
  if (!same(before, after)) throw new Error('Traffic changed during identity migration inspection');
  const observedAt = now();
  if (observedAt < startedAt || observedAt - startedAt >= 60000)
    throw new Error('Identity migration absence inspection is stale');
  return {
    schemaVersion: 1,
    reason: 'schema1-id-exceeds-api-30-character-limit',
    previousIdentity,
    identity,
    absentResources,
    traffic: after,
    inspectionStartedAt: startedAt,
    observedAt,
  };
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

export function sameAppHostingResource(actual, expected, projectNumber) {
  if (actual === expected && typeof actual === 'string') return true;
  if (!/^\d+$/.test(String(projectNumber ?? ''))) return false;
  const parse = (name) =>
    typeof name === 'string' &&
    name.match(/^projects\/([^/]+)(\/locations\/[^/]+\/backends\/[^/]+\/(?:builds|rollouts)\/[^/]+)$/);
  const a = parse(actual),
    e = parse(expected);
  return !!(a && e && a[2] === e[2] && a[1] === String(projectNumber) && !/^\d+$/.test(e[1]));
}

export function verifyAppHostingBuild(build, identity, projectNumber) {
  if (!sameAppHostingResource(build.name, identity.buildName, projectNumber))
    throw new Error('App Hosting build identity or immutable commit changed');
  if (FAILED_BUILDS.has(build.state)) throw new Error(`Reviewed App Hosting build is ${build.state}`);
  const codebase = build.source?.codebase;
  if (
    (codebase?.commit && codebase.commit !== identity.uiCommit) ||
    (codebase?.hash && codebase.hash !== identity.uiCommit)
  )
    throw new Error('App Hosting build identity or immutable commit changed');
  // Hash is output-only and optional. Either exact full SHA proves the immutable source.
  // Initial responses may omit both fields; observe them without claiming source readiness.
  if (!(codebase?.hash || codebase?.commit)) {
    if (build.reconciling || ['BUILDING', 'PENDING', 'STATE_UNSPECIFIED'].includes(build.state)) return false;
    throw new Error('App Hosting build lacks an immutable commit');
  }
  return true;
}

/**
 * One resumable reconciliation pass; never waits or invokes a non-idempotent CLI.
 * saveIdentity must durably commit ui-rollout-started plus this complete identity
 * before returning. Persist that identity unchanged on every later invocation.
 * Official REST create exposes IDs that the Firebase rollout CLI does not expose.
 */
export async function reconcileAppHostingRollout({ config, checkpoint, api, saveIdentity, projectNumber }) {
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
        (rollout) =>
          !sameAppHostingResource(rollout.name, identity.rolloutName, projectNumber) &&
          !TERMINAL_ROLLOUTS.has(rollout.state)
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
  if (!verifyAppHostingBuild(build, identity, projectNumber)) return { status: 'pending', identity };

  let rollout = await lookup(api, identity.rolloutName);
  if (!rollout)
    rollout = await createOrObserve(api, identity.rolloutName, identity.rolloutRequestId, 'rolloutId', {
      build: identity.buildName,
      labels: { 'temporal-release': identity.releaseId.toLowerCase() },
    });
  if (!rollout) return { status: 'pending', identity };
  if (
    !sameAppHostingResource(rollout.name, identity.rolloutName, projectNumber) ||
    !sameAppHostingResource(rollout.build, identity.buildName, projectNumber)
  )
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
    !sameAppHostingResource(splits[0].build, identity.buildName, projectNumber) ||
    splits[0].percent !== 100
  )
    return { status: 'pending', identity };
  build = await api(identity.buildName);
  if (!verifyAppHostingBuild(build, identity, projectNumber)) return { status: 'pending', identity };
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
  projectNumber,
}) {
  const expectedBuildName = `${parent}/builds/${buildName?.split('/').at(-1)}`;
  if (!sameAppHostingResource(buildName, expectedBuildName, projectNumber) || !/^[a-f0-9]{40}$/.test(uiCommit))
    throw new Error('Reviewed recovery build identity is required');
  const checkBuild = (build) => {
    if (
      !verifyAppHostingBuild(build, { buildName: expectedBuildName, uiCommit }, projectNumber) ||
      build.state !== 'READY' ||
      build.reconciling
    )
      throw new Error('Recovery build is not the verified READY immutable commit');
  };
  checkBuild(await api(buildName));
  let traffic = await api(`${parent}/traffic`);
  recoveryPolicy(traffic, savedRolloutPolicy);
  if (traffic.reconciling) throw new Error('Recovery traffic is still pending; retry after it settles');
  const matches = (value) =>
    value.current?.splits?.length === 1 &&
    sameAppHostingResource(value.current.splits[0].build, expectedBuildName, projectNumber) &&
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
