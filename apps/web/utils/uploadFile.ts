import firestore, { doc, getDocFromServer } from '../firebase/firestore';
import storage, { ref, uploadBytesResumable, getMetadata } from '../firebase/storage';
import type { Dispatch, SetStateAction } from 'react';
import type { DurableAdmissionReceipt, DurableJob } from '@upperroom/contracts/temporal';
import type { UploadableFile } from '../components/DropZone';
import type { Sermon } from '../types/SermonTypes';
import type { List } from '../types/List';
import type { UploadProgress } from '../context/types';
import { submitDurableIntent, submitDurableCommand } from './durableJobs';
import { retryStorageUpload } from './retryStorageUpload';
import {
  buildStableUploadPayload,
  getUploadAdmissionIdentity,
  forgetUploadAdmissionIdentity,
} from './uploadAdmissionIdentity';

export type AudioTransferProgress = UploadProgress & {
  phase?: 'checking' | 'admitting' | 'transferring' | 'confirming' | 'admitted';
};
export type AudioSource = { type: 'YoutubeUrl'; source: string } | { type: 'File'; source: UploadableFile };
export type SourceUploadSession = NonNullable<DurableAdmissionReceipt['sourceUpload']>;
export type SourceFingerprint = NonNullable<SourceUploadSession['expectedFile']['fingerprint']>;
export type AudioAdmissionReceipt = DurableAdmissionReceipt & { sermonId?: string; alreadyComplete?: boolean };
type UploadFileProps = {
  audioSource: AudioSource;
  setUploadProgress: Dispatch<SetStateAction<AudioTransferProgress>>;
  trimStart: number;
  sermon: Sermon;
  sermonList: List[];
  receipt?: AudioAdmissionReceipt;
  /** Explicit source retry; the server reuses the original canonical sermon and settings. */
  retryOfJobId?: string;
  onAdmission?: (receipt: AudioAdmissionReceipt) => void;
};

