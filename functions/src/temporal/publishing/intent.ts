import { capturePublishingAllocationSource } from './allocationBarrier';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import type { DurableJobKind } from '@upperroom/contracts/temporal';
import type { PrivatePublishingIntent, PublishingAction } from './types';
export interface PublishingAdmissionActor {
  uid: string;
  role: string;
}
export const PUBLISHING_SERMON_KINDS = [
  'sermon.publish',
  'sermon.unpublish',
  'sermon.update',
  'sermon.delete',
] as const;
export const publishingAuthorization = { roles: ['admin', 'publisher'], entity: 'sermon' } as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const ids = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((id) => typeof id !== 'string' || !id.trim() || id.includes('/'))
  )
    throw new HttpsError('invalid-argument', 'Destination IDs are invalid.');
  return [...new Set(value as string[])];
};
const selections = (value: unknown) => {
  const data = record(value);
  if (data.soundcloud !== undefined && typeof data.soundcloud !== 'boolean')
    throw new HttpsError('invalid-argument', 'SoundCloud selection must be a boolean.');
  const seriesId = data.seriesId;
  if (seriesId !== undefined && (typeof seriesId !== 'string' || !seriesId.trim() || seriesId.includes('/')))
    throw new HttpsError('invalid-argument', 'Series ID is invalid.');
  return {
    listIds: ids(data.listIds),
    ...(typeof seriesId === 'string' ? { seriesId } : {}),
    soundcloud: data.soundcloud === true,
  };
};
/** Admission snapshots canonical content; clients can select destinations, never provider IDs/credentials. */
export function normalizePublishingIntent(
  input: { kind: DurableJobKind; payload: Record<string, unknown>; generation: number },
  canonicalEntity: Sermon,
  actor: PublishingAdmissionActor
): PrivatePublishingIntent {
  const localUploaderEdit =
    ['sermon.update', 'sermon.delete'].includes(input.kind) &&
    actor.role === 'uploader' &&
    canonicalEntity.uploaderId === actor.uid &&
    !canonicalEntity.subsplashId &&
    !canonicalEntity.soundCloudTrackId;
  if (!localUploaderEdit && !publishingAuthorization.roles.some((role) => role === actor.role))
    throw new HttpsError('permission-denied', 'Publishing permission is required.');
  if (!(PUBLISHING_SERMON_KINDS as readonly string[]).includes(input.kind))
    throw new HttpsError('invalid-argument', 'Unsupported publishing operation.');
  const action = input.kind.split('.')[1] as PublishingAction;
  if (
    action === 'update' &&
    input.payload.expectedEditedAtMillis !== undefined &&
    input.payload.expectedEditedAtMillis !==
      (typeof canonicalEntity.editedAtMillis === 'number' ? canonicalEntity.editedAtMillis : 0)
  )
    throw new HttpsError('failed-precondition', 'This sermon changed while the draft was open. Refresh before saving.');
  const nestedDestinations = record(input.payload.destinations);
  const destinations = selections(
    input.payload.destinations ?? {
      listIds: input.payload.listIds,
      seriesId: input.payload.seriesId ?? undefined,
      soundcloud: false,
    }
  );
  const removals = selections(input.payload.removals);
  if (action !== 'update' && destinations.seriesId && canonicalEntity.seriesId !== destinations.seriesId)
    throw new HttpsError('failed-precondition', 'Selected series does not match the sermon.');
  if (removals.seriesId && canonicalEntity.seriesId !== removals.seriesId)
    throw new HttpsError('failed-precondition', 'Removed series does not match the sermon.');
  const patch = record(input.payload.patch);
  const allowed = [
    'title',
    'subtitle',
    'description',
    'dateMillis',
    'dateString',
    'sourceStartTime',
    'trimDurationSeconds',
    'durationSeconds',
    'speakers',
    'topics',
    'images',
    'youtubeUrl',
    'seriesId',
  ];
  const editable: Record<string, unknown> = {};
  if (action === 'update') {
    for (const [field, value] of Object.entries(patch)) {
      if (!allowed.includes(field)) continue;
      if (['title', 'subtitle', 'description', 'dateString', 'youtubeUrl', 'seriesId'].includes(field)) {
        if (value === null && ['youtubeUrl', 'seriesId'].includes(field)) {
          editable[field] = null;
          continue;
        }
        if (typeof value !== 'string' || value.length > 50000)
          throw new HttpsError('invalid-argument', `Invalid ${field}.`);
      } else if (['dateMillis', 'sourceStartTime', 'trimDurationSeconds', 'durationSeconds'].includes(field)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
          throw new HttpsError('invalid-argument', `Invalid ${field}.`);
      } else if (!Array.isArray(value) || value.length > 100)
        throw new HttpsError('invalid-argument', `Invalid ${field}.`);
      editable[field] = value;
    }
  }
  const selectedSeries = input.payload.seriesId !== undefined ? input.payload.seriesId : nestedDestinations.seriesId;
  if (
    action === 'update' &&
    input.payload.seriesId !== undefined &&
    nestedDestinations.seriesId !== undefined &&
    input.payload.seriesId !== nestedDestinations.seriesId
  )
    throw new HttpsError('invalid-argument', 'Conflicting series selections.');
  if (
    action === 'update' &&
    selectedSeries !== undefined &&
    editable.seriesId !== undefined &&
    selectedSeries !== editable.seriesId
  )
    throw new HttpsError('invalid-argument', 'Series selection does not match the edited sermon.');
  if (action === 'update' && selectedSeries !== undefined) editable.seriesId = selectedSeries;
  const processAudio = record(input.payload.processAudio);
  if (
    input.payload.processAudio !== undefined &&
    canonicalEntity.soundCloudTrackId &&
    !['recreate_track', 'keep_existing_audio'].includes(String(processAudio.soundcloudPolicy))
  )
    throw new HttpsError('invalid-argument', 'Choose how to handle the existing SoundCloud track when changing audio.');
  if (
    input.payload.processAudio !== undefined &&
    (action !== 'update' ||
      typeof processAudio.startTime !== 'number' ||
      !Number.isFinite(processAudio.startTime) ||
      processAudio.startTime < 0 ||
      typeof processAudio.duration !== 'number' ||
      !Number.isFinite(processAudio.duration) ||
      processAudio.duration <= 0)
  )
    throw new HttpsError('invalid-argument', 'Audio processing range is invalid.');
  return {
    sermonId: canonicalEntity.id,
    action,
    generation: input.generation,
    actorUid: actor.uid,
    destinations,
    payload: {
      // Firestore serialization deliberately omits undefined optional properties.
      allocationSource: capturePublishingAllocationSource(canonicalEntity as unknown as Record<string, unknown>),
      sermon: JSON.parse(JSON.stringify({ ...canonicalEntity, ...editable })),
      ...(action === 'update'
        ? {
            patch: editable,
            hasMembershipSelection:
              input.payload.listIds !== undefined ||
              nestedDestinations.listIds !== undefined ||
              selectedSeries !== undefined ||
              editable.seriesId !== undefined,
            desiredSeriesId:
              selectedSeries !== undefined
                ? selectedSeries
                : editable.seriesId !== undefined
                ? editable.seriesId
                : canonicalEntity.seriesId ?? null,
          }
        : {}),
      ...(input.payload.processAudio !== undefined
        ? {
            processAudio: {
              startTime: processAudio.startTime,
              duration: processAudio.duration,
              ...(processAudio.soundcloudPolicy ? { soundcloudPolicy: processAudio.soundcloudPolicy } : {}),
            },
          }
        : {}),
      audioStoragePath: canonicalEntity.audioArtifacts?.finalPath ?? `intro-outro-sermons/${canonicalEntity.id}`,
      removals,
    },
  };
}

