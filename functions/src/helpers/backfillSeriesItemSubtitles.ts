import type { firestore as FirebaseAdminFirestore } from 'firebase-admin';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { authenticateSubsplash } from '../subsplashUtils';
import { getAllSeriesItemsAcrossStatuses, getSeriesDetails } from './seriesHelpers';
import {
  planSeriesItemSubtitleUpdates,
  syncSeriesItemSubtitles,
  type SeriesItemSubtitleSource,
  type SyncSeriesItemSubtitlesResult,
} from './seriesItemSubtitles';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';

type Firestore = FirebaseAdminFirestore.Firestore;

export interface SeriesItemSubtitleBackfillResult {
  mode: 'dry-run' | 'apply';
  seriesScanned: number;
  linkedSeriesScanned: number;
  unlinkedSeriesSkipped: number;
  mediaItemsInspected: number;
  mismatchesFound: number;
  mediaItemsUpdated: number;
  errors: Array<{ firestoreSeriesId: string; message: string }>;
}

export interface RunSeriesItemSubtitleBackfillOptions {
  apply?: boolean;
  firestore?: Firestore;
  firestoreSeriesId?: string;
  limit?: number;
  logger?: (message: string) => void;
  getAccessToken?: () => Promise<string>;
  getSeriesDetails?: (seriesId: string, token: string) => Promise<{ title: string }>;
  getSeriesItems?: (seriesId: string, token: string) => Promise<SeriesItemSubtitleSource[]>;
  sync?: (
    seriesId: string,
    seriesTitle: string,
    items: SeriesItemSubtitleSource[],
    token: string
  ) => Promise<SyncSeriesItemSubtitlesResult>;
}

const print = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

export async function runSeriesItemSubtitleBackfill(
  options: RunSeriesItemSubtitleBackfillOptions = {}
): Promise<SeriesItemSubtitleBackfillResult> {
  const firestore = options.firestore ?? firebaseAdmin.firestore();
  const logger = options.logger ?? print;
  const getAccessToken = options.getAccessToken ?? authenticateSubsplash;
  const readSeriesDetails = options.getSeriesDetails ?? getSeriesDetails;
  const readSeriesItems = options.getSeriesItems ?? getAllSeriesItemsAcrossStatuses;
  const sync = options.sync ?? syncSeriesItemSubtitles;
  const mode = options.apply ? 'apply' : 'dry-run';

  let documents: FirebaseAdminFirestore.QueryDocumentSnapshot[];
  if (options.firestoreSeriesId) {
    const document = await firestore.collection('series').doc(options.firestoreSeriesId).get();
    documents = document.exists ? [document as FirebaseAdminFirestore.QueryDocumentSnapshot] : [];
  } else {
    let query: FirebaseAdminFirestore.Query = firestore.collection('series');
    if (options.limit) {
      query = query.limit(options.limit);
    }
    documents = (await query.get()).docs;
  }

  const result: SeriesItemSubtitleBackfillResult = {
    mode,
    seriesScanned: documents.length,
    linkedSeriesScanned: 0,
    unlinkedSeriesSkipped: 0,
    mediaItemsInspected: 0,
    mismatchesFound: 0,
    mediaItemsUpdated: 0,
    errors: [],
  };
  let tokenPromise: Promise<string> | undefined;

  logger(`Mode: ${mode.toUpperCase()}`);
  logger(`Series documents scanned: ${documents.length}`);

  for (const document of documents) {
    const seriesData = document.data() as { subsplashId?: string | null };
    const seriesId = seriesData.subsplashId?.trim();
    if (!seriesId) {
      result.unlinkedSeriesSkipped += 1;
      continue;
    }

    result.linkedSeriesScanned += 1;
    try {
      tokenPromise ??= getAccessToken();
      const token = await tokenPromise;
      const [remoteSeries, items] = await Promise.all([
        readSeriesDetails(seriesId, token),
        readSeriesItems(seriesId, token),
      ]);
      const updates = planSeriesItemSubtitleUpdates(remoteSeries.title, items);
      result.mediaItemsInspected += items.length;
      result.mismatchesFound += updates.length;

      logger(
        `${mode === 'apply' ? 'APPLY' : 'PLAN'} ${document.id} (${remoteSeries.title}): ` +
          `${updates.length}/${items.length} subtitle update(s)`
      );

      if (!options.apply || updates.length === 0) {
        continue;
      }

      const syncResult = await withSubsplashLocks(
        [`series:${seriesId}`, ...items.map((item) => `media-item:${item.id}`)],
        async () => {
          const [latestSeries, latestItems] = await Promise.all([
            readSeriesDetails(seriesId, token),
            readSeriesItems(seriesId, token),
          ]);
          if (planSeriesItemSubtitleUpdates(latestSeries.title, latestItems).length === 0) {
            return { inspected: latestItems.length, updated: 0 };
          }
          return sync(seriesId, latestSeries.title, latestItems, token);
        },
        { operationKey: `backfill-series-item-subtitles:${document.id}` }
      );
      result.mediaItemsUpdated += syncResult.updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ firestoreSeriesId: document.id, message });
      logger(`ERROR ${document.id}: ${message}`);
    }
  }

  logger(
    `Summary: ${result.linkedSeriesScanned} linked series, ${result.mediaItemsInspected} media items, ` +
      `${result.mismatchesFound} mismatch(es), ${result.mediaItemsUpdated} updated, ${result.errors.length} error(s).`
  );

  return result;
}

interface CliArgs {
  apply: boolean;
  firestoreSeriesId?: string;
  limit?: number;
  help: boolean;
}

export function parseSeriesItemSubtitleBackfillArgs(argv: string[]): CliArgs {
  const result: CliArgs = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg.startsWith('--series-id=')) {
      const firestoreSeriesId = arg.slice('--series-id='.length).trim();
      if (!firestoreSeriesId) {
        throw new Error('--series-id must contain a Firestore series ID.');
      }
      result.firestoreSeriesId = firestoreSeriesId;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const limit = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer.');
      }
      result.limit = limit;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

export async function runSeriesItemSubtitleBackfillCli(): Promise<void> {
  const args = parseSeriesItemSubtitleBackfillArgs(process.argv.slice(2));
  if (args.help) {
    print('Backfill Subsplash series item subtitles (dry-run by default)');
    print('Usage: pnpm backfill:series-item-subtitles [--apply] [--series-id=<id>] [--limit=<n>]');
    return;
  }

  const result = await runSeriesItemSubtitleBackfill(args);
  if (result.errors.length > 0) {
    throw new Error(`Backfill completed with ${result.errors.length} error(s).`);
  }
}

if (require.main === module) {
  runSeriesItemSubtitleBackfillCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
