import { createSermon } from '../types/Sermon';
import { sermonStatusType } from '../types/SermonTypes';
import {
  reconcileAdminSermonSearchResults,
} from './sermonSearchResults';

describe('reconcileAdminSermonSearchResults', () => {
  it('keeps a pending sermon visible until Algolia results have settled', () => {
    const pendingSermon = createSermon({
      id: 'sermon-pending',
      searchPending: true,
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [pendingSermon],
      pendingSermons: [pendingSermon],
      showPendingOverlay: true,
      hasSettledResults: false,
      liveSermonsById: { [pendingSermon.id]: pendingSermon },
      resolvedLiveSermonIds: new Set([pendingSermon.id]),
    });

    expect(result.visiblePendingSermons.map((sermon) => sermon.id)).toEqual([pendingSermon.id]);
    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.displayRows).toEqual([
      {
        sermon: pendingSermon,
        enableProcessingProgress: false,
      },
    ]);
  });

  it('removes stale Algolia hits once Firestore confirms the sermon no longer exists', () => {
    const deletedSermonHit = createSermon({
      id: 'deleted-sermon',
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [deletedSermonHit],
      pendingSermons: [],
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set([deletedSermonHit.id]),
    });

    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.confirmedVisibleHitIds.size).toBe(0);
    expect(result.displayRows).toEqual([]);
  });

  it('builds a single stable row list with pending sermons first and indexed sermons after', () => {
    const pendingSermon = createSermon({
      id: 'pending-sermon',
      searchPending: true,
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });
    const indexedSermon = createSermon({
      id: 'indexed-sermon',
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [pendingSermon, indexedSermon],
      pendingSermons: [pendingSermon],
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {
        [pendingSermon.id]: pendingSermon,
        [indexedSermon.id]: indexedSermon,
      },
      resolvedLiveSermonIds: new Set([pendingSermon.id, indexedSermon.id]),
    });

    expect(result.displayRows.map((row) => [row.sermon.id, row.enableProcessingProgress])).toEqual([
      [pendingSermon.id, true],
      [indexedSermon.id, false],
    ]);
  });

  it('keeps a pending Firestore sermon visible until Algolia has the latest version', () => {
    const pendingSermon = createSermon({
      id: 'sermon-stale-hit',
      searchPending: true,
      editedAtMillis: 200,
    });
    const staleAlgoliaHit = createSermon({
      id: 'sermon-stale-hit',
      editedAtMillis: 100,
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [staleAlgoliaHit],
      pendingSermons: [pendingSermon],
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: { [pendingSermon.id]: pendingSermon },
      resolvedLiveSermonIds: new Set([pendingSermon.id]),
    });

    expect(result.displayRows.map((row) => row.sermon.id)).toEqual([pendingSermon.id]);
    expect(result.visibleAlgoliaHits.map((sermon) => sermon.id)).toEqual([pendingSermon.id]);
  });

  it('does not duplicate a processing sermon once Algolia has the current version', () => {
    const processingSermon = createSermon({
      id: 'sermon-processing-current',
      searchPending: true,
      editedAtMillis: 200,
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [processingSermon],
      pendingSermons: [processingSermon],
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: { [processingSermon.id]: processingSermon },
      resolvedLiveSermonIds: new Set([processingSermon.id]),
    });

    expect(result.displayRows.map((row) => [row.sermon.id, row.enableProcessingProgress])).toEqual([
      [processingSermon.id, true],
    ]);
    expect(result.visiblePendingSermons).toHaveLength(0);
  });
});