/** Hydrates media references from Admin Firestore; URLs and provider IDs from clients are discarded. */
export async function normalizeCanonicalPublishingPatch(options: {
  patch: Record<string, unknown>;
  firestore: import('firebase-admin/firestore').Firestore;
}): Promise<Record<string, unknown>> {
  const { patch, firestore } = options;
  const normalized: Record<string, unknown> = { ...patch };
  for (const field of ['speakers', 'images'] as const) {
    if (patch[field] === undefined) continue;
    const values = patch[field];
    const limit = field === 'speakers' ? 3 : 20;
    if (!Array.isArray(values) || values.length > limit)
      throw new HttpsError('invalid-argument', `At most ${limit} ${field} can be selected.`);
    const selected = values.map((value) => {
      const valueObject = record(value);
      const selectedId = valueObject.id;
      if (typeof selectedId !== 'string' || !selectedId.trim() || selectedId.includes('/') || selectedId.length > 200)
        throw new HttpsError('invalid-argument', `${field} require canonical IDs.`);
      return selectedId;
    });
    if (new Set(selected).size !== selected.length)
      throw new HttpsError('invalid-argument', `Duplicate ${field} are not allowed.`);
    const documents = selected.length
      ? await firestore.getAll(...selected.map((selectedId) => firestore.collection(field).doc(selectedId)))
      : [];
    normalized[field] = documents.map((document) => {
      if (!document.exists)
        throw new HttpsError(
          'failed-precondition',
          `A selected ${
            field === 'images' ? 'image' : 'speaker'
          } is unavailable. Wait for processing or select another.`
        );
      return JSON.parse(JSON.stringify({ ...document.data(), id: document.id }));
    });
  }
  if (
    patch.topics !== undefined &&
    (!Array.isArray(patch.topics) ||
      patch.topics.length > 10 ||
      patch.topics.some((topic) => typeof topic !== 'string' || !topic.trim() || topic.length > 200))
  )
    throw new HttpsError('invalid-argument', 'Topics must contain at most 10 names.');
  return normalized;
}
