#!/usr/bin/env node
// Every step is explicit, revision-fenced, resumable, and leaves admissions paused on failure.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  reconcileAppHostingRollout,
  restoreReviewedUiRecovery,
  ensureFrozenRecoveryPolicy,
} from './temporal-apphosting-rollout.mjs';
import {
  validateReleaseConfig,
  validateControl,
  firebaseAdmin,
  CONTROL_PATH,
  RELEASE_DOMAINS,
  flagsForControl,
  legacyStateCounts,
  assertDrainedCounts,
  validateWorkerCoverage,
  validatePromotionApproval,
  validatePreopenSmoke,
  validateProviderUsageMarker,
} from './temporal-release-lib.mjs';

const [action, ...args] = process.argv.slice(2);
const configPath = args[args.indexOf('--release') + 1];
if (
  ![
    'plan',
    'freeze-ui',
    'compatibility-ready',
    'drain',
    'workers-ready',
    'provider-usage-ready',
    'take-ownership',
    'backend-ready',
    'bootstrap-bundles',
    'rollout-ui',
    'open',
    'restore-auto',
    'pause',
    'resume',
    'rollback-ui',
    'restore-reviewed-ui',
  ].includes(action) ||
  !args.includes('--release') ||
  !configPath
)
  throw new Error('Usage: temporal-release.mjs ACTION --release PATH [--apply] [--output PATH]');
const config = validateReleaseConfig(JSON.parse(await readFile(configPath, 'utf8')));
const parent = `projects/${config.projectId}/locations/${config.location}/backends/${config.backendId}`;
if (action === 'plan') {
  console.log(
    'Freeze automatic UI rollouts before merging; deploy compatibility backend/rules; pause new admissions and drain legacy work; verify workers; switch private ownership while paused; write/deploy and verify source env flags; roll out pinned UI; smoke test; open admissions; restore the saved automatic rollout policy. Failures keep admissions paused. No legacy task fallback is permitted.'
  );
  process.exit(0);
}
if (!args.includes('--apply'))
  throw new Error('Remote release operations require explicit --apply; use plan for offline review');
const { firestore, database } = firebaseAdmin(config.projectId, config.databaseUrl);
const controlRef = firestore.doc(CONTROL_PATH);
const stateRef = firestore.doc('_control/temporalReleaseState');
const lockRef = firestore.doc('_control/temporalReleaseOperation');
const operationId = randomUUID();
await firestore.runTransaction(async (tx) => {
  const snapshot = await tx.get(lockRef);
  if (snapshot.exists)
    throw new Error('Another release operation or crash recovery lock exists; inspect it before proceeding');
  tx.create(lockRef, { operationId, releaseId: config.releaseId, action, createdAt: Date.now() });
});

