import axios from '../../providerSandbox/http';
import { probeProviderAudioUrl } from '../../providerSandbox/http';
import {
  listProviderAcknowledgementsForJob,
  sameResourceAcknowledgementProvesReceipt,
  type ProviderAcknowledgementFact,
} from './providerReceipts';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
export interface SubsplashAudioOutput {
  uploaded_at?: string;
  file_size?: number;
  duration?: number;
  content_type?: string;
  _links?: { download?: { href?: string } };
}
export const isUploadedSubsplashAudioOutput = (output: SubsplashAudioOutput): boolean =>
  Boolean(output.uploaded_at) &&
  typeof output.file_size === 'number' &&
  output.file_size > 0 &&
  typeof output.duration === 'number' &&
  output.duration > 0 &&
  /^audio\//.test(output.content_type ?? '') &&
  typeof output._links?.download?.href === 'string';

/** GET is required: the verified Subsplash download resource does not support HEAD. */
export async function probeSubsplashAudioOutput(output: SubsplashAudioOutput, token: string): Promise<boolean> {
  if (!isUploadedSubsplashAudioOutput(output)) return false;
  return probeProviderAudioUrl(output._links!.download!.href!, token);
}

export async function isSubsplashAudioPlayable(audioId: string, token: string): Promise<boolean> {
  const config = createAxiosConfig(`https://core.subsplash.com/files/v1/audios/${audioId}`, token, 'GET');
  config.params = { include: 'audio-outputs' };
  const audio = (await axios(config)).data;
  if (audio.id !== audioId || audio.app_key !== '9XTSHD') return false;
  const outputs = audio._embedded?.['audio-outputs'];
  if (!Array.isArray(outputs)) return false;
  for (const output of outputs) if (await probeSubsplashAudioOutput(output, token)) return true;
  return false;
}

export async function isSubsplashMediaPlayable(mediaId: string): Promise<boolean> {
  const token = await authenticateSubsplash();
  const config = createAxiosConfig(`https://core.subsplash.com/media/v1/media-items/${mediaId}`, token, 'GET');
  config.params = { include: 'audio.audio-outputs' };
  const media = (await axios(config)).data;
  if (media.id !== mediaId || media.app_key !== '9XTSHD') return false;
  const audioId = media._embedded?.audio?.id;
  return typeof audioId === 'string' && isSubsplashAudioPlayable(audioId, token);
}

/** Streams are documented playable outputs; POST acceptance alone queues encoding. */
export async function isSoundCloudTrackEncoded(trackId: string, requireStreamable = true): Promise<boolean> {
  return runWithSoundCloudAccessToken(async (token) => {
    const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
    const url = `https://api.soundcloud.com/tracks/${encodeURIComponent(trackId)}`;
    try {
      const track = (await axios.get(url, { headers, timeout: 30000 })).data;
      if (requireStreamable && track.streamable !== true) return false;
      const streams = (await axios.get(`${url}/streams`, { headers, timeout: 30000 })).data;
      return ['hls_aac_160_url', 'hls_mp3_128_url'].some(
        (field) => typeof streams[field] === 'string' && streams[field].startsWith('https://')
      );
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'response' in error
          ? (error.response as { status?: number } | undefined)?.status
          : undefined;
      if (status === 404 || status === 409) return false;
      throw error;
    }
  });
}

export const isSoundCloudTrackPlayable = (trackId: string): Promise<boolean> => isSoundCloudTrackEncoded(trackId, true);

/** Scoped private receipts plus terminal provider jobs prove no future source fetch. */
export async function verifyPublishingProviderFetchSettled(
  ref: import('@upperroom/contracts/temporal').DurableJobRef,
  receipts: Array<{ receiptId: string; receipt: import('./providerReceipts').ProviderReceipt }>
): Promise<boolean> {
  const token = await authenticateSubsplash();
  let acknowledgements: Array<{ acknowledgementId: string; acknowledgement: ProviderAcknowledgementFact }> | undefined;
  for (const { receiptId, receipt } of receipts) {
    if (receipt.projectId !== ref.projectId || receipt.jobId !== ref.jobId) return false;
    if (receipt.state === 'executing' || receipt.state === 'needs_review') return false;
    if (!receipt.step.includes('subsplash-transcode')) continue;
    // Adoption alone does not prove the original POST. A matching original positive ACK is factual proof only.
    if (receipt.adoptionAudit) {
      acknowledgements ??= await listProviderAcknowledgementsForJob(ref);
      if (
        !acknowledgements.some(({ acknowledgement }) =>
          sameResourceAcknowledgementProvesReceipt(acknowledgement, receipt)
        )
      )
        return false;
    }
    const result = receipt.result as { id?: unknown } | undefined;
    if (receipt.state !== 'confirmed' || typeof result?.id !== 'string') return false;
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const checkpoint = await admin
      .firestore()
      .collection('temporalPublishingCancellationReceipts')
      .doc(`${ref.jobId}-${receiptId}`)
      .get();
    if (
      checkpoint.exists &&
      checkpoint.get('projectId') === ref.projectId &&
      checkpoint.get('jobId') === ref.jobId &&
      checkpoint.get('receiptId') === receiptId &&
      checkpoint.get('remoteId') === result.id &&
      checkpoint.get('providerReceiptFingerprint') === receipt.fingerprint &&
      checkpoint.get('receiptRevision') === (receipt.revision ?? 0) &&
      checkpoint.get('fetchSettled') === true &&
      ['retained', 'deleted'].includes(checkpoint.get('state'))
    )
      continue;
    const job = (
      await axios(
        createAxiosConfig(
          `https://core.subsplash.com/transcoder/v1/jobs/${encodeURIComponent(result.id)}`,
          token,
          'GET'
        )
      )
    ).data;
    if (job.id !== result.id || !['complete', 'failed', 'error', 'cancelled', 'canceled'].includes(job.status))
      return false;
  }
  return true;
}
