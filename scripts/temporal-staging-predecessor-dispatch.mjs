import { isDeepStrictEqual } from 'node:util';
import { verifyAppHostingBuild } from './temporal-apphosting-rollout.mjs';
import { preparedDispatchServiceIdentity } from './temporal-prepare-dispatch-service.mjs';
import { normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { assertTraditionalRetirementWorkIdle, readReleaseCandidateWork, readTraditionalRetirementWork } from './temporal-retirement-work.mjs';
import { renderServerlessDispatchWakeups } from './temporal-serverless-dispatch-resources.mjs';

const project = 'urm-app-staging';
const buildId = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const releaseId = '417a472a-c79b-4c3b-bb85-f3d9e4d04696';
const serviceOperation = '7459ce36-f3e0-4861-b662-db2fe06236f1';
const serviceReceiptPath = '_control/temporalCloudDispatchServicePreparation-' + serviceOperation;
const image = 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:e405a820385a8d4f908debbcba2f030cea991db89bfc13877c04d03115f2cf12';
const evidence = '4705617a0efd0b2cd8e1248ea0ea7814e736b225b29da8d3a6d07c03f1608585';
const parent = 'projects/urm-app-staging/locations/us-central1/backends/web-staging';
const frozenBuild = parent + '/builds/temporal-52fa00c162ccc581dfb1';
const hosting = 'https://firebaseapphosting.googleapis.com/v1beta/';
const sha = /^[0-9a-f]{40}$/;
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);

function fail() {
  throw new Error('STAGING_PREDECESSOR_DISPATCH_UNCONFIRMED');
}

function checkScope(db, successorBuildId) {
  if (db?.projectId !== project || db.databaseId !== '(default)' || !sha.test(successorBuildId ?? '') ||
    successorBuildId.slice(0, 20) === buildId.slice(0, 20)) fail();
}

// Call inside the final authority transaction as well. These collections
// record dispatched work, leases, sessions and execution identity, not poller registration.
export async function assertStagingPredecessorDispatchWork(db, tx, successorBuildId, nativeProof) {
  checkScope(db, successorBuildId);
  const [work, predecessorWork, successorWork] = await Promise.all([
    readTraditionalRetirementWork(db, tx), readReleaseCandidateWork(db, tx, buildId),
    readReleaseCandidateWork(db, tx, successorBuildId),
  ]);
  if (predecessorWork.length || successorWork.length) fail();
  const digest = assertTraditionalRetirementWorkIdle(work);
  if (nativeProof) {
    const receipt = await tx.get(db.doc(serviceReceiptPath));
    if (!receipt.exists || !isDeepStrictEqual(nativeSnapshotProof(receipt), nativeProof.dispatch?.serviceReceipt) ||
      nativeProof.privateWorkSHA256 !== digest) fail();
  }
  return digest;
}

async function assertAbsentWake(api, url) {
  let sent = false;
  try {
    await api(url, 'GET', undefined, () => { sent = true; });
  } catch (error) {
    if (sent && error?.status === 404) return;
    throw error;
  }
  fail();
}

async function observeDispatch(db, platform, api) {
  const snapshot = await db.doc(serviceReceiptPath).get();
  if (!snapshot.exists) fail();
  const stamp = nativeSnapshotProof(snapshot);
  const receipt = snapshot.data(), saved = receipt.identityState, plan = saved?.plan;
  if (!isDeepStrictEqual(stamp.createTime, stamp.updateTime) || receipt.operationId !== serviceOperation ||
    receipt.releaseId !== releaseId || saved?.stage !== 'completed' || plan?.operationId !== serviceOperation ||
    plan.releaseId !== releaseId || plan.role !== 'dispatch' || plan.buildId !== buildId || plan.evidenceDigest !== evidence ||
    plan.apiKeyVersion !== '1' || plan.runner !== platform.dispatch.runnerServiceAccount ||
    !/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]+$/.test(saved.nativeOperation ?? '')) fail();
  const observation = await observeCloudRunDispatchService(platform, api, 'disabled');
  const { service, config, expected } = observation;
  const annotations = { 'urm.upperroom.media/preparation': serviceOperation };
  const identity = preparedDispatchServiceIdentity(observation, plan);
  if (!isDeepStrictEqual(plan.body, { ...expected, annotations }) ||
    !isDeepStrictEqual(identity, saved.service) || !isDeepStrictEqual(service.labels, expected.labels) ||
    identity.generation !== '1') fail();
  const wake = renderServerlessDispatchWakeups(config, service);
  const urls = [...wake.triggers.map(t => 'https://eventarc.googleapis.com/v1/' + t.name),
    'https://cloudscheduler.googleapis.com/v1/' + wake.scheduler.name];
  const policyUrl = 'https://run.googleapis.com/v2/' + identity.name + ':getIamPolicy?options.requestedPolicyVersion=3';
  const [policy] = await Promise.all([api(policyUrl, 'GET'), ...urls.map(url => assertAbsentWake(api, url))]);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
    (policy.bindings !== undefined && (!Array.isArray(policy.bindings) || policy.bindings.length))) fail();
  return {
    identity, serviceReceipt: stamp, serviceEtag: service.etag, revisionEtag: observation.revision.etag,
    namedWakesAbsent: [...wake.triggers.map(t => t.name), wake.scheduler.name], directPolicySHA256: proofDigest(policy),
  };
}

