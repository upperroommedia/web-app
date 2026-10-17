/** Complete readonly preservation inventory. No SDK initialization, queue mutation or cleanup entrypoint. */
import { readFileSync } from 'node:fs';
import { proofDigest, nativeSnapshotProof, assertNativeSnapshot } from './temporal-release-runtime.mjs';
const contract = JSON.parse(
  readFileSync(new URL('../ops/temporal/owned-smoke-search-preservation.staging.json', import.meta.url))
);
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('OWNED_SMOKE_' + code), { code: 'OWNED_SMOKE_' + code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b);
const fixedPaths = [
  ...contract.parents.flatMap((p) => [p.jobPath, p.intentPath, p.entityPath]),
  ...contract.historicalSearchJobPaths,
];
/** Native pins always describe current states. Historical sync jobs need not remain queued. */
export async function collectOwnedSearchPreservation({ db, tx, runtime }) {
  need(typeof runtime?.durableEntityKey === 'function', 'PRESERVATION_RUNTIME_REQUIRED');
  const documents = new Map();
  const remember = (s) => {
    need(s.exists, 'PRESERVED_SEARCH_DOCUMENT_MISSING');
    const row = { path: s.ref.path, native: nativeSnapshotProof(s) };
    need(!documents.has(row.path) || same(documents.get(row.path), row), 'PRESERVED_SEARCH_NATIVE_CHANGED');
    documents.set(row.path, row);
    return s.data();
  };
  const values = new Map();
  for (const path of fixedPaths) values.set(path, remember(await tx.get(db.doc(path))));
  for (const parent of contract.parents) {
    const job = values.get(parent.jobPath),
      intent = values.get(parent.intentPath),
      entity = values.get(parent.entityPath);
    need(
      job.projectId === contract.projectId &&
        intent.projectId === contract.projectId &&
        entity.projectId === contract.projectId &&
        job.jobId === parent.jobPath.split('/')[1] &&
        intent.jobId === job.jobId &&
        job.kind === 'search.backfill' &&
        intent.kind === job.kind &&
        parent.entityPath ===
          'durableJobEntities/' + runtime.durableEntityKey(contract.projectId, parent.entity, 'search.backfill') &&
        job.state === 'succeeded' &&
        job.generation === 2 &&
        intent.generation === 2 &&
        entity.generation === 2 &&
        entity.activeJobId === job.jobId &&
        same(job.entity, parent.entity) &&
        same(job.entity, intent.entity) &&
        same(job.entity, entity.entity),
      'ORIGINAL_GEN2_PARENT_CHANGED'
    );
  }
  for (const path of contract.historicalSearchJobPaths) {
    const value = values.get(path);
    need(
      value.projectId === contract.projectId && value.kind?.startsWith('search.') && typeof value.state === 'string',
      'HISTORICAL_SEARCH_IDENTITY_CHANGED'
    );
  }
  // Complete queued set is read in the same SDK transaction as all fixed documents. An extra
  // non-search queued job also stops maintenance instead of being silently filtered away.
  const queued = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; ; page++) {
    need(page < 20, 'QUEUED_SEARCH_PAGE_BOUND');
    let query = db.collection('durableJobs').where('state', '==', 'queued').orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const result = await tx.get(query);
    for (const doc of result.docs) {
      const value = remember(doc);
      need(
        !seen.has(doc.ref.path) &&
          value.projectId === contract.projectId &&
          value.kind?.startsWith('search.') &&
          value.state === 'queued',
        'QUEUED_SEARCH_SET_INVALID'
      );
      seen.add(doc.ref.path);
      queued.push(doc.ref.path);
    }
    if (result.docs.length < 100) break;
    cursor = result.docs.at(-1);
  }
  const protectedDocuments = [...documents.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    projectId: contract.projectId,
    contractDigest: proofDigest(contract),
    protectedDocuments,
    currentQueuedSearchPaths: queued.sort(),
    protectedDigest: proofDigest(protectedDocuments),
  };
}
export async function assertOwnedSearchPreservation({ db, tx, expected, runtime }) {
  need(
    expected?.schemaVersion === 1 &&
      expected.projectId === contract.projectId &&
      expected.contractDigest === proofDigest(contract),
    'PRESERVATION_CONTRACT_CHANGED'
  );
  const actual = await collectOwnedSearchPreservation({ db, tx, runtime });
  need(same(actual, expected), 'PRESERVED_SEARCH_SET_CHANGED');
  for (const row of expected.protectedDocuments) assertNativeSnapshot(row.native, await tx.get(db.doc(row.path)));
  return actual;
}
/** getJSON must be a GET-only authenticated adapter; no credentials or task bodies enter proof output. */
export async function collectOwnedEmptyQueueInventory({ getJSON }) {
  need(typeof getJSON === 'function', 'READONLY_QUEUE_ADAPTER_REQUIRED');
  const parent = `projects/${contract.projectId}/locations/us-central1`;
  async function full(path, key) {
    const values = [],
      tokens = new Set();
    let token;
    for (let page = 0; ; page++) {
      need(page < 100, 'QUEUE_PAGE_BOUND');
      const response = await getJSON(path + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      need(
        response &&
          typeof response === 'object' &&
          !Array.isArray(response) &&
          Object.keys(response).every((k) => [key, 'nextPageToken'].includes(k)) &&
          (!Object.hasOwn(response, key) || Array.isArray(response[key])) &&
          (!Object.hasOwn(response, 'nextPageToken') || typeof response.nextPageToken === 'string'),
        'QUEUE_RESPONSE_INVALID'
      );
      values.push(...(response[key] ?? []));
      need(values.length <= 10000, 'QUEUE_RESULT_BOUND');
      token = response.nextPageToken;
      if (!token) break;
      need(typeof token === 'string' && !tokens.has(token), 'QUEUE_CURSOR_INVALID');
      tokens.add(token);
    }
    return values;
  }
  const queues = await full(parent + '/queues?pageSize=1000', 'queues');
  need(queues.length === 13 && new Set(queues.map((q) => q.name)).size === 13, 'EXACT_QUEUE_SET_REQUIRED');
  const proof = [];
  for (const original of [...contract.queues].sort((a, b) => a.name.localeCompare(b.name))) {
    const queue = queues.find((q) => q.name === original.name);
    need(queue && queue.state === original.state, 'QUEUE_STATE_CHANGED');
    const tasks = await full(queue.name + '/tasks?pageSize=1000&responseView=FULL', 'tasks');
    need(tasks.length === 0, 'QUEUE_NOT_DRAINED');
    proof.push({
      name: queue.name,
      state: queue.state,
      queueDigest: proofDigest(queue),
      allPages: true,
      responseView: 'FULL',
      taskCount: 0,
      tasksDigest: proofDigest(tasks),
    });
  }
  return {
    schemaVersion: 1,
    projectId: contract.projectId,
    allQueuePages: true,
    responseView: 'FULL',
    queues: proof,
    inventoryDigest: proofDigest(proof),
  };
}
