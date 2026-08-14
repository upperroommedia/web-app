import {
  chunkSeriesItemPositionUpdates,
  planCompactedSeriesItemPositions,
} from './compactSeriesItemPositions';

describe('planCompactedSeriesItemPositions', () => {
  it('preserves relative order while closing gaps after a removal', () => {
    expect(
      planCompactedSeriesItemPositions([
        { id: 'part-1', position: 1 },
        { id: 'part-3', position: 3 },
        { id: 'part-4', position: 4 },
      ])
    ).toEqual([
      { id: 'part-3', position: 2 },
      { id: 'part-4', position: 3 },
    ]);
  });

  it('plans no writes for an already-contiguous order', () => {
    expect(
      planCompactedSeriesItemPositions([
        { id: 'part-1', position: 1 },
        { id: 'part-2', position: 2 },
      ])
    ).toEqual([]);
  });

  it('chunks more than 500 shifted items into safe Firestore batches', () => {
    const updates = Array.from({ length: 999 }, (_, index) => index + 1);

    expect(chunkSeriesItemPositionUpdates(updates).map((chunk) => chunk.length)).toEqual([
      400,
      400,
      199,
    ]);
  });
});
