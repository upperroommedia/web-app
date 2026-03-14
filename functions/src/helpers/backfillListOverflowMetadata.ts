import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { GetListOverflowChainIssue } from '../../../packages/contracts/getListOverflowChain';
import {
  buildOverflowChainRepairPlan,
  getOverflowChainState,
  type OverflowChainRepairPlan,
  type OverflowChainRepairWrite,
} from './listOverflowChain';

type Firestore = FirebaseFirestore.Firestore;

type Args = {
  apply: boolean;
  dryRun: boolean;
  help: boolean;
  listId?: string;
  limit?: number;
};

export type BackfillChainResult = {
  requestedListId: string;
  rootListId: string;
  skipped: boolean;
  logicalCount: number;
  hasOverflowPages: boolean;
  issues: GetListOverflowChainIssue[];
  updates: OverflowChainRepairWrite[];
};

export type BackfillListOverflowMetadataResult = {
  mode: 'dry-run' | 'apply';
  chainsScanned: number;
  chainsPlanned: number;
  chainsUpdated: number;
  chainsSkipped: number;
  documentsPlanned: number;
  documentsUpdated: number;
  chains: BackfillChainResult[];
};

type RunOptions = {
  apply?: boolean;
  firestore?: Firestore;
  listId?: string;
  limit?: number;
  logger?: (message: string) => void;
  now?: number;
};

const print = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    apply: false,
    dryRun: false,
    help: false,
  };

  argv.forEach((arg) => {
    if (arg === '--apply') {
      args.apply = true;
      return;
    }

    if (arg === '--dry-run') {
      args.dryRun = true;
      return;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      return;
    }

    if (arg.startsWith('--list-id=')) {
      args.listId = arg.split('=')[1];
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
};

const printHelp = (): void => {
  print('Backfill list overflow metadata');
  print('');
  print('Usage:');
  print('  pnpm exec ts-node --transpile-only scripts/backfill-list-overflow-metadata.ts [options]');
  print('');
  print('Options:');
  print('  --dry-run               Preview repairs without writing (default)');
  print('  --apply                 Persist metadata repairs to Firestore');
  print('  --list-id=<id>          Limit repair scan to a single Firestore list document');
  print('  --limit=<number>        Limit number of list documents scanned');
  print('  --help, -h              Show this help');
};

const getCandidateListIds = async (
  firestore: Firestore,
  options: Pick<RunOptions, 'listId' | 'limit'>
): Promise<string[]> => {
  if (options.listId) {
    const singleDoc = await firestore.collection('lists').doc(options.listId).get();
    return singleDoc.exists ? [singleDoc.id] : [];
  }

  let query: FirebaseFirestore.Query = firestore.collection('lists');
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => doc.id).sort();
};

const formatIssue = (issue: GetListOverflowChainIssue): string => {
  const parts = [`[${issue.severity}]`, issue.code, issue.message];
  if (issue.firestoreListId) {
    parts.push(`firestore=${issue.firestoreListId}`);
  }
  if (issue.subsplashListId) {
    parts.push(`subsplash=${issue.subsplashListId}`);
  }
  return parts.join(' | ');
};

const applyRepairPlan = async (
  firestore: Firestore,
  repairPlan: OverflowChainRepairPlan
): Promise<void> => {
  const batch = firestore.batch();
  repairPlan.updates.forEach((update) => {
    batch.set(firestore.collection('lists').doc(update.firestoreListId), update.data, { merge: true });
  });
  await batch.commit();
};

export const runListOverflowMetadataBackfill = async (
  options: RunOptions = {}
): Promise<BackfillListOverflowMetadataResult> => {
  const firestore = options.firestore ?? firebaseAdmin.firestore();
  const logger = options.logger ?? print;
  const mode = options.apply ? 'apply' : 'dry-run';
  const candidateListIds = await getCandidateListIds(firestore, options);
  const processedRoots = new Set<string>();
  const chains: BackfillChainResult[] = [];

  let chainsScanned = 0;
  let chainsPlanned = 0;
  let chainsUpdated = 0;
  let chainsSkipped = 0;
  let documentsPlanned = 0;
  let documentsUpdated = 0;

  logger(`Mode: ${mode.toUpperCase()}`);
  logger(`List documents scanned: ${candidateListIds.length}`);

  for (const listId of candidateListIds) {
    const chainState = await getOverflowChainState(listId);
    if (processedRoots.has(chainState.rootListId)) {
      continue;
    }

    processedRoots.add(chainState.rootListId);
    chainsScanned += 1;

    const repairPlan = buildOverflowChainRepairPlan(chainState, {
      now: options.now,
    });
    const chainResult: BackfillChainResult = {
      requestedListId: listId,
      rootListId: repairPlan.rootListId,
      skipped: !repairPlan.canApply,
      logicalCount: repairPlan.logicalCount,
      hasOverflowPages: repairPlan.hasOverflowPages,
      issues: repairPlan.issues,
      updates: repairPlan.updates,
    };
    chains.push(chainResult);

    if (!repairPlan.canApply) {
      chainsSkipped += 1;
      logger(`SKIP ${repairPlan.rootListId}: blocking chain issues prevent safe repair.`);
      repairPlan.issues.forEach((issue) => logger(`  - ${formatIssue(issue)}`));
      continue;
    }

    chainsPlanned += 1;
    documentsPlanned += repairPlan.updates.length;

    logger(
      `${mode === 'apply' ? 'APPLY' : 'PLAN'} ${repairPlan.rootListId}: ${repairPlan.updates.length} metadata update(s), logicalCount=${repairPlan.logicalCount}`
    );

    repairPlan.updates.forEach((update) => {
      logger(`  - ${update.firestoreListId}: ${JSON.stringify(update.data)}`);
    });

    if (!options.apply) {
      continue;
    }

    await applyRepairPlan(firestore, repairPlan);
    chainsUpdated += 1;
    documentsUpdated += repairPlan.updates.length;
  }

  logger(
    `Summary: ${chainsScanned} chain(s) scanned, ${chainsPlanned} repairable, ${chainsUpdated} updated, ${chainsSkipped} skipped.`
  );

  return {
    mode,
    chainsScanned,
    chainsPlanned,
    chainsUpdated,
    chainsSkipped,
    documentsPlanned,
    documentsUpdated,
    chains,
  };
};

export const runListOverflowMetadataBackfillCli = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  await runListOverflowMetadataBackfill({
    apply: args.apply && !args.dryRun,
    listId: args.listId,
    limit: args.limit,
  });
};

if (require.main === module) {
  runListOverflowMetadataBackfillCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
