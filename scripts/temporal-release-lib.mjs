import { PROVIDER_USAGE_SCAN_GROUPS } from './temporal-backfill-provider-usage.mjs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const RELEASE_DOMAINS = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
export const CONTROL_PATH = '_control/temporalRelease';
export function compatibilityLegacyAdmissionCutoffUpdate(control, mode, serverTimestamp) {
  return mode === 'initial-cutover' && !control.legacyAdmissionCutoff
    ? { legacyAdmissionCutoff: serverTimestamp() }
    : {};
}

function needsLegacyUploadDrain(control, domains) {
  if (!domains.includes('media')) return false;
  const owner = control?.domains?.media?.owner;
  if (!['legacy', 'temporal'].includes(owner)) throw new Error('Explicit media ownership is required for upload drain');
  return owner === 'legacy';
}
const pendingLegacyUploads = (firestore) =>
  firestore.collection('sermons').where('status.audioStatus', 'in', ['PENDING', 'PROCESSING']);
/** A browser-owned canonical admission is work even before a file/queue/lease exists.
 * Never exempt an unverified client marker; under legacy ownership all pending rows block. */
export async function countPendingLegacyUploadAdmissions(firestore, control, domains) {
  if (!needsLegacyUploadDrain(control, domains)) return 0;
  const snapshot = await pendingLegacyUploads(firestore).count().get();
  return snapshot.data().count;
}
export async function assertPendingLegacyUploadsDrainedInTransaction(tx, firestore, control, domains) {
  if (!needsLegacyUploadDrain(control, domains)) return;
  const pending = await tx.get(pendingLegacyUploads(firestore).limit(1));
  if (!pending.empty)
    throw new Error(
      'Previously admitted legacy uploads remain pending or processing; complete or explicitly reconcile them before taking ownership'
    );
}

export function validateReleaseConfig(config) {
  const expected = { staging: ['urm-app-staging', 'web-staging'], production: ['urm-app', 'web-prod'] }[
    config.environment
  ];
  if (
    !expected ||
    config.projectId !== expected[0] ||
    config.backendId !== expected[1] ||
    config.location !== 'us-central1'
  )
    throw new Error('Release environment, Firebase project, backend or location mismatch');
  if (
    !Number.isInteger(config.legacyExecutionGraceSeconds) ||
    config.legacyExecutionGraceSeconds < 3600 ||
    config.legacyExecutionGraceSeconds > 86400
  )
    throw new Error(
      'Reviewed legacy execution grace must cover the3570-second native HTTP timeout (3600..86400 seconds)'
    );
  if (!['initial-cutover', 'durable-upgrade'].includes(config.mode))
    throw new Error('An explicit initial-cutover or durable-upgrade mode is required');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(config.releaseId))
    throw new Error('A concrete release UUID is required');
  for (const key of ['compatibilityCommit', 'uiCommit'])
    if (!/^[a-f0-9]{40}$/.test(config[key] ?? '')) throw new Error(`${key} must be a full immutable commit`);
  if (
    !Array.isArray(config.domains) ||
    !config.domains.length ||
    new Set(config.domains).size !== config.domains.length ||
    config.domains.some((d) => !RELEASE_DOMAINS.includes(d))
  )
    throw new Error('Explicit nonduplicate release domains are required');
  for (const key of [
    'platformConfig',
    'platformPeerConfig',
    'compatibilityEvidence',
    'backendEvidence',
    'smokeEvidence',
  ]) {
    if (typeof config[key] !== 'string' || !config[key] || /REQUIRED|PLACEHOLDER|[\r\n\0]/.test(config[key]))
      throw new Error(`Missing concrete ${key}`);
  }
  if (
    config.environment === 'production' &&
    (typeof config.promotionApprovalEvidence !== 'string' ||
      !config.promotionApprovalEvidence ||
      /REQUIRED|PLACEHOLDER|[\r\n\0]/.test(config.promotionApprovalEvidence))
  )
    throw new Error('Production requires reviewed open-staging E2E and human promotion approval evidence');
  if (
    !Number.isInteger(config.providerUsageBackfillTimeoutMs) ||
    config.providerUsageBackfillTimeoutMs < 60000 ||
    config.providerUsageBackfillTimeoutMs > 86400000
  )
    throw new Error('Provider usage backfill maintenance timeout must be explicitly60000..86400000 milliseconds');
  const rtdb = new URL(config.databaseUrl);
  if (rtdb.protocol !== 'https:' || rtdb.hostname !== `${config.projectId}-default-rtdb.firebaseio.com`)
    throw new Error('Release RTDB must match the Firebase project');
  if (!/^[A-Za-z0-9_-]+$/.test(config.mailCollection ?? '')) throw new Error('Invalid mail collection');
  for (const key of ['legacyQueues', 'additionalLegacyQueues'])
    if (!Array.isArray(config[key]) || config[key].some((q) => !/^[a-z][a-z0-9-]+$/.test(q)))
      throw new Error('Explicit reviewed legacy queue lists are required');
  for (const queue of ['processaudiofiletask', 'processaudioyoutubetask'])
    if (!config.legacyQueues.includes(queue)) throw new Error(`Missing mandatory legacy queue ${queue}`);
  return config;
}

