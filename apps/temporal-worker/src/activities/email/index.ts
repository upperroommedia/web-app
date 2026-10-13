import { ApplicationFailure } from '@temporalio/common';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { isDurableJobTerminal, type DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableJobStore } from '@upperroom/orchestration/job-store';
import { createEmailRuntime } from '@upperroom/function-kit-firestore-send-email/lib/temporal/runtime';
import { deliverDurableEmail } from '@upperroom/function-kit-firestore-send-email/lib/temporal/delivery';
import type {
  EmailDeliveryIntent,
  EmailOutcome,
} from '@upperroom/function-kit-firestore-send-email/lib/temporal/delivery';

export function createEmailActivities({
  db,
  store,
  projectId,
}: {
  db: Firestore;
  store: DurableJobStore;
  projectId: string;
}) {
  // Bind the deployed kit adapters once, with project-specific runtime secrets/configuration.
  const runtime = createEmailRuntime(db);
  return {
    async deliverEmail(ref: DurableJobRef): Promise<EmailOutcome> {
      if (ref.projectId !== projectId)
        throw ApplicationFailure.nonRetryable('Email project mismatch', 'EMAIL_PROJECT_MISMATCH');
      try {
        const job = await store.loadJob(ref);
        if (isDurableJobTerminal(job.state))
          return job.state === 'succeeded' ? 'confirmed' : job.state === 'cancelled' ? 'cancelled' : 'rejected';
        await store.assertCurrent(ref);
        const intent = await store.loadIntent<EmailDeliveryIntent>(ref);
        if (job.state === 'cancel_requested') {
          const receipt = await db.collection('durableEmailReceipts').doc(ref.jobId).get();
          if (!['sending', 'unknown', 'partial', 'accepted'].includes(receipt.get('state'))) {
            const mail = db.doc(intent.payload.mailPath);
            if ((await mail.get()).exists)
              await mail.update({
                'delivery.state': 'ERROR',
                'delivery.error': 'Email cancelled before submission.',
                'delivery.endTime': FieldValue.serverTimestamp(),
              });
            await store.project(ref, { state: 'cancelled', actions: [] });
            return 'cancelled';
          }
        }
        if (intent.kind !== 'email.deliver')
          throw ApplicationFailure.nonRetryable('Email intent mismatch', 'EMAIL_INTENT_MISMATCH');
        if (job.state !== 'cancel_requested')
          await store.project(ref, {
            state: 'running',
            actions: ['cancel'],
            attention: undefined,
            error: undefined,
            destinations: [{ destination: 'email', state: 'running' }],
          });
        const result = await deliverDurableEmail(db, runtime, ref, intent.payload, {
          assertCurrent: async () => {
            await store.assertCurrent(ref);
          },
          assertInTransaction: async (tx) => {
            await store.assertCurrentInTransaction(tx, ref);
          },
        });
        const uncertain = result === 'unknown' || result === 'partial';
        const safeRetry = result === 'safe_retry';
        const success = result === 'confirmed';
        const cancelled = result === 'cancelled';
        const receipt = await db.collection('durableEmailReceipts').doc(ref.jobId).get();
        const attempt = Number.isSafeInteger(receipt.get('attempts')) ? receipt.get('attempts') : 0;
        await store.recordStep(ref, {
          id: 'deliver',
          label: 'Deliver email',
          state: success
            ? 'succeeded'
            : cancelled
            ? 'cancelled'
            : safeRetry
            ? 'retrying'
            : uncertain
            ? 'waiting'
            : 'failed',
          attempt,
        });
        await store.project(ref, {
          state: success
            ? 'succeeded'
            : cancelled
            ? 'cancelled'
            : safeRetry
            ? 'retrying'
            : uncertain
            ? 'needs_attention'
            : 'failed',
          actions: uncertain ? ['resolve'] : safeRetry ? ['cancel'] : [],
          attention: undefined,
          error: undefined,
          destinations: [
            {
              destination: 'email',
              state: success
                ? 'confirmed'
                : cancelled
                ? 'absent'
                : uncertain
                ? 'unknown'
                : safeRetry
                ? 'pending'
                : 'failed',
            },
          ],
          ...(uncertain
            ? {
                attention: {
                  kind: 'external_result_unknown' as const,
                  message:
                    result === 'partial'
                      ? 'Some recipients were accepted. Review before taking another action.'
                      : 'Email provider acceptance is unknown. Review provider evidence before retrying.',
                  provider: 'smtp' as const,
                  stepId: 'deliver',
                },
              }
            : {}),
          ...(!success && !safeRetry && !cancelled
            ? {
                error: {
                  code: `EMAIL_${result.toUpperCase()}`,
                  message: uncertain ? 'Email delivery requires review.' : 'Email could not be delivered.',
                  retryable: false,
                  provider: 'smtp' as const,
                },
              }
            : {}),
        });
        return result;
      } catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (
          ['STALE_GENERATION', 'TERMINAL_JOB', 'PROJECT_MISMATCH', 'INVALID_ARGUMENT'].includes(
            (error as { code?: string }).code || ''
          )
        )
          throw ApplicationFailure.nonRetryable('Email job is no longer current', 'EMAIL_STALE_JOB');
        // Firebase/provider exceptions can include private paths/requests; keep histories clean.
        throw ApplicationFailure.retryable('Email storage is temporarily unavailable', 'EMAIL_STORAGE');
      }
    },
  };
}
export type EmailActivities = ReturnType<typeof createEmailActivities> & import('./controls').EmailControlActivities;
