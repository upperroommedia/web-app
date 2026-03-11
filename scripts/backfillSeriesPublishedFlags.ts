/**
 * Backfill script for strict series published flags.
 *
 * Default mode is dry-run:
 *   npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts
 *
 * Apply mode:
 *   npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts --apply
 *
 * Optional scope:
 *   --series-id=<firestoreSeriesId>
 *   --limit=<number>
 */

import axios from 'axios';
import * as admin from 'firebase-admin';
import FormData from 'form-data';

const APP_KEY = '9XTSHD';
const PAGE_SIZE = 200;
const BATCH_SIZE = 400;

type SeriesStatus = 'published' | 'draft' | 'scheduled';

interface Args {
  apply: boolean;
  seriesId?: string;
  limit?: number;
  help: boolean;
}

interface BackfillCounters {
  seriesScanned: number;
  seriesWithSubsplashId: number;
  seriesWithoutSubsplashId: number;
  itemDocsScanned: number;
  mismatchesFound: number;
  recordsUpdated: number;
  errors: number;
}

interface SeriesItemData {
  publishedToSubsplash?: boolean | null;
  sermonSubsplashId?: string | null;
}

const print = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    help: false,
  };

  argv.forEach((arg) => {
    if (arg === '--apply') {
      args.apply = true;
      return;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      return;
    }
    if (arg.startsWith('--series-id=')) {
      args.seriesId = arg.split('=')[1];
      return;
    }
    if (arg.startsWith('--limit=')) {
      const limit = Number(arg.split('=')[1]);
      if (Number.isFinite(limit) && limit > 0) {
        args.limit = limit;
      }
    }
  });

  return args;
}

function printHelp(): void {
  print('Backfill series published flags');
  print('');
  print('Usage:');
  print('  npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts [options]');
  print('');
  print('Options:');
  print('  --apply                 Persist changes to Firestore (default is dry-run)');
  print('  --series-id=<id>        Limit to a single Firestore series document');
  print('  --limit=<number>        Limit number of series processed');
  print('  --help, -h              Show this help');
  print('');
  print('Required env vars for Subsplash auth: SUBSPLASH_EMAIL, SUBSPLASH_PASSWORD');
}

async function authenticateSubsplash(): Promise<string> {
  const email = process.env.SUBSPLASH_EMAIL;
  const password = process.env.SUBSPLASH_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing SUBSPLASH_EMAIL or SUBSPLASH_PASSWORD environment variable for Subsplash authentication.');
  }

  const formData = new FormData();
  formData.append('grant_type', 'password');
  formData.append('scope', `app:${APP_KEY}`);
  formData.append('email', email);
  formData.append('password', password);

  const response = await axios({
    method: 'post',
    url: 'https://core.subsplash.com/accounts/v1/oauth/token',
    headers: {
      ...formData.getHeaders(),
    },
    data: formData,
  });

  return response.data.access_token as string;
}

