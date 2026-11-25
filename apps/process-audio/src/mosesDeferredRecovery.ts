import type { Database } from 'firebase-admin/database';
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Timestamp } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import {
  computeMosesRecoveryCustody,
  MOSES_RECOVERY_RECEIPTS_PATH,
  mosesRecoveryDigest,
  type MosesDeferredRecoveryReceipt,
} from '@upperroom/contracts/mosesDeferredRecovery';
import type {
  StoredProcessAudioRequestState,
  YouTubeSuccessfulAcquisitionAuthority,
} from '@upperroom/contracts/processAudioQueue';
import type { VerifiedMosesRecoveryDelivery } from './mosesGuestTaskIdentity';
import { computeProcessAudioRequestVersion, withProcessAudioQueueClaim } from './processAudioQueueStore';
import { rememberConsumedMosesPilotNonce } from './sentryMosesPrivacy';

import { sermonStatusType, type Sermon } from './types';

export function createMosesRecoveryStatusWriter(ref: Pick<DocumentReference<Sermon>, 'update'>, initial: Timestamp) {
  let previous = initial;
  return async (audioStatus: sermonStatusType, message?: string, durationSeconds?: number) => {
    const written = await ref.update(
      {
        'status.audioStatus': audioStatus,
        'status.message': message ?? FieldValue.delete(),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      },
      { lastUpdateTime: previous }
    );
    previous = written.writeTime;
    return written;
  };
}

const QUEUE = 'processAudioQueues/youtube';
const fail = (): never => {
  throw new Error('Deferred audio recovery custody is unconfirmed');
};
const stamp = (time?: Timestamp): string | undefined =>
  time && time.seconds + '.' + String(time.nanoseconds).padStart(9, '0');

type TerminalProof = {
  authority: YouTubeSuccessfulAcquisitionAuthority;
  mosesVerified: boolean;
  documentWriteTime: string;
  completedAt: string;
};
type Receipt = MosesDeferredRecoveryReceipt & {
  owner?: string;
  originalRequest?: StoredProcessAudioRequestState;
  outcome?: 'processing' | 'review_required' | 'media_completed' | 'completed';
  proof?: TerminalProof;
};

const receiptPath = (job: VerifiedMosesRecoveryDelivery) =>
  MOSES_RECOVERY_RECEIPTS_PATH + '/' + job.sermonId + '/' + job.requestVersion;
const requestPath = (job: VerifiedMosesRecoveryDelivery) => 'processAudioRequests/' + job.sermonId;

function sameIntent(current: Receipt | null, job: VerifiedMosesRecoveryDelivery): current is Receipt {
  return (
    !!current &&
    current.schema === 1 &&
    current.kind === 'deferred_cookie' &&
    current.sermonId === job.sermonId &&
    current.videoId === job.videoId &&
    current.requestVersion === job.requestVersion &&
    current.custodySha256 === job.custodySha256 &&
    current.taskId === job.taskId &&
    current.nonce === job.nonce &&
    computeMosesRecoveryCustody(current) === job.custodySha256 &&
    computeProcessAudioRequestVersion(job.payload) === job.requestVersion
  );
}

function ownsRow(row: Record<string, unknown> | undefined, receipt: Receipt): boolean {
  if (!row) return false;
  const { mosesRecoveryReservation, ...original } = row;
  const { taskId, nonce, requestVersion, custodySha256 } = receipt;
  return (
    isDeepStrictEqual(mosesRecoveryReservation, { taskId, nonce, requestVersion, custodySha256 }) &&
    mosesRecoveryDigest(original) === receipt.deferredSha256
  );
}

function withReceipt(queue: Record<string, any>, receipt: Receipt) {
  return {
    ...queue,
    mosesRecoveries: {
      ...queue.mosesRecoveries,
      [receipt.sermonId]: {
        ...queue.mosesRecoveries[receipt.sermonId],
        [receipt.requestVersion]: receipt,
      },
    },
  };
}

