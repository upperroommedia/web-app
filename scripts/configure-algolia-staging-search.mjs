import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { STAGING_SEARCH_INSTANCES, stagingSearchSettingsPlan } from './algolia-staging-search-schema.mjs';

/** No client is constructed for a plan. Provider errors must never escape into receipts/logs. */
export async function configureStagingSearch({ projectId, appId, indexNames, apply = false, createClient, now = () => Date.now() }) {
  const updates = stagingSearchSettingsPlan({ projectId, appId, indexNames });
  const receipt = { projectId, appId, mode: apply ? 'apply' : 'dry-run', usersPolicy: 'empty-private', updates, tasks: [] };
  if (!apply) return receipt;
  if (typeof createClient !== 'function') throw new Error('An authorized settings client is required for apply');
  try {
    const client = await createClient();
    // Refuse to detach any unexpected replicas. In particular, old production count
    // replicas require a separately reviewed migration, never silent cleanup here.
    for (const row of STAGING_SEARCH_INSTANCES) {
      let existing;
      let exists = true;
      try { existing = await client.getSettings({ indexName: row.indexName }); }
      catch (error) {
        if (error?.status !== 404 && error?.statusCode !== 404) throw error;
        existing = {};
        exists = false;
      }
      if (exists && row.recordPolicy === 'empty-private') {
        const count = await client.searchSingleIndex({ indexName: row.indexName, searchParams: { query: '', hitsPerPage: 0, attributesToRetrieve: [] } });
        if (count.nbHits !== 0 || count.exhaustiveNbHits === false) throw new Error('Users index is not proven empty');
      }
      const desired = updates.find(update => update.indexName === row.indexName).indexSettings.replicas;
      if ((existing.replicas ?? []).some(name => !desired.includes(name))) throw new Error('Unexpected replicas require a separate migration');
    }
    for (const update of updates) {
      const indexSettings = Object.fromEntries(Object.entries(update.indexSettings).filter(([, value]) => value !== undefined));
      const response = await client.setSettings({ indexName: update.indexName, indexSettings });
      if (!Number.isSafeInteger(response.taskID) || response.taskID < 0) throw new Error('Missing settings task identity');
      await client.waitForTask({ indexName: update.indexName, taskID: response.taskID });
      receipt.tasks.push({ indexName: update.indexName, taskID: response.taskID, completed: true });
    }
    receipt.verifiedAt = new Date(now()).toISOString();
    return receipt;
  } catch {
    throw new Error('Staging Algolia settings failed; inspect target and task state without logging provider credentials');
  }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const allowed = new Set(['--project', '--app', '--indices', '--dry-run', '--apply']);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.has(arg) || Object.hasOwn(parsed, arg)) throw new Error('Unknown or duplicate settings argument');
    if (arg === '--apply' || arg === '--dry-run') parsed[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing settings argument value');
      parsed[arg] = value;
    }
  }
  if (parsed['--apply'] && parsed['--dry-run']) throw new Error('Choose either dry-run or apply');
  const receipt = await configureStagingSearch({
    projectId: parsed['--project'], appId: parsed['--app'], indexNames: parsed['--indices']?.split(','), apply: parsed['--apply'] === true,
    createClient: async () => {
      const key = env.ALGOLIA_ADMIN_API_KEY?.trim();
      if (!key) throw new Error('Missing private settings key');
      const require = createRequire(new URL('../function-kits/firestore-algolia-search/package.json', import.meta.url));
      const { algoliasearch } = require('algoliasearch');
      return algoliasearch(parsed['--app'], key);
    },
  });
  console.log(JSON.stringify(receipt, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Staging settings failed. Check explicit project/app/index arguments and authorized private settings credentials.'); process.exitCode = 1; });
}
