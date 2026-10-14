import { ApplicationFailure } from '@temporalio/common';
import type { Firestore } from 'firebase-admin/firestore';
import { isDurableJobTerminal, type DurableJobRef } from '@upperroom/contracts/temporal';
import {
  emailCaptureProfile,
  authoritativeEmailProject,
  assertEmailCaptureReceiptProfile,
} from '@upperroom/function-kit-firestore-send-email/lib/temporal/capture';
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
        const profile = emailCaptureProfile(authoritativeEmailProject(db));
        await store.project(ref, {
          state: 'needs_attention',
          actions: ['resume', 'cancel'],
          attention: {
            kind: 'source_unavailable',
            message: profile
              ? 'Staging email capture is unavailable. Check capture storage before retrying.'
              : 'Email connection is unavailable. Check the mail provider before retrying.',
            ...(profile ? {} : { provider: 'smtp' as const }),
          },
          error: {
            code: profile ? 'EMAIL_CAPTURE_UNAVAILABLE' : 'EMAIL_CONNECTION_UNAVAILABLE',
            message: profile ? 'Staging email was not captured.' : 'Email was not submitted.',
            retryable: true,
            ...(profile ? {} : { provider: 'smtp' as const }),
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
        const profile = emailCaptureProfile(authoritativeEmailProject(db));
        assertEmailCaptureReceiptProfile(receipt, profile);
        const state = receipt.get('state');
        if (state === 'accepted' || state === 'rejected') {
          const job = await store.loadJob(ref);
          if (!isDurableJobTerminal(job.state)) {
            await store.assertCurrent(ref);
            const accepted = state === 'accepted';
            const review = receipt.get('review');
            await store.recordStep(ref, {
              id: 'deliver',
              label: profile ? 'Capture staging email' : 'Deliver email',
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
                    message: profile
                      ? 'Staging email capture closed after administrator review.'
                      : 'Email delivery closed after administrator review.',
                    retryable: false,
                    ...(profile ? {} : { provider: 'smtp' as const }),
                  },
              destinations: [
                {
                  destination: 'email',
                  state: accepted ? 'confirmed' : 'failed',
                  ...(profile
                    ? {
                        message:
                          accepted && receipt.get('info.deliveryTransport')
                            ? 'Staging simulation: captured privately; no external email sent.'
                            : 'Staging simulation: external email delivery is disabled.',
                      }
                    : {}),
                },
              ],
              result: {
                status: accepted ? 'confirmed_after_review' : 'closed_after_review',
                ...(profile
                  ? { deliveryTransport: receipt.get('info.deliveryTransport') ?? profile, externalDelivery: false }
                  : {}),
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
      } catch (error) {
        if (error instanceof Error && error.message === 'EMAIL_DELIVERY_PROFILE_MISMATCH')
          throw ApplicationFailure.nonRetryable(
            'Email transport profile requires review',
            'EMAIL_DELIVERY_PROFILE_MISMATCH'
          );
        throw ApplicationFailure.retryable('Email receipt storage is temporarily unavailable', 'EMAIL_STORAGE');
      }
    },
  };
}
export type EmailControlActivities = ReturnType<typeof createEmailControlActivities>;
