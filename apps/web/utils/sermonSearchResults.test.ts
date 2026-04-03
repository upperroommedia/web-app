import { createSermon } from '../types/Sermon';
import { sermonStatusType } from '../types/SermonTypes';
import {
  getPendingSermonsReadyForAcknowledgement,
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
      liveHitHydrationSettled: false,
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
      liveHitHydrationSettled: true,
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
      liveHitHydrationSettled: true,
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

  it('suppresses Algolia rows until live hydration settles on the default first page', () => {
    const indexedSermon = createSermon({
      id: 'indexed-sermon',
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [indexedSermon],
      pendingSermons: [],
      showPendingOverlay: true,
      liveHitHydrationSettled: false,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set<string>(),
    });

    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.displayRows).toEqual([]);
  });

  it('keeps processing progress enabled for processing sermons rendered from Algolia hits', () => {
    const processingSermon = createSermon({
      id: 'processing-sermon',
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [processingSermon],
      pendingSermons: [],
      showPendingOverlay: false,
      liveHitHydrationSettled: true,
      hasSettledResults: true,
      liveSermonsById: {
        [processingSermon.id]: processingSermon,
      },
      resolvedLiveSermonIds: new Set([processingSermon.id]),
    });

    expect(result.displayRows).toEqual([
      {
        sermon: processingSermon,
        enableProcessingProgress: true,
      },
    ]);
  });
});

describe('getPendingSermonsReadyForAcknowledgement', () => {
  it('waits for settled Algolia results before clearing searchPending', () => {
    const sermon = createSermon({
      id: 'sermon-1',
      searchPending: true,
    });

    const notReady = getPendingSermonsReadyForAcknowledgement({
      pendingSermons: [sermon],
      hasSettledResults: false,
      confirmedVisibleHitIds: new Set([sermon.id]),
    });

    expect(notReady).toHaveLength(0);
  });

  it('skips processing sermons until they are no longer processing', () => {
    const baseStatus = createSermon().status;
    const processingSermon = createSermon({
      id: 'sermon-processing',
      searchPending: true,
      status: {
        soundCloud: baseStatus.soundCloud,
        subsplash: baseStatus.subsplash,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });

    const ready = getPendingSermonsReadyForAcknowledgement({
      pendingSermons: [processingSermon],
      hasSettledResults: true,
      confirmedVisibleHitIds: new Set([processingSermon.id]),
    });

    expect(ready).toHaveLength(0);
  });
});
