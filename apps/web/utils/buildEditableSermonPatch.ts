import { deleteField, Timestamp } from '../firebase/firestore';
import { getDateString } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';

/**
 * Build an explicit patch for editable sermon fields.
 * Counter fields are intentionally excluded so they remain listener-owned.
 */
export const buildEditableSermonPatch = (sermon: Sermon) => ({
  title: sermon.title,
  subtitle: sermon.subtitle,
  description: sermon.description,
  dateMillis: sermon.dateMillis,
  date: Timestamp.fromMillis(sermon.dateMillis),
  dateString: sermon.dateString ?? getDateString(new Date(sermon.dateMillis)),
  sourceStartTime: sermon.sourceStartTime,
  durationSeconds: sermon.durationSeconds,
  speakers: sermon.speakers,
  topics: sermon.topics,
  status: sermon.status,
  images: sermon.images,
  seriesId: sermon.seriesId ?? deleteField(),
  editedAtMillis: new Date().getTime(),
});
