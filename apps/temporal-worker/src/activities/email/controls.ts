import { ApplicationFailure } from '@temporalio/common';
import type { Firestore } from 'firebase-admin/firestore';
import { isDurableJobTerminal, type DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableJobStore } from '@upperroom/orchestration/job-store';
/** Datastore-only controls. No SMTP/OAuth configuration or secrets are imported. */
export function createEmailControlActivities({
  db,
  store,
  projectId,
}: {
  db: Firestore;
  store: DurableJobStore;
  projectId: string;
}) {
  return {
    async exhaustEmailRetries(ref: DurableJobRef): Promise<void> {
      try {
        await store.project(ref, {
          state: 'needs_attention',
          actions: ['resume', 'cancel'],
          attention: {
            kind: 'source_unavailable',
            message: 'Email connection is unavailable. Check the mail provider before retrying.',
            provider: 'smtp',
          },
          error: {
            code: 'EMAIL_CONNECTION_UNAVAILABLE',
            message: 'Email was not submitted.',
            retryable: true,
            provider: 'smtp',
          },
        });
      } catch {
        throw ApplicationFailure.retryable('Email projection storage is temporarily unavailable', 'EMAIL_STORAGE');
      }
    },
    async getEmailReceiptState(ref: DurableJobRef): Promise<'confirmed' | 'rejected' | 'unknown' | 'prepared'> {
      if (ref.projectId !== projectId)
        throw ApplicationFailure.nonRetryable('Email project mismatch', 'EMAIL_PROJECT_MISMATCH');
      try {
        const receipt = await db.collection('durableEmailReceipts').doc(ref.jobId).get();
        if (!receipt.exists) return 'prepared';
        const state = receipt.get('state');
        if (state === 'accepted' || state === 'rejected') {
          const job = await store.loadJob(ref);
          if (!isDurableJobTerminal(job.state)) {
            await store.assertCurrent(ref);
            const accepted = state === 'accepted';
            const review = receipt.get('review');
            await store.recordStep(ref, {
              id: 'deliver',
              label: 'Deliver email',
              state: accepted ? 'succeeded' : 'failed',
              attempt: Number.isSafeInteger(receipt.get('attempts')) ? receipt.get('attempts') : 0,
            });
            await store.project(ref, {
              state: accepted ? 'succeeded' : 'failed',
              actions: [],
              attention: undefined,
              error: accepted
                ? undefined
                : {
                    code: 'EMAIL_CLOSED_AFTER_REVIEW',
                    message: 'Email delivery closed after administrator review.',
                    retryable: false,
                    provider: 'smtp',
                  },
              destinations: [{ destination: 'email', state: accepted ? 'confirmed' : 'failed' }],
              result: {
                status: accepted ? 'confirmed_after_review' : 'closed_after_review',
                ...(typeof review?.result?.replacementJobId === 'string'
                  ? { replacementJobId: review.result.replacementJobId }
                  : {}),
              },
            });
          }
        }
        return state === 'accepted'
          ? 'confirmed'
          : state === 'rejected'
          ? 'rejected'
          : state === 'prepared'
          ? 'prepared'
          : 'unknown';
      } catch {
        throw ApplicationFailure.retryable('Email receipt storage is temporarily unavailable', 'EMAIL_STORAGE');
      }
    },
  };
}
export type EmailControlActivities = ReturnType<typeof createEmailControlActivities>;
