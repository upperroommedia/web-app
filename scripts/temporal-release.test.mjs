import { PROVIDER_USAGE_SCAN_GROUPS } from './temporal-backfill-provider-usage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_DOMAINS,
  validateReleaseConfig,
  validateControl,
  flagsForControl,
  upsertFunctionFlags,
  firebaseEnvironmentSources,
  legacyStateCounts,
  assertDrainedCounts,
  validateWorkerCoverage,
  validatePromotionApproval,
  validatePreopenSmoke,
  validateProviderUsageMarker,
} from './temporal-release-lib.mjs';

const config = {
  environment: 'staging',
  mode: 'initial-cutover',
  legacyExecutionGraceSeconds: 3600,
  providerUsageBackfillTimeoutMs: 1800000,
  projectId: 'urm-app-staging',
  backendId: 'web-staging',
  location: 'us-central1',
  releaseId: 'f6ea4660-779e-4162-947c-5376238cdf9a',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'b'.repeat(40),
  domains: ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'],
  platformConfig: '/secure/stage.json',
  platformPeerConfig: '/secure/prod.json',
  databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com',
  mailCollection: 'mail',
  legacyQueues: ['processaudiofiletask', 'processaudioyoutubetask'],
  additionalLegacyQueues: [],
  compatibilityEvidence: '/secure/compat.json',
  backendEvidence: '/secure/backend.json',
  smokeEvidence: '/secure/smoke.json',
};
const control = {
  schemaVersion: 1,
  revision: 3,
  admission: 'paused',
  releaseId: config.releaseId,
  domains: Object.fromEntries(
    RELEASE_DOMAINS.map((domain) => [
      domain,
      { owner: domain === 'search' ? 'legacy' : 'temporal', admission: 'paused' },
    ])
  ),
};

test('release plan binds explicit project/backend/region/commits and mode', () => {
  assert.equal(validateReleaseConfig(config), config);
  for (const [field, value] of [
    ['projectId', 'urm-app'],
    ['backendId', 'web-prod'],
    ['compatibilityCommit', 'main'],
    ['uiCommit', 'staging'],
    ['releaseId', 'REQUIRED'],
    ['databaseUrl', 'https://urm-app-default-rtdb.firebaseio.com'],
    ['mode', 'fallback'],
    ['domains', ['media', 'media']],
    ['legacyQueues', []],
  ]) {
    assert.throws(() => validateReleaseConfig({ ...config, [field]: value }));
  }
});
test('missing, malformed or partial ownership cannot default to silent legacy deployment', () => {
  for (const value of [
    undefined,
    {},
    { ...control, revision: 0 },
    { ...control, domains: {} },
    { ...control, admission: 'unknown' },
  ])
    assert.throws(() => validateControl(value));
  assert.equal(flagsForControl(control).TASK_ORCHESTRATOR_MEDIA, 'temporal');
  assert.equal(flagsForControl(control).TASK_ORCHESTRATOR_SEARCH, 'legacy');
  assert.equal(Object.keys(flagsForControl(control)).length, RELEASE_DOMAINS.length);
});
test('source env updates preserve existing settings, remove conflicting flags and are idempotent', () => {
  const existing =
    '# Exported instance settings\nMAIL_COLLECTION=mail\nFIREBASE_SECRET_REF_SMTP_PASSWORD=projects/project/secrets/email/versions/latest\nTASK_ORCHESTRATOR_EMAILS=legacy\nexport TASK_ORCHESTRATOR_MEDIA = legacy\n';
  const flags = { ...flagsForControl(control), TEMPORAL_RELEASE_COMMIT: config.compatibilityCommit };
  const next = upsertFunctionFlags(existing, flags);
  assert.match(next, /MAIL_COLLECTION=mail/);
  assert.match(next, /FIREBASE_SECRET_REF_SMTP_PASSWORD=projects\/project\/secrets\/email\/versions\/latest/);
  assert.equal(next.match(/TASK_ORCHESTRATOR_MEDIA=/g).length, 1);
  assert.match(next, /TASK_ORCHESTRATOR_EMAILS=temporal/);
  assert.match(next, /TEMPORAL_RELEASE_COMMIT=a{40}/);
  assert.equal(upsertFunctionFlags(next, flags), next);
});
test('env manifest covers split sources and enabled kit instances while skipping abandoned staging search', () => {
  const manifest = {
    functions: [
      { source: 'functions-core', codebase: 'core' },
      { source: 'functions-media', codebase: 'media' },
      { kit: 'firestore-send-email', instances: { email: 'function-kits/email/config-email' } },
      {
        kit: 'firestore-algolia-search',
        instances: { images: 'function-kits/search/config-images', sermons: 'function-kits/search/config-sermons' },
      },
    ],
  };
  assert.deepEqual(firebaseEnvironmentSources(manifest, 'urm-app-staging'), [
    'functions-core',
    'functions-media',
    'function-kits/email/config-email',
  ]);
  assert.equal(firebaseEnvironmentSources(manifest, 'urm-app').length, 5);
});
test('completed audio metadata alone is drained; queued/running/deferred state and old locks block', () => {
  assertDrainedCounts(
    legacyStateCounts({ requests: { a: { currentPayload: {}, lastCompletedRequestVersion: 'old' } } })
  );
  for (const field of ['queuedTaskId', 'runningRequestId', 'runningTaskId', 'nextPayload', 'deferredAt']) {
    const counts = legacyStateCounts({ requests: { a: { [field]: field === 'nextPayload' ? {} : 'existing' } } });
    assert.throws(() => assertDrainedCounts(counts));
  }
  for (const state of [
    { locks: { a: { expired: true } } },
    { claims: { a: {} } },
    { deferred: { a: {} } },
    { subsplashLocks: { a: { leaseExpiresAtMs: 1 } } },
    { youtubeState: { probeStatus: 'probing' } },
    { youtubeState: { probeDispatchReservationId: 'old' } },
  ]) {
    assert.throws(() => assertDrainedCounts(legacyStateCounts(state)));
  }
});
test('ambiguous, negative or unknown counts cannot certify a drain', () => {
  for (const counts of [{ pending: -1 }, { pending: undefined }, { pending: 0.5 }, { pending: '0' }, { pending: 1 }])
    assert.throws(() => assertDrainedCounts(counts));
  assert.doesNotThrow(() => assertDrainedCounts({ pending: 0, unresolvedLeases: 0 }));
});