async function observeFrozenUi(state, api, successorBuildId) {
  const read = path => api(hosting + path, 'GET');
  const traffic = await read(parent + '/traffic');
  const policy = traffic?.rolloutPolicy;
  if (!policy || normalize(traffic.name) !== parent + '/traffic' || traffic.etag !== state.appHostingFrozenETag ||
    (traffic.reconciling !== undefined && traffic.reconciling !== false) || traffic.target != null ||
    !isDeepStrictEqual(traffic.current, state.savedUiTraffic) || policy.disabled !== true) fail();
  // disabledTime is output metadata from the provider's freeze operation.
  const { disabled: _disabled, disabledTime, ...automaticPolicy } = policy;
  if (!isDeepStrictEqual(automaticPolicy, state.savedRolloutPolicy) ||
    (disabledTime !== undefined && !Number.isFinite(Date.parse(disabledTime)))) fail();
  const build = await read(frozenBuild);
  const uiCommit = build?.source?.codebase?.hash || build?.source?.codebase?.commit;
  if (!sha.test(uiCommit ?? '') || [buildId, successorBuildId].includes(uiCommit) || build.state !== 'READY' ||
    (build.reconciling !== undefined && build.reconciling !== false) ||
    !verifyAppHostingBuild(build, { buildName: frozenBuild, uiCommit }, '251680231116')) fail();
  const rollouts = new Map(), cursors = new Set();
  let cursor;
  do {
    const list = await read(parent + '/rollouts?pageSize=100' + (cursor ? '&pageToken=' + encodeURIComponent(cursor) : ''));
    if (!list || list.unreachable?.length || (list.rollouts !== undefined && !Array.isArray(list.rollouts))) fail();
    for (const row of list.rollouts ?? []) {
      const name = normalize(row.name);
      if (typeof name !== 'string' || !name.startsWith(parent + '/rollouts/') ||
        !/^[A-Za-z0-9_-]+$/.test(name.slice((parent + '/rollouts/').length)) ||
        rollouts.has(name) || row.reconciling === true || !terminal.has(row.state) || rollouts.size >= 2000) fail();
      rollouts.set(name, row.state);
    }
    cursor = list.nextPageToken;
    if (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096)) fail();
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 32) fail();
      cursors.add(cursor);
    }
  } while (cursor);
  const latest = await read(parent + '/traffic');
  if (!isDeepStrictEqual(latest, traffic)) fail();
  return { build: frozenBuild, uiCommit, trafficEtag: traffic.etag, trafficSHA256: proofDigest(traffic),
    rolloutCount: rollouts.size, terminalRolloutsSHA256: proofDigest([...rollouts].sort()) };
}

/** Native named wake configuration and frozen serving UI. The historical
 * traditional worker topology is checked separately by the Temporal observer. */
export async function observeStagingPredecessorDispatch({ db, api, platform, state, successorBuildId }) {
  checkScope(db, successorBuildId);
  if (typeof api !== 'function' || platform?.workerBuildId !== buildId || platform.workerImage !== image ||
    platform.dispatch?.apiKeyVersion !== '1' || state?.releaseId !== releaseId || state.controlRevision !== 65 ||
    state.phase !== 'provider-usage-ready' || state.compatibilityCommit !== buildId || state.uiCommit !== buildId ||
    state.mode !== 'durable-upgrade' || !isDeepStrictEqual(state.savedRolloutPolicy, { codebaseBranch: 'staging' }) ||
    !state.appHostingFrozenETag || state.appHostingFrozenETag === state.appHostingFreezeETag ||
    state.savedUiTraffic?.splits?.length !== 1 || state.savedUiTraffic.splits[0].percent !== 100 ||
    normalize(state.savedUiTraffic.splits[0].build) !== frozenBuild) fail();
  const [dispatch, frozenUi, privateWorkSHA256] = await Promise.all([
    observeDispatch(db, platform, api), observeFrozenUi(state, api, successorBuildId),
    db.runTransaction(tx => assertStagingPredecessorDispatchWork(db, tx, successorBuildId), { readOnly: true }),
  ]);
  return { schemaVersion: 1, buildId, successorBuildId, dispatch, frozenUi, privateWorkSHA256,
    observedAt: new Date().toISOString() };
}
