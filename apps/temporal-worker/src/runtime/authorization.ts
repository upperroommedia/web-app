import type { DurableActivityExecution, DurableJobIntent } from '@upperroom/orchestration/job-store';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';
/** Revalidate the current user and canonical ownership before effects. Admission
 * permissions are not a permanent grant after a role or ownership change. */
export function createActorAuthorization(
  auth: Auth,
  db: Firestore,
  getExecution?: () => DurableActivityExecution | undefined,
  authorizeCriticalRepair?: (intent: DurableJobIntent<unknown>, transaction?: Transaction) => Promise<void>,
  authorizeDeletedSermonCleanup?: (
    intent: DurableJobIntent<unknown>,
    execution: DurableActivityExecution,
    transaction?: Transaction
  ) => Promise<{ uploaderId: string }>,
  authorizeDeletedListCleanup?: (
    intent: DurableJobIntent<unknown>,
    execution: DurableActivityExecution,
    transaction?: Transaction
  ) => Promise<void>
) {
  return async (intent: DurableJobIntent<unknown>, transaction?: Transaction): Promise<void> => {
    const read = (reference: DocumentReference) => (transaction ? transaction.get(reference) : reference.get());
    const deny = (): never => {
      throw Object.assign(new Error('Permission changed'), { code: 'PERMISSION_CHANGED' });
    };
    const execution = getExecution?.();
    let deletedCleanup: { uploaderId: string } | undefined;
    if (intent.kind === 'sermon.delete' && intent.entity.type === 'sermon') {
      const sermon = await read(db.collection('sermons').doc(intent.entity.id));
      if (!sermon.exists) {
        if (
          !execution ||
          ![
            'commitPublishingProjection',
            'releasePublishingAudio',
            'repairPublishingCritical',
            'cleanupCancelledPublishing',
          ].includes(execution.activityType) ||
          !authorizeDeletedSermonCleanup
        )
          deny();
        deletedCleanup = await authorizeDeletedSermonCleanup!(intent, execution!, transaction);
      }
    }
    let deletedListCleanup = false;
    if (
      intent.kind === 'list.delete' &&
      intent.entity.type === 'list' &&
      !(await read(db.collection('lists').doc(intent.entity.id))).exists
    ) {
      if (
        !execution ||
        !['executePublishingEntityActivity', 'repairPublishingCritical', 'cleanupCancelledPublishingEntity'].includes(
          execution.activityType
        ) ||
        !authorizeDeletedListCleanup
      )
        deny();
      await authorizeDeletedListCleanup!(intent, execution!, transaction);
      deletedListCleanup = true;
    }
    if (execution && ['beginDurableCriticalRepair', 'repairPublishingCritical'].includes(execution.activityType)) {
      if (!authorizeCriticalRepair) deny();
      await authorizeCriticalRepair!(intent, transaction);
      return;
    }
    if (intent.kind === 'provider.orphan_review') {
      if (!execution || !['beginDurableJob', 'reviewProviderOrphanAcknowledgement'].includes(execution.activityType))
        deny();
      const { loadValidatedProviderOrphanReview } = await import(
        '../../../../functions/src/temporal/publishing/orphanReview'
      );
      const validated = await loadValidatedProviderOrphanReview(db, {
        projectId: intent.projectId,
        jobId: intent.jobId,
      });
      if (
        validated.intent.actorUid !== intent.actorUid ||
        validated.intent.generation !== intent.generation ||
        execution!.workflowId !== `provider-ack-review:${intent.projectId}:${intent.jobId}`
      )
        deny();
      return;
    }
    if (
      execution &&
      ((execution.activityType === 'cleanupCancelledPublishing' && intent.kind.startsWith('sermon.')) ||
        (execution.activityType === 'cleanupCancelledPublishingEntity' &&
          (intent.kind.startsWith('list.') ||
            intent.kind.startsWith('series.') ||
            intent.kind === 'speaker.mutate' ||
            (intent.kind === 'maintenance.run' &&
              (intent.payload as { operation?: unknown })?.operation !== 'media_artifacts_cleanup'))))
    ) {
      const [job, permission] = await Promise.all([
        read(db.collection('durableJobs').doc(intent.jobId)),
        read(db.collection('durableJobCancellationIntents').doc(intent.jobId)),
      ]);
      const proof = permission.data();
      if (
        job.exists &&
        permission.exists &&
        job.get('projectId') === intent.projectId &&
        job.get('workflowId') === execution.workflowId &&
        (job.get('state') === 'cancel_requested' ||
          (job.get('state') === 'reconciling' && job.get('result')?.resolutionPurpose === 'cleanup')) &&
        proof?.schemaVersion === 1 &&
        proof.projectId === intent.projectId &&
        proof.jobId === intent.jobId &&
        proof.workflowId === execution.workflowId &&
        proof.generation === intent.generation &&
        typeof proof.actorUid === 'string' &&
        Number.isFinite(proof.authorizedAt) &&
        proof.authorizedAt > 0
      ) {
        if (deletedCleanup || deletedListCleanup) {
          const reviewer = await auth.getUser(proof!.actorUid).catch((error) => {
            if (error?.code === 'auth/user-not-found') deny();
            throw error;
          });
          if (
            reviewer.disabled ||
            !(
              reviewer.customClaims?.role === 'admin' ||
              (reviewer.customClaims?.role === 'publisher' &&
                reviewer.uid === (deletedCleanup?.uploaderId ?? intent.actorUid))
            )
          )
            deny();
        }
        return;
      }
    }
    if (intent.actorUid === 'system:maintenance') {
      if (
        intent.kind !== 'maintenance.run' ||
        (intent.payload as { operation?: unknown })?.operation !== 'media_artifacts_cleanup'
      )
        deny();
      return;
    }
    const systemKinds: Record<string, string[]> = {
      system: ['search.sync'],
      'system:email': ['email.deliver'],
      '__system__:search': ['search.sync', 'search.backfill'],
      'system:firebase-event': [
        'bundle.regenerate',
        'image.ingest',
        'image.delete',
        'search.sync',
        'email.deliver',
        'series.sync_metadata',
      ],
      'system:image': ['image.ingest', 'image.delete'],
      'system:search': ['search.sync', 'search.backfill'],
      'system:bundle': ['bundle.regenerate'],
    };
    if (systemKinds[intent.actorUid]) {
      if (!systemKinds[intent.actorUid].includes(intent.kind)) deny();
      return;
    }
    const actor = await auth.getUser(intent.actorUid).catch((error) => {
      if (error?.code === 'auth/user-not-found') deny();
      throw error;
    });
    const role = actor.customClaims?.role;
    if (actor.disabled) deny();
    if (intent.kind === 'invite.claim') {
      if ((intent.payload as { claimantUid?: unknown })?.claimantUid !== actor.uid) deny();
      return;
    }
    const adminOnly = [
      'invite.create',
      'invite.resend',
      'role.resolve',
      'role.assign',
      'speaker.resolve',
      'speaker.mutate',
      'maintenance.run',
      'search.backfill',
    ];
    if (adminOnly.includes(intent.kind)) {
      if (role !== 'admin') deny();
      return;
    }
    const upload = ['upload.create', 'audio.process', 'image.ingest'].includes(intent.kind);
    if (!(upload ? ['admin', 'publisher', 'uploader'] : ['admin', 'publisher']).includes(String(role))) deny();
    if (role === 'admin') return;
    if (intent.entity.type === 'sermon') {
      const sermon = await read(db.collection('sermons').doc(intent.entity.id));
      if (
        deletedCleanup
          ? deletedCleanup.uploaderId !== actor.uid
          : !sermon.exists || sermon.get('uploaderId') !== actor.uid
      )
        deny();
    }
    if (intent.entity.type === 'series' && intent.kind !== 'series.create') {
      const series = await read(db.collection('series').doc(intent.entity.id));
      if (!series.exists || series.get('ownerId') !== actor.uid) deny();
    }
  };
}