const { validateLeaseReview } = await import('./temporal-reconcile-legacy-lease.mjs');
test('audited reconciliation fences exact lease snapshot, verified effects and genuinely stopped runtime', () => {
  const now = Date.now();
  const lease = {
    projectId: 'urm-app-staging',
    leaseId: 'lease-1',
    state: 'active',
    acquiredAt: now - 600000,
    effectsStarted: true,
    releaseRevision: 2,
    heartbeatAt: now - 600000,
    diagnosticExpiresAt: now - 10000,
  };
  const review = {
    projectId: 'urm-app-staging',
    leaseId: 'lease-1',
    reviewId: 'f6ea4660-779e-4162-947c-5376238cdf9a',
    decision: 'completed_verified_effects',
    reason: 'Provider receipt and canonical artifact verified after confirmed worker termination',
    evidenceReferences: ['gs://private-audit/immutable-proof.json'],
    verifiedAt: new Date(now).toISOString(),
    runtimeEndedVerified: true,
    providerEffectsVerified: true,
    observed: lease,
  };
  assert.equal(validateLeaseReview(review, lease, now), review);
  assert.throws(() => validateLeaseReview({ ...review, runtimeEndedVerified: false }, lease, now));
  assert.throws(() => validateLeaseReview(review, { ...lease, heartbeatAt: now }, now));
  assert.throws(() => validateLeaseReview({ ...review, observed: { ...lease, effectsStarted: false } }, lease, now));
  assert.throws(() =>
    validateLeaseReview({ ...review, verifiedAt: new Date(now - 7200000).toISOString() }, lease, now)
  );
});

test('selected domains cannot transfer or open without every native queue role and reviewed build', () => {
  const platform = {
    firebaseProjectId: config.projectId,
    workerBuildId: config.compatibilityCommit,
    workerRoles: ['orchestration', 'controls', 'media', 'images', 'email'],
  };
  assert.equal(validateWorkerCoverage(config, platform), platform);
  assert.throws(
    () => validateWorkerCoverage(config, { ...platform, dispatcherEnabled: false }),
    /restart-probe-only deployment/
  );
  assert.equal(validateWorkerCoverage(config, { ...platform, dispatcherEnabled: true }).dispatcherEnabled, true);
  for (const role of platform.workerRoles)
    assert.throws(() =>
      validateWorkerCoverage(config, { ...platform, workerRoles: platform.workerRoles.filter((r) => r !== role) })
    );
  assert.throws(() => validateWorkerCoverage({ ...config, domains: [...config.domains, 'search'] }, platform));
  assert.throws(() => validateWorkerCoverage(config, { ...platform, workerBuildId: 'c'.repeat(40) }));
});