export function validateControl(control) {
  if (
    !control ||
    control.schemaVersion !== 1 ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1 ||
    !['open', 'paused'].includes(control.admission) ||
    !control.releaseId
  )
    throw new Error('Valid private release control is required');
  for (const domain of RELEASE_DOMAINS) {
    const value = control.domains?.[domain];
    if (!value || !['legacy', 'temporal'].includes(value.owner) || !['open', 'paused'].includes(value.admission))
      throw new Error(`Missing valid ownership state for ${domain}`);
  }
  return control;
}

export function flagsForControl(control) {
  validateControl(control);
  return Object.fromEntries(
    RELEASE_DOMAINS.map((domain) => [`TASK_ORCHESTRATOR_${domain.toUpperCase()}`, control.domains[domain].owner])
  );
}

export function upsertFunctionFlags(contents, flags) {
  const marker = '# Generated from private _control/temporalRelease; do not infer flags from deploy process.env.';
  const lines = contents
    .split(/\r?\n/)
    .filter(
      (line) =>
        line !== marker && !/^\s*(?:export\s+)?(?:TASK_ORCHESTRATOR_[A-Z_]+|TEMPORAL_RELEASE_COMMIT)\s*=/.test(line)
    );
  while (lines.at(-1) === '') lines.pop();
  return [...lines, marker, ...Object.entries(flags).map(([key, value]) => `${key}=${value}`), ''].join('\n');
}

export function firebaseEnvironmentSources(firebaseConfig, project) {
  const entries = Array.isArray(firebaseConfig.functions)
    ? firebaseConfig.functions
    : [firebaseConfig.functions].filter(Boolean);
  const sources = new Set();
  for (const entry of entries) {
    if (entry.kit) {
      // The abandoned staging Algolia app is intentionally not enabled or redeployed.
      if (project === 'urm-app-staging' && entry.kit === 'firestore-algolia-search') continue;
      for (const path of Object.values(entry.instances ?? {})) sources.add(path);
    } else if (entry.source) sources.add(entry.source);
  }
  if (!sources.size) throw new Error('Firebase function source manifests are empty');
  return [...sources];
}

export function legacyStateCounts({
  requests,
  locks,
  claims,
  deferred,
  youtubeState,
  subsplashLocks,
  now = Date.now(),
}) {
  const values = (object) => Object.values(object && typeof object === 'object' ? object : {});
  const nonempty = (value) => value !== undefined && value !== null && value !== '' && value !== false;
  return {
    activeAudioRequests: values(requests).filter(
      (r) =>
        r &&
        ['queuedTaskId', 'runningRequestId', 'runningTaskId', 'nextPayload', 'deferredAt'].some((k) => nonempty(r[k]))
    ).length,
    audioLocks: values(locks).length,
    audioMutationClaims: values(claims).length,
    deferredYouTubeJobs: values(deferred).length,
    youtubeProbe:
      youtubeState &&
      (youtubeState.probeStatus === 'probing' ||
        nonempty(youtubeState.probeTaskSermonId) ||
        nonempty(youtubeState.probeDispatchReservationId))
        ? 1
        : 0,
    unresolvedPublishingLocks: values(subsplashLocks).length,
  };
}

export function assertDrainedCounts(counts) {
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value !== 0))
    throw new Error(
      'Legacy work is not drained; preserve and complete queued, leased, deferred and uncertain work before cutover'
    );
}

export function firebaseAdmin(projectId, databaseURL) {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_DATABASE_EMULATOR_HOST)
    throw new Error('Release tooling refuses emulator environment overrides');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const require = createRequire(resolve(root, 'functions/package.json'));
  const { initializeApp, getApps, applicationDefault } = require('firebase-admin/app');
  const app =
    getApps().find((app) => app.name === `temporal-release-${projectId}`) ||
    initializeApp({ projectId, databaseURL, credential: applicationDefault() }, `temporal-release-${projectId}`);
  return {
    credential: app.options.credential,
    firestore: require('firebase-admin/firestore').getFirestore(app),
    serverTimestamp: () => require('firebase-admin/firestore').FieldValue.serverTimestamp(),
    database: databaseURL ? require('firebase-admin/database').getDatabase(app) : undefined,
  };
}

