import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_USAGE_SCAN_GROUPS, assertProviderBackfillControl } from './temporal-backfill-provider-usage.mjs';
import { RELEASE_DOMAINS, validateProviderUsageMarker } from './temporal-release-lib.mjs';
import {
  isSearchProviderUsageContinuity,
  captureProviderUsageContinuity,
  validateProviderUsageContinuity,
  providerUsageHistoryPath,
} from './temporal-provider-usage-continuity.mjs';
const predecessor = 'a801c079-a832-4bfa-a526-ec385e49d27f',
  releaseId = '99ef4e7e-fadf-4830-b631-68a82a20d82d';
const config = {
  projectId: 'urm-app-staging',
  environment: 'staging',
  mode: 'initial-cutover',
  domains: ['search'],
  releaseId,
};
function fixture({ upgradedPredecessor = false } = {}) {
  const oldControl = {
    schemaVersion: 1,
    releaseId: predecessor,
    revision: 14,
    admission: 'open',
    domains: Object.fromEntries(
      RELEASE_DOMAINS.map((domain) => [
        domain,
        { owner: domain === 'search' ? 'legacy' : 'temporal', admission: domain === 'search' ? 'paused' : 'open' },
      ])
    ),
  };
  const marker = {
    schemaVersion: 1,
    projectId: config.projectId,
    status: 'ready',
    releaseId: upgradedPredecessor ? 'older-original-index-release' : predecessor,
    controlRevision: 7,
    epoch: 'original-verified-index-epoch',
    groups: [...PROVIDER_USAGE_SCAN_GROUPS],
    groupIndex: PROVIDER_USAGE_SCAN_GROUPS.length,
    cursor: null,
    documentCount: 1571,
    edgeCount: 2000,
    completedAtMillis: 1791957000000,
  };
  const oldState = {
    releaseId: predecessor,
    controlRevision: 14,
    mode: upgradedPredecessor ? 'durable-upgrade' : 'initial-cutover',
    phase: 'complete',
    providerUsageEpoch: marker.epoch,
    providerUsageBackfillRevision: marker.controlRevision,
    providerUsageVerifiedAt: 1791957001000,
  };
  const snap = {
    exists: true,
    data: () => structuredClone(marker),
    createTime: { seconds: 1791956000, nanoseconds: 1000 },
    updateTime: { seconds: 1791957000, nanoseconds: 2000 },
  };
  const continuity = captureProviderUsageContinuity(config, oldControl, oldState, snap);
  const control = { ...structuredClone(oldControl), releaseId, revision: 18, admission: 'paused' };
  const state = {
    releaseId,
    controlRevision: 18,
    mode: config.mode,
    domains: ['search'],
    phase: 'legacy-drained',
    providerUsageContinuity: continuity,
  };
  return { oldControl, oldState, marker, snap, control, state };
}
test('search-only staging carries the exact original ready epoch without pretending it belongs to the new release', () => {
  for (const upgradedPredecessor of [false, true]) {
    const f = fixture({ upgradedPredecessor });
    assert.equal(isSearchProviderUsageContinuity(config), true);
    assert.deepEqual(validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState), f.marker);
    assert.equal(f.state.providerUsageContinuity.originReleaseId, f.marker.releaseId);
    assert.equal(providerUsageHistoryPath(f.state), `_control/temporalReleaseHistory-${predecessor}`);
    assert.throws(() => validateProviderUsageMarker(config, f.marker), /Provider reference/);
    const proof = {
      schemaVersion: 1,
      projectId: config.projectId,
      releaseId,
      controlRevision: 18,
      result: 'passed',
      legacyDrained: true,
    };
    assert.throws(
      () =>
        assertProviderBackfillControl(
          f.control,
          { projectId: config.projectId, releaseId, controlRevision: 18 },
          proof
        ),
      /CONTROL_NOT_FROZEN/
    );
  }
});
test('capture requires actually completed first-six owners, paused legacy search and verified producer completion', () => {
  for (const mutate of [
    (f) => (f.oldState.phase = 'workers-ready'),
    (f) => (f.oldState.providerUsageEpoch = 'other'),
    (f) => f.oldState.providerUsageBackfillRevision++,
    (f) => (f.oldControl.admission = 'paused'),
    (f) => (f.oldControl.domains.media.owner = 'legacy'),
    (f) => (f.oldControl.domains.bundles.admission = 'paused'),
    (f) => (f.oldControl.domains.search.owner = 'temporal'),
    (f) => (f.oldControl.domains.search.admission = 'open'),
    (f) => f.marker.groupIndex--,
    (f) => (f.marker.cursor = 'unfinished'),
    (f) => (f.marker.documentCount = -1),
    (f) => (f.marker.status = 'building'),
    (f) => (f.marker.projectId = 'urm-app'),
    (f) => delete f.snap.updateTime,
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => captureProviderUsageContinuity(config, f.oldControl, f.oldState, f.snap));
  }
  for (const patch of [
    { projectId: 'urm-app' },
    { environment: 'production' },
    { mode: 'durable-upgrade' },
    { domains: ['search', 'images'] },
  ]) {
    const f = fixture();
    assert.throws(() => captureProviderUsageContinuity({ ...config, ...patch }, f.oldControl, f.oldState, f.snap));
  }
});
test('ready-marker body/native identity/history/epoch and first-six ownership cannot drift before final CAS', () => {
  for (const mutate of [
    (f) => (f.marker.epoch = 'replaced'),
    (f) => (f.marker.releaseId = releaseId),
    (f) => f.marker.edgeCount++,
    (f) => f.snap.updateTime.nanoseconds++,
    (f) => f.snap.createTime.seconds++,
    (f) => f.oldState.providerUsageVerifiedAt++,
    (f) => (f.oldState.phase = 'open'),
    (f) => (f.state.providerUsageContinuity.epoch = 'invented'),
    (f) => (f.state.providerUsageContinuity.extra = true),
    (f) => f.state.controlRevision++,
    (f) => (f.control.domains.accounts.owner = 'legacy'),
    (f) => (f.control.domains.publishing.admission = 'paused'),
    (f) => (f.control.admission = 'open'),
    (f) => (f.control.domains.search.owner = 'temporal'),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState));
  }
  const f = fixture();
  assert.throws(() => validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState, 'wrong-epoch'));
});
test('after search ownership changes the same unchanged ledger must be retained through opening', () => {
  const f = fixture();
  f.control.domains.search.owner = 'temporal';
  f.state.phase = 'ui-ready';
  assert.deepEqual(
    validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState, f.marker.epoch),
    f.marker
  );
  f.control.domains.search.admission = 'open';
  assert.throws(() => validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState));
});

test('provider-ready recovery preserves legacy search and retained epoch before ownership transfer', () => {
  const f = fixture();
  f.state.phase = 'paused-for-recovery';
  f.state.pausedFrom = 'provider-usage-ready';
  f.state.providerUsageEpoch = f.marker.epoch;
  assert.deepEqual(
    validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState, f.state.providerUsageEpoch),
    f.marker
  );
  f.state.pausedFrom = 'ownership-changed';
  assert.throws(() => validateProviderUsageContinuity(config, f.control, f.state, f.snap, f.oldState));
});
