import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { Timestamp } from 'firebase-admin/firestore';
import { uploadStatus, sermonStatusType, Sermon } from '../../../types/SermonTypes';

describe('firestoreAdminSermonConverter', () => {
  const baseSermon: Sermon = {
    id: 'sermon-1',
    title: 'Sermon Title',
    subtitle: 'Subtitle',
    description: 'Description',
    dateMillis: 1700000000000,
    sourceStartTime: 0,
    durationSeconds: 1200,
    speakers: [],
    topics: [],
    status: {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PENDING,
    },
    images: [],
    createdAtMillis: 1700000000000,
    editedAtMillis: 1700000000000,
  };

  it('toFirestore writes admin Timestamp from dateMillis', () => {
    const converted = firestoreAdminSermonConverter.toFirestore(baseSermon);
    expect(converted.date).toBeInstanceOf(Timestamp);
    expect(converted.date.toMillis()).toBe(baseSermon.dateMillis);
  });

  it('fromFirestore restores date fields and preserves data', () => {
    const snapshot = {
      id: 'sermon-1',
      data: () =>
        ({
          ...baseSermon,
          date: Timestamp.fromMillis(baseSermon.dateMillis),
        }) as unknown as ReturnType<typeof firestoreAdminSermonConverter.toFirestore>,
    } as unknown as Parameters<typeof firestoreAdminSermonConverter.fromFirestore>[0];

    const converted = firestoreAdminSermonConverter.fromFirestore(snapshot);
    expect(converted.id).toBe('sermon-1');
    expect(converted.title).toBe(baseSermon.title);
    expect(converted.dateMillis).toBe(baseSermon.dateMillis);
    expect(converted.dateString).toBeDefined();
    expect(converted.status.audioStatus).toBe(sermonStatusType.PENDING);
  });
});
