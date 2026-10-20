import type { Auth } from 'firebase-admin/auth';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { computeProcessAudioRequestVersion, sanitizeProcessAudioPayload } from '@upperroom/contracts/processAudioQueue';
import {
  assertTemporalReleaseAdmission,
  TEMPORAL_RELEASE_CONTROL_PATH,
  type TemporalReleaseControl,
} from '@upperroom/orchestration/release-admission';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import { validateAddIntroOutroData } from '../utils';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId, validateCanonicalYouTubeSource, type RemoteYouTubeResult } from './hetzner-acquisition';
import { assertStagingAcquisitionDatabase } from './hetzner-acquisition-store';

export type EligibleYouTubeAcquisition =
  | { kind: 'ready'; payload: AddIntroOutroInputType & { youtubeUrl: string } }
  | RemoteYouTubeResult;
const deny = (): never => {
  throw new Error('YOUTUBE_ACQUISITION_INELIGIBLE');
};

/** Real canonical host guard. It reads current media ownership, immutable input,
 * durable generation and live actor permission. This does not impersonate a
 * Temporal Activity or replace its native execution assertion: private delegation
 * must already have been prepared by that actual registered execution.
 * It writes no documents or public status and grants no upload/adoption authority.
 */
export async function readEligibleYouTubeAcquisition(options: {
  firestore: Firestore;
  auth: Auth;
  transaction: Transaction;
  ref: MediaJobRef;
}): Promise<EligibleYouTubeAcquisition> {
  try {
    const { firestore: db, auth, transaction: tx } = options;
    const ref = Object.freeze({ ...options.ref });
    youtubeAcquisitionId(ref);
    assertStagingAcquisitionDatabase(db);
    if (auth.app.options.projectId !== ref.projectId) return deny();
    const entity = { type: 'sermon' as const, id: ref.sermonId };
    const [request, state, sermon, job, intent, generation] = await Promise.all([
      tx.get(db.collection('temporalMediaRequests').doc(ref.jobId)),
      tx.get(db.collection('temporalMediaState').doc(ref.sermonId)),
      tx.get(db.collection('sermons').doc(ref.sermonId)),
      tx.get(db.collection('durableJobs').doc(ref.jobId)),
      tx.get(db.collection('durableJobIntents').doc(ref.jobId)),
      tx.get(db.collection('durableJobEntities').doc(durableEntityKey(ref.projectId, entity, 'audio.process'))),
    ]);
    if (!sermon.exists) return { kind: 'deleted' };
    if (
      !state.exists ||
      state.get('owner') !== 'temporal' ||
      youtubeAcquisitionId(state.get('ref')) !== youtubeAcquisitionId(ref)
    )
      return { kind: 'superseded' };
    if (
      !job.exists ||
      !intent.exists ||
      !request.exists ||
      job.get('projectId') !== ref.projectId ||
      job.get('jobId') !== ref.jobId ||
      job.get('kind') !== 'audio.process' ||
      job.get('entity.type') !== 'sermon' ||
      job.get('entity.id') !== ref.sermonId ||
      intent.get('projectId') !== ref.projectId ||
      intent.get('jobId') !== ref.jobId ||
      intent.get('kind') !== 'audio.process' ||
      intent.get('entity.type') !== 'sermon' ||
      intent.get('entity.id') !== ref.sermonId ||
      intent.get('generation') !== ref.revision ||
      job.get('generation') !== ref.revision ||
      intent.get('payload.mediaRequestId') !== ref.jobId ||
      !generation.exists ||
      generation.get('projectId') !== ref.projectId ||
      generation.get('entity.type') !== 'sermon' ||
      generation.get('entity.id') !== ref.sermonId ||
      generation.get('scope') !== 'audio' ||
      generation.get('activeJobId') !== ref.jobId ||
      generation.get('generation') !== ref.revision ||
      youtubeAcquisitionId(request.get('ref')) !== youtubeAcquisitionId(ref)
    )
      return deny();
    if (job.get('state') === 'succeeded') return { kind: 'completed' };
    if (job.get('state') === 'superseded') return { kind: 'superseded' };
    if (state.get('cancellationJobId') === ref.jobId || ['cancel_requested', 'cancelled'].includes(job.get('state')))
      return { kind: 'cancelled' };
    if (
      !['queued', 'running', 'retrying', 'waiting_for_auth'].includes(job.get('state')) ||
      state.get('deletionParentRef')
    )
      return deny();
    assertTemporalReleaseAdmission(
      (await tx.get(db.doc(TEMPORAL_RELEASE_CONTROL_PATH))).data() as TemporalReleaseControl | undefined,
      'media',
      { continuation: true }
    );
    const payload: unknown = request.get('payload');
    if (
      !validateAddIntroOutroData(payload) ||
      !('youtubeUrl' in payload) ||
      payload.id !== ref.sermonId ||
      payload.skipTranscode ||
      computeProcessAudioRequestVersion(payload) !== ref.requestVersion
    )
      return deny();
    const actorUid: unknown = intent.get('actorUid');
    if (typeof actorUid !== 'string' || !actorUid || job.get('requestedBy') !== actorUid) return deny();
    const actor = await auth.getUser(actorUid);
    const role = actor.customClaims?.role;
    if (
      actor.disabled ||
      !['admin', 'publisher', 'uploader'].includes(String(role)) ||
      (role !== 'admin' && sermon.get('uploaderId') !== actor.uid)
    )
      return deny();
    const source = request.get('artifacts.source');
    if (source !== undefined) {
      validateCanonicalYouTubeSource(ref, source);
      return { kind: 'source_available' };
    }
    const sanitized = sanitizeProcessAudioPayload(payload);
    if (!('youtubeUrl' in sanitized)) return deny();
    return { kind: 'ready', payload: sanitized };
  } catch {
    return deny();
  }
}
