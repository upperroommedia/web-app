import { createHash } from 'node:crypto';
import { nativeCompatibilityTimestamp } from './temporal-compatibility-cutoff.mjs';
import { PROVIDER_USAGE_SCAN_GROUPS } from './temporal-backfill-provider-usage.mjs';
import { validateReadyProviderUsageIndex, validateControl } from './temporal-release-lib.mjs';
const firstSix = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'];
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const fail = () => {
  throw new Error('Search onboarding requires unchanged completed provider-index continuity');
};
export function isSearchProviderUsageContinuity(config) {
  return (
    config.projectId === 'urm-app-staging' &&
    config.environment === 'staging' &&
    config.mode === 'initial-cutover' &&
    Array.isArray(config.domains) &&
    config.domains.length === 1 &&
    config.domains[0] === 'search'
  );
}
function completedMarker(projectId, snapshot, expectedEpoch) {
  if (!snapshot?.exists) fail();
  const marker = snapshot.data();
  validateReadyProviderUsageIndex(projectId, marker, expectedEpoch);
  if (
    typeof marker.releaseId !== 'string' ||
    !marker.releaseId ||
    !Number.isSafeInteger(marker.controlRevision) ||
    marker.controlRevision < 1 ||
    new Set(marker.groups).size !== PROVIDER_USAGE_SCAN_GROUPS.length ||
    marker.groups.length !== PROVIDER_USAGE_SCAN_GROUPS.length ||
    marker.groupIndex !== PROVIDER_USAGE_SCAN_GROUPS.length ||
    marker.cursor !== null ||
    !Number.isSafeInteger(marker.documentCount) ||
    marker.documentCount < 0 ||
    !Number.isSafeInteger(marker.edgeCount) ||
    marker.edgeCount < 0 ||
    !Number.isFinite(marker.completedAtMillis)
  )
    fail();
  nativeCompatibilityTimestamp(snapshot.createTime);
  nativeCompatibilityTimestamp(snapshot.updateTime);
  return marker;
}
function preservedDomains(control) {
  if (
    !firstSix.every(
      (domain) => control?.domains?.[domain]?.owner === 'temporal' && control.domains[domain].admission === 'open'
    )
  )
    fail();
}
function completedPredecessor(state, releaseId, revision, marker) {
  if (
    !state ||
    state.releaseId !== releaseId ||
    state.controlRevision !== revision ||
    state.phase !== 'complete' ||
    !['initial-cutover', 'durable-upgrade'].includes(state.mode) ||
    state.providerUsageEpoch !== marker.epoch ||
    state.providerUsageBackfillRevision !== marker.controlRevision ||
    !Number.isFinite(state.providerUsageVerifiedAt) ||
    marker.controlRevision > revision
  )
    fail();
}
/** Captured from actual predecessor/control/marker snapshots BEFORE the freeze transaction writes. */
export function captureProviderUsageContinuity(config, control, state, snapshot) {
  if (!isSearchProviderUsageContinuity(config)) fail();
  validateControl(control);
  if (
    control?.schemaVersion !== 1 ||
    control.admission !== 'open' ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1 ||
    typeof control.releaseId !== 'string' ||
    !control.releaseId ||
    control.releaseId === config.releaseId ||
    control.domains?.search?.owner !== 'legacy' ||
    control.domains.search.admission !== 'paused'
  )
    fail();
  preservedDomains(control);
  const marker = completedMarker(config.projectId, snapshot, state?.providerUsageEpoch);
  completedPredecessor(state, control.releaseId, control.revision, marker);
  return {
    schemaVersion: 1,
    kind: 'retained-ready-provider-index',
    projectId: config.projectId,
    predecessorReleaseId: control.releaseId,
    predecessorControlRevision: control.revision,
    predecessorStateSha256: digest(state),
    epoch: marker.epoch,
    originReleaseId: marker.releaseId,
    markerDataSha256: digest(marker),
    markerCreateTime: nativeCompatibilityTimestamp(snapshot.createTime),
    markerUpdateTime: nativeCompatibilityTimestamp(snapshot.updateTime),
  };
}
/** No epoch/release relabel: the original live index remains authoritative across search-only onboarding. */
export function validateProviderUsageContinuity(config, control, state, snapshot, history, expectedEpoch) {
  validateControl(control);
  const proof = state?.providerUsageContinuity;
  const keys = [
    'schemaVersion',
    'kind',
    'projectId',
    'predecessorReleaseId',
    'predecessorControlRevision',
    'predecessorStateSha256',
    'epoch',
    'originReleaseId',
    'markerDataSha256',
    'markerCreateTime',
    'markerUpdateTime',
  ];
  if (
    !isSearchProviderUsageContinuity(config) ||
    !proof ||
    Object.keys(proof).length !== keys.length ||
    Object.keys(proof).some((k) => !keys.includes(k)) ||
    proof.schemaVersion !== 1 ||
    proof.kind !== 'retained-ready-provider-index' ||
    proof.projectId !== config.projectId ||
    typeof proof.predecessorReleaseId !== 'string' ||
    !proof.predecessorReleaseId ||
    proof.predecessorReleaseId === config.releaseId ||
    !Number.isSafeInteger(proof.predecessorControlRevision) ||
    proof.predecessorControlRevision < 1 ||
    typeof proof.epoch !== 'string' ||
    !proof.epoch ||
    typeof proof.originReleaseId !== 'string' ||
    !proof.originReleaseId ||
    !/^[a-f0-9]{64}$/.test(proof.predecessorStateSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(proof.markerDataSha256 ?? '') ||
    control?.schemaVersion !== 1 ||
    control.releaseId !== config.releaseId ||
    control.admission !== 'paused' ||
    !Number.isSafeInteger(control.revision) ||
    control.revision <= proof.predecessorControlRevision ||
    state.releaseId !== config.releaseId ||
    state.controlRevision !== control.revision ||
    state.mode !== config.mode ||
    stable(state.domains) !== stable(config.domains) ||
    (expectedEpoch !== undefined && proof.epoch !== expectedEpoch)
  )
    fail();
  preservedDomains(control);
  const effectivePhase = state.phase === 'paused-for-recovery' ? state.pausedFrom : state.phase;
  const beforeOwnership = ['legacy-drained', 'provider-usage-ready', 'workers-ready'].includes(effectivePhase);
  if (
    control.domains?.search?.owner !== (beforeOwnership ? 'legacy' : 'temporal') ||
    control.domains.search.admission !== 'paused'
  )
    fail();
  const marker = completedMarker(config.projectId, snapshot, proof.epoch);
  if (
    marker.releaseId !== proof.originReleaseId ||
    digest(marker) !== proof.markerDataSha256 ||
    stable(nativeCompatibilityTimestamp(snapshot.createTime)) !==
      stable(nativeCompatibilityTimestamp(proof.markerCreateTime)) ||
    stable(nativeCompatibilityTimestamp(snapshot.updateTime)) !==
      stable(nativeCompatibilityTimestamp(proof.markerUpdateTime)) ||
    digest(history) !== proof.predecessorStateSha256
  )
    fail();
  completedPredecessor(history, proof.predecessorReleaseId, proof.predecessorControlRevision, marker);
  return marker;
}
export function providerUsageHistoryPath(state) {
  const id = state?.providerUsageContinuity?.predecessorReleaseId;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
    fail();
  return `_control/temporalReleaseHistory-${id}`;
}
