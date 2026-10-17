/** Complete readonly missing-edge collector. No initialization, mutation or cleanup transport. */
import { proofDigest, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import {
  OWNED_SMOKE_INCIDENT as incident,
  ownedMirrorPaths,
  planOwnedMirrorEdges,
  ownedIndexSourcePath,
} from './temporal-owned-smoke-plan.mjs';
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('OWNED_SMOKE_' + code), { code: 'OWNED_SMOKE_' + code });
};
export async function collectOwnedMirrorIndexPlan({ db, tx, runtime }) {
  need(
    ['extractProviderResources', 'providerResourceKey', 'providerEdgeKey'].every(
      (k) => typeof runtime?.[k] === 'function'
    ),
    'INDEX_PINNED_RUNTIME_REQUIRED'
  );
  async function read(path) {
    const s = await tx.get(db.doc(path));
    need(s.exists, 'INDEX_SOURCE_MISSING');
    return { path, data: s.data(), native: nativeSnapshotProof(s) };
  }
  const marker = await read('_control/temporalProviderUsage');
  need(
    marker.data.projectId === incident.projectId &&
      marker.data.epoch === incident.originalEpoch &&
      marker.data.status === 'ready',
    'INDEX_MARKER_CHANGED'
  );
  const groups = [];
  for (const resource of incident.resources) {
    const aggregatePath = `temporalProviderUsage/${runtime.providerResourceKey(resource)}/epochs/${
      incident.originalEpoch
    }`;
    const aggregate = await read(aggregatePath),
      rows = [];
    let cursor;
    for (let page = 0; ; page++) {
      need(page < 3, 'INDEX_EDGE_PAGE_BOUND');
      let query = db
        .collection(aggregatePath + '/edges')
        .orderBy('__name__')
        .limit(100);
      if (cursor) query = query.startAfter(cursor);
      const result = await tx.get(query);
      for (const snapshot of result.docs) {
        need(rows.length < 200, 'INDEX_EDGE_BOUND');
        const data = snapshot.data();
        need(
          typeof data.canonicalPath === 'string' && snapshot.id === runtime.providerEdgeKey(data.canonicalPath),
          'INDEX_EDGE_ROUTING_CHANGED'
        );
        rows.push({ path: snapshot.ref.path, data, native: nativeSnapshotProof(snapshot) });
      }
      if (result.docs.length < 100) break;
      cursor = result.docs.at(-1);
    }
    const canonicals = [];
    // Validate paths before dereferencing arbitrary persisted edge strings.
    const paths = [...new Set([...rows.map(ownedIndexSourcePath), ...ownedMirrorPaths()])];
    for (const path of paths) {
      canonicals.push(await read(path));
    }
    groups.push({ resource, aggregate, edges: { allPages: true, rows }, canonicals });
  }
  return planOwnedMirrorEdges({ marker, groups, extractResources: runtime.extractProviderResources });
}
