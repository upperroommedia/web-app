#!/usr/bin/env node
import { collectCloudRunReleaseWorkers, readCloudRunNamespaceEvidence, verifyCloudRunScalerPolicies, verifyCloudRunComputeIsolation } from './temporal-release-cloud-run.mjs';
import { verifyCloudRunDispatchConfiguration } from './temporal-release-dispatch.mjs';
import { verifyPreparationEvidence } from './temporal-preparation-evidence.mjs';
import { prepareCloudRunIdentity } from './temporal-prepare-cloud-identity.mjs';
import { prepareCloudRunScalerAccess } from './temporal-prepare-scaler-access.mjs';
import { prepareCloudRunRuntimeRole } from './temporal-prepare-runtime-role.mjs';
import { prepareCloudRunFirestoreAccess } from './temporal-prepare-firestore-access.mjs';
import { prepareCloudRunSecretAccess } from './temporal-prepare-secret-access.mjs';
import { prepareCloudRunZeroPool } from './temporal-prepare-cloud-pool.mjs';
import { readPreparationReceipt } from './temporal-preparation-evidence.mjs';
import { saveIdentityPreparationCheckpoint, savePoolPreparationCheckpoint, saveSecretAccessPreparationCheckpoint, saveScalerAccessPreparationCheckpoint, saveFirestoreAccessPreparationCheckpoint, saveRuntimeRolePreparationCheckpoint } from './temporal-preparation-checkpoint.mjs';
// Every step is explicit, revision-fenced, resumable, and leaves admissions paused on failure.
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { verifyTemporalCallableTransport } from './temporal-callable-access.mjs';
import { verifyFirebaseRtdbReadiness, validateCloudEvidence } from './temporal-platform.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pinReleaseCheckouts,
  loadReleaseResourceBinding,
  assertReleaseRuntimeSource,
  releaseScript,
  verifyReleaseResourceIdentity,
  verifyReleaseOperator,
  prepareLocalReleaseADC,
  hash,
  proofDigest,
  artifactProof,
  assertSameArtifact,
  nativeSnapshotProof,
  assertNativeSnapshot,
  confirmBundleProofInTransaction,
} from './temporal-release-runtime.mjs';
import {
  reconcileAppHostingRollout,
  prepareLegacyRolloutIdentityMigration,
  rolloutIdentity,
  sameAppHostingResource,
  verifyAppHostingBuild,
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
  countPendingLegacyUploadAdmissions,
  assertLegacyDrainInTransaction,
  countPendingSeriesMetadataContinuations,
  legacyMailRequiresDrain,
} from './temporal-release-lib.mjs';

import {
  confirmSearchBootstrapInTransaction,
  requiredPreUiPhase,
  requiresSearchBootstrap,
  searchRecoveryPhase,
  confirmAndWriteSearchReadiness,
  assertNoUnfinishedNonSearchJobs,
} from './temporal-bootstrap-search.mjs';
import { createHash } from 'node:crypto';
import { runWithCleanup } from './temporal-release-resources.mjs';
import {
  isSearchProviderUsageContinuity,
  captureProviderUsageContinuity,
  validateProviderUsageContinuity,
  providerUsageHistoryPath,
} from './temporal-provider-usage-continuity.mjs';

import {
  compatibilityCutoffUpdates,
  hasCompatibilitySettlingCheckpoint,
  assertCompatibilitySettlingCheckpoint,
  assertCompatibilityGraceElapsed,
} from './temporal-compatibility-cutoff.mjs';

