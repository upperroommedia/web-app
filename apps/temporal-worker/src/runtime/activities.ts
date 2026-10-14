import { createReviewedCreateActivities } from './reviewed-create';
import { beginClaimedPublishingStep } from './activity-step-start';
import { readAuthoritativeCriticalRepairStepIds } from '../../../../functions/src/temporal/publishing/criticalRepairStepAuthority';
import {
  validateSermonDeletionPartialStopRead,
  prepareSermonDeletionPartialStopUnclaimedReservation,
  validatePartialStopReservedCanonicalReference,
} from '../../../../functions/src/helpers/sermonDeletionPartialStop';
import {
  assertCriticalRepairCatalogClaimAllowed,
  validateCertifiedCriticalRepairOperation,
  validateCertifiedCriticalRepairDeletionPhase,
} from '../../../../functions/src/temporal/publishing/criticalRepairCatalog';
import { validateAcknowledgedRepairProviderRead } from '../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair';
import {
  prepareProviderMutationSessionCommitFromClosedEvidence,
  providerMutationFingerprint,
  PROVIDER_MUTATION_SESSIONS,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import {
  createDomainAttentionProjection,
  createDomainSuccessProjection,
  createStoppedRepairProjection,
  type DomainStepResult,
} from './domain-projection';
import type { WorkerWitness } from './worker-witness';
import type { Client } from '@temporalio/client';
import { ActivityExecutionContext } from './execution';
import { createCriticalRepairAuthority } from './critical-repair';
import {
  repairPublishingCritical,
  publishingCriticalRepairDigest,
  loadValidatedPublishingCriticalRepairCertificate,
  preparePublishingCriticalRepair,
} from '../../../../functions/src/temporal/publishing/criticalRepair';
import { createHash } from 'node:crypto';
import { Context } from '@temporalio/activity';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Storage } from '@google-cloud/storage';
import { withProviderIndexedTransaction } from '@upperroom/orchestration/provider-transaction';
import { createDurableJobStore, durableEntityKey } from '@upperroom/orchestration/job-store';
import type { DurableJobRef, DurableJobStep } from '@upperroom/contracts/temporal';
import { createMediaArtifactCleanupActivities } from '../../../../functions-media/src/temporal/artifactCleanup';
import { verifyPublishingProviderFetchSettled } from '../../../../functions/src/temporal/publishing/providerReadiness';
import { createPublishingMediaDependency } from '../../../../functions-media/src/temporal/publishingDependency';
import { assertAdmissionReleaseInTransaction } from '../../../../functions/src/temporal/releaseControl';
import { admitMedia } from '../../../../functions/src/temporal/bridge';
import { createMediaActivities } from '../../../process-audio/src/temporal/activities';
import { createPublishingActivities } from '../../../../functions/src/temporal/publishing/activities';
import { createProviderOrphanReviewActivities } from '../../../../functions/src/temporal/publishing/orphanReview';
import { createFirebasePublishingDependencies } from '../../../../functions/src/temporal/publishing/firebaseDependencies';
import { createAccountActivities } from '../../../../functions/src/temporal/accounts/activities';
import { createBundleActivities } from '../../../../functions/src/temporal/bundles/activities';
import {
  createImageActivities,
  createImageControlActivities,
} from '../../../../functions/src/temporal/images/activities';
import { createEmailActivities } from '../activities/email';
import { createEmailControlActivities } from '../activities/email/controls';
import { createSearchActivities, createSearchControlActivities } from '../activities/search';
import { loadSearchConfigurations } from './search-config';
import { createLifecycleActivities } from '../activities/lifecycle';
import { createMediaProjection } from './media-projection';
import { createActorAuthorization } from './authorization';
import { createPublishingEntityActivities } from '../../../../functions/src/temporal/publishing/entityActivities';
import {
  runCriticalPublishingRepair,
  type DurableCriticalPreparation,
} from '../../../../functions/src/temporal/publishing/durableOperationContext';
import { createProviderMutationRegistry } from './provider-mutations';
import { createPublishingEvidenceWakeup } from './evidence-wakeup';
import { createCriticalRepairCompilationActivities } from './private-compilation';
import { createMutationSettlementProjection } from './mutation-settlement';
import { assertLiveProviderMutationProject } from './provider-isolation';
import { safeActivities, safeCancellation, type ActivityFailureProjection } from './safe-activities';

