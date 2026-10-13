import type { DurableAdmissionReceipt } from '@upperroom/contracts/temporal';
import type { Sermon } from '../types/SermonTypes';
import { uploadStatus } from '../types/SermonTypes';
import type { List } from '../types/List';
import { submitDurableIntent } from './durableJobs';

export interface EditSermonOptions {
  originalSermon?: Sermon;
  processAudio?: { startTime: number; duration: number; soundcloudPolicy?: 'recreate_track' | 'keep_existing_audio' };
}

/** Editable values only: remote IDs, provider status, dates and counters remain server-owned. */
export function editableSermonIntent(sermon: Sermon): Record<string, unknown> {
  return {
    title: sermon.title,
    subtitle: sermon.subtitle,
    description: sermon.description,
    dateMillis: sermon.dateMillis,
    ...(sermon.dateString ? { dateString: sermon.dateString } : {}),
    sourceStartTime: sermon.sourceStartTime,
    ...(sermon.trimDurationSeconds === undefined ? {} : { trimDurationSeconds: sermon.trimDurationSeconds }),
    durationSeconds: sermon.durationSeconds,
    speakers: sermon.speakers,
    topics: sermon.topics,
    images: sermon.images,
    youtubeUrl: sermon.youtubeUrl ?? null,
    seriesId: sermon.seriesId ?? null,
  };
}

export default async function editSermon(
  sermon: Sermon,
  sermonList: List[],
  options: EditSermonOptions = {}
): Promise<DurableAdmissionReceipt> {
  const original = options.originalSermon ?? sermon;
  return submitDurableIntent({
    kind: 'sermon.update',
    entity: { type: 'sermon', id: sermon.id },
    payload: {
      patch: editableSermonIntent(sermon),
      expectedEditedAtMillis: original.editedAtMillis,
      destinations: {
        listIds: sermonList.map((list) => list.id),
        ...(sermon.seriesId ? { seriesId: sermon.seriesId } : {}),
        soundcloud: original.status.soundCloud === uploadStatus.UPLOADED,
      },
      ...(options.processAudio ? { processAudio: options.processAudio } : {}),
    },
  });
}
