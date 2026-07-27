import { getDateString, normalizeSermonDateMillis, sermonConverter } from '../types/Sermon';

const createSnapshot = (data: Record<string, unknown>) =>
  ({
    id: 'sermon-id',
    data: () => data,
  } as never);

describe('sermonConverter', () => {
  it('reads Firestore Timestamp values without replacing epoch millis', () => {
    const sermon = sermonConverter.fromFirestore(
      createSnapshot({
        title: 'Timestamp sermon',
        date: {
          toMillis: () => 0,
          toDate: () => new Date(0),
        },
      })
    );

    expect(sermon).toMatchObject({
      id: 'sermon-id',
      title: 'Timestamp sermon',
      dateMillis: 0,
      dateString: getDateString(new Date(0)),
    });
  });

  it('accepts plain timestamp-shaped date objects', () => {
    const sermon = sermonConverter.fromFirestore(
      createSnapshot({
        title: 'Plain timestamp sermon',
        date: {
          seconds: 1767225600,
          nanoseconds: 500_000_000,
        },
      })
    );

    expect(sermon.dateMillis).toBe(1767225600500);
    expect(sermon.dateString).toBe(getDateString(new Date(1767225600500)));
  });

  it('accepts serialized date strings from legacy or cached data', () => {
    const sermon = sermonConverter.fromFirestore(
      createSnapshot({
        title: 'Serialized date sermon',
        date: '2026-01-15T12:00:00.000Z',
      })
    );

    expect(sermon.dateMillis).toBe(Date.parse('2026-01-15T12:00:00.000Z'));
    expect(sermon.dateString).toBe(getDateString(new Date('2026-01-15T12:00:00.000Z')));
  });
});

describe('normalizeSermonDateMillis', () => {
  it('falls back for invalid date values instead of throwing', () => {
    expect(normalizeSermonDateMillis({ unexpected: 'shape' }, 1234)).toBe(1234);
    expect(normalizeSermonDateMillis(undefined, 1234)).toBe(1234);
    expect(normalizeSermonDateMillis(Number.NaN, 1234)).toBe(1234);
  });
});