async function getSubsplashSeriesMembership(
  seriesSubsplashId: string,
  accessToken: string
): Promise<Set<string>> {
  const mediaItemIds = new Set<string>();
  const statuses: SeriesStatus[] = ['published', 'draft', 'scheduled'];

  await Promise.all(statuses.map(async (status) => {
    const response = await axios({
      method: 'get',
      url: `https://core.subsplash.com/media/v1/media-items?filter[app_key]=${APP_KEY}&filter[media_series]=${seriesSubsplashId}&filter[status]=${status}&filter[unlisted]=include&page[size]=${PAGE_SIZE}&sort=-position`,
      headers: {
        'Cache-Control': 'no-cache',
        Authority: 'core.subsplash.com',
        Origin: 'https://dashboard.subsplash.com',
        Referer: 'https://dashboard.subsplash.com/',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const items = (response.data?._embedded?.['media-items'] || []) as Array<{ id?: string }>;
    items.forEach((item) => {
      if (item.id) {
        mediaItemIds.add(item.id);
      }
    });
  }));

  return mediaItemIds;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const firestore = admin.firestore();
  const token = await authenticateSubsplash();

  const counters: BackfillCounters = {
    seriesScanned: 0,
    seriesWithSubsplashId: 0,
    seriesWithoutSubsplashId: 0,
    itemDocsScanned: 0,
    mismatchesFound: 0,
    recordsUpdated: 0,
    errors: 0,
  };

  const changePreview: Array<{
    seriesId: string;
    seriesItemId: string;
    previousPublished: boolean;
    nextPublished: boolean;
    seriesSubsplashId: string | null;
    sermonSubsplashId: string | null;
  }> = [];

  let seriesDocs: admin.firestore.QueryDocumentSnapshot[];
  if (args.seriesId) {
    const singleSeriesDoc = await firestore.collection('series').doc(args.seriesId).get();
    seriesDocs = singleSeriesDoc.exists ? [singleSeriesDoc as admin.firestore.QueryDocumentSnapshot] : [];
  } else {
    let seriesQuery: admin.firestore.Query = firestore.collection('series');
    if (args.limit) {
      seriesQuery = seriesQuery.limit(args.limit);
    }
    const snapshot = await seriesQuery.get();
    seriesDocs = snapshot.docs;
  }

  print(`Mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  print(`Series to scan: ${seriesDocs.length}`);

  let batch = firestore.batch();
  let batchedWrites = 0;

  for (const seriesDoc of seriesDocs) {
    counters.seriesScanned += 1;
    const seriesId = seriesDoc.id;
    const seriesData = seriesDoc.data() as { subsplashId?: string | null; name?: string };
    const seriesSubsplashId = seriesData.subsplashId || null;

    try {
      const seriesItemSnapshot = await firestore.collection(`series/${seriesId}/seriesItems`).get();
      counters.itemDocsScanned += seriesItemSnapshot.size;

      let membershipIds = new Set<string>();
      if (seriesSubsplashId) {
        counters.seriesWithSubsplashId += 1;
        membershipIds = await getSubsplashSeriesMembership(seriesSubsplashId, token);
      } else {
        counters.seriesWithoutSubsplashId += 1;
      }

      for (const itemDoc of seriesItemSnapshot.docs) {
        const itemData = itemDoc.data() as SeriesItemData;
        const currentPublished = itemData.publishedToSubsplash === true;
        const sermonSubsplashId = itemData.sermonSubsplashId || null;
        const nextPublished = Boolean(seriesSubsplashId && sermonSubsplashId && membershipIds.has(sermonSubsplashId));

        if (currentPublished === nextPublished) {
          continue;
        }

        counters.mismatchesFound += 1;
        if (changePreview.length < 50) {
          changePreview.push({
            seriesId,
            seriesItemId: itemDoc.id,
            previousPublished: currentPublished,
            nextPublished,
            seriesSubsplashId,
            sermonSubsplashId,
          });
        }

        if (!args.apply) {
          continue;
        }

        batch.set(
          itemDoc.ref,
          {
            publishedToSubsplash: nextPublished,
          },
          { merge: true }
        );
        batchedWrites += 1;
        counters.recordsUpdated += 1;

        if (batchedWrites >= BATCH_SIZE) {
          await batch.commit();
          batch = firestore.batch();
          batchedWrites = 0;
        }
      }
    } catch (error: unknown) {
      counters.errors += 1;
      const errorMessage = error instanceof Error ? error.message : error;
      console.error(
        `Error processing series ${seriesId} (${seriesData.name || 'Unnamed Series'}):`,
        errorMessage
      );
    }
  }

  if (args.apply && batchedWrites > 0) {
    await batch.commit();
  }

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    counters,
    changePreviewCount: changePreview.length,
    preview: changePreview,
  };

  print('Backfill summary:');
  print(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error('Backfill failed:', error?.message || error);
  process.exit(1);
});
