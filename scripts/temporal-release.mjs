#!/usr/bin/env node
import { mediaPromotionReceiptPrefixes, confirmRestoredMediaActivationCapsule } from './temporal-restored-media-capsule.mjs';
import {activateRestoredCloudRunMedia} from './temporal-media-restored-activation.mjs';
import {saveRestoredMediaActivationCheckpoint} from './temporal-media-restored-checkpoint.mjs';
import {restoredMediaActivationRuntime} from './temporal-media-restored-runtime.mjs';
import {readRestoredMediaRecoveryOrigin} from './temporal-media-restored-origin.mjs';
import {confirmCompletedMediaRecoveryCapsule} from './temporal-media-recovery-capsule.mjs';
import {runMediaRecoveryCycle} from './temporal-media-recovery-cycle.mjs';
import {saveMediaRecoveryCheckpoint,assertMediaRecoveryAuthority} from './temporal-media-recovery-checkpoint.mjs';
import {canonicalMediaRecoveryRuntime,mediaRecoveryJobPreflight,mediaRecoveryPreparation,mediaRecoveryExecution,mediaRecoveryDrainage,mediaRecoveryNeverStartedConfirmation,mediaRecoveryStoppedConfirmation,mediaRecoveryProtection,mediaRecoveryJobLauncher,mediaRecoveryJobDrainage} from './temporal-media-recovery-runtime.mjs';
import {independentPromotionPredecessor} from './temporal-promotion-roles.mjs';
import {runCloudRunControlsPromotion,runCloudRunSearchPromotion,runCloudRunEmailPromotion,runCloudRunImagesPromotion,runCloudRunMediaPromotion} from './temporal-release-cloud-run.mjs';
import {saveControlsPromotionCheckpoint,assertControlsPromotionAuthority,saveSearchPromotionCheckpoint,assertSearchPromotionAuthority,saveEmailPromotionCheckpoint,assertEmailPromotionAuthority,saveImagesPromotionCheckpoint,assertImagesPromotionAuthority,saveMediaPromotionCheckpoint,assertMediaPromotionAuthority} from './temporal-preparation-checkpoint.mjs';
import {bootstrapStopCloudRunMediaPool,activateCloudRunMediaPool,stopCloudRunMediaActivation} from './temporal-bootstrap-pool.mjs';
import {saveMediaBootstrapCycleCheckpoint,saveMediaActivationCheckpoint,saveMediaActivationStopCheckpoint} from './temporal-preparation-checkpoint.mjs';
import {assertPoolPreparationAuthority,readOwnedPoolOperationReceipts} from './temporal-preparation-checkpoint.mjs';
import {bootstrapStopCloudRunImagesPool,activateCloudRunImagesPool,stopCloudRunImagesActivation} from './temporal-bootstrap-pool.mjs';
import {saveImagesBootstrapCycleCheckpoint,saveImagesActivationCheckpoint,saveImagesActivationStopCheckpoint} from './temporal-preparation-checkpoint.mjs';
import {bootstrapStopCloudRunEmailPool,activateCloudRunEmailPool,stopCloudRunEmailActivation} from './temporal-bootstrap-pool.mjs';
import {saveEmailBootstrapCycleCheckpoint,saveEmailActivationCheckpoint,saveEmailActivationStopCheckpoint} from './temporal-preparation-checkpoint.mjs';
import {bootstrapStopCloudRunSearchPool,activateCloudRunSearchPool,stopCloudRunSearchActivation} from './temporal-bootstrap-pool.mjs';
import {saveSearchBootstrapCycleCheckpoint,saveSearchActivationCheckpoint,saveSearchActivationStopCheckpoint} from './temporal-preparation-checkpoint.mjs';
import { assertCloudRunReadinessHandoff, prepareCloudRunTransitionFence, verifyCurrentCloudRunReadinessResources, verifyCloudRunBootstrapProtection, verifyCloudRunBootstrapRegistration, collectCloudRunDispatchDiagnostic, collectCloudRunReleaseWorkers, readCloudRunNamespaceEvidence, verifyCloudRunScalerPolicies, verifyCloudRunComputeIsolation } from './temporal-release-cloud-run.mjs';
import { createReleaseApi } from './temporal-release-api.mjs';
import { verifyDispatchTemporalKeyIdentity } from './temporal-dispatch-key-identity.mjs';
import { verifyCloudRunDispatchConfiguration } from './temporal-release-dispatch.mjs';
import { verifyPreparationEvidence } from './temporal-preparation-evidence.mjs';
import { prepareCloudRunIdentity } from './temporal-prepare-cloud-identity.mjs';
import { prepareCloudRunScalerAccess } from './temporal-prepare-scaler-access.mjs';
import { prepareCloudRunRuntimeAccess } from './temporal-prepare-runtime-access.mjs';
import { prepareCloudRunRuntimeRole } from './temporal-prepare-runtime-role.mjs';
import { prepareCloudRunFirestoreAccess } from './temporal-prepare-firestore-access.mjs';
import { prepareCloudRunSecretAccess } from './temporal-prepare-secret-access.mjs';
import { prepareCloudRunEventarcAudit } from './temporal-prepare-eventarc-audit.mjs';
import { prepareStopCloudRunEventarc } from './temporal-prepare-stop-eventarc.mjs';
import { prepareStopCloudRunScheduler } from './temporal-prepare-stop-scheduler.mjs';
import { enableStagingDispatchWakes, readStagingDispatchWakeAuthority } from './temporal-enable-dispatch-wakes.mjs';
import { saveDispatchWakesCheckpoint } from './temporal-preparation-checkpoint.mjs';
import { stopCloudRunDispatchWake } from './temporal-stop-dispatch-wake.mjs';
import { prepareCloudRunDispatchAccess } from './temporal-prepare-dispatch-access.mjs';
import { saveDiagnosticWakeCheckpoint, pulseDiagnosticWake, saveDispatchDiagnosticCompletion, dispatchDiagnosticCompletionPath } from './temporal-diagnostic-wake.mjs';
import { armCloudRunDispatchDiagnostic } from './temporal-dispatch-diagnostic.mjs';
import { activateCloudRunDispatchService } from './temporal-activate-dispatch-service.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { bootstrapStopCloudRunOrchestrationPool, activateCloudRunOrchestrationPool, stopCloudRunOrchestrationActivation, activateCloudRunControlsPool, stopCloudRunControlsActivation, bootstrapStopCloudRunControlsPool } from './temporal-bootstrap-pool.mjs';
import { prepareCloudRunZeroPool } from './temporal-prepare-cloud-pool.mjs';
import {
  assertStagingMediaSuccessorLineage, observeStagingMediaSuccessorTransfer,
  predecessorReleaseId, transferStagingMediaSuccessor, verifyStagingMediaPredecessorStillIsolated,
} from './temporal-staging-media-successor.mjs';
import { verifyStagingPredecessorTemporal } from './temporal-release-cloud-run.mjs';
import {
  assertStagingPredecessorDispatchWork, observeStagingPredecessorDispatch,
} from './temporal-staging-predecessor-dispatch.mjs';
import { readPreparationReceipt } from './temporal-preparation-evidence.mjs';
import { createTraditionalKubernetesTransport } from './temporal-traditional-kubernetes-transport.mjs';
import { attachCloudRunWorkerCompute, runCloudRunOrchestrationHandoff, runCloudRunTraditionalRetirement, runCloudRunWorkerWake, verifyManagedWorkerHandoff } from './temporal-release-cloud-run.mjs';
import { readOrchestrationHandoffReceipt, readWorkerWakeReadiness, saveWorkerReadinessStartIntent } from './temporal-retirement-checkpoint.mjs';
import { verifyWorkerHandoffVm, validateWorkerHandoffPlan, workerHandoffInput } from './temporal-worker-handoff-plan.mjs';
import { saveOrchestrationBootstrapCycleCheckpoint, saveOrchestrationActivationCheckpoint, saveOrchestrationActivationStopCheckpoint, saveControlsActivationCheckpoint, saveControlsActivationStopCheckpoint, savePoolBootstrapCycleCheckpoint, saveDispatchActivationCheckpoint, saveDispatchEventarcCycleCheckpoint, saveDispatchSchedulerCycleCheckpoint, saveEventarcAuditPreparationCheckpoint, saveDispatchWakeStopCheckpoint, saveDispatchAccessPreparationCheckpoint, saveDispatchServicePreparationCheckpoint, saveIdentityPreparationCheckpoint, savePoolPreparationCheckpoint, saveSecretAccessPreparationCheckpoint, saveScalerAccessPreparationCheckpoint, saveFirestoreAccessPreparationCheckpoint, saveRuntimeRolePreparationCheckpoint, saveRuntimeAccessPreparationCheckpoint } from './temporal-preparation-checkpoint.mjs';
// Every step is explicit, revision-fenced, resumable, and leaves admissions paused on failure.
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertHetznerActivationReceipt, confirmLiveHetznerActivation, hetznerActivationPath } from './temporal-hetzner-activation.mjs';
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
  assertNativeSnapshotSuccessor,
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
  restoreAutomaticRollouts,
  freezeAutomaticRollouts,
} from './temporal-apphosting-rollout.mjs';
import {
  canReleaseOwnedOperationLock,
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
    'handoff-cloud-run-orchestration',
    'retire-traditional-staging-workers',
    'attach-cloud-run-worker-compute',
    'verify-cloud-run-worker-wake',
    'prepare-cloud-run-identity',
    'prepare-cloud-run-pool',
    'promote-cloud-run-email','promote-cloud-run-images','promote-cloud-run-media','promote-cloud-run-search','promote-cloud-run-controls','bootstrap-stop-cloud-run-controls',
    'activate-restored-cloud-run-media','diagnose-cloud-run-media-recovery','bootstrap-stop-cloud-run-media','activate-cloud-run-media-pool','stop-cloud-run-media-activation',
    'bootstrap-stop-cloud-run-images','activate-cloud-run-images-pool','stop-cloud-run-images-activation',
    'bootstrap-stop-cloud-run-email','activate-cloud-run-email-pool','stop-cloud-run-email-activation',
    'bootstrap-stop-cloud-run-search','activate-cloud-run-search-pool','stop-cloud-run-search-activation',
    'bootstrap-stop-cloud-run-orchestration',
    'activate-cloud-run-orchestration-pool',
    'stop-cloud-run-orchestration-activation',
    'activate-cloud-run-controls-pool',
    'stop-cloud-run-controls-activation',
    'prepare-cloud-run-dispatch-diagnostic', 'enable-staging-dispatch-wakes', 'activate-cloud-run-dispatch-service',
    'prepare-cloud-run-dispatch-service',
    'prepare-cloud-run-dispatch-access',
    'stop-cloud-run-dispatch-wake',
    'prepare-stop-cloud-run-dispatch-scheduler', 'prepare-stop-cloud-run-dispatch-eventarc',
    'prepare-cloud-run-secret-access',
    'prepare-cloud-run-scaler-access',
    'prepare-cloud-run-firestore-access',
    'prepare-cloud-run-runtime-role',
    'prepare-cloud-run-runtime-access',
    'prepare-cloud-run-eventarc-audit',
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
    'supersede-staging-media-create',
    'observe-staging-media-supersession',
  ].includes(action) ||
  !args.includes('--release') ||
  !configPath
)
  throw new Error('Usage: temporal-release.mjs ACTION --release PATH [--apply] [--output PATH]');
const descriptorBytes = await readFile(configPath, 'utf8');
const config = validateReleaseConfig(JSON.parse(descriptorBytes));
const mediaSuccessorAction = ['supersede-staging-media-create', 'observe-staging-media-supersession'].includes(action);
if (mediaSuccessorAction && (config.environment !== 'staging' || config.mode !== 'durable-upgrade' ||
  config.releaseId === predecessorReleaseId || args.includes('--resume-operation')))
  throw new Error('STAGING_MEDIA_SUCCESSOR_SCOPE_REQUIRED');
const parent = `projects/${config.projectId}/locations/${config.location}/backends/${config.backendId}`;
if (action === 'plan') {
  console.log(
    'Freeze automatic UI rollouts before merging; deploy compatibility backend/rules; pause new admissions and drain legacy work; verify workers; switch private ownership while paused; write/deploy and verify source env flags; roll out pinned UI; smoke test; open admissions; restore the saved automatic rollout policy. Failures keep admissions paused. No legacy task fallback is permitted.'
  );
  process.exit(0);
}
if (!args.includes('--apply'))
  throw new Error('Remote release operations require explicit --apply; use plan for offline review');