export async function beginMosesRecovery(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string,
  document: DocumentSnapshot
): Promise<void> {
  await withProcessAudioQueueClaim(db, job.sermonId, 'recovery-start:' + owner, async () => {
    const [state, lock] = await Promise.all([
      db.ref(requestPath(job)).get(),
      db.ref('processAudioLocks/' + job.sermonId).get(),
    ]);
    const request = state.val();
    if (
      !request ||
      lock.val()?.requestId !== owner ||
      !isDeepStrictEqual(request.currentPayload, job.payload) ||
      request.currentRequestVersion !== job.requestVersion ||
      request.runningRequestId ||
      request.nextPayload ||
      request.queuedTaskId ||
      request.runningTaskId ||
      !document.exists ||
      document.ref.path !== 'sermons/' + job.sermonId
    )
      fail();
    const digest = mosesRecoveryDigest(request);
    const result = await db.ref(QUEUE).transaction(
      (queue) => {
        if (!queue) return null;
        const receipt = queue.mosesRecoveries?.[job.sermonId]?.[job.requestVersion];
        const row = queue.deferred?.[job.sermonId];
        if (
          !sameIntent(receipt, job) ||
          receipt.phase !== 'acknowledged' ||
          receipt.owner ||
          receipt.outcome ||
          Object.keys(receipt).sort().join(',') !==
            'custodySha256,deferredSha256,documentCreateTime,documentUpdateTime,kind,nonce,phase,queuedAt,requestSha256,requestVersion,schema,sermonId,taskId,videoId' ||
          receipt.requestSha256 !== digest ||
          receipt.documentCreateTime !== stamp(document.createTime) ||
          receipt.documentUpdateTime !== stamp(document.updateTime) ||
          queue.state?.probeTaskSermonId === job.sermonId ||
          !ownsRow(row, receipt) ||
          !isDeepStrictEqual(row.payload, job.payload)
        )
          return undefined;
        return withReceipt(queue, {
          ...receipt,
          phase: 'consumed',
          owner,
          originalRequest: request,
          outcome: 'processing',
        });
      },
      undefined,
      false
    );
    if (
      !result.committed ||
      result.snapshot.child('mosesRecoveries/' + job.sermonId + '/' + job.requestVersion + '/owner').val() !== owner
    )
      fail();
    rememberConsumedMosesPilotNonce(job.nonce);
  });
}

export async function holdUnconfirmedMosesRecovery(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string
): Promise<void> {
  await db.ref(receiptPath(job)).transaction(
    (current: Receipt | null) => {
      if (!current) return null;
      if (
        !sameIntent(current, job) ||
        current.phase !== 'consumed' ||
        current.owner !== owner ||
        current.outcome !== 'processing'
      )
        return undefined;
      return { ...current, outcome: 'review_required' };
    },
    undefined,
    false
  );
}

function completedRequest(original: StoredProcessAudioRequestState, receipt: Receipt) {
  const proof = receipt.proof!;
  // RTDB drops nulls when persisting. The resulting value must also match exactly on an interrupted settlement.
  const result: Partial<StoredProcessAudioRequestState> = {
    ...original,
    lastCompletedRequestVersion: receipt.requestVersion,
    lastCompletedAt: proof.completedAt,
    lastSuccessfulYouTubeAcquisitionAuthority: proof.authority,
    lastSuccessfulYouTubeAcquisitionRequestVersion: receipt.requestVersion,
    authenticatedDeferralAttemptCount: 0,
    transientRetryCount: 0,
    updatedAt: proof.completedAt,
  };
  for (const field of [
    'deferredAt',
    'queuedTaskId',
    'queuedAt',
    'runningRequestId',
    'runningTaskId',
    'runningRequestVersion',
    'runningAt',
    'transientRetryReason',
    'transientRetryNextRunAt',
    'transientRetryLastFailureMessage',
  ] as const)
    delete result[field];
  return result;
}

// Persist terminal media evidence first. A retry can finish the two RTDB branches without executing media work again.
export async function recordMosesRecoveryMediaCompletion(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  owner: string,
  authority: YouTubeSuccessfulAcquisitionAuthority,
  mosesVerified: boolean,
  written: Timestamp
): Promise<void> {
  const updated = await db.ref(receiptPath(job)).transaction(
    (current: Receipt | null) => {
      if (!current) return null;
      if (
        !sameIntent(current, job) ||
        current.phase !== 'consumed' ||
        current.owner !== owner ||
        current.outcome !== 'processing'
      )
        return undefined;
      return {
        ...current,
        outcome: 'media_completed',
        proof: {
          authority,
          mosesVerified,
          documentWriteTime: stamp(written),
          completedAt: written.toDate().toISOString(),
        },
      };
    },
    undefined,
    false
  );
  if (!updated.committed || updated.snapshot.child('outcome').val() !== 'media_completed') fail();
}