const [action, ...args] = process.argv.slice(2);
const configPath = args[args.indexOf('--release') + 1];
if (
  ![
    'plan',
    'freeze-ui',
    'compatibility-ready',
    'drain',
    'workers-ready',
    'prepare-cloud-run-identity',
    'prepare-cloud-run-pool',
    'prepare-cloud-run-secret-access',
    'prepare-cloud-run-scaler-access',
    'prepare-cloud-run-firestore-access',
    'prepare-cloud-run-runtime-role',
    'provider-usage-ready',
    'take-ownership',
    'backend-ready',
    'bootstrap-bundles',
    'bootstrap-search',
    'rollout-ui',
    'migrate-ui-identity',
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
const descriptorBytes = await readFile(configPath, 'utf8');
const config = validateReleaseConfig(JSON.parse(descriptorBytes));
const parent = `projects/${config.projectId}/locations/${config.location}/backends/${config.backendId}`;
if (action === 'plan') {
  console.log(
    'Freeze automatic UI rollouts before merging; deploy compatibility backend/rules; pause new admissions and drain legacy work; verify workers; switch private ownership while paused; write/deploy and verify source env flags; roll out pinned UI; smoke test; open admissions; restore the saved automatic rollout policy. Failures keep admissions paused. No legacy task fallback is permitted.'
  );
  process.exit(0);
}
if (!args.includes('--apply'))
  throw new Error('Remote release operations require explicit --apply; use plan for offline review');
const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = args.includes('--runtime-root') ? resolve(args[args.indexOf('--runtime-root') + 1]) : operatorRoot;
const binding = pinReleaseCheckouts(operatorRoot, runtimeRoot, config);
const resourceBinding = loadReleaseResourceBinding(config);
const operatorIdentity = {
  descriptorSHA256: hash(descriptorBytes),
  operatorRoot: binding.operatorRoot,
  runtimeRoot: binding.runtimeRoot,
  operatorCommit: binding.operatorCommit,
  runtimeCommit: binding.runtimeCommit,
  operatorClosureDigest: binding.operatorClosureDigest,
  runtimePins: binding.runtimePins,
  resourceBinding,
};
const preparationArguments = ['prepare-cloud-run-identity', 'prepare-cloud-run-pool', 'prepare-cloud-run-secret-access', 'prepare-cloud-run-scaler-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role'].includes(action) ? {
  role: args[args.indexOf('--identity-role') + 1],
  kind: args[args.indexOf('--identity-kind') + 1],
  proof: args[args.indexOf('--preparation-proof') + 1],
  digest: args[args.indexOf('--preparation-proof-sha256') + 1],
} : undefined;
if (preparationArguments) {
  const required = ['--identity-role', '--preparation-proof', '--preparation-proof-sha256', ...(action === 'prepare-cloud-run-identity' ? ['--identity-kind'] : ['--pool-settings', '--pool-settings-sha256', '--runner-preparation-operation'])];
  if (!required.every(flag => args.includes(flag)) ||
    !/^[a-f0-9]{64}$/.test(preparationArguments.digest ?? ''))
    throw new Error('Explicit immutable identity preparation inputs required');
  if (['prepare-cloud-run-pool', 'prepare-cloud-run-secret-access', 'prepare-cloud-run-scaler-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role'].includes(action)) {
    delete preparationArguments.kind;
    preparationArguments.settings = args[args.indexOf('--pool-settings') + 1];
    preparationArguments.settingsDigest = args[args.indexOf('--pool-settings-sha256') + 1];
    preparationArguments.runnerOperationId = args[args.indexOf('--runner-preparation-operation') + 1];
    if (!/^[a-f0-9]{64}$/.test(preparationArguments.settingsDigest ?? '') ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(preparationArguments.runnerOperationId ?? ''))
      throw new Error('Explicit immutable pool preparation inputs required');
  }
  if (action === 'prepare-cloud-run-secret-access') {
    if (!args.includes('--secret-name')) throw new Error('Explicit source-rendered secret required');
    preparationArguments.secret = args[args.indexOf('--secret-name') + 1];
  }
  if (action === 'prepare-cloud-run-scaler-access') {
    for (const [field, flag] of [['surface', '--iam-surface'], ['scalerOperationId', '--scaler-preparation-operation'], ['poolOperationId', '--pool-preparation-operation']]) {
      if (!args.includes(flag)) throw new Error('Explicit scoped scaler preparation inputs required');
      preparationArguments[field] = args[args.indexOf(flag) + 1];
    }
    if (![preparationArguments.scalerOperationId, preparationArguments.poolOperationId].every(value =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? '')))
      throw new Error('Explicit immutable owned-resource receipts required');
  }
  if (action === 'prepare-cloud-run-runtime-role') {
    if (!args.includes('--runtime-surface')) throw new Error('Explicit source-derived runtime surface required');
    preparationArguments.surface = args[args.indexOf('--runtime-surface') + 1];
  }
  operatorIdentity.cloudIdentityPreparation = preparationArguments;
}
const bindingDigest = proofDigest(operatorIdentity);
const adc = prepareLocalReleaseADC(binding.operatorRoot, config.projectId);
let resources;
try {
  resources = firebaseAdmin(config.projectId, resourceBinding.resources.databaseUrl);
} catch (error) {
  adc.close();
  throw error;
}
await runWithCleanup(
  async () => {
    const { firestore, database, serverTimestamp } = resources;
    const controlRef = firestore.doc(CONTROL_PATH);
    const stateRef = firestore.doc('_control/temporalReleaseState');
    const lockRef = firestore.doc('_control/temporalReleaseOperation');
    const resumeOperation = args.includes('--resume-operation')
      ? args[args.indexOf('--resume-operation') + 1]
      : undefined;
    if (resumeOperation && !/^[a-f0-9-]{36}$/.test(resumeOperation))
      throw new Error('Explicit release operation UUID required');
    if (resources.credential !== adc.credential)
      throw new Error('Release SDK credential differs from bounded local ADC');
    const operatorPrincipal = {
      ...(await verifyReleaseOperator(binding, resources.credential)),
      adcType: adc.adcType,
      sdkCredentialImplementationSHA256: adc.sdkCredentialImplementationSHA256,
    };
    const operationId = resumeOperation ?? randomUUID();
    let operationAcquired = false,
      transitionPending = false,
      cloudWorkerProbePending = false,
      cloudIdentityPending = false,
      expectedAuthority,
      resourceIdentity,
      ownedOperation,
      sourceControl;
    const auditPath = (revision) => `_control/temporalReleaseOperatorAudit-${operationId}-${revision}`;
    await runWithCleanup(
      async () => {
        await firestore.runTransaction(async (tx) => {
          const snapshot = await tx.get(lockRef);
          if (snapshot.exists) {
            const held = snapshot.data();
            if (
              !resumeOperation ||
              held.operationId !== resumeOperation ||
              held.releaseId !== config.releaseId ||
              held.action !== action ||
              held.bindingDigest !== bindingDigest
            )
              throw new Error('Another release operation or crash recovery lock exists; inspect it before proceeding');
          } else {
            if (resumeOperation)
              throw new Error(
                'Reviewed operation is absent; inspect its immutable audit before starting a fresh action'
              );
            tx.create(lockRef, {
              operationId,
              releaseId: config.releaseId,
              action,
              bindingDigest,
              operatorIdentity,
              operatorPrincipal,
              createdAt: serverTimestamp(),
            });
          }
        });
        operationAcquired = true;
        ownedOperation = nativeSnapshotProof(await lockRef.get());

        function token() {
          return execFileSync('gcloud', ['auth', 'print-access-token'], {
            encoding: 'utf8',
            timeout: 60000,
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
            throw Object.assign(new Error(`Release API ${method} failed: HTTP${response.status}`), {
              status: response.status,
            });
          return response.json();
        }
        const appApi = (path, method, body) =>
          api(`https://firebaseapphosting.googleapis.com/v1beta/${path}`, method, body);
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
          const configuredPlatform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
          if (configuredPlatform.workerHosting === 'cloud-run') {
            validateWorkerCoverage(config, configuredPlatform);
            validateCloudEvidence(configuredPlatform, await readCloudRunNamespaceEvidence(configuredPlatform), { requireRecovery: false });
            const held = await lockRef.get();
            assertNativeSnapshot(ownedOperation, held);
            const hasPrior = Object.prototype.hasOwnProperty.call(held.data(), 'cloudWorkerIntent');
            const prior = held.data()?.cloudWorkerIntent;
            if (hasPrior) cloudWorkerProbePending = true;
            if (hasPrior && (!prior || typeof prior !== 'object' || Array.isArray(prior) ||
              Object.keys(prior).sort().join(',') !== 'artifactDirectory,bindings,createdAt,nonce,schemaVersion,workflowId'))
              throw new Error('CLOUD_RUN_SAVED_PROBE_INTENT_INVALID');
            const directory = prior?.artifactDirectory ?? await realpath(await mkdtemp(join(tmpdir(), 'urm-temporal-cloud-ready-')));
            const savedIntent = prior && (({ artifactDirectory, ...intent }) => intent)(prior);
            const scalerPolicies = await verifyCloudRunScalerPolicies(configuredPlatform, api);
            const dispatchConfiguration = await verifyCloudRunDispatchConfiguration(configuredPlatform, api);
            await collectCloudRunReleaseWorkers({ binding, config, platform: configuredPlatform, firestore,
              artifactDirectory: directory, savedIntent,
              recordIntent: async (intent) => {
                // From this point a lost transaction acknowledgement is uncertain.
                cloudWorkerProbePending = true;
                await firestore.runTransaction(async (tx) => {
                  const current = await tx.get(lockRef);
                  assertNativeSnapshot(ownedOperation, current);
                  if (current.get('cloudWorkerIntent')) throw new Error('CLOUD_RUN_PROBE_INTENT_ALREADY_EXISTS');
                  tx.update(lockRef, { cloudWorkerIntent: { ...intent, artifactDirectory: directory } });
                });
                ownedOperation = nativeSnapshotProof(await lockRef.get());
              },
            });
            // The native collector validates canonical private directory ownership
            // and the matching saved intent before any additional artifact write.
            await writeFile(join(directory, `scaler-policy-${randomUUID()}.json`), JSON.stringify(scalerPolicies),
              { flag: 'wx', mode: 0o600 });
            await writeFile(join(directory, `dispatch-configuration-${randomUUID()}.json`), JSON.stringify(dispatchConfiguration),
              { flag: 'wx', mode: 0o600 });
            cloudWorkerProbePending = false;
            // Never substitute role execution for the remaining native guards.
            // This hosting branch cannot advance a release until their actual
            // implementations are connected; no descriptor boolean can bypass it.
            throw new Error('CLOUD_RUN_RECOVERY_AND_DISPATCH_GATES_REQUIRED');
          }
          // Read-only preflight verifies actual host/access and original-run worker restart evidence in Cloud mode.
          // Database backup/restore evidence applies only to the separate self-hosted mode.
          execFileSync(
            process.execPath,
            [
              releaseScript(binding, 'deploy-temporal-platform.mjs'),
              'preflight',
              '--config',
              config.platformConfig,
              '--peer',
              config.platformPeerConfig,
            ],
            { stdio: 'inherit', cwd: binding.operatorRoot }
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
              throw new Error(
                'Live orchestration Pod must have the dispatcher enabled before application ownership opens'
              );
          }
          const directory = await mkdtemp(join(tmpdir(), 'urm-temporal-release-ready-'));
          try {
            const output = join(directory, 'worker-ready.json');
            execFileSync(
              process.execPath,
              [
                releaseScript(binding, 'deploy-temporal-platform.mjs'),
                'worker-status',
                '--config',
                config.platformConfig,
                '--peer',
                config.platformPeerConfig,
                '--output',
                output,
                '--apply',
              ],
              { stdio: 'inherit', timeout: 960_000, cwd: binding.operatorRoot }
            );
            await verifyFirebaseRtdbReadiness(
              platform,
              {
                configPath: config.platformConfig,
                peerPath: config.platformPeerConfig,
                output: join(directory, 'firebase-rtdb-ready.json'),
              },
              {
                run: (args) =>
                  execFileSync(process.execPath, [releaseScript(binding, 'deploy-temporal-platform.mjs'), ...args], {
                    stdio: 'inherit',
                    timeout: 120000,
                    cwd: binding.operatorRoot,
                  }),
                readProof: async (path) => JSON.parse(await readFile(path, 'utf8')),
              }
            );
            if (config.domains.includes('emails')) {
              const emailOutput = join(directory, 'email-ready.json');
              execFileSync(
                process.execPath,
                [
                  releaseScript(binding, 'deploy-temporal-platform.mjs'),
                  'email-canary',
                  '--config',
                  config.platformConfig,
                  '--peer',
                  config.platformPeerConfig,
                  '--output',
                  emailOutput,
                  '--apply',
                ],
                { stdio: 'inherit', timeout: 180000, cwd: binding.operatorRoot }
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
        async function verifyUiCommit(checkpoint) {
          const traffic = await appApi(`${parent}/traffic`);
          const splits = traffic.current?.splits ?? [];
          const live = splits.length === 1 && splits[0].percent === 100 ? splits[0] : undefined;
          if (!live || traffic.reconciling) throw new Error('Reviewed UI rollout has not settled');
          const expectedBuild = checkpoint.uiBuild;
          if (!expectedBuild || !sameAppHostingResource(live.build, expectedBuild, resourceIdentity.projectNumber))
            throw new Error('Live UI does not match the reviewed immutable build');
          const build = await appApi(expectedBuild);
          if (
            !expectedBuild ||
            !sameAppHostingResource(live.build, expectedBuild, resourceIdentity.projectNumber) ||
            !verifyAppHostingBuild(
              build,
              { buildName: expectedBuild, uiCommit: config.uiCommit },
              resourceIdentity.projectNumber
            ) ||
            build.state !== 'READY' ||
            build.reconciling
          )
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
          const validatedControl = validateControl(control.data());
          if (hasCompatibilitySettlingCheckpoint(validatedControl, checkpoint, config))
            assertCompatibilitySettlingCheckpoint(validatedControl, checkpoint, config);
          sourceControl ??= validatedControl;
          await assertReleaseRuntimeSource(binding, config, sourceControl);
          expectedAuthority = { control: nativeSnapshotProof(control), state: nativeSnapshotProof(state) };
          return { control: validatedControl, state: checkpoint, serverReadTime: control.readTime };
        }
        async function transition(revision, phase, update = {}, controlUpdate) {
          await firestore.runTransaction(async (tx) => {
            transitionPending = false;
            const [current, currentState, operation] = await Promise.all([
              tx.get(controlRef),
              tx.get(stateRef),
              tx.get(lockRef),
            ]);
            if (
              current.data()?.releaseId !== config.releaseId ||
              currentState.data()?.releaseId !== config.releaseId ||
              current.data()?.revision !== revision ||
              operation.data()?.operationId !== operationId ||
              operation.data()?.releaseId !== config.releaseId ||
              operation.data()?.action !== action
            )
              throw new Error('Release revision changed; re-read before proceeding');
            if (operation.data()?.bindingDigest !== bindingDigest)
              throw new Error('Operator/runtime operation binding changed');
            assertNativeSnapshot(ownedOperation, operation);
            if (expectedAuthority) {
              assertNativeSnapshot(expectedAuthority.control, current);
              assertNativeSnapshot(expectedAuthority.state, currentState);
            }
            if (hasCompatibilitySettlingCheckpoint(current.data(), currentState.data(), config)) {
              assertCompatibilitySettlingCheckpoint(current.data(), currentState.data(), config);
              if (!['compatibility-ready', 'pause', 'resume', 'rollback-ui', 'restore-reviewed-ui'].includes(action))
                assertCompatibilityGraceElapsed(current.data(), currentState.data(), config, current.readTime);
            }
            if (
              phase === 'legacy-drained' ||
              (phase === 'ownership-changed' && !isSearchProviderUsageContinuity(config))
            )
              await assertLegacyDrainInTransaction(
                tx,
                firestore,
                current.data(),
                config.domains,
                config.mailCollection
              );
            if (
              isSearchProviderUsageContinuity(config) &&
              ['provider-usage-ready', 'ownership-changed', 'open'].includes(phase)
            ) {
              await assertLegacyDrainInTransaction(
                tx,
                firestore,
                current.data(),
                config.domains,
                config.mailCollection
              );
              await assertNoUnfinishedNonSearchJobs(firestore, tx);
              const [usage, history] = await Promise.all([
                tx.get(firestore.doc('_control/temporalProviderUsage')),
                tx.get(firestore.doc(providerUsageHistoryPath(currentState.data()))),
              ]);
              validateProviderUsageContinuity(
                config,
                current.data(),
                currentState.data(),
                usage,
                history.data(),
                phase === 'provider-usage-ready' ? update.providerUsageEpoch : currentState.data().providerUsageEpoch
              );
            } else if (phase === 'ownership-changed') {
              const usage = await tx.get(firestore.doc('_control/temporalProviderUsage'));
              validateProviderUsageMarker(config, usage.data(), currentState.data().providerUsageEpoch);
            }
            if (phase === 'search-ready') {
              if (currentState.data().phase !== 'backend-ready' || !requiresSearchBootstrap(config))
                throw new Error('Search convergence can only follow its reviewed backend-ready checkpoint');
              await confirmAndWriteSearchReadiness(
                firestore,
                tx,
                {
                  projectId: config.projectId,
                  releaseId: config.releaseId,
                  commit: config.compatibilityCommit,
                  controlRevision: revision,
                  operationId,
                },
                update.searchBootstrapProof
              );
            }
            if (requiresSearchBootstrap(config) && ['ui-rollout-started', 'ui-ready', 'open'].includes(phase)) {
              await confirmSearchBootstrapInTransaction(
                firestore,
                tx,
                {
                  projectId: config.projectId,
                  releaseId: config.releaseId,
                  commit: config.compatibilityCommit,
                  controlRevision: revision,
                  operationId,
                },
                currentState.data().searchBootstrapProof,
                { phase: currentState.data().phase, action }
              );
            }
            if (phase === 'compatibility-ready') {
              if (currentState.data().phase !== 'ui-frozen')
                throw new Error('Compatibility cutoff already committed or phase changed');
              if (
                config.mode === 'initial-cutover' &&
                (!Number.isSafeInteger(currentState.data().maximumLegacyExecutionSeconds) ||
                  update.legacySettlingGraceSeconds < currentState.data().maximumLegacyExecutionSeconds ||
                  update.legacySettlingGraceSeconds < config.legacyExecutionGraceSeconds)
              )
                throw new Error('Reviewed compatibility grace changed');
              const cutoff = compatibilityCutoffUpdates(
                current.data(),
                config.mode,
                update.legacySettlingGraceSeconds,
                serverTimestamp
              );
              controlUpdate = { ...controlUpdate, ...cutoff.controlUpdate };
              update = { ...update, ...cutoff.stateUpdate };
            }
            if (update.uiRolloutIdentityMigration) {
              const migration = update.uiRolloutIdentityMigration;
              if (
                action !== 'migrate-ui-identity' ||
                currentState.data().phase !== 'ui-rollout-started' ||
                current.data().admission !== 'paused' ||
                RELEASE_DOMAINS.some((domain) => current.data().domains[domain]?.admission !== 'paused') ||
                proofDigest(currentState.data().uiRolloutIdentity) !== proofDigest(migration.previousIdentity) ||
                Date.now() < migration.observedAt ||
                Date.now() - migration.inspectionStartedAt >= 60000
              )
                throw new Error('UI identity migration authority or fresh absence proof changed');
            }
            if (phase === 'bundles-ready') {
              if (currentState.data().phase !== 'backend-ready' || !update.bundleBootstrapProof)
                throw new Error('Bundle checkpoint requires current backend-ready and complete artifact proof');
              await confirmBundleProofInTransaction(tx, firestore, update.bundleBootstrapProof, config.projectId);
            }
            transitionPending = true;
            tx.create(firestore.doc(auditPath(revision + 1)), {
              schemaVersion: 1,
              operationId,
              action,
              releaseId: config.releaseId,
              fromRevision: revision,
              toRevision: revision + 1,
              fromPhase: currentState.data()?.phase ?? null,
              toPhase: phase,
              operatorIdentity,
              operatorPrincipal,
              resourceIdentity,
              operationAuthority: ownedOperation,
              runtimeSourceVerified: true,
              authority: expectedAuthority ?? null,
              bundleBootstrapProof: update.bundleBootstrapProof ?? null,
              uiRolloutIdentityMigration: update.uiRolloutIdentityMigration ?? null,
              createdAt: serverTimestamp(),
            });
            tx.update(controlRef, { ...controlUpdate, revision: revision + 1, updatedAt: Date.now() });
            tx.update(stateRef, { ...update, phase, updatedAt: Date.now(), controlRevision: revision + 1 });
          });
          transitionPending = false;
          await snapshot();
        }
        async function verifyBundleArtifacts(proof) {
          if (
            proof.operatorRuntime?.operatorCommit !== binding.operatorCommit ||
            proof.operatorRuntime?.runtimeCommit !== binding.runtimeCommit ||
            proof.operatorRuntime?.operatorClosureDigest !== binding.operatorClosureDigest ||
            proofDigest(proof.operatorRuntime?.resourceBinding) !== proofDigest(resourceBinding) ||
            proofDigest(proof.operatorRuntime?.resourceIdentity) !== proofDigest(resourceIdentity) ||
            proof.artifactProofs?.length !== 6
          )
            throw new Error('Bundle proof operator/runtime/resource binding changed');
          for (const expected of proof.artifactProofs) {
            if (expected.bucket !== resourceBinding.resources.storageBucket)
              throw new Error('Bundle artifact bucket changed');
            const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
              expected.bucket
            )}/o/${encodeURIComponent(expected.path)}`;
            const pointer = (await firestore.doc(`_durableBundlePointers/${expected.bundleType}`).get()).data();
            const currentHead = await api(url);
            assertSameArtifact(expected, artifactProof(expected.bundleType, pointer, currentHead, expected.bucket));
            const metadata = await api(
              `${url}?generation=${expected.generation}&ifMetagenerationMatch=${expected.metageneration}`
            );
            assertSameArtifact(expected, artifactProof(expected.bundleType, pointer, metadata, expected.bucket));
            const finalHead = await api(url);
            assertSameArtifact(expected, artifactProof(expected.bundleType, pointer, finalHead, expected.bucket));
          }
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
        async function verifyCallableTransport(control, managed) {
          return verifyTemporalCallableTransport({
            functions: managed ?? (await functionsList()),
            projectId: config.projectId,
            projectNumber: resourceIdentity.projectNumber,
            region: config.location,
            runtimeCommit: config.compatibilityCommit,
            flags: flagsForControl(control),
            api,
          });
        }
        async function verifyStorageFirestoreRulesAccess() {
          const member = `serviceAccount:service-${resourceIdentity.projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
          // getIamPolicy is an official POST read; it never grants or changes a role.
          const policy = await api(
            `https://cloudresourcemanager.googleapis.com/v1/projects/${config.projectId}:getIamPolicy`,
            'POST',
            { options: { requestedPolicyVersion: 3 } }
          );
          if (
            !Array.isArray(policy.bindings) ||
            !policy.bindings.some(
              (binding) =>
                binding.role === 'roles/firebaserules.firestoreServiceAgent' &&
                Array.isArray(binding.members) &&
                binding.members.includes(member) &&
                !Object.hasOwn(binding, 'condition')
            )
          )
            throw new Error('Storage cross-service Firestore rules permission missing');
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
            const resource = await api(
              `https://cloudtasks.googleapis.com/v2/${name}/tasks?pageSize=1&responseView=BASIC`
            );
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
              if (legacyMailRequiresDrain(delivery)) legacyMailPending++;
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
          const currentControl = (await controlRef.get()).data();
          counts.pendingLegacyUploadAdmissions = await countPendingLegacyUploadAdmissions(
            firestore,
            currentControl,
            config.domains
          );
          counts.pendingSeriesMetadataContinuations = await countPendingSeriesMetadataContinuations(
            firestore,
            currentControl,
            config.domains
          );
          assertDrainedCounts(counts);
          return counts;
        }

        resourceIdentity = await verifyReleaseResourceIdentity(resourceBinding, api);
        sourceControl = (await controlRef.get()).data();
        await assertReleaseRuntimeSource(binding, config, sourceControl);
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
          if (inFlight)
            throw new Error('An App Hosting rollout is already active; allow it to settle before release freeze');
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
              const [previous, oldState, usage] = await Promise.all([
                tx.get(controlRef),
                tx.get(stateRef),
                isSearchProviderUsageContinuity(config)
                  ? tx.get(firestore.doc('_control/temporalProviderUsage'))
                  : Promise.resolve(undefined),
              ]);
              const providerUsageContinuity = isSearchProviderUsageContinuity(config)
                ? captureProviderUsageContinuity(config, previous.data(), oldState.data(), usage)
                : undefined;
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
                ...(providerUsageContinuity ? { providerUsageContinuity } : {}),
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
          if (!sameRelease || existingState.data()?.phase !== 'ui-frozen')
            await transition(control.revision, 'ui-frozen');
        } else {
          const { control, state, serverReadTime } = await snapshot();
          if (!['pause', 'restore-auto'].includes(action)) requirePaused(control);
          if (
            hasCompatibilitySettlingCheckpoint(control, state, config) &&
            !['pause', 'resume', 'rollback-ui', 'restore-reviewed-ui', 'compatibility-ready'].includes(action)
          )
            assertCompatibilityGraceElapsed(control, state, config, serverReadTime);
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
              ...(config.mode === 'initial-cutover' ? { legacySettlingGraceSeconds: maxTimeout } : {}),
              compatibilityEvidenceAt: report.verifiedAt,
            });
          } else if (action === 'drain') {
            requirePhase(state, ['compatibility-ready', 'legacy-drained']);
            assertCompatibilityGraceElapsed(control, state, config, serverReadTime);
            const counts = { ...(await queuesEmpty()), ...(await legacyCounts()) };
            await transition(control.revision, 'legacy-drained', {
              legacyDrainedAt: Date.now(),
              legacyDrainCounts: counts,
            });
          } else if (action === 'provider-usage-ready') {
            requirePhase(state, ['legacy-drained', 'provider-usage-ready']);
            await queuesEmpty();
            await legacyCounts();
            if (config.mode === 'initial-cutover' && !isSearchProviderUsageContinuity(config)) {
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
                    releaseScript(binding, 'temporal-backfill-provider-usage.mjs'),
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
                  { stdio: 'inherit', timeout: config.providerUsageBackfillTimeoutMs, cwd: binding.runtimeRoot }
                );
              } finally {
                await rm(dir, { recursive: true, force: true });
              }
            }
            const markerSnapshot = await firestore.doc('_control/temporalProviderUsage').get();
            const marker = markerSnapshot.data();
            if (isSearchProviderUsageContinuity(config)) {
              const history = await firestore.doc(providerUsageHistoryPath(state)).get();
              validateProviderUsageContinuity(config, control, state, markerSnapshot, history.data());
            } else validateProviderUsageMarker(config, marker);
            await transition(control.revision, 'provider-usage-ready', {
              providerUsageEpoch: marker.epoch,
              providerUsageBackfillRevision: marker.controlRevision,
              providerUsageVerifiedAt: Date.now(),
            });
          } else if (action === 'prepare-cloud-run-identity') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('IDENTITY_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
            if (platform.workerHosting !== 'cloud-run') throw new Error('IDENTITY_PREPARATION_REQUIRES_CLOUD_RUN');
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments,
              path: preparationArguments.proof, platform, binding, google: api });
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudIdentityPreparation');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudIdentityPreparation-${operationId}`);
            const result = await prepareCloudRunIdentity({ platform, role: preparationArguments.role,
              kind: preparationArguments.kind, operationId, creator: operatorPrincipal.email,
              evidenceDigest: preparationArguments.digest, api,
              saved: hasSaved ? currentOperation.get('cloudIdentityPreparation') : undefined,
              save: async (identityState) => {
                cloudIdentityPending = true;
                ownedOperation = await saveIdentityPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.account.uniqueId') !== result.account.uniqueId)
              throw new Error('IDENTITY_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Dedicated identity preparation recorded at ${immutableReceipt.path}; no grants or compute activation.`);
          } else if (action === 'prepare-cloud-run-pool') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('POOL_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const runnerReceipt = await firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get();
            if (!runnerReceipt.exists) throw new Error('POOL_RUNNER_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudPoolPreparation');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudPoolPreparation-${operationId}`);
            const result = await prepareCloudRunZeroPool({ platform, role: preparationArguments.role, settings,
              operationId, releaseId: config.releaseId, evidenceDigest: preparationArguments.digest,
              identityReceipt: runnerReceipt.data(), api,
              observeComputeIsolation: () => verifyCloudRunComputeIsolation({ binding, config, platform, firestore }),
              saved: hasSaved ? currentOperation.get('cloudPoolPreparation') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await savePoolPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.pool.uid') !== result.pool.uid)
              throw new Error('POOL_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Zero-target pool configuration recorded at ${immutableReceipt.path}; no activation or readiness claim.`);
          } else if (['prepare-cloud-run-secret-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role'].includes(action)) {
            const accessPreparation = {
              'prepare-cloud-run-secret-access': { field: 'cloudSecretAccessPreparation', prefix: 'temporalCloudSecretAccessPreparation', prepare: prepareCloudRunSecretAccess, save: saveSecretAccessPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-firestore-access': { field: 'cloudFirestoreAccessPreparation', prefix: 'temporalCloudFirestoreAccessPreparation', prepare: prepareCloudRunFirestoreAccess, save: saveFirestoreAccessPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-runtime-role': { field: 'cloudRuntimeRolePreparation', prefix: 'temporalCloudRuntimeRolePreparation', prepare: prepareCloudRunRuntimeRole, save: saveRuntimeRolePreparationCheckpoint, etagField: 'identityState.nativeRole.etag' },
            }[action];
            const preparationField = accessPreparation.field;
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('SECRET_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const runnerReceipt = await firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get();
            if (!runnerReceipt.exists) throw new Error('SECRET_RUNNER_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), preparationField);
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/${accessPreparation.prefix}-${operationId}`);
            const result = await accessPreparation.prepare({ platform, role: preparationArguments.role, surface: preparationArguments.surface, settings,
              secret: preparationArguments.secret, operationId, releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, identityReceipt: runnerReceipt.data(), api,
              saved: hasSaved ? currentOperation.get(preparationField) : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await accessPreparation.save({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get(accessPreparation.etagField) !== (result.nativeRole?.etag ?? result.observedEtag))
              throw new Error('SECRET_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Scoped runtime preparation recorded at ${immutableReceipt.path}; no effective-access or activation claim.`);
          } else if (action === 'prepare-cloud-run-scaler-access') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('SCALER_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = JSON.parse(await readFile(config.platformConfig, 'utf8'));
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const [runnerReceipt, scalerReceipt, poolReceipt] = await Promise.all([
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.scalerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudPoolPreparation-${preparationArguments.poolOperationId}`).get(),
            ]);
            if (![runnerReceipt, scalerReceipt, poolReceipt].every(receipt => receipt.exists))
              throw new Error('SCALER_OWNED_RESOURCE_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudScalerAccessPreparation');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudScalerAccessPreparation-${operationId}`);
            const result = await prepareCloudRunScalerAccess({ platform, role: preparationArguments.role,
              surface: preparationArguments.surface, settings, operationId, releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, runnerReceipt: runnerReceipt.data(), scalerReceipt: scalerReceipt.data(),
              poolReceipt: poolReceipt.data(), api,
              observeComputeIsolation: () => verifyCloudRunComputeIsolation({ binding, config, platform, firestore }),
              saved: hasSaved ? currentOperation.get('cloudScalerAccessPreparation') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveScalerAccessPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.observedEtag') !== result.observedEtag)
              throw new Error('SCALER_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Scoped runner/scaler policy observation recorded at ${immutableReceipt.path}; no compute attachment or effective-access claim.`);
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
            await verifyCallableTransport(control, managed);
            await verifyStorageFirestoreRulesAccess();
            await transition(control.revision, 'backend-ready', { backendVerifiedAt: Date.now() });
          } else if (action === 'bootstrap-bundles') {
            if (!config.domains.includes('bundles')) throw new Error('This release does not own bundle regeneration');
            if (state.phase === 'bundles-ready') {
              const proof = state.bundleBootstrapProof;
              const previousAudit = (await firestore.doc(state.bundleBootstrapAudit).get()).data();
              if (
                !previousAudit ||
                previousAudit.releaseId !== config.releaseId ||
                previousAudit.toRevision !== control.revision ||
                previousAudit.toPhase !== 'bundles-ready' ||
                proofDigest(previousAudit.bundleBootstrapProof) !== proofDigest(proof)
              )
                throw new Error('Bundle checkpoint audit is absent or changed; inspect before reconciliation');
              await verifyBundleArtifacts(proof);
              await firestore.runTransaction(async (tx) => {
                const [c, checkpoint, op] = await Promise.all([tx.get(controlRef), tx.get(stateRef), tx.get(lockRef)]);
                assertNativeSnapshot(expectedAuthority.control, c);
                assertNativeSnapshot(expectedAuthority.state, checkpoint);
                if (op.data()?.operationId !== operationId || op.data()?.bindingDigest !== bindingDigest)
                  throw new Error('Owned operation changed during checkpoint reconciliation');
                await confirmBundleProofInTransaction(tx, firestore, proof, config.projectId);
              });
            } else {
              requirePhase(state, ['backend-ready']);
              const response = execFileSync(
                process.execPath,
                [
                  releaseScript(binding, 'temporal-bootstrap-bundles.mjs'),
                  '--project',
                  config.projectId,
                  '--release-id',
                  config.releaseId,
                  '--control-revision',
                  String(control.revision),
                  '--timeout-ms',
                  '840000',
                  '--release',
                  resolve(configPath),
                  '--runtime-root',
                  binding.runtimeRoot,
                  '--operator-binding-digest',
                  bindingDigest,
                  '--apply',
                ],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, cwd: binding.runtimeRoot }
              );
              const proof = JSON.parse(response);
              if (
                proof.projectId !== config.projectId ||
                proof.releaseId !== config.releaseId ||
                proof.controlRevision !== control.revision ||
                proof.result !== 'passed'
              )
                throw new Error('Bundle convergence proof failed; admissions remain paused');
              await verifyBundleArtifacts(proof);
              await transition(control.revision, 'bundles-ready', {
                bundlesConverged: true,
                bundleTypes: proof.bundleTypes,
                bootstrapJobIds: proof.bootstrapJobIds ?? proof.jobIds,
                bundleConvergenceJobIds: proof.jobIds,
                bundleBootstrapProof: proof,
                bundleBootstrapAudit: auditPath(control.revision + 1),
              });
            }
          } else if (action === 'bootstrap-search') {
            requirePhase(state, ['backend-ready']);
            if (!requiresSearchBootstrap(config))
              throw new Error('This release does not own staging search onboarding');
            const response = execFileSync(
              process.execPath,
              [
                releaseScript(binding, 'temporal-bootstrap-search.mjs'),
                '--project',
                config.projectId,
                '--release-id',
                config.releaseId,
                '--commit',
                config.compatibilityCommit,
                '--control-revision',
                String(control.revision),
                '--operation-id',
                operationId,
                '--release',
                configPath,
                '--settings-proof',
                config.searchSettingsEvidence,
                '--timeout-ms',
                '840000',
                '--apply',
              ],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, cwd: binding.runtimeRoot }
            );
            const proof = JSON.parse(response);
            if (
              proof.result !== 'passed' ||
              proof.projectId !== config.projectId ||
              proof.releaseId !== config.releaseId ||
              proof.commit !== config.compatibilityCommit ||
              proof.controlRevision !== control.revision ||
              proof.appId !== '2VZFOFLFHE' ||
              !Array.isArray(proof.jobIds) ||
              proof.jobIds.length !== 5 ||
              new Set(proof.jobIds).size !== 5 ||
              !Array.isArray(proof.generations) ||
              proof.generations.length !== 5
            )
              throw new Error('Search bootstrap did not confirm its exact five release jobs');
            const settings = JSON.parse(await readFile(config.searchSettingsEvidence, 'utf8'));
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
            if (proof.settingsReceiptCanonicalSha256 !== createHash('sha256').update(stable(settings)).digest('hex'))
              throw new Error('Applied search settings evidence changed during bootstrap');
            await transition(control.revision, 'search-ready', { searchConverged: true, searchBootstrapProof: proof });
          } else if (action === 'migrate-ui-identity') {
            requirePhase(state, ['ui-rollout-started']);
            if (
              control.admission !== 'paused' ||
              RELEASE_DOMAINS.some((domain) => control.domains[domain]?.admission !== 'paused')
            )
              throw new Error('Identity migration requires all release admissions paused');
            const uiConfig = { parent, releaseId: config.releaseId, uiCommit: config.uiCommit };
            if (state.uiRolloutIdentity?.schemaVersion === 2) {
              const migration = state.uiRolloutIdentityMigration;
              const audit = (
                await firestore
                  .doc(state.uiRolloutIdentityMigrationAuditPath ?? '_control/absent-identity-migration')
                  .get()
              ).data();
              if (
                !migration ||
                proofDigest(state.uiRolloutIdentity) !== proofDigest(rolloutIdentity(uiConfig)) ||
                proofDigest(migration.previousIdentity) !== proofDigest(rolloutIdentity(uiConfig, 1)) ||
                audit?.action !== 'migrate-ui-identity' ||
                audit?.releaseId !== config.releaseId ||
                audit?.toRevision !== control.revision ||
                proofDigest(audit.uiRolloutIdentityMigration) !== proofDigest(migration)
              )
                throw new Error('Completed identity migration lacks its immutable audit');
              // Explicit unknown-ACK recovery verifies the same history; no second revision or POST.
              await prepareLegacyRolloutIdentityMigration({
                config: uiConfig,
                checkpoint: migration.previousIdentity,
                api: appApi,
              });
              await firestore.runTransaction(async (tx) => {
                const [current, checkpoint, operation] = await Promise.all([
                  tx.get(controlRef),
                  tx.get(stateRef),
                  tx.get(lockRef),
                ]);
                assertNativeSnapshot(expectedAuthority.control, current);
                assertNativeSnapshot(expectedAuthority.state, checkpoint);
                assertNativeSnapshot(ownedOperation, operation);
              });
            } else {
              const migration = await prepareLegacyRolloutIdentityMigration({
                config: uiConfig,
                checkpoint: state.uiRolloutIdentity,
                projectNumber: resourceIdentity.projectNumber,
                api: appApi,
              });
              await transition(control.revision, 'ui-rollout-started', {
                uiRolloutIdentity: migration.identity,
                uiRolloutIdentityMigration: migration,
                uiRolloutIdentityMigrationAuditPath: auditPath(control.revision + 1),
              });
            }
          } else if (action === 'rollout-ui') {
            requirePhase(state, [requiredPreUiPhase(config), 'ui-rollout-started']);
            if (state.phase === 'ui-rollout-started' && !state.uiRolloutIdentity)
              throw new Error(
                'Old rollout checkpoint lacks immutable identity; read-only reconciliation required before adopting it'
              );
            const result = await reconcileAppHostingRollout({
              config: { parent, releaseId: config.releaseId, uiCommit: config.uiCommit },
              checkpoint: state.uiRolloutIdentity,
              projectNumber: resourceIdentity.projectNumber,
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
            if (requiresSearchBootstrap(config) && state.searchConverged !== true)
              throw new Error('All five search indexes must converge before admissions open');
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
            const usage = await firestore.doc('_control/temporalProviderUsage').get();
            if (isSearchProviderUsageContinuity(config)) {
              const history = await firestore.doc(providerUsageHistoryPath(state)).get();
              validateProviderUsageContinuity(config, control, state, usage, history.data(), state.providerUsageEpoch);
            } else validateProviderUsageMarker(config, usage.data(), state.providerUsageEpoch);
            await verifyCallableTransport(control);
            await verifyStorageFirestoreRulesAccess();
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
            if (!state.pausedFrom)
              throw new Error('Recovery has no saved phase; operator must reconcile the checkpoint');
            const phase = requiresSearchBootstrap(config)
              ? searchRecoveryPhase(state.pausedFrom)
              : ['open', 'complete'].includes(state.pausedFrom)
              ? 'ui-ready'
              : state.pausedFrom;
            if (phase === 'ui-ready') await verifyUiCommit(state);
            await transition(control.revision, phase, { resumedAt: Date.now() });
          } else if (action === 'restore-reviewed-ui') {
            requirePhase(state, ['paused-for-recovery']);
            await restoreReviewedUiRecovery({
              parent,
              uiCommit: config.uiCommit,
              buildName: state.uiBuild,
              projectNumber: resourceIdentity.projectNumber,
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
      },
      async () => {
        if (!operationAcquired || transitionPending || cloudWorkerProbePending || cloudIdentityPending) return;
        await firestore.runTransaction(async (tx) => {
          const lock = await tx.get(lockRef);
          if (lock.data()?.operationId === operationId) {
            assertNativeSnapshot(ownedOperation, lock);
            if (
              lock.data()?.bindingDigest !== bindingDigest ||
              lock.data()?.action !== action ||
              lock.data()?.releaseId !== config.releaseId
            )
              throw new Error('Owned release operation changed; retained for inspection');
            tx.delete(lockRef);
          }
        });
      }
    );
  },
  () =>
    runWithCleanup(
      () => resources.close(),
      () => adc.close()
    )
);