export function validateWorkerCoverage(release, platform) {
  if (platform.dispatcherEnabled === false)
    throw new Error(
      'Application cutover requires the orchestration dispatcher enabled; a restart-probe-only deployment cannot own admissions'
    );
  const roleForDomain = {
    media: 'media',
    images: 'images',
    emails: 'email',
    search: 'search',
    accounts: 'orchestration',
    publishing: 'orchestration',
    bundles: 'orchestration',
  };
  if (platform.firebaseProjectId !== release.projectId || platform.workerBuildId !== release.compatibilityCommit)
    throw new Error('Worker identity/build must match project and immutable reviewed backend commit');
  if (
    platform.connectionMode === 'temporal-cloud' &&
    (platform.cloudAccountId !== 'qwejt' ||
      platform.cloudProvider !== 'gcp' ||
      platform.cloudRegion !== release.location ||
      !['us-central1.gcp.api.temporal.io:7233', `${platform.temporalNamespace}.tmprl.cloud:7233`].includes(
        platform.cloudAddress
      ) ||
      platform.temporalNamespace !== `${release.projectId}.qwejt`)
  )
    throw new Error(
      'Cloud release identity must match the trusted account, project namespace and App Hosting GCP region'
    );
  for (const role of new Set(['orchestration', 'controls', ...release.domains.map((d) => roleForDomain[d])]))
    if (!platform.workerRoles?.includes(role))
      throw new Error(`Selected release domain requires missing worker role ${role}`);
  return platform;
}

export function validatePromotionApproval(config, report, now = Date.now()) {
  const age = now - Date.parse(report?.verifiedAt);
  if (
    report?.schemaVersion !== 1 ||
    report.scope !== 'open-staging-end-to-end' ||
    report.stageProjectId !== 'urm-app-staging' ||
    report.result !== 'passed' ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 604800000 ||
    report.failureInjectionPassed !== true ||
    report.userSmokePassed !== true ||
    report.approvedCompatibilityCommit !== config.compatibilityCommit ||
    report.approvedUiCommit !== config.uiCommit ||
    !/^[a-f0-9]{40}$/.test(report.stageCompatibilityCommit ?? '') ||
    !/^[a-f0-9]{40}$/.test(report.stageUiCommit ?? '')
  )
    throw new Error('Production promotion lacks fresh actual open-staging E2E proof for the reviewed target commits');
  const approval = report.humanApproval;
  if (
    approval?.approved !== true ||
    typeof approval.approvedBy !== 'string' ||
    !approval.approvedBy.trim() ||
    !['protected-environment-review', 'explicit-user-message'].includes(approval.source) ||
    typeof approval.evidenceReference !== 'string' ||
    !approval.evidenceReference.trim() ||
    !Number.isFinite(Date.parse(approval.approvedAt)) ||
    Date.parse(approval.approvedAt) < Date.parse(report.verifiedAt) ||
    Date.parse(approval.approvedAt) > now
  )
    throw new Error('Production promotion requires explicit human acceptance after staging smoke');
  if (!Array.isArray(report.testedDomains) || report.testedDomains.some((d) => !RELEASE_DOMAINS.includes(d)))
    throw new Error('Explicit tested staging domains required');
  for (const domain of config.domains)
    if (!report.testedDomains.includes(domain)) {
      const waiver = report.untestedDomainWaivers?.find((w) => w.domain === domain);
      if (
        domain !== 'search' ||
        waiver?.approved !== true ||
        typeof waiver.reason !== 'string' ||
        waiver.reason.length < 30
      )
        throw new Error(`Missing actual staging E2E proof for selected domain ${domain}`);
    }
  return report;
}
export function validatePreopenSmoke(report) {
  if (
    report?.scope !== 'preopen-readonly-and-existing-jobs' ||
    report.readonlySmokePassed !== true ||
    report.claimsFreshWriteE2E === true
  )
    throw new Error('Pre-open smoke must honestly cover readonly/existing jobs; fresh user writes are blocked');
  return report;
}

export function validateProviderUsageMarker(config, marker, expectedEpoch) {
  if (
    marker?.schemaVersion !== 1 ||
    marker.projectId !== config.projectId ||
    marker.status !== 'ready' ||
    !Array.isArray(marker.groups) ||
    !PROVIDER_USAGE_SCAN_GROUPS.every((group) => marker.groups.includes(group)) ||
    typeof marker.epoch !== 'string' ||
    !marker.epoch ||
    (expectedEpoch !== undefined && marker.epoch !== expectedEpoch) ||
    (config.mode === 'initial-cutover' && marker.releaseId !== config.releaseId)
  )
    throw new Error(
      'Provider reference index lacks the verified ready project/release/epoch and complete source groups'
    );
  return marker;
}