export async function reconcileMosesRecovery(
  db: Database,
  job: VerifiedMosesRecoveryDelivery,
  requestId: string,
  readDocument: () => Promise<DocumentSnapshot>
): Promise<'ready' | 'completed'> {
  return withProcessAudioQueueClaim(db, job.sermonId, 'recovery-finish:' + requestId, async () => {
    const receipt: Receipt = (await db.ref(receiptPath(job)).get()).val();
    if (!sameIntent(receipt, job)) return fail();
    if (receipt.phase === 'acknowledged') {
      const [state, deferred, document] = await Promise.all([
        db.ref(requestPath(job)).get(),
        db.ref(QUEUE + '/deferred/' + job.sermonId).get(),
        readDocument(),
      ]);
      const original = state.val();
      if (
        !original ||
        !isDeepStrictEqual(original.currentPayload, job.payload) ||
        mosesRecoveryDigest(original) !== receipt.requestSha256 ||
        !ownsRow(deferred.val(), receipt) ||
        !isDeepStrictEqual(deferred.val()?.payload, job.payload) ||
        document.ref.path !== 'sermons/' + job.sermonId ||
        stamp(document.createTime) !== receipt.documentCreateTime ||
        stamp(document.updateTime) !== receipt.documentUpdateTime ||
        document.get('status.audioStatus') === 'PROCESSED'
      )
        return fail();
      return 'ready';
    }
    if (receipt.phase !== 'consumed') return fail();
    if (
      !receipt.originalRequest ||
      mosesRecoveryDigest(receipt.originalRequest) !== receipt.requestSha256 ||
      !isDeepStrictEqual(receipt.originalRequest.currentPayload, job.payload)
    )
      return fail();
    if (receipt.outcome === 'completed') return 'completed';
    if (receipt.outcome !== 'media_completed' || !receipt.owner || !receipt.proof) return fail();
    const doc = await readDocument();
    if (
      doc.ref.path !== 'sermons/' + job.sermonId ||
      stamp(doc.createTime) !== receipt.documentCreateTime ||
      stamp(doc.updateTime) !== receipt.proof.documentWriteTime ||
      doc.get('status.audioStatus') !== 'PROCESSED'
    )
      return fail();
    const requestRef = db.ref(requestPath(job));
    const original = (await requestRef.get()).val();
    if (!original) return fail();
    const rowRef = db.ref(QUEUE + '/deferred/' + job.sermonId);
    if (!ownsRow((await rowRef.get()).val(), receipt)) return fail();

    const next = completedRequest(receipt.originalRequest, receipt);
    const completedDigest = mosesRecoveryDigest(next);
    if (!isDeepStrictEqual(original, next)) {
      if (!isDeepStrictEqual(original, receipt.originalRequest)) return fail();
      const changed = await requestRef.transaction(
        (current) => {
          if (current === null) return null;
          return isDeepStrictEqual(current, original) ? next : undefined;
        },
        undefined,
        false
      );
      if (!changed.committed || mosesRecoveryDigest(changed.snapshot.val()) !== completedDigest) return fail();
    }
    const settled = await db.ref(QUEUE).transaction(
      (queue) => {
        if (!queue) return null;
        const row = queue.deferred?.[job.sermonId];
        if (
          !isDeepStrictEqual(queue.mosesRecoveries?.[job.sermonId]?.[job.requestVersion], receipt) ||
          !ownsRow(row, receipt) ||
          !Number.isSafeInteger(queue.state?.deferredYouTubeTaskCount) ||
          queue.state.deferredYouTubeTaskCount <= 0 ||
          queue.state.probeTaskSermonId === job.sermonId
        )
          return undefined;
        const deferred = { ...queue.deferred };
        delete deferred[job.sermonId];
        const terminal = {
          ...receipt,
          outcome: 'completed' as const,
          originalDeferred: row,
          completedRequestSha256: completedDigest,
        };
        return {
          ...withReceipt(queue, terminal),
          deferred,
          state: { ...queue.state, deferredYouTubeTaskCount: queue.state.deferredYouTubeTaskCount - 1 },
        };
      },
      undefined,
      false
    );
    if (
      !settled.committed ||
      settled.snapshot.child('mosesRecoveries/' + job.sermonId + '/' + job.requestVersion + '/outcome').val() !==
        'completed'
    )
      return fail();
    return 'completed';
  });
}
