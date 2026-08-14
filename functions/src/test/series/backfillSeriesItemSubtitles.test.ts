import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { clearFirestore, createSeriesDocument } from './firestoreHelpers';
import {
  parseSeriesItemSubtitleBackfillArgs,
  runSeriesItemSubtitleBackfill,
} from '../../helpers/backfillSeriesItemSubtitles';

describe('series item subtitle backfill', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('rejects malformed or unknown CLI flags instead of broadening apply scope', () => {
    expect(() => parseSeriesItemSubtitleBackfillArgs(['--apply', '--series-id='])).toThrow(
      '--series-id'
    );
    expect(() => parseSeriesItemSubtitleBackfillArgs(['--limit=nope'])).toThrow('--limit');
    expect(() => parseSeriesItemSubtitleBackfillArgs(['--everything'])).toThrow('Unknown option');
  });

  it('dry-runs every linked series and reports only remote subtitle mismatches', async () => {
    await createSeriesDocument({ subsplashId: 'remote-sowing-seeds', name: 'Stale Local Name' });
    await createSeriesDocument({ subsplashId: '', name: 'Local-only Series' });
    const sync = jest.fn();

    const result = await runSeriesItemSubtitleBackfill({
      firestore: firebaseAdmin.firestore(),
      getAccessToken: async () => 'token',
      getSeriesDetails: async () => ({ title: 'Sowing Seeds' }),
      getSeriesItems: async () => [
        { id: 'part-2', position: 2, subtitle: null },
        { id: 'part-1', position: 1, subtitle: 'Part 1 of Sowing Seeds' },
      ],
      sync,
    });

    expect(result).toMatchObject({
      mode: 'dry-run',
      seriesScanned: 2,
      linkedSeriesScanned: 1,
      unlinkedSeriesSkipped: 1,
      mediaItemsInspected: 2,
      mismatchesFound: 1,
      mediaItemsUpdated: 0,
      errors: [],
    });
    expect(sync).not.toHaveBeenCalled();
  });

  it('applies mismatches and skips an already-correct rerun', async () => {
    await createSeriesDocument({ subsplashId: 'remote-sowing-seeds', name: 'Sowing Seeds' });
    const sync = jest.fn().mockResolvedValue({ inspected: 2, updated: 1 });
    const baseOptions = {
      firestore: firebaseAdmin.firestore(),
      getAccessToken: async () => 'token',
      getSeriesDetails: async () => ({ title: 'Sowing Seeds' }),
      sync,
    };

    const applied = await runSeriesItemSubtitleBackfill({
      ...baseOptions,
      apply: true,
      getSeriesItems: async () => [
        { id: 'part-2', position: 2, subtitle: null },
        { id: 'part-1', position: 1, subtitle: 'Part 1 of Sowing Seeds' },
      ],
    });

    expect(applied.mediaItemsUpdated).toBe(1);
    expect(sync).toHaveBeenCalledTimes(1);

    sync.mockClear();
    const rerun = await runSeriesItemSubtitleBackfill({
      ...baseOptions,
      apply: true,
      getSeriesItems: async () => [
        { id: 'part-2', position: 2, subtitle: 'Part 2 of Sowing Seeds' },
        { id: 'part-1', position: 1, subtitle: 'Part 1 of Sowing Seeds' },
      ],
    });

    expect(rerun.mismatchesFound).toBe(0);
    expect(rerun.mediaItemsUpdated).toBe(0);
    expect(sync).not.toHaveBeenCalled();
  });
});