test('closed-admission smoke cannot claim fresh write E2E or replace human staging promotion acceptance', () => {
  assert.equal(
    validatePreopenSmoke({ scope: 'preopen-readonly-and-existing-jobs', readonlySmokePassed: true })
      .readonlySmokePassed,
    true
  );
  assert.throws(() => validatePreopenSmoke({ scope: 'fresh-upload-e2e', readonlySmokePassed: true }));
  assert.throws(() =>
    validatePreopenSmoke({
      scope: 'preopen-readonly-and-existing-jobs',
      readonlySmokePassed: true,
      claimsFreshWriteE2E: true,
    })
  );
  const now = Date.now();
  const proof = {
    schemaVersion: 1,
    scope: 'open-staging-end-to-end',
    stageProjectId: 'urm-app-staging',
    result: 'passed',
    verifiedAt: new Date(now - 60000).toISOString(),
    failureInjectionPassed: true,
    userSmokePassed: true,
    approvedCompatibilityCommit: config.compatibilityCommit,
    approvedUiCommit: config.uiCommit,
    stageCompatibilityCommit: config.compatibilityCommit,
    stageUiCommit: config.uiCommit,
    testedDomains: config.domains,
    humanApproval: {
      approved: true,
      approvedBy: 'human-reviewer',
      source: 'protected-environment-review',
      evidenceReference: 'https://github.com/upperroommedia/web-app/actions/runs/123',
      approvedAt: new Date(now - 30000).toISOString(),
    },
  };
  assert.equal(validatePromotionApproval(config, proof, now), proof);
  assert.throws(() => validatePromotionApproval(config, { ...proof, userSmokePassed: false }, now));
  assert.throws(() =>
    validatePromotionApproval(config, { ...proof, humanApproval: { ...proof.humanApproval, approved: false } }, now)
  );
  assert.throws(() => validatePromotionApproval(config, { ...proof, testedDomains: ['bundles'] }, now));
  assert.throws(() => validatePromotionApproval(config, { ...proof, approvedUiCommit: 'c'.repeat(40) }, now));
});

test('provider ownership cannot change or open with missing, building or replaced reference index', () => {
  const marker = {
    schemaVersion: 1,
    projectId: config.projectId,
    releaseId: config.releaseId,
    status: 'ready',
    epoch: 'verified-backfill-epoch',
    groups: [...PROVIDER_USAGE_SCAN_GROUPS],
  };
  assert.equal(validateProviderUsageMarker(config, marker, marker.epoch), marker);
  assert.throws(() => validateProviderUsageMarker(config, { ...marker, groups: undefined }, marker.epoch));
  for (const missingGroup of PROVIDER_USAGE_SCAN_GROUPS) {
    assert.throws(() =>
      validateProviderUsageMarker(
        config,
        { ...marker, groups: marker.groups.filter((group) => group !== missingGroup) },
        marker.epoch
      )
    );
  }
  for (const missingGroup of ['temporalProviderAcknowledgementReviews', 'temporalProviderRetentions']) {
    assert.ok(PROVIDER_USAGE_SCAN_GROUPS.includes(missingGroup));
  }
  assert.throws(() => validateProviderUsageMarker(config, undefined, marker.epoch));
  assert.throws(() => validateProviderUsageMarker(config, { ...marker, status: 'building' }, marker.epoch));
  assert.throws(() => validateProviderUsageMarker(config, { ...marker, epoch: 'new-unverified-epoch' }, marker.epoch));
  assert.throws(() => validateProviderUsageMarker(config, { ...marker, projectId: 'urm-app' }, marker.epoch));
});

test('search initial onboarding is separate and settings-bound, while later durable upgrades remain supported', () => {
  const search = { ...config, domains: ['search'], searchSettingsEvidence: '/secure/settings.json' };
  assert.equal(validateReleaseConfig(search), search);
  assert.throws(() => validateReleaseConfig({ ...search, searchSettingsEvidence: undefined }));
  assert.throws(() => validateReleaseConfig({ ...search, domains: ['media', 'search'] }));
  assert.doesNotThrow(() =>
    validateReleaseConfig({ ...config, mode: 'durable-upgrade', domains: ['media', 'search'] })
  );
});