function token() {
  return execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function api(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`Release API ${method} failed: HTTP${response.status}`), { status: response.status });
  return response.json();
}
const appApi = (path, method, body) => api(`https://firebaseapphosting.googleapis.com/v1beta/${path}`, method, body);
async function settleOperation(operation) {
  const deadline = Date.now() + 180_000;
  while (operation.name && !operation.done) {
    if (Date.now() > deadline)
      throw new Error('App Hosting operation is still pending; resume the saved release checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    operation = await appApi(operation.name);
  }
  if (operation.error) throw new Error('App Hosting operation failed; admissions remain paused');
}
async function list(path, key, base = 'apphosting') {
  const result = [];
  let pageToken;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${path}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = base === 'apphosting' ? await appApi(url) : await api(url);
    result.push(...(page[key] ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return result;
}
async function verifyReleaseWorkers() {
  // Read-only preflight verifies actual host/access and original-run worker restart evidence in Cloud mode.
  // Database backup/restore evidence applies only to the separate self-hosted mode.
  execFileSync(
    process.execPath,
    [
      new URL('./deploy-temporal-platform.mjs', import.meta.url).pathname,
      'preflight',
      '--config',
      config.platformConfig,
      '--peer',
      config.platformPeerConfig,
    ],
    { stdio: 'inherit' }
  );
  const platform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
  validateWorkerCoverage(config, platform);
  const pods = JSON.parse(
    execFileSync(
      'kubectl',
      [
        '--context',
        platform.context,
        'get',
        'pods',
        '-n',
        platform.namespace,
        '-l',
        `app.kubernetes.io/name=urm-temporal-worker,app.kubernetes.io/version=${platform.workerBuildId}`,
        '-o',
        'json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  ).items;
  for (const role of platform.workerRoles) {
    const ready = pods.filter(
      (p) =>
        p.metadata.labels['urm.temporal/role'] === role &&
        p.status.conditions?.some((s) => s.type === 'Ready' && s.status === 'True')
    );
    if (ready.length < platform.workerReplicas) throw new Error(`Missing ready${role} worker replicas`);
    if (
      role === 'orchestration' &&
      ready.some(
        (pod) =>
          pod.spec.containers
            .find((container) => container.name === 'worker')
            ?.env?.find((variable) => variable.name === 'TEMPORAL_DISPATCHER_ENABLED')?.value !== 'true'
      )
    )
      throw new Error('Live orchestration Pod must have the dispatcher enabled before application ownership opens');
  }
  const directory = await mkdtemp(join(tmpdir(), 'urm-temporal-release-ready-'));
  try {
    const output = join(directory, 'worker-ready.json');
    execFileSync(
      process.execPath,
      [
        new URL('./deploy-temporal-platform.mjs', import.meta.url).pathname,
        'worker-status',
        '--config',
        config.platformConfig,
        '--peer',
        config.platformPeerConfig,
        '--output',
        output,
        '--apply',
      ],
      { stdio: 'inherit', timeout: 960_000 }
    );
    if (config.domains.includes('emails')) {
      const emailOutput = join(directory, 'email-ready.json');
      execFileSync(
        process.execPath,
        [
          new URL('./deploy-temporal-platform.mjs', import.meta.url).pathname,
          'email-canary',
          '--config',
          config.platformConfig,
          '--peer',
          config.platformPeerConfig,
          '--output',
          emailOutput,
          '--apply',
        ],
        { stdio: 'inherit', timeout: 180000 }
      );
      const emailProof = JSON.parse(await readFile(emailOutput, 'utf8'));
      if (
        emailProof.projectId !== config.projectId ||
        emailProof.buildId !== platform.workerBuildId ||
        emailProof.authenticationVerified !== true ||
        emailProof.tlsVerified !== true ||
        emailProof.noMessageSent !== true
      )
        throw new Error('Reviewed email TLS/authentication canary proof missing');
    }
    const report = JSON.parse(await readFile(output, 'utf8'));
    if (
      report.projectId !== config.projectId ||
      report.buildId !== platform.workerBuildId ||
      report.current !== true ||
      report.allQueuesRegistered !== true
    )
      throw new Error('Native Temporal current-version/queue readiness proof failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return platform;
}
async function verifyUiCommit() {
  const traffic = await appApi(`${parent}/traffic`);
  const live = traffic.current?.splits?.find((split) => split.percent === 100);
  if (!live || traffic.reconciling) throw new Error('Reviewed UI rollout has not settled');
  const build = await appApi(live.build);
  if (build.state !== 'READY' || (build.source?.codebase?.hash ?? build.source?.codebase?.commit) !== config.uiCommit)
    throw new Error('Live UI does not match the reviewed immutable commit');
}
async function snapshot() {
  const [control, state] = await Promise.all([controlRef.get(), stateRef.get()]);
  if (
    !control.exists ||
    !state.exists ||
    control.data().releaseId !== config.releaseId ||
    state.data().releaseId !== config.releaseId
  )
    throw new Error('This release does not own the control/checkpoint document');
  const checkpoint = state.data();
  if (
    checkpoint.mode !== config.mode ||
    checkpoint.compatibilityCommit !== config.compatibilityCommit ||
    checkpoint.uiCommit !== config.uiCommit ||
    JSON.stringify(checkpoint.domains) !== JSON.stringify(config.domains)
  )
    throw new Error(
      'Release descriptor differs from immutable checkpoint; resume with the original reviewed descriptor'
    );
  return { control: validateControl(control.data()), state: checkpoint };
}
async function transition(revision, phase, update = {}, controlUpdate) {
  await firestore.runTransaction(async (tx) => {
    const [current, currentState] = await Promise.all([tx.get(controlRef), tx.get(stateRef)]);
    if (
      current.data()?.releaseId !== config.releaseId ||
      currentState.data()?.releaseId !== config.releaseId ||
      current.data()?.revision !== revision
    )
      throw new Error('Release revision changed; re-read before proceeding');
    if (phase === 'ownership-changed') {
      const usage = await tx.get(firestore.doc('_control/temporalProviderUsage'));
      validateProviderUsageMarker(config, usage.data(), currentState.data().providerUsageEpoch);
      const leases = await tx.get(
        firestore
          .collection('legacyAdmissionLeases')
          .where('state', 'in', ['active', 'needs_attention'])
          .select('domain', 'state')
      );
      if (leases.size) throw new Error('A legacy lease remains active or uncertain; audited reconciliation required');
    }
    tx.update(controlRef, { ...controlUpdate, revision: revision + 1, updatedAt: Date.now() });
    tx.update(stateRef, { ...update, phase, updatedAt: Date.now(), controlRevision: revision + 1 });
  });
}
function requirePhase(state, phases) {
  if (!phases.includes(state.phase))
    throw new Error(`Expected release phase${phases.join('/')} before${action}; found${state.phase}`);
}
function requirePaused(control) {
  if (control.admission !== 'paused' || config.domains.some((d) => control.domains[d].admission !== 'paused'))
    throw new Error('Release admissions must remain paused');
}
async function evidence(path, revision, fields) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (
    value.projectId !== config.projectId ||
    value.releaseId !== config.releaseId ||
    value.controlRevision !== revision ||
    value.result !== 'passed' ||
    !Number.isFinite(Date.parse(value.verifiedAt)) ||
    Date.now() - Date.parse(value.verifiedAt) > 3600_000 ||
    Date.parse(value.verifiedAt) > Date.now()
  )
    throw new Error('Release evidence is stale or belongs to another revision/project');
  for (const [field, expected] of Object.entries(fields))
    if (value[field] !== expected) throw new Error(`Missing verified evidence field${field}`);
  return value;
}
async function functionsList() {
  return list(
    `https://cloudfunctions.googleapis.com/v2/projects/${config.projectId}/locations/${config.location}/functions?pageSize=1000`,
    'functions',
    'cloud'
  );
}
async function queuesEmpty() {
  const counts = {};
  const discovered = await list(
    `https://cloudtasks.googleapis.com/v2/projects/${config.projectId}/locations/${config.location}/queues?pageSize=1000`,
    'queues',
    'cloud'
  );
  const ignoredStagingSearch = (queue) =>
    config.environment === 'staging' &&
    !config.domains.includes('search') &&
    /(?:images|lists|sermons|speakers|users)-index/.test(queue);
  const all = [
    ...new Set([
      ...config.legacyQueues,
      ...config.additionalLegacyQueues,
      ...discovered.map((q) => q.name.split('/').at(-1)).filter((q) => !ignoredStagingSearch(q)),
    ]),
  ];
  for (const queue of all) {
    const name = `projects/${config.projectId}/locations/${config.location}/queues/${queue}`;
    // Stable v2 task listing proves emptiness; approximate beta queue statistics are insufficient.
    const resource = await api(`https://cloudtasks.googleapis.com/v2/${name}/tasks?pageSize=1&responseView=BASIC`);
    counts[`queue:${queue}`] = resource.tasks?.length || resource.nextPageToken ? 1 : 0;
  }
  assertDrainedCounts(counts);
  return counts;
}
async function legacyCounts() {
  const paths = [
    'processAudioRequests',
    'processAudioLocks',
    'processAudioQueueClaims',
    'processAudioQueues/youtube/deferred',
    'processAudioQueues/youtube/state',
    'subsplashLocks',
  ];
  const values = await Promise.all(
    paths.map((path) =>
      database
        .ref(path)
        .get()
        .then((s) => s.val())
    )
  );
  const counts = legacyStateCounts({
    requests: values[0],
    locks: values[1],
    claims: values[2],
    deferred: values[3],
    youtubeState: values[4],
    subsplashLocks: values[5],
  });
  let cursor;
  let legacyMailPending = 0;
  do {
    let query = firestore.collection(config.mailCollection).orderBy('__name__').select('delivery').limit(500);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const delivery = doc.data().delivery;
      if (delivery?.orchestrator !== 'temporal' && !['SUCCESS', 'ERROR'].includes(delivery?.state)) legacyMailPending++;
    }
    cursor = page.size === 500 ? page.docs.at(-1) : undefined;
  } while (cursor);
  counts.legacyMailPending = legacyMailPending;
  const leases = await firestore
    .collection('legacyAdmissionLeases')
    .where('state', 'in', ['active', 'needs_attention'])
    .select('domain', 'state')
    .get();
  counts.unresolvedLegacyAdmissionLeases = leases.size;
  assertDrainedCounts(counts);
  return counts;
}

try {
  if (action === 'freeze-ui') {
    if (config.environment === 'production')
      validatePromotionApproval(config, JSON.parse(await readFile(config.promotionApprovalEvidence, 'utf8')));
    const traffic = await appApi(`${parent}/traffic`);
    if (!traffic.rolloutPolicy || traffic.reconciling || !traffic.etag)
      throw new Error('A stable automatic rollout policy and etag are required');
    if (traffic.rolloutPolicy.codebaseBranch !== (config.environment === 'production' ? 'main' : 'staging'))
      throw new Error('App Hosting live branch must retain its documented main/staging wiring');
    const inFlight = (await list(`${parent}/rollouts?pageSize=100`, 'rollouts')).some(
      (r) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(r.state)
    );
    if (inFlight) throw new Error('An App Hosting rollout is already active; allow it to settle before release freeze');
    const existingState = await stateRef.get();
    if (existingState.exists) {
      if (existingState.data().releaseId !== config.releaseId && existingState.data().phase !== 'complete')
        throw new Error('Another active release checkpoint exists; do not overwrite it');
      if (
        existingState.data().releaseId === config.releaseId &&
        !['freezing-ui', 'ui-frozen'].includes(existingState.data().phase)
      )
        throw new Error('Resume the appropriate existing release phase instead of freezing again');
      if (existingState.data().phase === 'ui-frozen') {
        console.log('UI rollout policy is already frozen for this release.');
        process.exitCode = 0;
      }
    }
    // Save policy/current build BEFORE mutation. Recovery reuses the same request ID.
    const sameRelease = existingState.data()?.releaseId === config.releaseId;
    const requestId = sameRelease ? existingState.data().appHostingFreezeRequestId : randomUUID();
    const previousFunctionTimeout = sameRelease
      ? existingState.data().maximumLegacyExecutionSeconds
      : Math.max(540, ...(await functionsList()).map((fn) => Number(fn.serviceConfig?.timeoutSeconds ?? 0)));
    if (!sameRelease)
      await firestore.runTransaction(async (tx) => {
        const [previous, oldState] = await Promise.all([tx.get(controlRef), tx.get(stateRef)]);
        if (
          config.mode === 'initial-cutover' &&
          previous.exists &&
          config.domains.some((d) => previous.data().domains?.[d]?.owner === 'temporal')
        )
          throw new Error('Initial legacy cutover cannot overwrite existing Temporal ownership');
        if (
          config.mode === 'durable-upgrade' &&
          (!previous.exists || config.domains.some((d) => previous.data().domains?.[d]?.owner !== 'temporal'))
        )
          throw new Error('Durable upgrade requires existing Temporal ownership for every selected domain');
        if (oldState.exists) {
          if (oldState.data().phase !== 'complete') throw new Error('Previous release is not complete');
          tx.set(firestore.doc(`_control/temporalReleaseHistory-${oldState.data().releaseId}`), oldState.data());
        }
        const revision = (previous.data()?.revision ?? 0) + 1;
        tx.set(controlRef, {
          schemaVersion: 1,
          revision,
          admission: 'paused',
          releaseId: config.releaseId,
          updatedAt: Date.now(),
          domains: Object.fromEntries(
            RELEASE_DOMAINS.map((domain) => [
              domain,
              {
                owner: previous.data()?.domains?.[domain]?.owner ?? 'legacy',
                admission: config.domains.includes(domain)
                  ? 'paused'
                  : previous.data()?.domains?.[domain]?.admission ?? 'paused',
              },
            ])
          ),
        });
        tx.set(stateRef, {
          releaseId: config.releaseId,
          mode: config.mode,
          domains: config.domains,
          phase: 'freezing-ui',
          savedRolloutPolicy: traffic.rolloutPolicy,
          savedUiTraffic: traffic.current,
          appHostingFreezeRequestId: requestId,
          maximumLegacyExecutionSeconds: previousFunctionTimeout,
          controlRevision: revision,
          compatibilityCommit: config.compatibilityCommit,
          uiCommit: config.uiCommit,
          updatedAt: Date.now(),
        });
      });
    if (traffic.rolloutPolicy.disabled !== true)
      await settleOperation(
        await appApi(`${parent}/traffic?updateMask=rollout_policy.disabled&requestId=${requestId}`, 'PATCH', {
          name: `${parent}/traffic`,
          etag: traffic.etag,
          rolloutPolicy: { disabled: true },
        })
      );
    const frozen = await appApi(`${parent}/traffic`);
    if (
      frozen.rolloutPolicy?.disabled !== true ||
      frozen.rolloutPolicy.codebaseBranch !== traffic.rolloutPolicy.codebaseBranch
    )
      throw new Error('Automatic rollout freeze did not preserve branch policy');
    const { control } = await snapshot();
    if (!sameRelease || existingState.data()?.phase !== 'ui-frozen') await transition(control.revision, 'ui-frozen');
  } else {
    const { control, state } = await snapshot();
    if (!['pause', 'restore-auto'].includes(action)) requirePaused(control);
    if (action === 'compatibility-ready') {
      requirePhase(state, ['ui-frozen']);
      const report = await evidence(config.compatibilityEvidence, control.revision, {
        commit: config.compatibilityCommit,
        legacyAdmissionPauseVerified: true,
        legacyAdmissionLeaseFencingVerified: true,
        oldBrowserWritePauseVerified: true,
        allSourcesDeployed: true,
      });
      const functions = await functionsList();
      const maxTimeout = Math.max(
        state.maximumLegacyExecutionSeconds ?? 540,
        config.legacyExecutionGraceSeconds,
        ...functions.map((f) => Number(f.serviceConfig?.timeoutSeconds ?? 0))
      );
      await transition(control.revision, 'compatibility-ready', {
        compatibilityVerifiedAt: Date.now(),
        legacySettlingDeadline: Date.now() + (config.mode === 'initial-cutover' ? maxTimeout * 1000 : 0),
        compatibilityEvidenceAt: report.verifiedAt,
      });
    } else if (action === 'drain') {
      requirePhase(state, ['compatibility-ready', 'legacy-drained']);
      if (Date.now() < state.legacySettlingDeadline)
        throw new Error(
          'Wait for maximum legacy execution duration after compatibility deployment before proving drain'
        );
      const counts = { ...(await queuesEmpty()), ...(await legacyCounts()) };
      await transition(control.revision, 'legacy-drained', { legacyDrainedAt: Date.now(), legacyDrainCounts: counts });
    } else if (action === 'provider-usage-ready') {
      requirePhase(state, ['legacy-drained', 'provider-usage-ready']);
      await queuesEmpty();
      await legacyCounts();
      if (config.mode === 'initial-cutover') {
        const dir = await mkdtemp(join(tmpdir(), 'urm-provider-usage-drain-'));
        try {
          const proof = join(dir, 'drain.json');
          await writeFile(
            proof,
            JSON.stringify({
              schemaVersion: 1,
              projectId: config.projectId,
              releaseId: config.releaseId,
              controlRevision: control.revision,
              result: 'passed',
              legacyDrained: true,
            }),
            { mode: 0o600 }
          );
          execFileSync(
            process.execPath,
            [
              new URL('./temporal-backfill-provider-usage.mjs', import.meta.url).pathname,
              '--project',
              config.projectId,
              '--release',
              config.releaseId,
              '--control-revision',
              String(control.revision),
              '--drain-proof',
              proof,
              '--apply',
            ],
            { stdio: 'inherit', timeout: config.providerUsageBackfillTimeoutMs }
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      const marker = (await firestore.doc('_control/temporalProviderUsage').get()).data();
      validateProviderUsageMarker(config, marker);
      await transition(control.revision, 'provider-usage-ready', {
        providerUsageEpoch: marker.epoch,
        providerUsageBackfillRevision: marker.controlRevision,
        providerUsageVerifiedAt: Date.now(),
      });
    } else if (action === 'workers-ready') {
      requirePhase(state, ['provider-usage-ready', 'workers-ready']);
      const platform = await verifyReleaseWorkers();
      await transition(control.revision, 'workers-ready', {
        workerBuildId: platform.workerBuildId,
        workersVerifiedAt: Date.now(),
      });
    } else if (action === 'take-ownership') {
      requirePhase(state, ['workers-ready']);
      await queuesEmpty();
      await legacyCounts();
      const platform = await verifyReleaseWorkers();
      if (platform.workerBuildId !== state.workerBuildId)
        throw new Error('Reviewed worker changed since readiness checkpoint');
      const domains = structuredClone(control.domains);
      for (const domain of config.domains) domains[domain] = { owner: 'temporal', admission: 'paused' };
      await transition(control.revision, 'ownership-changed', {}, { domains });
      console.log(
        'Ownership changed while paused. Generate real source env files, deploy all backends/kits, then run backend-ready.'
      );
    } else if (action === 'backend-ready') {
      requirePhase(state, ['ownership-changed']);
      await evidence(config.backendEvidence, control.revision, {
        commit: config.compatibilityCommit,
        allSourcesDeployed: true,
        runtimeServicesDeployed: true,
        facadeOwnershipVerified: true,
      });
      const expected = flagsForControl(control);
      const managed = (await functionsList()).filter((f) => !f.name.split('/').at(-1).startsWith('ext-'));
      if (!managed.length) throw new Error('No managed function runtimes found');
      for (const fn of managed) {
        if (fn.state !== 'ACTIVE') throw new Error('Managed function deployment has not settled');
        const deployed =
          fn.environment === 'GEN_1'
            ? (await api(`https://cloudfunctions.googleapis.com/v1/${fn.name}`)).environmentVariables
            : fn.serviceConfig?.environmentVariables;
        if (deployed?.TEMPORAL_RELEASE_COMMIT !== config.compatibilityCommit)
          throw new Error('A managed function is not deployed from the reviewed backend commit');
        for (const [key, value] of Object.entries(expected))
          if (deployed?.[key] !== value)
            throw new Error(`Deployed function ownership flag mismatch:${fn.name.split('/').at(-1)}:${key}`);
      }
      await transition(control.revision, 'backend-ready', { backendVerifiedAt: Date.now() });
    } else if (action === 'bootstrap-bundles') {
      requirePhase(state, ['backend-ready']);
      if (!config.domains.includes('bundles')) throw new Error('This release does not own bundle regeneration');
      const response = execFileSync(
        process.execPath,
        [
          new URL('./temporal-bootstrap-bundles.mjs', import.meta.url).pathname,
          '--project',
          config.projectId,
          '--release-id',
          config.releaseId,
          '--control-revision',
          String(control.revision),
          '--timeout-ms',
          '840000',
          '--apply',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 }
      );
      const proof = JSON.parse(response);
      if (
        proof.projectId !== config.projectId ||
        proof.releaseId !== config.releaseId ||
        proof.controlRevision !== control.revision ||
        proof.result !== 'passed' ||
        !Array.isArray(proof.bundleTypes) ||
        proof.bundleTypes.length !== 6 ||
        new Set(proof.bundleTypes).size !== 6
      )
        throw new Error('Bundle convergence proof failed; admissions remain paused');
      await transition(control.revision, 'bundles-ready', {
        bundlesConverged: true,
        bundleTypes: proof.bundleTypes,
        bootstrapJobIds: proof.bootstrapJobIds ?? proof.jobIds,
        bundleConvergenceJobIds: proof.jobIds,
      });
    } else if (action === 'rollout-ui') {
      requirePhase(state, [
        config.domains.includes('bundles') ? 'bundles-ready' : 'backend-ready',
        'ui-rollout-started',
      ]);
      if (state.phase === 'ui-rollout-started' && !state.uiRolloutIdentity)
        throw new Error(
          'Old rollout checkpoint lacks immutable identity; read-only reconciliation required before adopting it'
        );
      const result = await reconcileAppHostingRollout({
        config: { parent, releaseId: config.releaseId, uiCommit: config.uiCommit },
        checkpoint: state.uiRolloutIdentity,
        api: appApi,
        saveIdentity: async (identity) =>
          transition(control.revision, 'ui-rollout-started', {
            uiRolloutStartedAt: Date.now(),
            uiRolloutIdentity: identity,
          }),
      });
      if (result.status !== 'ready')
        throw new Error(
          'Reviewed UI build/rollout remains pending; rerun rollout-ui to reconcile the same immutable identity'
        );
      const fresh = await snapshot();
      await transition(fresh.control.revision, 'ui-ready', {
        uiBuild: result.buildName,
        uiRollout: result.rolloutName,
        uiVerifiedAt: Date.now(),
      });
    } else if (action === 'open') {
      requirePhase(state, ['ui-ready']);
      if (config.domains.includes('bundles') && state.bundlesConverged !== true)
        throw new Error('All six bundle pointers must converge before admissions open');
      validatePreopenSmoke(
        await evidence(config.smokeEvidence, control.revision, {
          uiCommit: config.uiCommit,
          backendOwnershipVerified: true,
          workerReady: true,
          oldBrowserWritesDenied: true,
        })
      );
      const platform = await verifyReleaseWorkers();
      if (platform.workerBuildId !== state.workerBuildId)
        throw new Error('Reviewed worker changed before opening admission');
      const usage = (await firestore.doc('_control/temporalProviderUsage').get()).data();
      validateProviderUsageMarker(config, usage, state.providerUsageEpoch);
      const domains = structuredClone(control.domains);
      for (const domain of config.domains) domains[domain].admission = 'open';
      await transition(control.revision, 'open', { openedAt: Date.now() }, { admission: 'open', domains });
    } else if (action === 'restore-auto') {
      // Opening is the explicit smoke acceptance; saved policy is never restored on an error path.
      requirePhase(state, ['open']);
      const traffic = await appApi(`${parent}/traffic`);
      if (traffic.rolloutPolicy?.codebaseBranch !== state.savedRolloutPolicy.codebaseBranch)
        throw new Error('Automatic rollout branch policy changed during the cutover; review before restoring it');
      await settleOperation(
        await appApi(`${parent}/traffic?updateMask=rollout_policy.disabled&requestId=${randomUUID()}`, 'PATCH', {
          name: `${parent}/traffic`,
          etag: traffic.etag,
          rolloutPolicy: { disabled: state.savedRolloutPolicy.disabled ?? false },
        })
      );
      await transition(control.revision, 'complete', { completedAt: Date.now() });
    } else if (action === 'pause') {
      const domains = structuredClone(control.domains);
      for (const domain of config.domains) domains[domain].admission = 'paused';
      await transition(
        control.revision,
        'paused-for-recovery',
        { pausedFrom: state.phase === 'paused-for-recovery' ? state.pausedFrom : state.phase },
        { admission: 'paused', domains }
      );
    } else if (action === 'resume') {
      requirePhase(state, ['paused-for-recovery']);
      if (!state.pausedFrom) throw new Error('Recovery has no saved phase; operator must reconcile the checkpoint');
      const phase = ['open', 'complete'].includes(state.pausedFrom) ? 'ui-ready' : state.pausedFrom;
      if (phase === 'ui-ready') await verifyUiCommit();
      await transition(control.revision, phase, { resumedAt: Date.now() });
    } else if (action === 'restore-reviewed-ui') {
      requirePhase(state, ['paused-for-recovery']);
      await restoreReviewedUiRecovery({
        parent,
        uiCommit: config.uiCommit,
        buildName: state.uiBuild,
        savedRolloutPolicy: state.savedRolloutPolicy,
        api: appApi,
        settleOperation,
      });
      await transition(control.revision, 'ui-ready', { reviewedUiRestoredAt: Date.now() });
    } else if (action === 'rollback-ui') {
      // Keep Temporal ownership and pinned workers. Old UI stays read-only until an explicit compatible recovery release.
      const previous = state.savedUiTraffic?.splits?.find((split) => split.percent === 100)?.build;
      if (!previous) throw new Error('No saved known-good UI build is available');
      const traffic = await appApi(`${parent}/traffic`);
      await settleOperation(
        await appApi(`${parent}/traffic?updateMask=target&requestId=${randomUUID()}`, 'PATCH', {
          name: `${parent}/traffic`,
          etag: traffic.etag,
          target: { splits: [{ build: previous, percent: 100 }] },
        })
      );
      await ensureFrozenRecoveryPolicy({
        parent,
        savedRolloutPolicy: state.savedRolloutPolicy,
        api: appApi,
        settleOperation,
      });
      await transition(control.revision, 'paused-for-recovery', { rollbackUiBuild: previous });
    }
  }
  if (args.includes('--output')) {
    const state = await snapshot();
    await writeFile(args[args.indexOf('--output') + 1], JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`Temporal release ${action} checkpoint saved. Existing jobs and worker versions are retained.`);
} finally {
  await firestore.runTransaction(async (tx) => {
    const lock = await tx.get(lockRef);
    if (lock.data()?.operationId === operationId) tx.delete(lockRef);
  });
}
