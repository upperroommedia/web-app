import { createSermon } from '../types/Sermon';
import { sermonStatusType } from '../types/SermonTypes';
import { reconcileAdminSermonSearchResults } from './sermonSearchResults';

describe('reconcileAdminSermonSearchResults', () => {
  it('keeps a pending sermon visible until Algolia results have settled', () => {
    const pendingSermon = createSermon({
      id: 'sermon-pending',
      searchPending: true,
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [pendingSermon],
      pendingSermons: [pendingSermon],
      pendingSermonsServerConfirmed: true,
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
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set([deletedSermonHit.id]),
    });

    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.confirmedVisibleHitIds.size).toBe(0);
    expect(result.displayRows).toEqual([]);
  });

  it('removes a pending overlay once Firestore confirms the sermon no longer exists', () => {
    const deletedPendingSermon = createSermon({ id: 'deleted-pending', searchPending: true });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [deletedPendingSermon],
      pendingSermons: [deletedPendingSermon],
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set([deletedPendingSermon.id]),
    });

    expect(result.displayRows).toEqual([]);
  });

  it('hides Algolia hits until Firestore has confirmed the visible ids from the server', () => {
    const unresolvedSermonHit = createSermon({
      id: 'unresolved-sermon',
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [unresolvedSermonHit],
      pendingSermons: [],
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set(),
    });

    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.confirmedVisibleHitIds.size).toBe(0);
    expect(result.displayRows).toEqual([]);
  });

  it('does not label a completed sermon as processing from an unverified cached snapshot', () => {
    const cachedSermon = createSermon({
      id: 'cached-sermon',
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [cachedSermon],
      pendingSermons: [],
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: { [cachedSermon.id]: cachedSermon },
      resolvedLiveSermonIds: new Set(),
    });

    expect(result.visibleAlgoliaHits).toHaveLength(0);
    expect(result.confirmedVisibleHitIds.size).toBe(0);
    expect(result.displayRows).toEqual([]);
  });

  it('does not show an unverified cached pending overlay as an active upload', () => {
    const cachedPendingSermon = createSermon({
      id: 'cached-pending',
      searchPending: true,
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [],
      pendingSermons: [cachedPendingSermon],
      pendingSermonsServerConfirmed: false,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: {},
      resolvedLiveSermonIds: new Set(),
    });

    expect(result.displayRows).toEqual([]);
  });

  it('uses a server-confirmed processed sermon over an older processing overlay', () => {
    const cachedProcessingSermon = createSermon({
      id: 'sermon-finished',
      editedAtMillis: 200,
      searchPending: true,
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSING,
      },
    });
    const liveProcessedSermon = createSermon({
      id: 'sermon-finished',
      editedAtMillis: 100,
      status: {
        ...createSermon().status,
        audioStatus: sermonStatusType.PROCESSED,
      },
    });

    const result = reconcileAdminSermonSearchResults({
      algoliaHits: [cachedProcessingSermon],
      pendingSermons: [cachedProcessingSermon],
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: { [liveProcessedSermon.id]: liveProcessedSermon },
      resolvedLiveSermonIds: new Set([liveProcessedSermon.id]),
    });

    expect(result.displayRows).toEqual([{ sermon: liveProcessedSermon, enableProcessingProgress: false }]);
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
      pendingSermonsServerConfirmed: true,
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
      pendingSermonsServerConfirmed: true,
      showPendingOverlay: true,
      hasSettledResults: true,
      liveSermonsById: { [pendingSermon.id]: pendingSermon },
      resolvedLiveSermonIds: new Set([pendingSermon.id]),
    });

    expect(result.displayRows.map((row) => row.sermon.id)).toEqual([pendingSermon.id]);
    expect(result.visiblePendingSermons.map((sermon) => sermon.id)).toEqual([pendingSermon.id]);
    expect(result.visibleAlgoliaHits).toHaveLength(0);
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
      pendingSermonsServerConfirmed: true,
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