const resourceBinding = loadReleaseResourceBinding(config);
async function readBoundPlatform() {
  const bytes = await readFile(config.platformConfig);
  if (hash(bytes) !== resourceBinding.platformConfigSHA256)
    throw new Error('RELEASE_RESOURCE_PLATFORM_CHANGED');
  return JSON.parse(bytes);
}
const workerHandoff = workerHandoffInput(action, args, config);
const workerReadiness = ['workers-ready', 'take-ownership', 'open'].includes(action)
  ? workerHandoffInput(action, args, config, (await readBoundPlatform()).workerHosting)
  : undefined;
if (workerReadiness) {
  const flag = '--dispatch-wakes-operation';
  const at = args.indexOf(flag);
  workerReadiness.dispatchWakesOperation = args[at + 1];
  if (at < 0 || at !== args.lastIndexOf(flag) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workerReadiness.dispatchWakesOperation ?? ''))
    throw new Error('OWNED_DISPATCH_WAKE_ACTIVATION_REQUIRED');
}
const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = args.includes('--runtime-root') ? resolve(args[args.indexOf('--runtime-root') + 1]) : operatorRoot;
const binding = pinReleaseCheckouts(operatorRoot, runtimeRoot, config);
const operatorIdentity = {
  descriptorSHA256: hash(descriptorBytes),
  operatorRoot: binding.operatorRoot,
  runtimeRoot: binding.runtimeRoot,
  operatorCommit: binding.operatorCommit,
  runtimeCommit: binding.runtimeCommit,
  operatorClosureDigest: binding.operatorClosureDigest,
  runtimePins: binding.runtimePins,
  resourceBinding,
  ...(workerHandoff ? { workerHandoff } : {}),
  ...(workerReadiness ? { workerReadiness } : {}),
};
const poolOperationRoles=Object.freeze({'promote-cloud-run-email':'email','promote-cloud-run-images':'images','promote-cloud-run-media':'media','promote-cloud-run-search':'search','promote-cloud-run-controls':'controls',
 'activate-restored-cloud-run-media':'media','diagnose-cloud-run-media-recovery':'media','bootstrap-stop-cloud-run-media':'media','activate-cloud-run-media-pool':'media','stop-cloud-run-media-activation':'media',
 'bootstrap-stop-cloud-run-images':'images','activate-cloud-run-images-pool':'images','stop-cloud-run-images-activation':'images',
 'bootstrap-stop-cloud-run-email':'email','activate-cloud-run-email-pool':'email','stop-cloud-run-email-activation':'email',
 'bootstrap-stop-cloud-run-search':'search','activate-cloud-run-search-pool':'search','stop-cloud-run-search-activation':'search',
 'bootstrap-stop-cloud-run-controls':'controls','activate-cloud-run-controls-pool':'controls','stop-cloud-run-controls-activation':'controls',
 'bootstrap-stop-cloud-run-orchestration':'orchestration','activate-cloud-run-orchestration-pool':'orchestration','stop-cloud-run-orchestration-activation':'orchestration',
});
const preparationArguments = ['activate-restored-cloud-run-media','diagnose-cloud-run-media-recovery','bootstrap-stop-cloud-run-media','activate-cloud-run-media-pool','stop-cloud-run-media-activation','bootstrap-stop-cloud-run-images','activate-cloud-run-images-pool','stop-cloud-run-images-activation','bootstrap-stop-cloud-run-email','activate-cloud-run-email-pool','stop-cloud-run-email-activation','bootstrap-stop-cloud-run-search','activate-cloud-run-search-pool','stop-cloud-run-search-activation','activate-cloud-run-orchestration-pool','stop-cloud-run-orchestration-activation','bootstrap-stop-cloud-run-orchestration','activate-cloud-run-controls-pool','stop-cloud-run-controls-activation','promote-cloud-run-email','promote-cloud-run-images','promote-cloud-run-media','promote-cloud-run-search','promote-cloud-run-controls','bootstrap-stop-cloud-run-controls', 'prepare-cloud-run-dispatch-diagnostic', 'enable-staging-dispatch-wakes', 'activate-cloud-run-dispatch-service', 'prepare-cloud-run-identity', 'prepare-cloud-run-dispatch-service', 'prepare-cloud-run-dispatch-access', 'prepare-stop-cloud-run-dispatch-scheduler', 'prepare-stop-cloud-run-dispatch-eventarc', 'stop-cloud-run-dispatch-wake', 'prepare-cloud-run-pool', 'prepare-cloud-run-secret-access', 'prepare-cloud-run-scaler-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role', 'prepare-cloud-run-runtime-access', 'prepare-cloud-run-eventarc-audit'].includes(action) ? {
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
  if (['activate-restored-cloud-run-media','diagnose-cloud-run-media-recovery','bootstrap-stop-cloud-run-media','activate-cloud-run-media-pool','stop-cloud-run-media-activation','bootstrap-stop-cloud-run-images','activate-cloud-run-images-pool','stop-cloud-run-images-activation','bootstrap-stop-cloud-run-email','activate-cloud-run-email-pool','stop-cloud-run-email-activation','bootstrap-stop-cloud-run-search','activate-cloud-run-search-pool','stop-cloud-run-search-activation','activate-cloud-run-orchestration-pool','stop-cloud-run-orchestration-activation','bootstrap-stop-cloud-run-orchestration','activate-cloud-run-controls-pool','stop-cloud-run-controls-activation','promote-cloud-run-email','promote-cloud-run-images','promote-cloud-run-media','promote-cloud-run-search','promote-cloud-run-controls','bootstrap-stop-cloud-run-controls', 'prepare-cloud-run-dispatch-diagnostic', 'enable-staging-dispatch-wakes', 'activate-cloud-run-dispatch-service', 'prepare-cloud-run-dispatch-service', 'prepare-cloud-run-dispatch-access', 'prepare-stop-cloud-run-dispatch-scheduler', 'prepare-stop-cloud-run-dispatch-eventarc', 'stop-cloud-run-dispatch-wake', 'prepare-cloud-run-pool', 'prepare-cloud-run-secret-access', 'prepare-cloud-run-scaler-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role', 'prepare-cloud-run-runtime-access', 'prepare-cloud-run-eventarc-audit'].includes(action)) {
    delete preparationArguments.kind;
    preparationArguments.settings = args[args.indexOf('--pool-settings') + 1];
    preparationArguments.settingsDigest = args[args.indexOf('--pool-settings-sha256') + 1];
    preparationArguments.runnerOperationId = args[args.indexOf('--runner-preparation-operation') + 1];
    if (!/^[a-f0-9]{64}$/.test(preparationArguments.settingsDigest ?? '') ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(preparationArguments.runnerOperationId ?? ''))
      throw new Error('Explicit immutable pool preparation inputs required');
  }
  if (Object.hasOwn(poolOperationRoles,action)) {
    preparationArguments.receipts=args[args.indexOf('--bootstrap-receipts')+1];
    preparationArguments.receiptsDigest=args[args.indexOf('--bootstrap-receipts-sha256')+1];
    if(preparationArguments.role!==poolOperationRoles[action]||!args.includes('--bootstrap-receipts')||!args.includes('--bootstrap-receipts-sha256')||
      !/^[a-f0-9]{64}$/.test(preparationArguments.receiptsDigest??'')) throw new Error('FIXED_CONTROLS_BOOTSTRAP_RECEIPTS_REQUIRED');
  }
  if (['prepare-cloud-run-dispatch-diagnostic', 'enable-staging-dispatch-wakes'].includes(action)) {
    preparationArguments.activationOperationId = args[args.indexOf('--activation-preparation-operation') + 1];
    if (!args.includes('--activation-preparation-operation') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(preparationArguments.activationOperationId ?? ''))
      throw new Error('OWNED_DISPATCH_ACTIVATION_REQUIRED');
  }
  if (action === 'enable-staging-dispatch-wakes') {
    const flag = '--dispatch-diagnostic-operation';
    const at = args.indexOf(flag);
    preparationArguments.diagnosticOperationId = args[at + 1];
    if (at < 0 || at !== args.lastIndexOf(flag) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparationArguments.diagnosticOperationId ?? '') ||
      preparationArguments.role !== 'dispatch') throw new Error('OWNED_DISPATCH_DIAGNOSTIC_REQUIRED');
  }
  if (action === 'prepare-cloud-run-secret-access') {
    if (!args.includes('--secret-name')) throw new Error('Explicit source-rendered secret required');
    preparationArguments.secret = args[args.indexOf('--secret-name') + 1];
  }
  if (action === 'stop-cloud-run-dispatch-wake') {
    for (const [field, flag] of [['surface', '--wake-surface'], ['serviceOperationId', '--service-preparation-operation'], ['wakeOperationId', '--wake-preparation-operation']]) {
      if (!args.includes(flag)) throw new Error('Explicit owned wake stop inputs required');
      preparationArguments[field] = args[args.indexOf(flag) + 1];
    }
    if (![preparationArguments.serviceOperationId, preparationArguments.wakeOperationId].every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? '')))
      throw new Error('Explicit immutable wake and service receipts required');
  }
  if (['prepare-cloud-run-dispatch-diagnostic', 'enable-staging-dispatch-wakes', 'activate-cloud-run-dispatch-service', 'prepare-cloud-run-dispatch-access', 'prepare-stop-cloud-run-dispatch-scheduler', 'prepare-stop-cloud-run-dispatch-eventarc'].includes(action)) {
    for (const [field, flag] of [['surface', '--dispatch-iam-surface'], ['eventOperationId', '--event-preparation-operation'], ['schedulerOperationId', '--scheduler-preparation-operation'], ['serviceOperationId', '--service-preparation-operation']]) {
      if (field === 'surface' && action !== 'prepare-cloud-run-dispatch-access') continue;
      if (!args.includes(flag)) throw new Error('Explicit dispatch caller preparation inputs required');
      preparationArguments[field] = args[args.indexOf(flag) + 1];
    }
    if (![preparationArguments.eventOperationId, preparationArguments.schedulerOperationId, preparationArguments.serviceOperationId].every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? '')))
      throw new Error('Explicit immutable dispatch receipts required');
  }
  if (action === 'prepare-stop-cloud-run-dispatch-eventarc') {
    if (!args.includes('--wake-surface')) throw new Error('EXPLICIT_EVENTARC_SURFACE_REQUIRED');
    preparationArguments.surface = args[args.indexOf('--wake-surface') + 1];
    if (!['outbox-trigger', 'commands-trigger'].includes(preparationArguments.surface)) throw new Error('FIXED_EVENTARC_SURFACE_REQUIRED');
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
  if (['prepare-cloud-run-runtime-role', 'prepare-cloud-run-runtime-access'].includes(action)) {
    if (!args.includes('--runtime-surface')) throw new Error('Explicit source-derived runtime surface required');
    preparationArguments.surface = args[args.indexOf('--runtime-surface') + 1];
  }
  if (action === 'prepare-cloud-run-runtime-access') {
    preparationArguments.roleOperationId = args[args.indexOf('--runtime-role-preparation-operation') + 1];
    if (!args.includes('--runtime-role-preparation-operation') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(preparationArguments.roleOperationId ?? ''))
      throw new Error('Explicit immutable runtime role receipt required');
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
    if (mediaSuccessorAction) {
      if (!operatorPrincipal.adcAndGcloudAccountMatch)
        throw new Error('STAGING_MEDIA_SUCCESSOR_OPERATOR_UNCONFIRMED');
      function requiredOption(flag) {
        const at = args.indexOf(flag);
        const value = args[at + 1];
        if (at < 0 || at !== args.lastIndexOf(flag) || !value || value.startsWith('--'))
          throw new Error('STAGING_MEDIA_SUCCESSOR_ARGUMENT_REQUIRED ' + flag);
        return value;
      }
      const api = createReleaseApi({ getAccessToken: () => resources.credential.getAccessToken()
        .then(({ access_token }) => access_token) });
      await verifyReleaseResourceIdentity(resourceBinding, api);
      if (action === 'observe-staging-media-supersession') {
        console.log(JSON.stringify(await observeStagingMediaSuccessorTransfer(firestore, config, resourceBinding)));
        return;
      }

      const oldDescriptor = await readFile(requiredOption('--predecessor-release'), 'utf8');
      const oldConfig = validateReleaseConfig(JSON.parse(oldDescriptor));
      if (oldConfig.releaseId !== predecessorReleaseId || oldConfig.projectId !== config.projectId)
        throw new Error('STAGING_MEDIA_SUCCESSOR_PREDECESSOR_REQUIRED');
      const oldBinding = pinReleaseCheckouts(operatorRoot, requiredOption('--predecessor-runtime-root'), oldConfig);
      const oldResourceBinding = loadReleaseResourceBinding(oldConfig);
      const [oldPlatformBytes, platformBytes] = await Promise.all([
        readFile(oldConfig.platformConfig), readFile(config.platformConfig),
      ]);
      if (hash(oldPlatformBytes) !== oldResourceBinding.platformConfigSHA256 ||
        hash(platformBytes) !== resourceBinding.platformConfigSHA256)
        throw new Error('STAGING_MEDIA_SUCCESSOR_PLATFORM_CHANGED');
      const oldPlatform = JSON.parse(oldPlatformBytes);
      const platform = JSON.parse(platformBytes);
      const path = requiredOption('--preparation-proof');
      const digest = requiredOption('--preparation-proof-sha256');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('STAGING_MEDIA_SUCCESSOR_PROOF_DIGEST_REQUIRED');
      const result = await transferStagingMediaSuccessor({
        db: firestore, api, successor: config, resourceBinding,
        verifyCandidate: () => verifyPreparationEvidence({
          path, digest, platform, binding, google: api,
          signedPullRequestBase: '546a7c12aed57e08db3d66514b05e08f02354dd7',
        }),
        observeWorkExclusion: async ({ original }) => {
          const previousOperator = original.operation.operatorPrincipal;
          if (previousOperator?.adcAndGcloudAccountMatch !== true || previousOperator.verified !== true ||
            previousOperator.email !== operatorPrincipal.email ||
            !previousOperator.subject || previousOperator.subject !== operatorPrincipal.subject ||
            original.operation.operatorIdentity.descriptorSHA256 !== hash(oldDescriptor) ||
            proofDigest(original.operation.operatorIdentity.resourceBinding) !== proofDigest(oldResourceBinding))
            throw new Error('STAGING_MEDIA_SUCCESSOR_PREDECESSOR_OPERATOR_CHANGED');
          const [temporal, dispatch] = await Promise.all([
            verifyStagingPredecessorTemporal({ binding: oldBinding, config: oldConfig, platform: oldPlatform, firestore,
              successorBuildId: config.compatibilityCommit }),
            observeStagingPredecessorDispatch({ db: firestore, api, platform: oldPlatform,
              state: original.state, successorBuildId: config.compatibilityCommit }),
          ]);
          return { temporal, dispatch };
        },
        assertPrivateWorkIdle: (tx, work) =>
          assertStagingPredecessorDispatchWork(firestore, tx, config.compatibilityCommit, work.dispatch),
      });
      console.log(JSON.stringify(result));
      return;
    }
    const operationId = resumeOperation ?? randomUUID();
    let operationAcquired = false,
      operationVerified = false,
      transitionPending = false,
      diagnosticCompletionProof,
      poolAbortProof,
      cloudWorkerProbePending = false,
      cloudIdentityPending = false,
      expectedAuthority,
      resourceIdentity,
      ownedOperation,
      sourceControl;
    const auditPath = (revision) => `_control/temporalReleaseOperatorAudit-${operationId}-${revision}`;
    await runWithCleanup(
      async () => {
        const operationEnvelope = { operationId, releaseId: config.releaseId, action, bindingDigest, operatorIdentity, operatorPrincipal };
        const reacquired = resumeOperation
          ? await firestore.runTransaction(async (tx) => {
              const snapshot = await tx.get(lockRef);
              if (snapshot.exists) {
                const held = snapshot.data();
                if (held.operationId !== resumeOperation || held.releaseId !== config.releaseId ||
                    held.action !== action || held.bindingDigest !== bindingDigest)
                  throw new Error('Another release operation or crash recovery lock exists; inspect it before proceeding');
                return { proof: nativeSnapshotProof(snapshot) };
              }
              if (action === 'prepare-cloud-run-dispatch-diagnostic') {
                const final = await tx.get(firestore.doc(dispatchDiagnosticCompletionPath(operationId)));
                const data = final.data();
                if (final.exists && final.createTime?.isEqual(final.updateTime) &&
                    data.schemaVersion === 1 && data.operationId === operationId &&
                    data.releaseId === config.releaseId && data.bindingDigest === bindingDigest &&
                    data.buildId === resourceBinding.workerBuildId && data.image === resourceBinding.workerImage)
                  return false;
              }
              throw new Error('Reviewed operation is absent; inspect its immutable audit before starting a fresh action');
            }, { readOnly: true })
          : await lockRef.create({ ...operationEnvelope, createdAt: serverTimestamp() });
        if (!reacquired) {
          console.log(`Dispatch diagnostic already completed at ${dispatchDiagnosticCompletionPath(operationId)}.`);
          return;
        }
        const acquiredOperation = await lockRef.get();
        if (reacquired.proof) {
          assertNativeSnapshot(reacquired.proof, acquiredOperation);
          ownedOperation = reacquired.proof;
        } else {
          const { createdAt, ...stored } = acquiredOperation.data() ?? {};
          ownedOperation = nativeSnapshotProof(acquiredOperation);
          if (!acquiredOperation.exists || !createdAt || !reacquired.writeTime ||
              proofDigest(stored) !== proofDigest(operationEnvelope) ||
              proofDigest(acquiredOperation.createTime) !== proofDigest(reacquired.writeTime) ||
              proofDigest(acquiredOperation.updateTime) !== proofDigest(reacquired.writeTime))
            throw new Error('RELEASE_NATIVE_AUTHORITY_CHANGED');
        }
        operationAcquired = true;
        if (action === 'prepare-cloud-run-dispatch-diagnostic' && Object.hasOwn(acquiredOperation.data() ?? {}, 'cloudDispatchDiagnostic'))
          cloudIdentityPending = true;
        if (action === 'restore-auto' && Object.hasOwn(acquiredOperation.data() ?? {}, 'autoRolloutRestore'))
          cloudIdentityPending = true;
        if (action === 'freeze-ui' && resumeOperation)
          cloudIdentityPending = true;
        if (action === 'enable-staging-dispatch-wakes' && acquiredOperation.get('cloudBusinessDispatchWakes'))
          cloudIdentityPending = true;
        if (workerReadiness && Object.hasOwn(acquiredOperation.data() ?? {}, 'cloudWorkerIntent'))
          cloudWorkerProbePending = true;
        if (workerHandoff && (acquiredOperation.get('cloudOrchestrationHandoff') ||
          acquiredOperation.get('traditionalWorkerRetirement') ||
          acquiredOperation.get('cloudWorkerComputeAttachment') || acquiredOperation.get('cloudWorkerWake'))) cloudIdentityPending = true;

        function token() {
          return execFileSync('gcloud', ['auth', 'print-access-token'], {
            encoding: 'utf8',
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
        }
        const api = createReleaseApi({getAccessToken:token});
        const appApi = (path, method, body, beforeSend) =>
          api(`https://firebaseapphosting.googleapis.com/v1beta/${path}`, method, body, beforeSend);
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
        let cloudRunReadiness;
        async function verifyReleaseWorkers(state) {
          const platformBytes = await readFile(config.platformConfig);
          if (hash(platformBytes) !== resourceBinding.platformConfigSHA256)
            throw new Error('WORKER_READINESS_PLATFORM_CHANGED');
          const configuredPlatform = JSON.parse(platformBytes.toString('utf8'));
          if (configuredPlatform.workerHosting === 'cloud-run') {
            validateWorkerCoverage(config, configuredPlatform);
            if (!workerReadiness) throw new Error('CLOUD_RUN_WAKE_READINESS_INPUT_REQUIRED');
            const plan = validateWorkerHandoffPlan(
              await readPreparationReceipt(workerReadiness.plan, workerReadiness.planDigest),
              config, configuredPlatform, workerReadiness.evidenceDigest
            );
            const readWakeReadiness = (tx) => readWorkerWakeReadiness({
              action, operationId, bindingDigest, firestore, config, platform: configuredPlatform,
              expectedAuthority, ownedOperation, evidenceDigest: plan.evidenceDigest, pools: plan.pools,
            }, tx);
            // Revalidate receipts before any native diagnostic can be started.
            const { wakeReceiptsSHA256, retiredSHA256 } = await readWakeReadiness();
            if ((action !== 'workers-ready' || state.phase === 'workers-ready') &&
              state.workerWakeReceiptsSHA256 !== wakeReceiptsSHA256)
              throw new Error('CLOUD_RUN_WAKE_READINESS_CHECKPOINT_CHANGED');
            await verifyPreparationEvidence({ path: workerReadiness.proof, digest: workerReadiness.evidenceDigest,
              platform: configuredPlatform, binding, google: api });
            if (operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('STAGING_WORKER_HANDOFF_REQUIRES_MATCHED_OPERATOR');
            await verifyWorkerHandoffVm(api);
            const { context, ...authority } = plan.traditionalCluster;
            const transport = await createTraditionalKubernetesTransport(context);
            const handoff = await readOrchestrationHandoffReceipt(firestore, config, configuredPlatform, workerReadiness.planDigest);
            await verifyManagedWorkerHandoff({ binding, config, platform: configuredPlatform, firestore, api },
              { authority, transport, pools: plan.pools, retiredSHA256, handoff });
            validateCloudEvidence(configuredPlatform, await readCloudRunNamespaceEvidence(configuredPlatform), { requireRecovery: false });
            const held = await lockRef.get();
            assertNativeSnapshot(ownedOperation, held);
            const hasPrior = Object.prototype.hasOwnProperty.call(held.data(), 'cloudWorkerIntent');
            const prior = held.data()?.cloudWorkerIntent;
            if (hasPrior) cloudWorkerProbePending = true;
            if (hasPrior && (!prior || typeof prior !== 'object' || Array.isArray(prior) ||
              Object.keys(prior).sort().join(',') !== 'artifactDirectory,bindings,createdAt,imageWorkflowBundleSHA256,nonce,schemaVersion,workflowId'))
              throw new Error('CLOUD_RUN_SAVED_PROBE_INTENT_INVALID');
            const directory = prior?.artifactDirectory ?? await realpath(await mkdtemp(join(tmpdir(), 'urm-temporal-cloud-ready-')));
            const savedIntent = prior && (({ artifactDirectory, ...intent }) => intent)(prior);
            const scalerPolicies = await verifyCloudRunScalerPolicies(configuredPlatform, api);
            const dispatchKeyIdentity = await verifyDispatchTemporalKeyIdentity({ version: configuredPlatform.dispatch.apiKeyVersion, api });
            const dispatchConfiguration = await verifyCloudRunDispatchConfiguration(configuredPlatform, api);
            const dispatchWakesOperation = workerReadiness.dispatchWakesOperation;
            const observeDispatchWakes = (live, tx) => readStagingDispatchWakeAuthority(firestore, {
              releaseId: config.releaseId, platform: configuredPlatform, evidenceDigest: plan.evidenceDigest,
              operationId: dispatchWakesOperation, live,
            }, tx);
            const dispatchWakes = await observeDispatchWakes(dispatchConfiguration);
            const dispatchWakeReceiptsSHA256 = proofDigest(dispatchWakes);
            if ((action !== 'workers-ready' || state.phase === 'workers-ready') &&
                state.dispatchWakeReceiptsSHA256 !== dispatchWakeReceiptsSHA256)
              throw new Error('CLOUD_RUN_DISPATCH_WAKE_READINESS_CHECKPOINT_CHANGED');
            const roleProof = await collectCloudRunReleaseWorkers({ operationId, bindingDigest, binding, config, platform: configuredPlatform, firestore,
              artifactDirectory: directory, savedIntent,
              recordIntent: async (intent) => {
                cloudWorkerProbePending = true;
                ownedOperation = await saveWorkerReadinessStartIntent({
                  action, firestore, config, ownedOperation, expectedAuthority, operationId, bindingDigest,
                  intent, artifactDirectory: directory,
                });
              },
            });
            assertCloudRunReadinessHandoff(roleProof, configuredPlatform, plan.pools);
            // The native collector validates canonical private directory ownership
            // and the matching saved intent before any additional artifact write.
            await writeFile(join(directory, `scaler-policy-${randomUUID()}.json`), JSON.stringify(scalerPolicies),
              { flag: 'wx', mode: 0o600 });
            await writeFile(join(directory, `dispatch-configuration-${randomUUID()}.json`), JSON.stringify(dispatchConfiguration),
              { flag: 'wx', mode: 0o600 });
            await writeFile(join(directory, `dispatch-key-identity-${randomUUID()}.json`), JSON.stringify(dispatchKeyIdentity),
              { flag: 'wx', mode: 0o600 });
            const currentDispatch = await verifyCloudRunDispatchConfiguration(configuredPlatform, api);
            const dispatchFacts = ({ observedAt: _observedAt, ...facts }) => proofDigest(facts);
            if (dispatchFacts(currentDispatch) !== dispatchFacts(dispatchConfiguration) ||
              proofDigest(await observeDispatchWakes(currentDispatch)) !== proofDigest(dispatchWakes))
              throw new Error('OWNED_DISPATCH_WAKE_ACTIVATION_CHANGED');
            const readinessToken = token();
            await verifyCurrentCloudRunReadinessResources({
              proof: roleProof, platform: configuredPlatform, pools: plan.pools,
              api: createReleaseApi({ getAccessToken: () => readinessToken }),
            });
            const confirm = async (tx, liveDispatch = currentDispatch) => {
              const [worker, dispatch] = await Promise.all([
                readWakeReadiness(tx),
                observeDispatchWakes(liveDispatch, tx),
              ]);
              if (worker.wakeReceiptsSHA256 !== wakeReceiptsSHA256 ||
                  proofDigest(dispatch) !== dispatchWakeReceiptsSHA256)
                throw new Error('CLOUD_RUN_WAKE_READINESS_CHECKPOINT_CHANGED');
            };
            await firestore.runTransaction(confirm, { readOnly: true });
            const refresh = async () => {
              const refreshToken = token();
              const refreshApi = createReleaseApi({ getAccessToken: () => refreshToken });
              const withoutSampleTime = ({ observedAt: _observedAt, ...facts }) => proofDigest(facts);
              return prepareCloudRunTransitionFence(async () => {
                const [dispatch, scaler, key] = await Promise.all([
                  verifyCloudRunDispatchConfiguration(configuredPlatform, refreshApi),
                  verifyCloudRunScalerPolicies(configuredPlatform, refreshApi),
                  verifyDispatchTemporalKeyIdentity({ version: configuredPlatform.dispatch.apiKeyVersion, api: refreshApi }),
                  verifyCurrentCloudRunReadinessResources({ proof: roleProof, platform: configuredPlatform, pools: plan.pools, api: refreshApi }),
                  verifyManagedWorkerHandoff({ binding, config, platform: configuredPlatform, firestore, api: refreshApi },
                    { authority, transport, pools: plan.pools, retiredSHA256, handoff }),
                ]);
                if (dispatchFacts(dispatch) !== dispatchFacts(currentDispatch) ||
                    withoutSampleTime(scaler) !== withoutSampleTime(scalerPolicies) ||
                    proofDigest(key) !== proofDigest(dispatchKeyIdentity))
                  throw new Error('CLOUD_RUN_TRANSITION_PROVIDER_EVIDENCE_CHANGED');
                return dispatch;
              });
            };
            cloudRunReadiness = {
              confirm, refresh, workerWakeReceiptsSHA256: wakeReceiptsSHA256, dispatchWakeReceiptsSHA256,
            };
            await writeFile(join(directory, `worker-wake-receipts-${randomUUID()}.json`),
              JSON.stringify({ releaseId: config.releaseId, evidenceDigest: plan.evidenceDigest, wakeReceiptsSHA256, dispatchWakeReceiptsSHA256 }),
              { flag: 'wx', mode: 0o600 });
            assertNativeSnapshot(ownedOperation, await lockRef.get());
            cloudWorkerProbePending = false;
            return configuredPlatform;
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
          const platform = await readBoundPlatform();
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
        async function verifyUiCommit(checkpoint, { requireFrozen = false } = {}) {
          const expectedBuild = checkpoint.uiBuild;
          const readServingTraffic = async () => {
            const traffic = await appApi(`${parent}/traffic`);
            const splits = traffic.current?.splits ?? [];
            if (traffic.reconciling || splits.length !== 1 || splits[0].percent !== 100)
              throw new Error('Reviewed UI rollout has not settled');
            if (!expectedBuild || !sameAppHostingResource(splits[0].build, expectedBuild, resourceIdentity.projectNumber))
              throw new Error('Live UI does not match the reviewed immutable build');
            if (requireFrozen && (traffic.rolloutPolicy?.disabled !== true || !traffic.etag))
              throw new Error('Automatic UI rollout must remain frozen before opening admissions');
            return traffic;
          };
          const before = await readServingTraffic();
          const build = await appApi(expectedBuild);
          if (
            !verifyAppHostingBuild(
              build,
              { buildName: expectedBuild, uiCommit: config.uiCommit },
              resourceIdentity.projectNumber
            ) ||
            build.state !== 'READY' ||
            build.reconciling
          )
            throw new Error('Live UI does not match the reviewed immutable commit');
          if (requireFrozen && (await readServingTraffic()).etag !== before.etag)
            throw new Error('App Hosting traffic changed while verifying the pre-open release');
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
          const predecessor = await assertStagingMediaSuccessorLineage(firestore, checkpoint, config, firestore, resourceBinding);
          await verifyStagingMediaPredecessorStillIsolated(firestore, api, predecessor);
          if (hasCompatibilitySettlingCheckpoint(validatedControl, checkpoint, config))
            assertCompatibilitySettlingCheckpoint(validatedControl, checkpoint, config);
          sourceControl ??= validatedControl;
          await assertReleaseRuntimeSource(binding, config, sourceControl);
          expectedAuthority = { control: nativeSnapshotProof(control), state: nativeSnapshotProof(state) };
          return { control: validatedControl, state: checkpoint, serverReadTime: control.readTime };
        }
        let hetznerActivation;
        async function verifyHetznerActivation(control, state) {
          if (config.environment !== 'staging' || !config.domains.includes('media')) return;
          const platform = await readBoundPlatform();
          if (platform.workerHosting !== 'cloud-run') return;
          const ref = firestore.doc(hetznerActivationPath(config.releaseId));
          const activation = await ref.get();
          const receipt = assertHetznerActivationReceipt(activation, config,
            state.phase === 'ownership-changed' ? { controlRevision: control.revision } : {});
          if (state.phase !== 'ownership-changed') assertNativeSnapshot(state.hetznerActivation, activation);
          await confirmLiveHetznerActivation(receipt);
          hetznerActivation = { ref, proof: nativeSnapshotProof(activation) };
        }
        async function transition(revision, phase, update = {}, controlUpdate) {
          let workerFence;
          if (workerReadiness && ['workers-ready', 'ownership-changed', 'open'].includes(phase)) {
            if (!cloudRunReadiness) throw new Error('CLOUD_RUN_WAKE_READINESS_CHECKPOINT_REQUIRED');
            workerFence = await cloudRunReadiness.refresh();
          }
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
            await assertStagingMediaSuccessorLineage(firestore, currentState.data(), config, tx, resourceBinding);
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
            if (workerFence) {
              workerFence.assertFresh();
              await cloudRunReadiness.confirm(tx, workerFence.live);
              if (phase === 'workers-ready') {
                update = {
                  ...update,
                  workerWakeReceiptsSHA256: cloudRunReadiness.workerWakeReceiptsSHA256,
                  dispatchWakeReceiptsSHA256: cloudRunReadiness.dispatchWakeReceiptsSHA256,
                };
              }
            }
            if (hetznerActivation) {
              assertNativeSnapshot(hetznerActivation.proof, await tx.get(hetznerActivation.ref));
              if (phase === 'backend-ready') update = { ...update, hetznerActivation: hetznerActivation.proof };
            }
            if (phase === 'bundles-ready') {
              if (currentState.data().phase !== 'backend-ready' || !update.bundleBootstrapProof)
                throw new Error('Bundle checkpoint requires current backend-ready and complete artifact proof');
              await confirmBundleProofInTransaction(tx, firestore, update.bundleBootstrapProof, config.projectId);
            }
            workerFence?.assertFresh();
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
              ...(hetznerActivation && { hetznerActivation: hetznerActivation.proof }),
              uiRolloutIdentityMigration: update.uiRolloutIdentityMigration ?? null,
              ...(update.autoRolloutRestoreSHA256 && { autoRolloutRestoreSHA256: update.autoRolloutRestoreSHA256 }),
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
          const assertNoActiveRollout = async () => {
            const inFlight = (await list(`${parent}/rollouts?pageSize=100`, 'rollouts')).some(
              (r) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(r.state)
            );
            if (inFlight)
              throw new Error('An App Hosting rollout is already active; allow it to settle before release freeze');
          };
          await assertNoActiveRollout();
          const existingState = await stateRef.get();
          if (existingState.exists) {
            if (existingState.data().releaseId !== config.releaseId && existingState.data().phase !== 'complete')
              throw new Error('Another active release checkpoint exists; do not overwrite it');
            if (
              existingState.data().releaseId === config.releaseId &&
              !['freezing-ui', 'ui-frozen'].includes(existingState.data().phase)
            )
              throw new Error('Resume the appropriate existing release phase instead of freezing again');
          }
          // Save policy/current build BEFORE mutation. Recovery reuses the same request ID.
          const sameRelease = existingState.data()?.releaseId === config.releaseId;
          const requestId = sameRelease ? existingState.data().appHostingFreezeRequestId : operationId;
          const previousFunctionTimeout = sameRelease
            ? existingState.data().maximumLegacyExecutionSeconds
            : Math.max(540, ...(await functionsList()).map((fn) => Number(fn.serviceConfig?.timeoutSeconds ?? 0)));
          if (!sameRelease)
            await firestore.runTransaction(async (tx) => {
              const [lock, previous, oldState, usage] = await Promise.all([
                tx.get(lockRef),
                tx.get(controlRef),
                tx.get(stateRef),
                isSearchProviderUsageContinuity(config)
                  ? tx.get(firestore.doc('_control/temporalProviderUsage'))
                  : Promise.resolve(undefined),
              ]);
              assertNativeSnapshot(ownedOperation, lock);
              if (oldState.exists !== existingState.exists)
                throw new Error('Release checkpoint changed before UI freeze');
              if (existingState.exists) assertNativeSnapshot(nativeSnapshotProof(existingState), oldState);
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
              cloudIdentityPending = true;
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
                appHostingFreezeETag: traffic.etag,
                maximumLegacyExecutionSeconds: previousFunctionTimeout,
                ...(providerUsageContinuity ? { providerUsageContinuity } : {}),
                controlRevision: revision,
                compatibilityCommit: config.compatibilityCommit,
                uiCommit: config.uiCommit,
                updatedAt: Date.now(),
              });
            });
          const { control, state } = await snapshot();
          requirePaused(control);
          if (!sameRelease && (state.phase !== 'freezing-ui' ||
              state.appHostingFreezeRequestId !== operationId || state.appHostingFreezeETag !== traffic.etag ||
              proofDigest(state.savedRolloutPolicy) !== proofDigest(traffic.rolloutPolicy) ||
              proofDigest(state.savedUiTraffic) !== proofDigest(traffic.current)))
            throw new Error('Original App Hosting freeze checkpoint changed before submission');
          const observed = await freezeAutomaticRollouts({
            parent,
            checkpoint: state,
            send: !sameRelease,
            assertNoActiveRollout,
            api: appApi,
            settle: settleOperation,
            assertCurrent: () => firestore.runTransaction(async (tx) => {
              const [lock, current, checkpoint] = await Promise.all([lockRef, controlRef, stateRef].map(ref => tx.get(ref)));
              assertNativeSnapshot(ownedOperation, lock);
              assertNativeSnapshot(expectedAuthority.control, current);
              assertNativeSnapshot(expectedAuthority.state, checkpoint);
            }, { readOnly: true }),
          });
          if (state.phase !== 'ui-frozen')
            await transition(control.revision, 'ui-frozen', { appHostingFrozenETag: observed.etag });
          cloudIdentityPending = false;
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
            const platform = await readBoundPlatform();
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
          } else if (Object.hasOwn(poolOperationRoles,action)) {
            requirePhase(state, ['provider-usage-ready']);
            if(config.environment!=='staging'||operatorPrincipal.adcAndGcloudAccountMatch!==true)
              throw new Error('BOOTSTRAP_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform=await readBoundPlatform();
            validateWorkerCoverage(config,platform);
            await verifyPreparationEvidence({...preparationArguments,path:preparationArguments.proof,platform,binding,google:api});
            const settings=await readPreparationReceipt(preparationArguments.settings,preparationArguments.settingsDigest);
            const ids=await readPreparationReceipt(preparationArguments.receipts,preparationArguments.receiptsDigest);
            const operation={
              'activate-restored-cloud-run-media':{role:'media',mode:'restored',field:'cloudRestoredMediaActivation',prefix:'temporalCloudRestoredMediaActivation',run:activateRestoredCloudRunMedia,checkpoint:saveRestoredMediaActivationCheckpoint},
              'diagnose-cloud-run-media-recovery':{role:'media',mode:'recovery',field:'cloudMediaRecovery',prefix:'temporalCloudMediaRecovery',run:runMediaRecoveryCycle,checkpoint:saveMediaRecoveryCheckpoint},
              'promote-cloud-run-media':{role:'media',mode:'promote',field:'cloudMediaPromotion',prefix:'temporalCloudMediaPromotion',run:runCloudRunMediaPromotion,checkpoint:saveMediaPromotionCheckpoint},
              'promote-cloud-run-images':{role:'images',mode:'promote',field:'cloudImagesPromotion',prefix:'temporalCloudImagesPromotion',run:runCloudRunImagesPromotion,checkpoint:saveImagesPromotionCheckpoint},
              'promote-cloud-run-email':{role:'email',mode:'promote',field:'cloudEmailPromotion',prefix:'temporalCloudEmailPromotion',run:runCloudRunEmailPromotion,checkpoint:saveEmailPromotionCheckpoint},
              'promote-cloud-run-search':{role:'search',mode:'promote',field:'cloudSearchPromotion',prefix:'temporalCloudSearchPromotion',run:runCloudRunSearchPromotion,checkpoint:saveSearchPromotionCheckpoint},
              'promote-cloud-run-controls':{role:'controls',mode:'promote',field:'cloudControlsPromotion',prefix:'temporalCloudControlsPromotion',run:runCloudRunControlsPromotion,checkpoint:saveControlsPromotionCheckpoint},
              'bootstrap-stop-cloud-run-media':{role:'media',mode:'cycle',field:'cloudMediaBootstrapCycle',prefix:'temporalCloudMediaBootstrapCycle',creationPrefix:'temporalCloudMediaBootstrapActivation',run:bootstrapStopCloudRunMediaPool,checkpoint:saveMediaBootstrapCycleCheckpoint},
              'activate-cloud-run-media-pool':{role:'media',mode:'retain',field:'cloudMediaActivation',prefix:'temporalCloudMediaActivation',creationPrefix:'temporalCloudMediaActivationStart',run:activateCloudRunMediaPool,checkpoint:saveMediaActivationCheckpoint},
              'stop-cloud-run-media-activation':{role:'media',mode:'abort',field:'cloudMediaActivationStop',prefix:'temporalCloudMediaActivationStop',run:stopCloudRunMediaActivation,checkpoint:saveMediaActivationStopCheckpoint},
              'bootstrap-stop-cloud-run-images':{role:'images',mode:'cycle',field:'cloudImagesBootstrapCycle',prefix:'temporalCloudImagesBootstrapCycle',creationPrefix:'temporalCloudImagesBootstrapActivation',run:bootstrapStopCloudRunImagesPool,checkpoint:saveImagesBootstrapCycleCheckpoint},
              'activate-cloud-run-images-pool':{role:'images',mode:'retain',field:'cloudImagesActivation',prefix:'temporalCloudImagesActivation',creationPrefix:'temporalCloudImagesActivationStart',run:activateCloudRunImagesPool,checkpoint:saveImagesActivationCheckpoint},
              'stop-cloud-run-images-activation':{role:'images',mode:'abort',field:'cloudImagesActivationStop',prefix:'temporalCloudImagesActivationStop',run:stopCloudRunImagesActivation,checkpoint:saveImagesActivationStopCheckpoint},
              'bootstrap-stop-cloud-run-email':{role:'email',mode:'cycle',field:'cloudEmailBootstrapCycle',prefix:'temporalCloudEmailBootstrapCycle',creationPrefix:'temporalCloudEmailBootstrapActivation',run:bootstrapStopCloudRunEmailPool,checkpoint:saveEmailBootstrapCycleCheckpoint},
              'activate-cloud-run-email-pool':{role:'email',mode:'retain',field:'cloudEmailActivation',prefix:'temporalCloudEmailActivation',creationPrefix:'temporalCloudEmailActivationStart',run:activateCloudRunEmailPool,checkpoint:saveEmailActivationCheckpoint},
              'stop-cloud-run-email-activation':{role:'email',mode:'abort',field:'cloudEmailActivationStop',prefix:'temporalCloudEmailActivationStop',run:stopCloudRunEmailActivation,checkpoint:saveEmailActivationStopCheckpoint},
              'bootstrap-stop-cloud-run-search':{role:'search',mode:'cycle',field:'cloudSearchBootstrapCycle',prefix:'temporalCloudSearchBootstrapCycle',creationPrefix:'temporalCloudSearchBootstrapActivation',run:bootstrapStopCloudRunSearchPool,checkpoint:saveSearchBootstrapCycleCheckpoint},
              'activate-cloud-run-search-pool':{role:'search',mode:'retain',field:'cloudSearchActivation',prefix:'temporalCloudSearchActivation',creationPrefix:'temporalCloudSearchActivationStart',run:activateCloudRunSearchPool,checkpoint:saveSearchActivationCheckpoint},
              'stop-cloud-run-search-activation':{role:'search',mode:'abort',field:'cloudSearchActivationStop',prefix:'temporalCloudSearchActivationStop',run:stopCloudRunSearchActivation,checkpoint:saveSearchActivationStopCheckpoint},
              'bootstrap-stop-cloud-run-controls':{role:'controls',mode:'cycle',field:'cloudPoolBootstrapCycle',prefix:'temporalCloudPoolBootstrapCycle',creationPrefix:'temporalCloudPoolBootstrapActivation',run:bootstrapStopCloudRunControlsPool,checkpoint:savePoolBootstrapCycleCheckpoint},
              'activate-cloud-run-controls-pool':{role:'controls',mode:'retain',field:'cloudControlsActivation',prefix:'temporalCloudControlsActivation',creationPrefix:'temporalCloudControlsActivationStart',run:activateCloudRunControlsPool,checkpoint:saveControlsActivationCheckpoint},
              'stop-cloud-run-controls-activation':{role:'controls',mode:'abort',field:'cloudControlsActivationStop',prefix:'temporalCloudControlsActivationStop',run:stopCloudRunControlsActivation,checkpoint:saveControlsActivationStopCheckpoint},
              'bootstrap-stop-cloud-run-orchestration':{role:'orchestration',mode:'cycle',field:'cloudOrchestrationBootstrapCycle',prefix:'temporalCloudOrchestrationBootstrapCycle',creationPrefix:'temporalCloudOrchestrationBootstrapActivation',run:bootstrapStopCloudRunOrchestrationPool,checkpoint:saveOrchestrationBootstrapCycleCheckpoint},
              'activate-cloud-run-orchestration-pool':{role:'orchestration',mode:'retain',field:'cloudOrchestrationActivation',prefix:'temporalCloudOrchestrationActivation',creationPrefix:'temporalCloudOrchestrationActivationStart',run:activateCloudRunOrchestrationPool,checkpoint:saveOrchestrationActivationCheckpoint},
              'stop-cloud-run-orchestration-activation':{role:'orchestration',mode:'abort',field:'cloudOrchestrationActivationStop',prefix:'temporalCloudOrchestrationActivationStop',run:stopCloudRunOrchestrationActivation,checkpoint:saveOrchestrationActivationStopCheckpoint},
            }[action];
            const prefixes=operation.mode==='promote'&&operation.role==='media'?mediaPromotionReceiptPrefixes:{...(operation.mode==='restored'?{recovery:'temporalCloudMediaRecovery'}:{}),...(operation.mode==='promote'&&operation.role!=='controls'?{[`${independentPromotionPredecessor[operation.role]}Promotion`]:`temporalCloud${independentPromotionPredecessor[operation.role][0].toUpperCase()+independentPromotionPredecessor[operation.role].slice(1)}Promotion`}:{}),runner:'temporalCloudIdentityPreparation',scaler:'temporalCloudIdentityPreparation',pool:'temporalCloudPoolPreparation',
              runnerScaler:'temporalCloudScalerAccessPreparation',scalerTrust:'temporalCloudScalerAccessPreparation',poolAccess:'temporalCloudScalerAccessPreparation',
              firestore:'temporalCloudFirestoreAccessPreparation',projectRole:'temporalCloudRuntimeRolePreparation',projectAccess:'temporalCloudRuntimeAccessPreparation',
              ...(['search','email'].includes(operation.role)?{}:{storageRole:'temporalCloudRuntimeRolePreparation',storageAccess:'temporalCloudRuntimeAccessPreparation'}),
              ...(operation.mode!=='cycle'?{bootstrapCycle:operation.role==='controls'?'temporalCloudPoolBootstrapCycle':operation.role==='media'?'temporalCloudMediaBootstrapCycle':operation.role==='images'?'temporalCloudImagesBootstrapCycle':operation.role==='email'?'temporalCloudEmailBootstrapCycle':operation.role==='search'?'temporalCloudSearchBootstrapCycle':'temporalCloudOrchestrationBootstrapCycle'}:{}),
              ...(['abort','promote'].includes(operation.mode)?{activation:operation.role==='controls'?'temporalCloudControlsActivation':operation.role==='media'?'temporalCloudMediaActivation':operation.role==='images'?'temporalCloudImagesActivation':operation.role==='email'?'temporalCloudEmailActivation':operation.role==='search'?'temporalCloudSearchActivation':'temporalCloudOrchestrationActivation'}:{})};
            if(!ids||Object.keys(ids).sort().join(',')!==Object.keys(prefixes).sort().join(',')||ids.runner!==preparationArguments.runnerOperationId||
              new Set(Object.values(ids)).size!==Object.keys(prefixes).length||Object.values(ids).some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id??'')))
              throw new Error('EXACT_BOOTSTRAP_RECEIPT_MANIFEST_REQUIRED');
            const { receipts, assertCurrent: assertPoolReceiptsCurrent } = await readOwnedPoolOperationReceipts(
              firestore, prefixes, ids, config.releaseId
            );
            const guardedPoolApi = (url, method, body, beforeSend) => api(url, method, body,
              method === 'PATCH' ? async () => {
                await assertPoolReceiptsCurrent();
                await beforeSend();
              } : beforeSend
            );
            const currentOperation=await lockRef.get();assertNativeSnapshot(ownedOperation,currentOperation);
            const hasSaved=Object.hasOwn(currentOperation.data(),operation.field);
            if(hasSaved)cloudIdentityPending=true;
            const immutableReceipt=firestore.doc(`_control/${operation.prefix}-${operationId}`);
            const creationReceipt=operation.creationPrefix?firestore.doc(`_control/${operation.creationPrefix}-${operationId}`):undefined;
            const mediaRecoveryStopOptions = () => ({
              binding,config,platform,api,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,
              operationId,bindingDigest,releaseId:config.releaseId,role:'media',settings,
              evidenceDigest:preparationArguments.digest,receipts,
            });
            const result=await operation.run({binding,config,firestore,bindingDigest,expectedAuthority,platform,role:operation.role,settings,operationId,releaseId:config.releaseId,
              ...(operation.mode==='restored'?{recoveryOperationId:ids.recovery,runtime:restoredMediaActivationRuntime({options:()=>({firebaseAuth:resources.auth,binding,config,platform,api,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,operationId,recoveryOperationId:ids.recovery,bindingDigest,releaseId:config.releaseId,role:'media',settings,evidenceDigest:preparationArguments.digest,receipts})})}:{}),
              ...(operation.mode==='recovery'?{runtime:Object.freeze({...canonicalMediaRecoveryRuntime,assertSupported:mediaRecoveryJobPreflight({options:mediaRecoveryStopOptions}),drainJob:mediaRecoveryJobDrainage({options:mediaRecoveryStopOptions}),launchJob:mediaRecoveryJobLauncher({options:mediaRecoveryStopOptions,setOwnedOperation:value=>{ownedOperation=value;}}),confirmStopped:mediaRecoveryStoppedConfirmation({options:mediaRecoveryStopOptions}),confirmNeverStarted:mediaRecoveryNeverStartedConfirmation({options:mediaRecoveryStopOptions}),drain:mediaRecoveryDrainage({options:()=>({binding,config,platform,api,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,operationId,bindingDigest})}),execute:mediaRecoveryExecution({options:()=>({binding,config,platform,api,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,operationId,bindingDigest}),setOwnedOperation:value=>{ownedOperation=value;}}),prepare:mediaRecoveryPreparation({options:()=>({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest}),setOwnedOperation:value=>{ownedOperation=value;}})})}:{}),
              authorizeMutation:async()=> {
                await assertPoolReceiptsCurrent();
                return (operation.mode==='recovery'?assertMediaRecoveryAuthority:({controls:assertControlsPromotionAuthority,search:assertSearchPromotionAuthority,email:assertEmailPromotionAuthority,images:assertImagesPromotionAuthority,media:assertMediaPromotionAuthority}[operation.role]))({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest});
              },
              evidenceDigest:preparationArguments.digest,receipts,api:guardedPoolApi,saved:hasSaved?currentOperation.get(operation.field):undefined,
              observeProtection:async scope=>{
                await assertPoolReceiptsCurrent();
                return operation.mode==='recovery'?mediaRecoveryProtection({options:()=>({firebaseAuth:resources.auth,binding,config,platform,api,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,operationId,bindingDigest,releaseId:config.releaseId,role:'media',settings,evidenceDigest:preparationArguments.digest,receipts})})(scope):verifyCloudRunBootstrapProtection({binding,config,platform,firestore,role:operation.role,operationId,bindingDigest,expectedAuthority,releaseId:config.releaseId});
              },
              observeRegistration:()=>verifyCloudRunBootstrapRegistration({binding,config,platform,firestore,api:guardedPoolApi,role:operation.role,operationId}),
              save:async identityState=>{
                cloudIdentityPending=true;
                ownedOperation=await operation.checkpoint({firestore,lockRef,controlRef,stateRef,immutableReceipt,creationReceipt,ownedOperation,
                  expectedAuthority,config,operationId,bindingDigest,operatorPrincipal,identityState});
              }}, operation.mode==='promote'&&operation.role==='media'
                ? () => {
                    const observationToken = token();
                    return { firebaseAuth:resources.auth, lockRef, controlRef, stateRef, ownedOperation,
                      api:createReleaseApi({getAccessToken:()=>observationToken}) };
                  }
                : undefined);
            await assertPoolReceiptsCurrent();
            const receipt=await immutableReceipt.get();
            if(!receipt.exists||receipt.get('bindingDigest')!==bindingDigest||(['recovery','restored'].includes(operation.mode)?result.stage!=='completed'||result.disposition!==(operation.mode==='restored'?'retained':result.plan.job?'normal-zero-after-job':'restored-normal-zero')||proofDigest(receipt.get('identityState'))!==proofDigest(result):operation.mode==='promote'?
              result.stage!=='completed'||receipt.get('identityState.plan.buildId')!==platform.workerBuildId||proofDigest(receipt.get('identityState'))!==proofDigest(result):
              receipt.get(operation.mode==='retain'?'identityState.activationState.pool.uid':'identityState.stop.pool.uid')!==(operation.mode==='retain'?result.activationState.pool.uid:result.stop.pool.uid)||result.disposition!==(operation.mode==='retain'?'retained':'stopped')))
              throw new Error('BOOTSTRAP_CYCLE_RECEIPT_UNCONFIRMED');
            if(operation.mode==='recovery'&&!result.plan.job)await readRestoredMediaRecoveryOrigin({binding,config,platform,firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,operationId,bindingDigest,releaseId:config.releaseId,role:'media',settings,evidenceDigest:preparationArguments.digest,receipts,api});
            if(operation.mode==='restored')await confirmRestoredMediaActivationCapsule({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest});
            if(operation.mode==='recovery')await confirmCompletedMediaRecoveryCapsule({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest});
            cloudIdentityPending=false;
            console.log(`Owned role-bound ${operation.mode==='promote'?`${operation.role} routing`:'configuration'} operation recorded at ${immutableReceipt.path}; no readiness advance.`);
          } else if (action === 'prepare-cloud-run-pool') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('POOL_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
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
            const poolAbortReceipt = firestore.doc(`_control/temporalCloudPoolPreSendAbort-${operationId}`);
            const result = await prepareCloudRunZeroPool({ platform, role: preparationArguments.role, settings,
              authorizeCreate:()=>assertPoolPreparationAuthority({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest}),
              operationId, releaseId: config.releaseId, evidenceDigest: preparationArguments.digest,
              identityReceipt: runnerReceipt.data(), api,
              observeComputeIsolation: () => verifyCloudRunComputeIsolation({ binding, config, platform, firestore }),
              saved: hasSaved ? currentOperation.get('cloudPoolPreparation') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await savePoolPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, poolAbortReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            if (result.stage === 'not-sent') {
              const [abort, success] = await firestore.getAll(poolAbortReceipt, immutableReceipt);
              if (!abort.exists || !abort.createTime?.isEqual(abort.updateTime) ||
                success.exists ||
                abort.get('bindingDigest') !== bindingDigest || abort.get('operationId') !== operationId ||
                abort.get('releaseId') !== config.releaseId ||
                proofDigest(abort.get('originalAuthority.control')) !== proofDigest(expectedAuthority.control) ||
                proofDigest(abort.get('originalAuthority.state')) !== proofDigest(expectedAuthority.state) ||
                proofDigest(abort.get('identityState')) !== proofDigest(result))
                throw new Error('POOL_PRE_SEND_ABORT_RECEIPT_UNCONFIRMED');
              poolAbortProof = nativeSnapshotProof(abort);
              cloudIdentityPending = false;
              operationVerified = true;
              throw new Error('POOL_CREATE_REJECTED_BEFORE_SEND_AUDIT_RETAINED');
            }
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.pool.uid') !== result.pool.uid)
              throw new Error('POOL_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Zero-target pool configuration recorded at ${immutableReceipt.path}; no activation or readiness claim.`);
          } else if (action === 'prepare-cloud-run-dispatch-diagnostic') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DIAGNOSTIC_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof, platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const receipts = await Promise.all([
              ...[preparationArguments.runnerOperationId, preparationArguments.eventOperationId, preparationArguments.schedulerOperationId]
                .map(id => firestore.doc(`_control/temporalCloudIdentityPreparation-${id}`).get()),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`).get(),
              firestore.doc(`_control/temporalCloudDispatchActivation-${preparationArguments.activationOperationId}`).get(),
            ]);
            if (!receipts.every(r => r.exists) || receipts[4].get('identityState.stage') !== 'completed')
              throw new Error('OWNED_COMPLETED_ACTIVATION_REQUIRED');
            const activation = receipts[4].data();
            const priorManifest = (await lockRef.get()).get('cloudDispatchDiagnostic');
            const diagnosticAuthority = priorManifest === undefined ? undefined : {firestore,manifest:priorManifest,activationReceipt:activation};
            const nativeActivation = await activateCloudRunDispatchService({platform, role:preparationArguments.role, settings,
              operationId:preparationArguments.activationOperationId, releaseId:config.releaseId,
              evidenceDigest:preparationArguments.digest,artifactDirectory:activation.identityState.plan.artifactDirectory,
              runnerReceipt:receipts[0].data(),eventReceipt:receipts[1].data(),schedulerReceipt:receipts[2].data(),serviceReceipt:receipts[3].data(),
              api,diagnostic:diagnosticAuthority,saved:activation.identityState, save:async()=>{throw new Error('DIAGNOSTIC_CANNOT_WRITE_ACTIVATION');},
              probe:async()=>{throw new Error('DIAGNOSTIC_CANNOT_START_REPLACEMENT_PROBE');} });
            cloudIdentityPending = true;
            ownedOperation = await armCloudRunDispatchDiagnostic({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,
              operationId,bindingDigest,config,platform,activationReceipt:activation,nativeActivation});
            const diagnostic = {firestore,manifest:(await lockRef.get()).get('cloudDispatchDiagnostic'),activationReceipt:activation};
            for (const surface of ['outbox', 'commands']) {
            const field = surface === 'outbox' ? 'cloudDispatchDiagnosticWake' : 'cloudDispatchDiagnosticCommandsWake';
            const savedWake = (await lockRef.get()).get(field);
            const creationRef = firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-${surface}`);
            const wake = await prepareStopCloudRunEventarc({platform,role:preparationArguments.role,settings,releaseId:config.releaseId,
              evidenceDigest:preparationArguments.digest,operationId,creator:operatorPrincipal.email,surface:`${surface}-trigger`,diagnostic,
              runnerReceipt:receipts[0].data(),eventReceipt:receipts[1].data(),schedulerReceipt:receipts[2].data(),serviceReceipt:receipts[3].data(),api,saved:savedWake,
              save:async child=>{ownedOperation=await saveDiagnosticWakeCheckpoint({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,diagnostic,operatorPrincipal},child);},
              readCreationReceipt:async()=>{const r=await creationRef.get();return r.exists?r.data():undefined;},
              observeDiagnostic:async({signal})=>{await pulseDiagnosticWake(diagnostic,`${surface}-trigger`,signal);
                return collectCloudRunDispatchDiagnostic({binding,config,platform,firestore,diagnostic,surface,recovery:surface==='commands'?'retry':undefined,signal});},
            });
            if(wake.stage!=='completed'||wake.stopState?.stage!=='completed'||!wake.diagnosticObservation||wake.diagnosticObservationFailed)
              throw new Error('DIAGNOSTIC_EVENTARC_OBSERVATION_OR_CLEANUP_UNCONFIRMED');
            }
            const schedulerCreation = firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-scheduler`);
            const schedulerWake = await prepareStopCloudRunScheduler({platform,role:preparationArguments.role,settings,releaseId:config.releaseId,
              evidenceDigest:preparationArguments.digest,operationId,creator:operatorPrincipal.email,surface:'scheduler',diagnostic,
              runnerReceipt:receipts[0].data(),eventReceipt:receipts[1].data(),schedulerReceipt:receipts[2].data(),serviceReceipt:receipts[3].data(),api,
              saved:(await lockRef.get()).get('cloudDispatchDiagnosticSchedulerWake'),
              save:async child=>{ownedOperation=await saveDiagnosticWakeCheckpoint({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,diagnostic,operatorPrincipal},child);},
              readCreationReceipt:async()=>{const r=await schedulerCreation.get();return r.exists?r.data():undefined;},
              observeDiagnostic:async({signal})=>collectCloudRunDispatchDiagnostic({binding,config,platform,firestore,diagnostic,surface:'commands',recovery:'scheduler',signal}),
            });
            if(schedulerWake.stage!=='completed'||schedulerWake.stopState?.stage!=='completed'||!schedulerWake.diagnosticObservation||schedulerWake.diagnosticObservationFailed)
              throw new Error('DIAGNOSTIC_SCHEDULER_RECOVERY_OR_CLEANUP_UNCONFIRMED');
            diagnosticCompletionProof = await saveDispatchDiagnosticCompletion({
              diagnostic, lockRef, controlRef, stateRef, ownedOperation, expectedAuthority,
              evidenceDigest: preparationArguments.digest,
            });
            cloudIdentityPending = false;
            console.log(`Dispatch diagnostic receipt ${dispatchDiagnosticCompletionPath(operationId)} saved.`);
          } else if (action === 'enable-staging-dispatch-wakes') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DISPATCH_WAKES_REQUIRE_MATCHED_STAGING_OPERATOR');
            const platformBytes = await readFile(config.platformConfig);
            if (hash(platformBytes) !== resourceBinding.platformConfigSHA256)
              throw new Error('DISPATCH_WAKES_PLATFORM_CHANGED');
            const platform = JSON.parse(platformBytes.toString('utf8'));
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ path: preparationArguments.proof, digest: preparationArguments.digest,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const id = preparationArguments.diagnosticOperationId;
            const refs = [
              ...[preparationArguments.runnerOperationId, preparationArguments.eventOperationId, preparationArguments.schedulerOperationId]
                .map(id => firestore.doc(`_control/temporalCloudIdentityPreparation-${id}`)),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`),
              firestore.doc(`_control/temporalCloudDispatchActivation-${preparationArguments.activationOperationId}`),
              firestore.doc(dispatchDiagnosticCompletionPath(id)),
              firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${id}-scheduler`),
            ];
            const originals = await Promise.all(refs.map(ref => ref.get()));
            if (originals.some(row => !row.exists || !row.createTime?.isEqual(row.updateTime)))
              throw new Error('DISPATCH_WAKES_ORIGINAL_RECEIPTS_REQUIRED');
            const [runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt, activation, diagnostic, schedulerCreation] =
              originals.map(row => row.data());
            if (diagnostic.operationId !== id || diagnostic.activationOperationId !== activation.operationId || diagnostic.scope !== 'original diagnostic delivery, retry reconciliation and resource cleanup only' ||
              proofDigest(diagnostic.activation) !== proofDigest(nativeSnapshotProof(originals[4])))
              throw new Error('DISPATCH_WAKES_ORIGINAL_RECEIPTS_CHANGED');
            const originalProofs = originals.map(nativeSnapshotProof);
            const assertAuthority = () => firestore.runTransaction(async tx => {
              const [lock, c, s, ...rows] = await Promise.all([lockRef, controlRef, stateRef, ...refs].map(ref => tx.get(ref)));
              assertNativeSnapshot(ownedOperation, lock);
              assertNativeSnapshot(expectedAuthority.control, c);
              assertNativeSnapshot(expectedAuthority.state, s);
              if (lock.get('action') !== action || lock.get('operationId') !== operationId ||
                lock.get('bindingDigest') !== bindingDigest || lock.get('releaseId') !== config.releaseId ||
                c.get('releaseId') !== config.releaseId || s.get('releaseId') !== config.releaseId ||
                c.get('admission') !== 'paused' || config.domains.some(domain => c.get(`domains.${domain}.admission`) !== 'paused') ||
                s.get('phase') !== 'provider-usage-ready') throw new Error('DISPATCH_WAKES_AUTHORITY_CHANGED');
              rows.forEach((row, index) => assertNativeSnapshot(originalProofs[index], row));
            }, { readOnly: true });
            const opts = { platform, api, settings, role: 'dispatch', releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt };
            const verify = async () => {
              await assertAuthority();
              await activateCloudRunDispatchService({ ...opts, operationId: activation.operationId,
                artifactDirectory: activation.identityState.plan.artifactDirectory, saved: activation.identityState,
                save: async () => { throw new Error('DISPATCH_WAKES_ACTIVATION_WRITE_DENIED'); },
                probe: async () => { throw new Error('DISPATCH_WAKES_REPLACEMENT_PROBE_DENIED'); },
              });
            };
            const held = await lockRef.get();
            assertNativeSnapshot(ownedOperation, held);
            const immutableReceipt = firestore.doc(`_control/temporalCloudBusinessDispatchWakes-${operationId}`);
            const result = await enableStagingDispatchWakes({ ...opts, creator: operatorPrincipal.email, operationId,
              diagnostic, schedulerCreation, verify, assertAuthority,
              verifyConfiguration: () => verifyCloudRunDispatchConfiguration(platform, api),
              saved: held.get('cloudBusinessDispatchWakes'),
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveDispatchWakesCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const sealed = await immutableReceipt.get();
            if (!sealed.exists || !sealed.createTime?.isEqual(sealed.updateTime) ||
              sealed.get('bindingDigest') !== bindingDigest || proofDigest(sealed.get('identityState')) !== proofDigest(result))
              throw new Error('DISPATCH_WAKES_TERMINAL_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Staging business dispatch configuration recorded at ${immutableReceipt.path}.`);
          } else if (action === 'activate-cloud-run-dispatch-service') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DISPATCH_ACTIVATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof, platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const receipts = await Promise.all([
              ...[preparationArguments.runnerOperationId, preparationArguments.eventOperationId, preparationArguments.schedulerOperationId]
                .map(id => firestore.doc(`_control/temporalCloudIdentityPreparation-${id}`).get()),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`).get(),
            ]);
            if (!receipts.every(receipt => receipt.exists)) throw new Error('DISPATCH_ACTIVATION_OWNED_RECEIPTS_REQUIRED');
            const held = await lockRef.get();
            assertNativeSnapshot(ownedOperation, held);
            const hasSaved = Object.hasOwn(held.data(), 'cloudDispatchActivation');
            if (hasSaved) cloudIdentityPending = true;
            const saved = hasSaved ? held.get('cloudDispatchActivation') : undefined;
            if (hasSaved && (!saved || typeof saved !== 'object' || Array.isArray(saved)))
              throw new Error('DISPATCH_ACTIVATION_SAVED_STATE_INVALID');
            const artifactDirectory = hasSaved ? saved.plan?.artifactDirectory : await realpath(await mkdtemp(join(tmpdir(), 'urm-dispatch-activation-')));
            const immutableReceipt = firestore.doc(`_control/temporalCloudDispatchActivation-${operationId}`);
            const result = await activateCloudRunDispatchService({ platform, role: preparationArguments.role, settings,
              operationId, releaseId: config.releaseId, evidenceDigest: preparationArguments.digest, artifactDirectory,
              runnerReceipt: receipts[0].data(), eventReceipt: receipts[1].data(), schedulerReceipt: receipts[2].data(), serviceReceipt: receipts[3].data(),
              api, saved, save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveDispatchActivationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState });
              },
              authorizePatch: attempted => firestore.runTransaction(async tx => {
                const [operation, release, phase] = await Promise.all([lockRef, controlRef, stateRef].map(ref => tx.get(ref)));
                assertNativeSnapshot(ownedOperation, operation);
                assertNativeSnapshot(expectedAuthority.control, release);
                assertNativeSnapshot(expectedAuthority.state, phase);
                if (attempted.stage !== 'attempted' ||
                  proofDigest(operation.get('cloudDispatchActivation')) !== proofDigest(attempted) ||
                  release.get('admission') !== 'paused' || phase.get('phase') !== 'provider-usage-ready' ||
                  config.domains.some(domain => release.get(`domains.${domain}.admission`) !== 'paused'))
                  throw new Error('DISPATCH_ACTIVATION_AUTHORITY_CHANGED');
              }, { readOnly: true }),
              probe: async ({ savedIntent, recordIntent, artifactDirectory }) => {
                await verifyCloudRunScalerPolicies(platform, api);
                const keyIdentity = await verifyDispatchTemporalKeyIdentity({ version: platform.dispatch.apiKeyVersion, api });
                const proof = await collectCloudRunReleaseWorkers({ operationId, bindingDigest, binding, config, platform, firestore,
                  artifactDirectory, savedIntent, recordIntent });
                // Native collector first validates directory ownership and matching saved intent.
                await writeFile(join(artifactDirectory, `dispatch-key-identity-${randomUUID()}.json`), JSON.stringify(keyIdentity), { flag: 'wx', mode: 0o600 });
                return proof;
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest || proofDigest(receipt.get('identityState')) !== proofDigest(result))
              throw new Error('DISPATCH_ACTIVATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Enabled dispatch configuration recorded at ${immutableReceipt.path}; canonical admission remains paused; no delivery or readiness claim.`);
          } else if (action === 'prepare-cloud-run-dispatch-service') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DISPATCH_SERVICE_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const runnerReceipt = await firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get();
            if (!runnerReceipt.exists) throw new Error('DISPATCH_SERVICE_RUNNER_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudDispatchServicePreparation');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudDispatchServicePreparation-${operationId}`);
            const result = await prepareCloudRunDispatchService({ platform, role: preparationArguments.role, settings,
              operationId, releaseId: config.releaseId, evidenceDigest: preparationArguments.digest,
              identityReceipt: runnerReceipt.data(), api,
              saved: hasSaved ? currentOperation.get('cloudDispatchServicePreparation') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveDispatchServicePreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.service.uid') !== result.service.uid)
              throw new Error('DISPATCH_SERVICE_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Inert admission-disabled dispatch service configuration recorded at ${immutableReceipt.path}; no activation or readiness claim.`);
          } else if (['prepare-cloud-run-secret-access', 'prepare-cloud-run-firestore-access', 'prepare-cloud-run-runtime-role', 'prepare-cloud-run-runtime-access', 'prepare-cloud-run-eventarc-audit'].includes(action)) {
            const accessPreparation = {
              'prepare-cloud-run-eventarc-audit': { field: 'cloudEventarcAuditPreparation', prefix: 'temporalCloudEventarcAuditPreparation', prepare: prepareCloudRunEventarcAudit, save: saveEventarcAuditPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-secret-access': { field: 'cloudSecretAccessPreparation', prefix: 'temporalCloudSecretAccessPreparation', prepare: prepareCloudRunSecretAccess, save: saveSecretAccessPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-firestore-access': { field: 'cloudFirestoreAccessPreparation', prefix: 'temporalCloudFirestoreAccessPreparation', prepare: prepareCloudRunFirestoreAccess, save: saveFirestoreAccessPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-runtime-access': { field: 'cloudRuntimeAccessPreparation', prefix: 'temporalCloudRuntimeAccessPreparation', prepare: prepareCloudRunRuntimeAccess, save: saveRuntimeAccessPreparationCheckpoint, etagField: 'identityState.observedEtag' },
              'prepare-cloud-run-runtime-role': { field: 'cloudRuntimeRolePreparation', prefix: 'temporalCloudRuntimeRolePreparation', prepare: prepareCloudRunRuntimeRole, save: saveRuntimeRolePreparationCheckpoint, etagField: 'identityState.nativeRole.etag' },
            }[action];
            const preparationField = accessPreparation.field;
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('SECRET_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const runnerReceipt = await firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get();
            if (!runnerReceipt.exists) throw new Error('SECRET_RUNNER_PREPARATION_REQUIRED');
            const roleReceipt = action === 'prepare-cloud-run-runtime-access'
              ? await firestore.doc(`_control/temporalCloudRuntimeRolePreparation-${preparationArguments.roleOperationId}`).get() : undefined;
            if (roleReceipt && !roleReceipt.exists) throw new Error('RUNTIME_ROLE_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), preparationField);
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/${accessPreparation.prefix}-${operationId}`);
            const result = await accessPreparation.prepare({ platform, role: preparationArguments.role, surface: preparationArguments.surface, settings,
              secret: preparationArguments.secret, operationId, releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, identityReceipt: runnerReceipt.data(), roleReceipt: roleReceipt?.data(), api,
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
          } else if (['prepare-stop-cloud-run-dispatch-scheduler', 'prepare-stop-cloud-run-dispatch-eventarc'].includes(action)) {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('SCHEDULER_CYCLE_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof, platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const receipts = await Promise.all([
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.eventOperationId}`).get(),
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.schedulerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`).get(),
            ]);
            if (!receipts.every(receipt => receipt.exists)) throw new Error('SCHEDULER_CYCLE_OWNED_RECEIPTS_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const eventarcCycle = action === 'prepare-stop-cloud-run-dispatch-eventarc';
            const cycle = eventarcCycle
              ? { field: 'cloudDispatchEventarcCycle', prefix: 'temporalCloudDispatchEventarcCycle', prepare: prepareStopCloudRunEventarc, checkpoint: saveDispatchEventarcCycleCheckpoint }
              : { field: 'cloudDispatchSchedulerCycle', prefix: 'temporalCloudDispatchSchedulerCycle', prepare: prepareStopCloudRunScheduler, checkpoint: saveDispatchSchedulerCycleCheckpoint };
            const field = cycle.field;
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), field);
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/${cycle.prefix}-${operationId}`);
            const creationReceipt = firestore.doc(`_control/temporalCloudDispatchWakePreparation-${operationId}`);
            const result = await cycle.prepare({ platform, role: preparationArguments.role, surface: preparationArguments.surface, settings,
              operationId, releaseId: config.releaseId, evidenceDigest: preparationArguments.digest, creator: operatorPrincipal.email,
              runnerReceipt: receipts[0].data(), eventReceipt: receipts[1].data(), schedulerReceipt: receipts[2].data(), serviceReceipt: receipts[3].data(), api,
              saved: hasSaved ? currentOperation.get(field) : undefined,
              readCreationReceipt: async () => {
                const receipt = await creationReceipt.get();
                if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest) throw new Error('SCHEDULER_CREATION_RECEIPT_REQUIRED');
                return receipt.data();
              },
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await cycle.checkpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, creationReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest || proofDigest(receipt.get('identityState')) !== proofDigest(result))
              throw new Error('SCHEDULER_CYCLE_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Same-operation wake creation and stopped observation recorded at ${immutableReceipt.path}; no wake or readiness claim.`);
          } else if (action === 'stop-cloud-run-dispatch-wake') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DISPATCH_WAKE_STOP_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const [runnerReceipt, serviceReceipt, wakeReceipt] = await Promise.all([
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`).get(),
              firestore.doc(`_control/temporalCloudDispatchWakePreparation-${preparationArguments.wakeOperationId}`).get(),
            ]);
            if (![runnerReceipt, serviceReceipt, wakeReceipt].every(receipt => receipt.exists))
              throw new Error('DISPATCH_WAKE_OWNED_RECEIPTS_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudDispatchWakeStop');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudDispatchWakeStop-${operationId}`);
            const result = await stopCloudRunDispatchWake({ platform, role: preparationArguments.role,
              surface: preparationArguments.surface, settings, operationId, releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, runnerReceipt: runnerReceipt.data(), wakeReceipt: wakeReceipt.data(),
              serviceReceipt: serviceReceipt.data(), api,
              saved: hasSaved ? currentOperation.get('cloudDispatchWakeStop') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveDispatchWakeStopCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              proofDigest(receipt.get('identityState')) !== proofDigest(result))
              throw new Error('DISPATCH_WAKE_STOP_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Owned wake stopped observation recorded at ${immutableReceipt.path}; no activation or effective-access claim.`);
          } else if (action === 'prepare-cloud-run-dispatch-access') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('DISPATCH_ACCESS_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
            validateWorkerCoverage(config, platform);
            await verifyPreparationEvidence({ ...preparationArguments, path: preparationArguments.proof,
              platform, binding, google: api });
            const settings = await readPreparationReceipt(preparationArguments.settings, preparationArguments.settingsDigest);
            const [runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt] = await Promise.all([
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.runnerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.eventOperationId}`).get(),
              firestore.doc(`_control/temporalCloudIdentityPreparation-${preparationArguments.schedulerOperationId}`).get(),
              firestore.doc(`_control/temporalCloudDispatchServicePreparation-${preparationArguments.serviceOperationId}`).get(),
            ]);
            if (![runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt].every(receipt => receipt.exists))
              throw new Error('DISPATCH_OWNED_RESOURCE_PREPARATION_REQUIRED');
            const currentOperation = await lockRef.get();
            assertNativeSnapshot(ownedOperation, currentOperation);
            const hasSaved = Object.prototype.hasOwnProperty.call(currentOperation.data(), 'cloudDispatchAccessPreparation');
            if (hasSaved) cloudIdentityPending = true;
            const immutableReceipt = firestore.doc(`_control/temporalCloudDispatchAccessPreparation-${operationId}`);
            const result = await prepareCloudRunDispatchAccess({ platform, role: preparationArguments.role,
              surface: preparationArguments.surface, settings, operationId, releaseId: config.releaseId,
              evidenceDigest: preparationArguments.digest, runnerReceipt: runnerReceipt.data(), eventReceipt: eventReceipt.data(), schedulerReceipt: schedulerReceipt.data(),
              serviceReceipt: serviceReceipt.data(), api,
              saved: hasSaved ? currentOperation.get('cloudDispatchAccessPreparation') : undefined,
              save: async identityState => {
                cloudIdentityPending = true;
                ownedOperation = await saveDispatchAccessPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
                  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest,
                  operatorPrincipal, identityState });
              },
            });
            const receipt = await immutableReceipt.get();
            if (!receipt.exists || receipt.get('bindingDigest') !== bindingDigest ||
              receipt.get('identityState.observedEtag') !== result.observedEtag)
              throw new Error('DISPATCH_ACCESS_PREPARATION_RECEIPT_UNCONFIRMED');
            cloudIdentityPending = false;
            console.log(`Scoped disabled-service caller policy observation recorded at ${immutableReceipt.path}; no activation or effective-access claim.`);
          } else if (action === 'prepare-cloud-run-scaler-access') {
            requirePhase(state, ['provider-usage-ready']);
            if (config.environment !== 'staging' || operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('SCALER_PREPARATION_REQUIRES_MATCHED_STAGING_OPERATOR');
            const platform = await readBoundPlatform();
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
          } else if (workerHandoff) {
            requirePhase(state, ['provider-usage-ready']);
            if (operatorPrincipal.adcAndGcloudAccountMatch !== true)
              throw new Error('STAGING_WORKER_HANDOFF_REQUIRES_MATCHED_OPERATOR');
            const platformBytes = await readFile(config.platformConfig);
            if (hash(platformBytes) !== resourceBinding.platformConfigSHA256)
              throw new Error('STAGING_WORKER_HANDOFF_PLATFORM_CHANGED');
            const platform = JSON.parse(platformBytes.toString('utf8'));
            validateWorkerCoverage(config, platform);
            const plan = validateWorkerHandoffPlan(
              await readPreparationReceipt(workerHandoff.plan, workerHandoff.planDigest),
              config, platform, workerHandoff.evidenceDigest
            );
            await verifyPreparationEvidence({ path: workerHandoff.proof, digest: workerHandoff.evidenceDigest,
              platform, binding, google: api });
            const operation = {
              operationId, bindingDigest, ownedOperation, expectedAuthority, pools: plan.pools,
              handoffPlanSHA256: workerHandoff.planDigest,
              markPending: value => { cloudIdentityPending = value; },
              updateOwnedOperation: value => { ownedOperation = value; },
            };
            const options = { binding, config, platform, firestore, api };
            if (action === 'handoff-cloud-run-orchestration') {
              await runCloudRunOrchestrationHandoff(options, { ...operation,
                previousBuildId: plan.previousBuildId, evidenceDigest: plan.evidenceDigest,
                receipts: Object.fromEntries(Object.entries(plan.promotionOperationIds).map(
                  ([role, operationId]) => [`${role}Promotion`, { operationId }]
                )),
              });
            } else {
              await verifyWorkerHandoffVm(api);
              const { context, ...authority } = plan.traditionalCluster;
              const handoffOperation = { ...operation, authority,
                transport: await createTraditionalKubernetesTransport(context),
              };
              if (action === 'attach-cloud-run-worker-compute') {
                await attachCloudRunWorkerCompute(options, { ...handoffOperation, role: workerHandoff.role,
                  evidenceDigest: plan.evidenceDigest });
              } else if (action === 'verify-cloud-run-worker-wake') {
                console.log(`Worker wake verification operation ${operationId}`);
                await runCloudRunWorkerWake(options, { ...handoffOperation, role: workerHandoff.role,
                  evidenceDigest: plan.evidenceDigest });
              } else {
                await runCloudRunTraditionalRetirement(options, handoffOperation);
              }
            }
          } else if (action === 'workers-ready') {
            requirePhase(state, ['provider-usage-ready', 'workers-ready']);
            const platform = await verifyReleaseWorkers(state);
            await transition(control.revision, 'workers-ready', {
              workerBuildId: platform.workerBuildId,
              ...(platform.workerWakeReceiptsSHA256 ? { workerWakeReceiptsSHA256: platform.workerWakeReceiptsSHA256 } : {}),
              workersVerifiedAt: Date.now(),
            });
          } else if (action === 'take-ownership') {
            requirePhase(state, ['workers-ready']);
            await queuesEmpty();
            await legacyCounts();
            const platform = await verifyReleaseWorkers(state);
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
            await verifyHetznerActivation(control, state);
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
            await verifyHetznerActivation(control, state);
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
            await verifyHetznerActivation(fresh.control, fresh.state);
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
            const readPreopenSmoke = async () => validatePreopenSmoke(
              await evidence(config.smokeEvidence, control.revision, {
                uiCommit: config.uiCommit,
                backendOwnershipVerified: true,
                workerReady: true,
                oldBrowserWritesDenied: true,
              })
            );
            const preopenSmokeSHA256 = proofDigest(await readPreopenSmoke());
            const platform = await verifyReleaseWorkers(state);
            if (platform.workerBuildId !== state.workerBuildId)
              throw new Error('Reviewed worker changed before opening admission');
            const usage = await firestore.doc('_control/temporalProviderUsage').get();
            if (isSearchProviderUsageContinuity(config)) {
              const history = await firestore.doc(providerUsageHistoryPath(state)).get();
              validateProviderUsageContinuity(config, control, state, usage, history.data(), state.providerUsageEpoch);
            } else validateProviderUsageMarker(config, usage.data(), state.providerUsageEpoch);
            await verifyCallableTransport(control);
            await verifyStorageFirestoreRulesAccess();
            await verifyHetznerActivation(control, state);
            const domains = structuredClone(control.domains);
            for (const domain of config.domains) domains[domain].admission = 'open';
            await verifyUiCommit(state, { requireFrozen: true });
            if (proofDigest(await readPreopenSmoke()) !== preopenSmokeSHA256)
              throw new Error('Pre-open smoke evidence changed while verifying the release');
            await transition(control.revision, 'open', { openedAt: Date.now(), preopenSmokeSHA256 }, { admission: 'open', domains });
          } else if (action === 'restore-auto') {
            requirePhase(state, ['open', 'complete']);
            if (state.phase === 'complete') {
              if (!resumeOperation || !/^[a-f0-9]{64}$/.test(state.autoRolloutRestoreSHA256 ?? ''))
                throw new Error('No original automatic rollout restoration to reconcile');
              await firestore.runTransaction(async (tx) => {
                const [lock, current, checkpoint, audit] = await Promise.all(
                  [lockRef, controlRef, stateRef, firestore.doc(auditPath(control.revision))].map(ref => tx.get(ref))
                );
                assertNativeSnapshot(ownedOperation, lock);
                assertNativeSnapshot(expectedAuthority.control, current);
                assertNativeSnapshot(expectedAuthority.state, checkpoint);
                if (
                  !audit.exists || !audit.createTime?.isEqual(audit.updateTime) ||
                  audit.get('operationId') !== operationId || audit.get('releaseId') !== config.releaseId ||
                  audit.get('action') !== action || audit.get('fromPhase') !== 'open' ||
                  audit.get('toPhase') !== 'complete' || audit.get('toRevision') !== control.revision ||
                  audit.get('autoRolloutRestoreSHA256') !== state.autoRolloutRestoreSHA256 ||
                  proofDigest(audit.get('operationAuthority')) !== proofDigest(ownedOperation)
                ) throw new Error('Original automatic rollout restoration audit changed');
              }, { readOnly: true });
              cloudIdentityPending = false;
              operationVerified = true;
              return;
            }
            const readRestoreAuthority = async (tx) => {
              const [lock, current, checkpoint] = await Promise.all([lockRef, controlRef, stateRef].map(ref => tx.get(ref)));
              assertNativeSnapshot(ownedOperation, lock);
              assertNativeSnapshot(expectedAuthority.control, current);
              assertNativeSnapshot(expectedAuthority.state, checkpoint);
              if (current.get('admission') !== 'open' || checkpoint.get('phase') !== 'open')
                throw new Error('Automatic rollout restoration requires the original open release');
              return lock;
            };
            const lock = await firestore.runTransaction(readRestoreAuthority, { readOnly: true });
            const proof = await restoreAutomaticRollouts({
              parent, operationId, controlRevision: control.revision, uiBuild: state.uiBuild,
              projectNumber: resourceIdentity.projectNumber,
              savedRolloutPolicy: state.savedRolloutPolicy,
              saved: lock.get('autoRolloutRestore'),
              api: appApi,
              settle: settleOperation,
              assertCurrent: () => firestore.runTransaction(readRestoreAuthority, { readOnly: true }),
              save: async (attempt) => {
                cloudIdentityPending = true;
                let proposed;
                await firestore.runTransaction(async (tx) => {
                  const original = await readRestoreAuthority(tx);
                  if (Object.hasOwn(original.data(), 'autoRolloutRestore'))
                    throw new Error('Automatic rollout restoration already attempted');
                  proposed = { ...original.data(), autoRolloutRestore: attempt };
                  tx.update(lockRef, { autoRolloutRestore: attempt });
                }, { maxAttempts: 1 });
                ownedOperation = assertNativeSnapshotSuccessor(ownedOperation, proofDigest(proposed), await lockRef.get());
              },
            });
            await transition(control.revision, 'complete', { completedAt: Date.now(), autoRolloutRestoreSHA256: proofDigest(proof) });
            cloudIdentityPending = false;
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
        operationVerified = true;
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
            if (!canReleaseOwnedOperationLock(lock.data(), operationVerified)) return;
            if (action === 'prepare-cloud-run-dispatch-diagnostic' && lock.get('cloudDispatchDiagnostic')) {
              const final = await tx.get(firestore.doc(dispatchDiagnosticCompletionPath(operationId)));
              assertNativeSnapshot(diagnosticCompletionProof, final);
            }
            if (action === 'prepare-cloud-run-pool' && lock.get('cloudPoolPreparation.stage') === 'not-sent') {
              const [abort, success] = await tx.getAll(
                firestore.doc(`_control/temporalCloudPoolPreSendAbort-${operationId}`),
                firestore.doc(`_control/temporalCloudPoolPreparation-${operationId}`)
              );
              assertNativeSnapshot(poolAbortProof, abort);
              if (success.exists) throw new Error('POOL_PREPARATION_CONFLICTING_TERMINAL_RECEIPT');
            }
            if (action === 'prepare-cloud-run-pool' && lock.get('cloudPoolPreparation.stage') === 'completed') {
              const abort = await tx.get(firestore.doc(`_control/temporalCloudPoolPreSendAbort-${operationId}`));
              if (abort.exists) throw new Error('POOL_PREPARATION_CONFLICTING_TERMINAL_RECEIPT');
            }
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