/** Hash every byte in bounded chunks; selecting a similarly named file is never enough to resume. */
export async function fingerprintAudioFile(file: File): Promise<SourceFingerprint> {
  const chunkBytes = 4 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < file.size; start += chunkBytes) {
    const chunk = await file.slice(start, Math.min(start + chunkBytes, file.size)).arrayBuffer();
    chunks.push(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', chunk)));
  }
  const digests = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => digests.set(chunk, index * 32));
  const value = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', digests));
  return {
    algorithm: 'sha256-chunks-v1',
    chunkBytes,
    value: Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function readAudioJob(jobId: string): Promise<DurableJob> {
  const snapshot = await getDocFromServer(doc(firestore, 'durableJobs', jobId));
  if (!snapshot.exists())
    throw new Error('The upload request could not be found. Refresh Activity before trying again.');
  return snapshot.data() as DurableJob;
}

export function sourceUploadSession(job: DurableJob): SourceUploadSession {
  const session = job.result?.sourceUpload as SourceUploadSession | undefined;
  if (!session?.storagePath || !session.expectedFile || job.state !== 'awaiting_source') {
    throw new Error('This task is no longer waiting for a file. Refresh its status before trying again.');
  }
  return session;
}

export async function transferAudioSource(
  job: DurableJob,
  file: File,
  setProgress: Dispatch<SetStateAction<AudioTransferProgress>>,
  fingerprint?: SourceFingerprint
): Promise<void> {
  const session = sourceUploadSession(job);
  if (file.name !== session.expectedFile.name || file.size !== session.expectedFile.size) {
    throw new Error('Choose the original audio file. Its name and size must match this upload request.');
  }
  setProgress({ error: false, percent: 0, phase: 'checking', message: 'Checking the selected audio file…' });
  const actualFingerprint = fingerprint ?? (await fingerprintAudioFile(file));
  if (
    session.expectedFile.fingerprint &&
    (actualFingerprint.algorithm !== session.expectedFile.fingerprint.algorithm ||
      actualFingerprint.chunkBytes !== session.expectedFile.fingerprint.chunkBytes ||
      actualFingerprint.value !== session.expectedFile.fingerprint.value)
  )
    throw new Error('This file has different content. Choose the original audio file to resume this upload.');
  if (!session.expectedFile.fingerprint && file.lastModified !== session.expectedFile.lastModified) {
    throw new Error('Choose the original audio file. Its modification time does not match this upload request.');
  }
  const object = ref(storage, session.storagePath);
  const validateSourceMetadata = (metadata: Awaited<ReturnType<typeof getMetadata>>) => {
    if (
      metadata.size !== file.size ||
      metadata.customMetadata?.durableJobId !== job.jobId ||
      metadata.customMetadata?.fingerprint !== JSON.stringify(actualFingerprint) ||
      typeof metadata.generation !== 'string' ||
      !metadata.generation
    ) {
      throw new Error(
        'The saved source differs from this upload request. Review this task in Activity; the source has been retained.'
      );
    }
  };
  const matchingExistingSource = async (): Promise<boolean> => {
    let metadata: Awaited<ReturnType<typeof getMetadata>>;
    try {
      metadata = await getMetadata(object);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage/object-not-found')
        return false;
      throw new Error('The saved source could not be checked. Reconnect before resuming this upload.');
    }
    validateSourceMetadata(metadata);
    return true;
  };
  try {
    await retryStorageUpload({
      upload: async () => {
        // Immutable source paths permit creation only. A lost acknowledgement must never cause an overwrite.
        if (await matchingExistingSource()) return;
        await new Promise<void>((resolve, reject) => {
          uploadBytesResumable(object, file, {
            contentType: file.type || 'application/octet-stream',
            customMetadata: { durableJobId: job.jobId, fingerprint: JSON.stringify(actualFingerprint) },
          }).on(
            'state_changed',
            (snapshot) => {
              setProgress({
                error: false,
                phase: 'transferring',
                percent: snapshot.totalBytes ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0,
                message: 'Sending audio file…',
              });
            },
            reject,
            resolve
          );
        });
      },
      onRetry: (attempt, maxAttempts) =>
        setProgress({
          error: false,
          phase: 'transferring',
          percent: 0,
          message: `Connection interrupted. Restarting file transfer (${attempt}/${maxAttempts})…`,
        }),
    });
  } catch (error) {
    // Upload may have completed remotely before its acknowledgement failed.
    if (!(await matchingExistingSource())) throw error;
  }
  setProgress({ error: false, phase: 'confirming', percent: 100, message: 'Confirming file transfer…' });
  const [metadata, currentJob] = await Promise.all([getMetadata(object), readAudioJob(job.jobId)]);
  validateSourceMetadata(metadata);
  // A prior completion request may have succeeded even if its response was lost.
  if (currentJob.state === 'awaiting_source') {
    await submitDurableCommand(currentJob, 'resume_upload', {
      storagePath: object.fullPath,
      generation: metadata.generation,
    });
  } else if (['cancel_requested', 'cancelled', 'superseded', 'failed'].includes(currentJob.state)) {
    throw new Error('The task no longer accepts this file. Your uploaded source has been retained for review.');
  }
}

const uploadFile = async (props: UploadFileProps): Promise<AudioAdmissionReceipt> => {
  let receipt = props.retryOfJobId ? undefined : props.receipt;
  props.setUploadProgress({ error: false, phase: 'checking', percent: 0, message: 'Checking the audio source…' });
  try {
    const file = props.audioSource.type === 'File' ? props.audioSource.source.file : undefined;
    const fingerprint = file ? await fingerprintAudioFile(file) : undefined;
    if (!receipt) {
      props.setUploadProgress({ error: false, phase: 'admitting', percent: 0, message: 'Saving upload request…' });
      const stablePayload = buildStableUploadPayload(
        props.sermon,
        props.sermonList,
        props.trimStart,
        file
          ? {
              type: 'file',
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
              contentType: file.type,
              fingerprint,
            }
          : { type: 'youtube', url: props.audioSource.source }
      );
      const payload = { ...stablePayload, ...(props.retryOfJobId ? { retryOfJobId: props.retryOfJobId } : {}) };
      const requestId = await getUploadAdmissionIdentity(payload);
      receipt = await submitDurableIntent({
        requestId,
        kind: 'upload.create',
        // This is a stable admission identity, not the canonical sermon ID assigned by the server.
        entity: { type: 'sermon', id: requestId },
        payload,
      });
      props.onAdmission?.(receipt);
      await forgetUploadAdmissionIdentity(requestId, payload);
    }
    if (receipt.clientResult?.alreadyComplete === true) {
      const sermonId = receipt.clientResult.sermonId;
      if (typeof sermonId !== 'string' || !sermonId || sermonId.length > 200 || sermonId.includes('/'))
        throw new Error('The processed sermon reference could not be confirmed. Check this request in Activity.');
      receipt = { ...receipt, sermonId, alreadyComplete: true };
      props.onAdmission?.(receipt);
      props.setUploadProgress({
        error: false,
        phase: 'admitted',
        percent: 100,
        message: 'Audio is already processed. Open the saved sermon.',
      });
      return receipt;
    }
    const job = await readAudioJob(receipt.jobId);
    if (job.entity.type !== 'sermon' || !job.entity.id)
      throw new Error('The canonical sermon reference is unavailable. Check this request in Activity.');
    receipt = { ...receipt, sermonId: job.entity.id };
    props.onAdmission?.(receipt);
    if (file) {
      if (job.state === 'awaiting_source') await transferAudioSource(job, file, props.setUploadProgress, fingerprint);
      else if (['failed', 'cancelled', 'superseded'].includes(job.state))
        throw new Error('This upload needs review in Activity before another file can be sent.');
    }
    props.setUploadProgress({
      error: false,
      phase: 'admitted',
      percent: 100,
      message: 'Request saved. Follow audio processing in Activity.',
    });
    return receipt;
  } catch (error) {
    props.setUploadProgress({
      error: true,
      percent: 0,
      message:
        error instanceof Error
          ? error.message
          : 'The request could not be confirmed. Your source has been kept. Check Activity before starting another upload.',
    });
    // Never delete the source or sermon on an ambiguous admission/transfer response.
    throw error;
  }
};
export default uploadFile;
