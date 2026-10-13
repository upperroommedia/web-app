import firebase, { isDevelopment } from '../firebase/firebase';
import auth from '../firebase/auth';
import type { Sermon } from '../types/SermonTypes';
import type { List } from '../types/List';
import { canonicalIntent, getPendingCreationId, forgetPendingCreationId } from './durableJobs';

export const UPLOAD_ADMISSION_PREFIX = 'urm:upload-admission:v1:';
/** A date-only picker has no time-of-day intent; generated draft timestamps are excluded. */
export function buildStableUploadPayload(
  sermon: Sermon,
  lists: readonly List[],
  trimStart: number,
  source: Record<string, unknown>
) {
  const date = new Date(sermon.dateMillis ?? 0);
  date.setHours(0, 0, 0, 0);
  return {
    sermon: {
      title: sermon.title ?? '',
      subtitle: sermon.subtitle ?? '',
      description: sermon.description ?? '',
      dateMillis: date.getTime(),
      speakers: (sermon.speakers ?? []).map((speaker) => ({ id: speaker.id })),
      images: (sermon.images ?? []).map((image) => ({ id: image.id })),
      topics: sermon.topics ?? [],
      ...(sermon.seriesId ? { seriesId: sermon.seriesId } : {}),
    },
    listIds: [...new Set(lists.map((list) => list.id))].sort(),
    trimStart,
    duration: sermon.trimDurationSeconds ?? 0,
    source,
  };
}
export type StableUploadPayload = ReturnType<typeof buildStableUploadPayload> & { retryOfJobId?: string };
const hash = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
const storageKey = (requestId: string) => {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Please sign in before uploading.');
  return `${UPLOAD_ADMISSION_PREFIX}${firebase.options.projectId}:${
    isDevelopment ? 'emulator' : 'hosted'
  }:${uid}:${requestId}`;
};
/** Persist only canonical content references and source fingerprints, never file bytes or token URLs. */
export async function getUploadAdmissionIdentity(payload: StableUploadPayload): Promise<string> {
  const requestId = await getPendingCreationId('upload.create', payload);
  const safeSource =
    payload.source.type === 'youtube'
      ? { type: 'youtube', fingerprint: await hash(String(payload.source.url)) }
      : {
          type: 'file',
          name: payload.source.name,
          size: payload.source.size,
          lastModified: payload.source.lastModified,
          contentType: payload.source.contentType,
          fingerprint: payload.source.fingerprint,
        };
  const record = {
    schemaVersion: 1,
    requestId,
    ...(payload.retryOfJobId ? { retryOfJobId: payload.retryOfJobId } : {}),
    creationFingerprint: await hash(canonicalIntent({ purpose: 'creation-entity', kind: 'upload.create', payload })),
    metadata: {
      sermon: payload.sermon,
      listIds: payload.listIds,
      trimStart: payload.trimStart,
      duration: payload.duration,
    },
    source: safeSource,
  };
  try {
    localStorage.setItem(storageKey(requestId), JSON.stringify(record));
  } catch {
    /* The generic pending ID remains available in this tab. */
  }
  return requestId;
}
export async function forgetUploadAdmissionIdentity(requestId: string, payload: StableUploadPayload): Promise<void> {
  await forgetPendingCreationId('upload.create', payload);
  try {
    localStorage.removeItem(storageKey(requestId));
  } catch {
    /* Optional local draft hints. */
  }
}