export function createRuntimeActivities(
  projectId: string,
  selectedQueues: readonly string[],
  client?: Pick<Client, 'workflow' | 'connection'>,
  witness?: WorkerWitness
) {
  if (firebaseAdmin.app().options.projectId !== projectId) throw new Error('Firebase runtime project mismatch');
  const db = firebaseAdmin.firestore();
  const executions = new ActivityExecutionContext(client, witness);
  const criticalRepair = createCriticalRepairAuthority({
    firestore: db,
    auth: firebaseAdmin.auth(),
    projectId,
    getExecution: executions.current,
    digest: publishingCriticalRepairDigest,
    loadValidatedCertificate: (ref, id, tx) => loadValidatedPublishingCriticalRepairCertificate(db, ref, id, tx),
    authorizeCertifiedDeletionInTransaction: async (tx, ref, certificate, operation, phase) => {
      if (
        !certificate.catalog ||
        certificate.operations.some(
          (op) => op.kind === 'publishing_zero_effects_stop' || op.kind === 'sermon_deletion_partial_stop'
        )
      )
        throw Object.assign(new Error('Certified deletion authority is unavailable'), { code: 'PERMISSION_CHANGED' });
      await validateCertifiedCriticalRepairDeletionPhase(
        tx,
        db,
        ref,
        certificate.catalog,
        operation as Parameters<typeof validateCertifiedCriticalRepairDeletionPhase>[4],
        phase
      );
    },
    authorizeDerivedOperation: async (ref, certificate, operation) => {
      if (certificate.operations.some((op) => op.kind === 'publishing_zero_effects_stop'))
        throw Object.assign(new Error('Stopped task cannot authorize a destination operation'), {
          code: 'PERMISSION_CHANGED',
        });
      const partialStop = certificate.operations.find((op) => op.kind === 'sermon_deletion_partial_stop');
      if (partialStop) {
        if (certificate.operations.length !== 1 || (operation as { kind?: unknown })?.kind !== 'provider_read')
          throw Object.assign(new Error('Stopped task cannot authorize a destination mutation'), {
            code: 'PERMISSION_CHANGED',
          });
        await db.runTransaction(async (tx) => {
          await store.assertCurrentInTransaction(tx, ref);
          await validateSermonDeletionPartialStopRead(
            tx,
            db,
            ref,
            partialStop,
            operation as Parameters<typeof validateSermonDeletionPartialStopRead>[4]
          );
        });
        return;
      }
      if (certificate.catalog) {
        try {
          await db.runTransaction(async (tx) => {
            await store.assertCurrentInTransaction(tx, ref);
            await validateCertifiedCriticalRepairOperation(
              tx,
              db,
              ref,
              certificate.catalog!,
              operation as Parameters<typeof validateCertifiedCriticalRepairOperation>[4]
            );
          });
          return;
        } catch (error) {
          if ((operation as { kind?: unknown })?.kind !== 'provider_read') throw error;
        }
      }
      if ((operation as { kind?: unknown })?.kind !== 'provider_read')
        throw Object.assign(new Error('Certified operation is unavailable'), { code: 'PERMISSION_CHANGED' });
      const read = operation as Parameters<typeof validateAcknowledgedRepairProviderRead>[4];
      let lastError: unknown;
      for (const approved of certificate.operations) {
        if (approved.kind !== 'acknowledged_projection') continue;
        try {
          await db.runTransaction(async (tx) => {
            await store.assertCurrentInTransaction(tx, ref);
            await validateAcknowledgedRepairProviderRead(tx, db, ref, approved, read);
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? Object.assign(new Error('Certified read is unavailable'), { code: 'PERMISSION_CHANGED' });
    },
    authorizeDeletedCanonicalCleanup: async (intent, execution, tx) => {
      if (intent.kind === 'sermon.delete') {
        const { validateDeletedSermonCleanup } = await import(
          '../../../../functions/src/helpers/sermonDeletionMirrors'
        );
        await validateDeletedSermonCleanup(db, intent, execution, tx);
      } else if (intent.kind === 'list.delete') {
        const { validateDeletedListCleanup } = await import('../../../../functions/src/helpers/listDeletionMirrors');
        await validateDeletedListCleanup(db, intent, execution, tx);
      } else
        throw Object.assign(new Error('Deleted canonical cleanup proof unavailable'), { code: 'PERMISSION_CHANGED' });
    },
    assertExecution: (ref, tx) =>
      tx
        ? store.assertCurrentInTransaction(tx, ref)
        : db.runTransaction((transaction) => store.assertCurrentInTransaction(transaction, ref)),
  });
  const authorizeActor = createActorAuthorization(
    firebaseAdmin.auth(),
    db,
    executions.current,
    criticalRepair.authorizeIntent,
    async (intent, execution, tx) => {
      const { validateDeletedSermonCleanup } = await import('../../../../functions/src/helpers/sermonDeletionMirrors');
      return validateDeletedSermonCleanup(db, intent, execution, tx);
    },
    async (intent, execution, tx) => {
      const { validateDeletedListCleanup } = await import('../../../../functions/src/helpers/listDeletionMirrors');
      await validateDeletedListCleanup(db, intent, execution, tx);
    }
  );
  const store = createDurableJobStore({
    getExecution: executions.current,
    firestore: db,
    projectId,
    authorizeActor,
    prepareCriticalAttention: async (tx, job, patch) => {
      try {
        const planned = await preparePublishingCriticalRepair(tx, db, { ref: job, expectedRevision: job.revision });
        return {
          attention: {
            ...(patch.attention ?? { kind: 'remote_drift' as const }),
            message: 'An administrator must review the confirmed changes before this task can be stopped safely.',
            resolutionKind: 'critical_repair' as const,
            certificateId: planned.certificateId,
            requiresRetentionAcknowledgement: planned.certificate.operations.some(
              (op) => String(op.kind) === 'legacy_soundcloud_retain'
            )
              ? true
              : undefined,
            repairPurpose: planned.certificate.operations.some((op) => op.kind === 'provider_delete')
              ? ('complete_fixed_cleanup' as const)
              : ('repair_confirmed_changes' as const),
          },
          commit: planned.commit,
        };
      } catch (error) {
        if (
          typeof (error as { code?: unknown })?.code === 'string' &&
          (error as { code: string }).code.startsWith('PUBLISHING_CRITICAL_REPAIR_')
        )
          return undefined;
        throw error;
      }
    },
  });
  executions.bindStore(store);
  const project = async (ref: DurableJobRef, patch: Parameters<typeof store.project>[1]) => {
    await store.project(ref, patch);
  };
  const recordStep = async (ref: DurableJobRef, step: DurableJobStep) => {
    await store.recordStep(ref, step);
  };
  const domainStep = async (ref: DurableJobRef, id: string, result: DomainStepResult) => {
    const success = result.state === 'completed';
    const temporary = [
      'PUBLISHING_AUDIO_PROCESSING',
      'PUBLISHING_TRANSIENT',
      'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
      'PUBLISHING_DELETION_SETTLEMENT_PENDING',
    ].includes(result.code ?? '');
    await recordStep(ref, {
      id,
      label: id === 'delete-plan' ? 'Prepare deletion' : id.replace(/-/g, ' '),
      state: success ? 'succeeded' : temporary ? 'retrying' : 'waiting',
      attempt: Context.current().info.attempt,
    });
    if (success && result.result) await project(ref, { result: result.result });
    if (success) {
      const patch = createDomainSuccessProjection(await store.loadJob(ref), id, result);
      if (patch) {
        try {
          await project(ref, patch);
        } catch (error) {
          if ((error as { code?: string })?.code !== 'STALE_REVISION') throw error;
        }
      }
    }
    if (!success) {
      const job = await store.loadJob(ref);
      await project(ref, createDomainAttentionProjection(job, id, result));
    }
  };
  const assertCurrent = async (ref: DurableJobRef) => {
    await store.assertCurrent(ref);
  };
  const assertCurrentInTransaction = async (
    tx: Parameters<typeof store.assertCurrentInTransaction>[0],
    ref: DurableJobRef
  ) => store.assertCurrentInTransaction(tx, ref);
  const mutations = createProviderMutationRegistry({
    prepareEvidenceWakeup: createPublishingEvidenceWakeup(db, projectId),
    assertNewProviderEffectInTransaction: async (tx, ref) => {
      const intent = await store.assertCurrentInTransaction(tx, ref);
      try {
        await assertCriticalRepairCatalogClaimAllowed(tx, db, ref);
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'PUBLISHING_CRITICAL_REPAIR_CATALOG_REQUIRED') throw error;
        throw Object.assign(new Error('Original publishing claims are unavailable for review'), {
          code: 'PUBLISHING_SOURCE_CLAIMS_FROZEN',
        });
      }
      if (
        (intent.kind === 'sermon.delete' &&
          intent.entity.type === 'sermon' &&
          !(await tx.get(db.collection('sermons').doc(intent.entity.id))).exists) ||
        (intent.kind === 'list.delete' &&
          intent.entity.type === 'list' &&
          !(await tx.get(db.collection('lists').doc(intent.entity.id))).exists)
      )
        throw Object.assign(new Error('Canonical deletion permits frozen cleanup only'), {
          code: 'PUBLISHING_CANONICAL_DELETION_EFFECT_FORBIDDEN',
        });
    },
    firestore: db,
    projectId,
    getExecution: executions.current,
    getUiStepIds: executions.currentStepIds,
    assertCurrentInTransaction: async (tx, ref) => {
      if (Context.current().cancellationSignal.aborted) throw safeCancellation(Context.current().cancellationSignal);
      const intent = await store.assertCurrentInTransaction(tx, ref);
      await authorizeActor(intent, tx);
      if (Context.current().cancellationSignal.aborted) throw safeCancellation(Context.current().cancellationSignal);
    },
  });
  const shared = {
    getSourceStepIds: executions.currentStepIds,
    prepareProviderMutationEffectsClosed: (
      ref: DurableJobRef,
      tx: Parameters<typeof store.assertCurrentInTransaction>[0],
      plan: Parameters<typeof mutations.prepareProviderMutationEffectsClosed>[2]
    ) => mutations.prepareProviderMutationEffectsClosed(tx, ref, plan),
    abortProviderMutationPlan: mutations.abortProviderMutationPlan,
    beginProviderMutationPlan: mutations.beginProviderMutationPlan,
    runPublishingProviderMutation: mutations.runPublishingProviderMutation,
    prepareProviderMutationPlanCommit: (
      ref: DurableJobRef,
      tx: Parameters<typeof store.assertCurrentInTransaction>[0],
      plan: Parameters<typeof mutations.prepareProviderMutationPlanCommit>[2]
    ) => mutations.prepareProviderMutationPlanCommit(tx, ref, plan),
    prepareAcknowledgedProjectionPlan: (
      ref: DurableJobRef,
      tx: Parameters<typeof store.assertCurrentInTransaction>[0],
      plan: Parameters<typeof mutations.prepareAcknowledgedProjectionPlan>[2]
    ) => mutations.prepareAcknowledgedProjectionPlan(tx, ref, plan),
    markCritical: async (ref: DurableJobRef, reasonCode: string, prepare?: DurableCriticalPreparation) => {
      await store.markCritical(ref, {
        reasonCode,
        prepare: async (tx) => {
          const intent = await store.assertCurrentInTransaction(tx, ref);
          await authorizeActor(intent, tx);
          const commit = prepare ? await prepare(tx) : () => {};
          // Reservations and critical capabilities share this actual transaction;
          // fresh authority must still hold after potentially slow preparation.
          await authorizeActor(intent, tx);
          if (Context.current().cancellationSignal.aborted)
            throw safeCancellation(Context.current().cancellationSignal);
          return commit;
        },
      });
    },
    getExecutionIdentity: store.getExecutionIdentity,
    loadIntent: store.loadIntent,
    assertCurrent,
    assertCurrentInTransaction,
    recordStep: domainStep,
  };
  const publishingMedia = createPublishingMediaDependency({
    firestore: db,
    bucket: firebaseAdmin.storage().bucket(),
    projectId,
    loadIntent: async (ref) => (await store.loadIntent<any>(ref)).payload,
    assertCurrent,
    assertCurrentInTransaction: async (tx, ref) => {
      await store.assertCurrentInTransaction(tx, ref);
    },
    verifyProviderFetchSettled: verifyPublishingProviderFetchSettled,
    admitMedia: (payload, actorUid, requestId, parentRef) =>
      admitMedia(payload, actorUid, requestId, undefined, undefined, undefined, undefined, parentRef),
  });
  const publishing = createPublishingActivities(
    createFirebasePublishingDependencies({
      getSourceStepIds: shared.getSourceStepIds,
      prepareProviderMutationEffectsClosed: shared.prepareProviderMutationEffectsClosed,
      abortProviderMutationPlan: shared.abortProviderMutationPlan,
      beginProviderMutationPlan: shared.beginProviderMutationPlan,
      runPublishingProviderMutation: shared.runPublishingProviderMutation,
      prepareProviderMutationPlanCommit: shared.prepareProviderMutationPlanCommit,
      prepareAcknowledgedProjectionPlan: shared.prepareAcknowledgedProjectionPlan,
      markCritical: shared.markCritical,
      loadIntent: async (ref) => (await store.loadIntent<any>(ref)).payload,
      assertCurrent: async (ref) => {
        await store.assertCurrent(ref);
      },
      commitCurrent: async (ref, mutate) => {
        await store.assertCurrent(ref);
        await db.runTransaction(async (tx) => {
          const intent = await store.assertCurrentInTransaction(tx, ref);
          await authorizeActor(intent, tx);
          await withProviderIndexedTransaction(tx, db, projectId, mutate);
        });
      },
      leaseAudio: async (ref, sermonId, sourcePath) => {
        await publishingMedia.leasePublishingAudio(ref, sermonId, sourcePath);
      },
      releaseAudio: publishingMedia.releasePublishingAudio,
      recordStep: domainStep,
    })
  );
  const entities = createPublishingEntityActivities({
    getSourceStepIds: shared.getSourceStepIds,
    prepareProviderMutationEffectsClosed: mutations.prepareProviderMutationEffectsClosed,
    abortProviderMutationPlan: shared.abortProviderMutationPlan,
    beginProviderMutationPlan: shared.beginProviderMutationPlan,
    runPublishingProviderMutation: shared.runPublishingProviderMutation,
    prepareProviderMutationPlanCommit: mutations.prepareProviderMutationPlanCommit,
    prepareAcknowledgedProjectionPlan: mutations.prepareAcknowledgedProjectionPlan,
    markCritical: shared.markCritical,
    loadIntent: store.loadIntent,
    assertCurrent,
    commitCurrent: async (ref, mutate) => {
      await store.commitCurrent(ref, async (tx, intent) => {
        await authorizeActor(intent, tx);
        return withProviderIndexedTransaction(tx, db, projectId, mutate);
      });
    },
    leaseAudio: async (ref, sermonId, sourcePath) => {
      await publishingMedia.leasePublishingAudio(ref, sermonId, sourcePath);
    },
    releaseAudio: publishingMedia.releasePublishingAudio,
    recordResult: async (ref, result) => {
      await domainStep(ref, 'entity', result);
    },
  });
  const media = createMediaActivities({
    assertAuthorized: assertCurrent,
    projectId,
    firestore: db,
    database: firebaseAdmin.database(),
    bucket: firebaseAdmin.storage().bucket(),
    ytdlpPath: process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp',
    projectJob: async (ref, value) => {
      const patch = createMediaProjection(await store.loadJob(ref), value, Context.current().info.attempt, Date.now());
      if (patch) await project(ref, patch);
    },
  });
  const artifactCleanup = createMediaArtifactCleanupActivities({
    firestore: db,
    bucket: firebaseAdmin.storage().bucket(),
    projectId,
    loadIntent: store.loadIntent,
    assertAuthorized: assertCurrent,
    assertCurrentInTransaction,
  });

  const configurations = loadSearchConfigurations(projectId, selectedQueues);
  const search = createSearchActivities({
    firestore: db,
    configurations,
    loadIntent: store.loadIntent,
    assertCurrent,
    project,
    enqueueDocument: async (input) => {
      const jobId = createHash('sha256')
        .update(JSON.stringify([projectId, input.requestId]))
        .digest('hex');
      const ref = { projectId, jobId };
      const entity = {
        type: 'maintenance' as const,
        id: createHash('sha256').update(`${input.instanceId}:${input.documentPath}`).digest('hex'),
      };
      await db.runTransaction(async (tx) => {
        const job = await tx.get(db.collection('durableJobs').doc(jobId));
        const entityDoc = db.collection('durableJobEntities').doc(durableEntityKey(projectId, entity, 'search.sync'));
        const entityState = await tx.get(entityDoc);
        if (job.exists) return;
        await assertAdmissionReleaseInTransaction(tx, db, 'search.sync', { continuation: true });
        store.createInTransaction(tx, {
          ref,
          kind: 'search.sync',
          entity,
          actorUid: 'system:search',
          payload: input,
          requestId: input.requestId,
          generation: (entityState.data()?.generation ?? 0) + 1,
          createdAt: Date.now(),
          dispatch: {
            ref,
            workflowType: 'SearchDocument',
            workflowId: `search:${projectId}:${jobId}`,
            taskQueue: 'urm-search',
          },
        });
      });
      return ref;
    },
  });
  const retrySteps: Record<string, { id: string; label: string }> = {
    preparePublishingDeletePlan: { id: 'delete-plan', label: 'Prepare deletion' },
    repairPublishingCritical: { id: 'cleanup', label: 'Repair applied publishing changes' },
    deliverEmail: { id: 'deliver', label: 'Deliver email' },
    acquireMedia: { id: 'downloading', label: 'Download audio' },
    mergeMedia: { id: 'merging', label: 'Prepare final audio' },
    publishMedia: { id: 'publishing', label: 'Save audio' },
    ensurePublishingMedia: { id: 'subsplash-media', label: 'Prepare published media' },
    checkPublishingMediaReady: { id: 'subsplash-media', label: 'Confirm published media' },
    checkPublishingSoundCloudReady: { id: 'soundcloud-track', label: 'Confirm SoundCloud audio' },
    replacePublishingAudio: { id: 'provider-audio', label: 'Replace published audio' },
    updatePublishingMemberships: { id: 'lists', label: 'Update publishing selections' },
    updatePublishingMetadata: { id: 'projection', label: 'Update published details' },
    reconcilePublishingState: { id: 'projection', label: 'Confirm publishing state' },
    prepareImage: { id: 'source', label: 'Verify image source' },
    allocateImage: { id: 'allocate', label: 'Reserve image destination' },
    commitImage: { id: 'commit', label: 'Make image available' },
    deleteImageProviders: { id: 'delete', label: 'Remove image destinations' },
    ensurePublishingSoundCloud: { id: 'soundcloud-track', label: 'Publish to SoundCloud' },
    applyPublishingLists: { id: 'lists', label: 'Update lists' },
    applyPublishingSeries: { id: 'series', label: 'Update series' },
    applyAccountClaims: { id: 'claims', label: 'Apply account access' },
    revokeAccountSessions: { id: 'sessions', label: 'Refresh account sessions' },
    regenerateBundle: { id: 'bundle', label: 'Refresh cached content' },
    uploadImageBytes: { id: 'upload', label: 'Upload image' },
    syncSearchDocument: { id: 'search', label: 'Update search' },
    executePublishingEntityActivity: { id: 'entity', label: 'Update publishing' },
    executeReviewedPublishingEntityCreate: { id: 'entity', label: 'Finish reviewed publishing setup' },
    executePublishingMaintenancePage: { id: 'entity', label: 'Maintain publishing' },
  };
  const projectFailure = async ({ name, args, failure, attempt, automaticRetry }: ActivityFailureProjection) => {
    if (!automaticRetry || !retrySteps[name]) return;
    const ref = args[0] as DurableJobRef | undefined;
    if (!ref || ref.projectId !== projectId || typeof ref.jobId !== 'string') return;
    const job = await store.loadJob(ref);
    if (!['queued', 'running', 'retrying', 'reconciling'].includes(job.state)) return;
    const step = retrySteps[name];
    await store.recordStep(ref, {
      ...step,
      state: 'retrying',
      attempt,
      error: { code: failure.type!, message: 'This step will retry automatically.', retryable: true },
    });
    await project(ref, {
      state: 'retrying',
      error: { code: failure.type!, message: 'A temporary problem is being retried automatically.', retryable: true },
    });
  };
  const stepIds = (name: string, args: unknown[]) => {
    if (name === 'reportAccountAttention' && typeof args[1] === 'string') return [args[1]];
    if (name === 'projectPublishingAttention' || name === 'recoverPublishingActivityFailure') {
      const known = [
        'subsplash-media',
        'soundcloud-track',
        'lists',
        'series',
        'projection',
        'cleanup',
        'provider-audio',
        'delete-plan',
      ];
      const alias: Record<string, string> = {
        memberships: 'lists',
        metadata: 'projection',
        reconciliation: 'projection',
      };
      const step = typeof args[1] === 'string' ? alias[args[1]] ?? args[1] : 'projection';
      return [known.includes(step) ? step : 'projection'];
    }
    const other: Record<string, string> = {
      validateAccountOperation: 'validate',
      resolveAccountDocument: 'resolve',
      notifyAccountOutcome: 'notification',
      getEmailReceiptState: 'deliver',
      exhaustEmailRetries: 'deliver',
      reportPublishingCancellationFailure: 'cleanup',
      reportPublishingEntityCancellationFailure: 'entity',
      cleanupCancelledPublishing: 'cleanup',
      cleanupCancelledPublishingEntity: 'entity',
      projectPublishingEntityAttention: 'entity',
      recoverPublishingEntityFailure: 'entity',
      createAccountSpeaker: 'speaker',
      commitPublishingProjection: 'projection',
      cleanupPublishingProviders: 'cleanup',
      prepareDeletionEffects: 'delete-plan',
      releaseDeletedSermonArtifacts: 'projection',
      prepareMedia: 'preparing',
      uploadImageBytes: 'upload',
    };
    return [retrySteps[name]?.id ?? other[name] ?? name];
  };
  const publishingControlNamesForStart = new Set([
    'loadPublishingPlan',
    'projectPublishingAttention',
    'recoverPublishingActivityFailure',
    'reportPublishingCancellationFailure',
  ]);
  const publishingAdditionalStarts: Record<string, Pick<DurableJobStep, 'id' | 'label'>> = {
    commitPublishingProjection: { id: 'projection', label: 'Save publishing state' },
    cleanupPublishingProviders: { id: 'cleanup', label: 'Remove published destinations' },
    cleanupCancelledPublishing: { id: 'cleanup', label: 'Confirm cancelled publishing effects' },
  };
  const publishingEntityStarts = new Set([
    'executePublishingEntityActivity',
    'executeReviewedPublishingEntityCreate',
    'executePublishingMaintenancePage',
  ]);
  const protect = <T extends object>(activities: T) =>
    safeActivities(activities, projectFailure, (name, args, run) =>
      executions.run(name, args, stepIds(name, args), async () => {
        try {
          if (
            (name in publishing &&
              ![
                'loadPublishingPlan',
                'projectPublishingAttention',
                'recoverPublishingActivityFailure',
                'reportPublishingCancellationFailure',
                'checkPublishingMediaReady',
                'checkPublishingSoundCloudReady',
              ].includes(name)) ||
            [
              'executePublishingEntityActivity',
              'executePublishingMaintenancePage',
              'cleanupCancelledPublishingEntity',
              'repairPublishingCritical',
              'createAccountSpeaker',
              'allocateImage',
              'uploadImageBytes',
              'deleteImageProviders',
              'reconcileImageReceipt',
              'cancelImage',
              'supersedeImage',
            ].includes(name)
          )
            assertLiveProviderMutationProject(projectId);
          // Source catalogue enrollment binds the public parent step to this
          // already registered SDK execution. Establish it before source work,
          // rather than waiting for the provider result to create the step.
          const publishingStep =
            name in publishing && !publishingControlNamesForStart.has(name)
              ? retrySteps[name] ?? publishingAdditionalStarts[name]
              : publishingEntityStarts.has(name)
              ? retrySteps[name]
              : undefined;
          if (publishingStep) {
            await beginClaimedPublishingStep(
              store,
              args[0] as DurableJobRef,
              publishingStep,
              executions.current(),
              executions.currentStepIds()
            );
          }
          return await run();
        } finally {
          mutations.clearCurrent();
        }
      })
    );
  const select = <T extends object, K extends Extract<keyof T, string>>(
    activities: T,
    names: readonly K[]
  ): Pick<T, K> =>
    Object.fromEntries(Object.entries(activities).filter(([name]) => names.includes(name as K))) as Pick<T, K>;
  const mediaControls = select(media, [
    'prepareMedia',
    'publishMedia',
    'projectMediaWaiting',
    'projectMediaFailure',
    'cleanupMedia',
    'registerMediaObserver',
    'readMediaObservers',
    'readMediaCompletion',
    'requestMediaCancellation',
  ] as const);
  const artifactControlNames = ['loadMediaCleanupPlan'] as const;
  const publishingControlNames = [
    'loadPublishingPlan',
    'projectPublishingAttention',
    'recoverPublishingActivityFailure',
    'reportPublishingCancellationFailure',
  ] as const;
  const entityControlNames = [
    'recoverPublishingEntityFailure',
    'reportPublishingEntityCancellationFailure',
    'projectPublishingEntityAttention',
  ] as const;
  const publishingMediaControlNames = [
    'preparePublishingDeletion',
    'prepareDeletionEffects',
    'clearPublishingDeletionGuard',
    'releaseDeletedSermonArtifacts',
    'leasePublishingAudio',
  ] as const;
  const accountActivities = createAccountActivities({
    ...shared,
    assertCurrent: async (ref) => {
      await db.runTransaction(async (tx) => {
        await store.assertCurrentInTransaction(tx, ref);
      });
    },
  });
  const accountControlNames = ['validateAccountOperation', 'reportAccountAttention'] as const;
  const bundleActivities = createBundleActivities(shared);
  const bundleControlNames = ['resolveLatestBundleJob'] as const;
  const omit = <T extends object, K extends Extract<keyof T, string>>(activities: T, names: readonly K[]): Omit<T, K> =>
    Object.fromEntries(Object.entries(activities).filter(([name]) => !names.includes(name as K))) as Omit<T, K>;
  const factories = {
    'urm-orchestration': () =>
      protect({
        repairPublishingCritical: async (ref: DurableJobRef, certificateId: string) => {
          const certificate = await criticalRepair.loadCertificate(ref, certificateId);
          const affectedSteps = await readAuthoritativeCriticalRepairStepIds(ref, certificate, db);
          const result = await executions.withRepairSteps(ref, affectedSteps, async () => {
            await criticalRepair.loadCertificate(ref, certificateId);
            return runCriticalPublishingRepair(ref.jobId, () =>
              repairPublishingCritical(ref, certificateId, {
                firestore: db,
                loadCertificate: criticalRepair.loadCertificate,
                authorizeOperation: (op) => criticalRepair.authorizeOperation(ref, certificateId, op),
                authorizeCertifiedDeletionInTransaction: (tx, op, phase) =>
                  criticalRepair.authorizeCertifiedDeletionInTransaction(tx, ref, certificateId, op, phase),
                authorizePartialStopInTransaction: (tx, current, op) =>
                  criticalRepair.authorizePartialStopInTransaction(tx, current, certificateId, op),
                prepareUnclaimedReservationDisposition: async (tx, input) => {
                  if (input.ref.projectId !== ref.projectId || input.ref.jobId !== ref.jobId || input.session.db !== db)
                    throw Object.assign(new Error('Partial stop reservation scope is unavailable'), {
                      code: 'PERMISSION_CHANGED',
                    });
                  await criticalRepair.authorizePartialStopInTransaction(tx, ref, certificateId, input.operation);
                  const commit = await prepareSermonDeletionPartialStopUnclaimedReservation(tx, input);
                  await criticalRepair.authorizePartialStopInTransaction(tx, ref, certificateId, input.operation);
                  return commit;
                },
                getRepairObservationScope: async () => {
                  const certificate = await criticalRepair.loadCertificate(ref, certificateId),
                    execution = executions.current();
                  if (!execution || execution.activityType !== 'repairPublishingCritical')
                    throw Object.assign(new Error('Repair execution is unavailable'), { code: 'PERMISSION_CHANGED' });
                  return publishingCriticalRepairDigest({
                    certificateDigest: publishingCriticalRepairDigest(certificate),
                    projectId,
                    jobId: ref.jobId,
                    execution,
                  });
                },
                prepareFinalSettlement: async (tx, session, validateSourceCompletion) => {
                  await store.assertCurrentInTransaction(tx, ref);
                  await criticalRepair.assertCurrentInTransaction(tx, ref, certificateId);
                  if (
                    session.db !== db ||
                    session.scope.projectId !== projectId ||
                    session.scope.jobId !== ref.jobId ||
                    session.id !== providerMutationFingerprint(session.scope)
                  )
                    throw Object.assign(new Error('Repair settlement scope is unavailable'), {
                      code: 'PERMISSION_CHANGED',
                    });
                  const persisted = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id));
                  if (
                    !['active', 'committed'].includes(persisted.get('state')) ||
                    persisted.get('effectsClosed') !== true ||
                    providerMutationFingerprint(persisted.get('resources')) !==
                      providerMutationFingerprint(session.resources)
                  )
                    throw Object.assign(new Error('Repair settlement proof is unavailable'), {
                      code: 'PROVIDER_MUTATION_UNRESOLVED',
                    });
                  return prepareProviderMutationSessionCommitFromClosedEvidence(
                    tx,
                    session,
                    async (transaction, current, seal) => {
                      const proof = await validateSourceCompletion(transaction, current, seal);
                      await criticalRepair.assertCurrentInTransaction(transaction, ref, certificateId);
                      return proof;
                    }
                  );
                },

                commitCurrent: async (current, mutate) => {
                  await criticalRepair.loadCertificate(current, certificateId);
                  await db.runTransaction(async (tx) => {
                    await store.assertCurrentInTransaction(tx, current);
                    const approved = await criticalRepair.assertCurrentInTransaction(tx, current, certificateId);
                    const partialStop = approved.operations.find((op) => op.kind === 'sermon_deletion_partial_stop');
                    const issuedPartialProof =
                      partialStop && approved.operations.length === 1
                        ? { ref: current, certificateId, operation: partialStop }
                        : undefined;
                    await withProviderIndexedTransaction(tx, db, projectId, mutate, {
                      ...(issuedPartialProof
                        ? {
                            reservedProjection: {
                              jobId: current.jobId,
                              sourceProof: issuedPartialProof,
                              validate: async (transaction, proof, { change, resource }) => {
                                if (proof !== issuedPartialProof || !partialStop)
                                  throw Object.assign(new Error('Partial stop reference authority is unavailable'), {
                                    code: 'PERMISSION_CHANGED',
                                  });
                                await criticalRepair.authorizePartialStopInTransaction(
                                  transaction,
                                  current,
                                  certificateId,
                                  partialStop
                                );
                                await validatePartialStopReservedCanonicalReference(
                                  transaction,
                                  db,
                                  current,
                                  partialStop,
                                  change,
                                  resource
                                );
                                await criticalRepair.authorizePartialStopInTransaction(
                                  transaction,
                                  current,
                                  certificateId,
                                  partialStop
                                );
                              },
                            },
                          }
                        : {}),
                      beforeCommit: async (transaction) => {
                        await criticalRepair.assertCurrentInTransaction(transaction, current, certificateId);
                      },
                    });
                  });
                },
              })
            );
          });
          const settled = createMutationSettlementProjection(await store.loadJob(ref), result, Date.now());
          if (settled) {
            try {
              await project(ref, settled);
            } catch (error) {
              if ((error as { code?: string })?.code !== 'STALE_REVISION') throw error;
            }
          }
          await domainStep(ref, 'cleanup', { ...result, cancelOnly: true });
          const stopped = createStoppedRepairProjection(await store.loadJob(ref), result, Date.now());
          if (stopped) await project(ref, stopped);
          return result;
        },
        ...omit(artifactCleanup, artifactControlNames),
        ...omit(publishing, publishingControlNames),
        ...omit(publishingMedia, publishingMediaControlNames),
        ...omit(entities, entityControlNames),
        ...omit(accountActivities, accountControlNames),
        ...omit(bundleActivities, bundleControlNames),
      }),
    'urm-controls': () =>
      protect({
        ...mediaControls,
        ...select(artifactCleanup, artifactControlNames),
        ...select(publishingMedia, publishingMediaControlNames),
        ...select(publishing, publishingControlNames),
        ...select(entities, entityControlNames),
        ...select(accountActivities, accountControlNames),
        ...select(bundleActivities, bundleControlNames),
        ...createCriticalRepairCompilationActivities(db, store, projectId),
        ...createReviewedCreateActivities(db, store, projectId),
        ...createLifecycleActivities(store, { authorizeCriticalRepair: criticalRepair.loadCertificate }),
        ...createEmailControlActivities({ db, store, projectId }),
        ...createImageControlActivities({ firestore: db, loadIntent: store.loadIntent, project }),
        ...createSearchControlActivities({ firestore: db, project }),
        ...createProviderOrphanReviewActivities(db, projectId, project),
      }),
    'urm-media': () => protect(media),
    'urm-email': () => protect(createEmailActivities({ db, store, projectId })),
    'urm-images': () =>
      protect(
        createImageActivities({
          getActor: (uid: string) => firebaseAdmin.auth().getUser(uid),
          firestore: db,
          storage: new Storage({ projectId }),
          loadJob: store.loadJob,
          assertCurrentInTransaction,
          loadIntent: store.loadIntent,
          assertCurrent,
          recordStep,
          project,
        })
      ),
    'urm-search': () =>
      protect({
        syncSearchDocument: async (...args: Parameters<typeof search.syncSearchDocument>) => {
          await store.assertCurrent(args[0]);
          return search.syncSearchDocument(...args);
        },
        searchBackfillPage: async (...args: Parameters<typeof search.searchBackfillPage>) => {
          await store.assertCurrent(args[0]);
          return search.searchBackfillPage(...args);
        },
      }),
  };
  const queues = Object.fromEntries(
    selectedQueues.map((queue) => [queue, factories[queue as keyof typeof factories]()])
  ) as Record<keyof typeof factories, ReturnType<(typeof factories)[keyof typeof factories]>>;
  return { db, store, queues };
}
