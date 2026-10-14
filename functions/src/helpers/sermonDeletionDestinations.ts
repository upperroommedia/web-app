import { acknowledgedProjectionDigest as hash } from '../temporal/publishing/acknowledgedProjectionDigest';
import { createHash } from 'node:crypto';
import axios from '../providerSandbox/http';
import { FieldPath, type Firestore, type Query, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { createAxiosConfig } from '../subsplashUtils';
import {
  getDurablePublishingJobId,
  getPublishingMutationOperation,
  runDurableTransaction,
  runPublishingProviderMutation,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import {
  type FrozenProjectionRequest,
  type FrozenProviderVerification,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  assertProviderMutationByteBudgets,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  PROVIDER_MUTATION_SESSIONS,
  type ProviderMutationResource,
} from '../temporal/publishing/providerMutationGuard';
import { assertSynchronousProviderMutationCompleted } from '../temporal/publishing/providerMutationCompletion';

const APP = '9XTSHD';
const PAGE = 200;
type Data = Record<string, unknown>;
const object = (v: unknown): Data => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {});
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 256 && !/[\s/?#]/.test(v);
function fail(): never {
  throw new Error('SERMON_DELETION_DESTINATION_PROOF_INVALID');
}
const resource = (resourceType: string, resourceId: string): ProviderMutationResource => ({
  provider: 'subsplash',
  account: `app:${APP}`,
  resourceType,
  resourceId,
});

export interface SermonDeletionDestinationRef extends DurableJobRef {
  sermonId: string;
  planId: string;
  digest: string;
}
export interface SermonDeletionDestinationNode {
  path: string;
  rootPath: string;
  listId: string;
  nextListId?: string;
  sourceDigest: string;
  remainingDigest: string;
  count: number;
  removedRowIds: string[];
}
interface Source {
  path: string;
  digest: string;
}
export interface SermonDeletionDestinationSeries {
  path: string;
  seriesId: string;
  sourceDigest: string;
  remainingDigest: string;
  publishedCount: number;
  subtitle: string;
}
export interface SermonDeletionDestinationProgram {
  ref: SermonDeletionDestinationRef;
  operation: string;
  mediaId: string;
  resources: ProviderMutationResource[];
  requests: FrozenProjectionRequest[];
  verifications: FrozenProviderVerification[];
}
export interface SermonDeletionDestinationCounts {
  path: string;
  expectedSourceDigest: string;
  patch: { count?: number; logicalCount?: number; publishedItemCount?: number; subtitle?: string };
}
interface Header {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  sermonId: string;
  mediaId: string;
  generation: number;
  intentDigest: string;
  operation: string;
  digest: string;
  resources: ProviderMutationResource[];
  nodeCount: number;
  requestCount: number;
  sourceCount: number;
  series?: SermonDeletionDestinationSeries;
}
const local = (db: Firestore, ref: Pick<SermonDeletionDestinationRef, 'planId'>) =>
  db.doc(`temporalSermonDeletionMirrorPlans/${ref.planId}/destinationPlan/header`);
export const sermonDeletionDestinationPlanId = (ref: DurableJobRef, sermonId: string): string =>
  createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, sermonId]))
    .digest('hex');
async function* pages(query: Query) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let next = query.orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) next = next.startAfter(cursor);
    const result = await next.get();
    if (result.empty) return;
    yield result.docs;
    if (result.size < PAGE) return;
    cursor = result.docs[result.size - 1];
  }
}
async function authority(tx: Transaction, db: Firestore, ref: DurableJobRef & { sermonId: string }) {
  const intent = await tx.get(db.doc(`durableJobIntents/${ref.jobId}`));
  const data = object(intent.data()),
    payload = object(data.payload);
  if (
    getDurablePublishingJobId() !== ref.jobId ||
    data.projectId !== ref.projectId ||
    data.kind !== 'sermon.delete' ||
    object(data.entity).id !== ref.sermonId ||
    payload.sermonId !== ref.sermonId ||
    payload.action !== 'delete' ||
    !Number.isSafeInteger(data.generation)
  )
    fail();
  return { generation: Number(data.generation), intentDigest: hash(data) };
}
async function checked(tx: Transaction, db: Firestore, ref: SermonDeletionDestinationRef): Promise<Header> {
  const scope = await authority(tx, db, ref),
    snapshot = await tx.get(local(db, ref));
  const header = snapshot.data() as Header | undefined;
  if (
    !header ||
    header.schemaVersion !== 1 ||
    header.digest !== ref.digest ||
    header.projectId !== ref.projectId ||
    header.jobId !== ref.jobId ||
    header.sermonId !== ref.sermonId ||
    header.generation !== scope.generation ||
    header.intentDigest !== scope.intentDigest ||
    ref.planId !== sermonDeletionDestinationPlanId(ref, ref.sermonId)
  )
    fail();
  return header;
}

/** Full authenticated pagination; never follow a provider supplied URL carrying credentials. */
async function remotePages(
  path: string,
  embedded: string,
  token: string,
  authorizePage?: () => Promise<void>
): Promise<Data[]> {
  const result: Data[] = [],
    seen = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    await authorizePage?.();
    const response = await axios(
      createAxiosConfig(
        `https://core.subsplash.com${path}${separator}page[size]=${PAGE}&page[number]=${page}`,
        token,
        'GET'
      )
    );
    if (response.status !== 200) fail();
    const body = object(response.data),
      rows = object(body._embedded)[embedded];
    if (!Array.isArray(rows)) fail();
    if (body.total !== undefined) {
      if (
        !Number.isSafeInteger(body.total) ||
        Number(body.total) < 0 ||
        (expectedTotal !== undefined && expectedTotal !== body.total)
      )
        fail();
      expectedTotal = Number(body.total);
    }

    for (const value of rows) {
      const row = object(value);
      if (!id(row.id) || seen.has(row.id) || row.app_key !== APP) fail();
      seen.add(row.id);
      result.push(row);
    }
    if (rows.length < PAGE) {
      if (expectedTotal !== undefined && result.length !== expectedTotal) fail();
      return result;
    }
  }
}
const readRows = (listId: string, token: string, authorizePage?: () => Promise<void>) =>
  remotePages(
    `/builder/v1/list-rows?filter[app_key]=${APP}&filter[source_list]=${encodeURIComponent(
      listId
    )}&filter[unlisted]=include&sort=position`,
    'list-rows',
    token,
    authorizePage
  );
function rowsDigest(rows: Data[]): string {
  return hash(
    rows
      .map((row) => ({
        id: row.id,
        type: row.type,
        method: row.method,
        source: object(object(row._embedded)['source-list']).id,
        resource: object(object(row._embedded)[String(row.type)]).id,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  );
}
/** Continuation contributes no content; an ordinary list link still contributes one item. */
export function deletionLogicalContentCount(rows: Data[], nextListId?: string): number {
  return rows.filter(
    (row, index) =>
      !(
        nextListId &&
        index === rows.length - 1 &&
        row.type === 'list' &&
        object(object(row._embedded).list).id === nextListId
      )
  ).length;
}
export function fixedSermonListRowRemoval(listId: string, row: Data, mediaId: string): FrozenProjectionRequest {
  if (
    !id(listId) ||
    !id(mediaId) ||
    !id(row.id) ||
    row.app_key !== APP ||
    row.type !== 'media-item' ||
    object(object(row._embedded)['source-list']).id !== listId ||
    object(object(row._embedded)['media-item']).id !== mediaId ||
    row.method !== 'static'
  )
    fail();
  const target = resource('list-row', row.id),
    payload = { id: row.id, listId };
  return {
    target,
    payload,
    method: 'DELETE',
    step: `sermon-delete-row:${listId}:${row.id}`,
    fingerprint: publishingMutationRequestFingerprint({ target, payload, method: 'DELETE' }),
  };
}
function seriesItemsDigest(items: Data[]): string {
  return hash(
    items.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  );
}
async function readSeriesItems(seriesId: string, token: string, authorizePage?: () => Promise<void>): Promise<Data[]> {
  const result: Data[] = [];
  for (const status of ['published', 'draft', 'scheduled'])
    result.push(
      ...(await remotePages(
        `/media/v1/media-items?filter[app_key]=${APP}&filter[media_series]=${encodeURIComponent(
          seriesId
        )}&filter[status]=${status}&filter[unlisted]=include&include=media-series&sort=-position`,
        'media-items',
        token,
        authorizePage
      ))
    );
  if (
    new Set(result.map((item) => item.id)).size !== result.length ||
    result.some(
      (item) =>
        object(object(item._embedded)['media-series']).id !== seriesId ||
        !['published', 'draft', 'scheduled'].includes(String(item.status))
    )
  )
    fail();
  return result;
}

/** Capture original server graph, before acquiring the complete immutable provider mutation set. */
export async function captureSermonDeletionDestinations(
  db: Firestore,
  input: DurableJobRef & { sermonId: string; mediaId: string },
  token: string
): Promise<SermonDeletionDestinationProgram> {
  if (![input.projectId, input.jobId, input.sermonId, input.mediaId].every(id)) fail();
  const planId = sermonDeletionDestinationPlanId(input, input.sermonId),
    base = { ...input, planId };
  const prior = await local(db, base).get();
  if (prior.exists) return readSermonDeletionDestinationProgram(db, { ...base, digest: prior.get('digest') });
  const scope = await runDurableTransaction(db, (tx) => authority(tx, db, input));
  const root = await db.doc(`sermons/${input.sermonId}`).get();
  if (!root.exists || root.get('subsplashId') !== input.mediaId) fail();
  const sources: Source[] = [{ path: root.ref.path, digest: hash(root.data()) }],
    roots = new Set<string>(),
    seriesIds = new Set<string>();
  if (id(root.get('seriesId'))) seriesIds.add(root.get('seriesId'));
  for await (const page of pages(root.ref.collection('sermonLists')))
    for (const membership of page) {
      sources.push({ path: membership.ref.path, digest: hash(membership.data()) });
      roots.add(membership.id);
      const placement = object(membership.get('physicalPlacement'));
      if (id(placement.firestoreListId)) roots.add(placement.firestoreListId);
    }
  // Include legacy mirrors without copied sermon/provider IDs. Path ownership is the authority.
  for (const kind of ['listItems', 'seriesItems'])
    for await (const page of pages(db.collectionGroup(kind)))
      for (const mirror of page) {
        const parts = mirror.ref.path.split('/');
        if (
          parts.length !== 4 ||
          parts[3] !== input.sermonId ||
          parts[2] !== kind ||
          parts[0] !== (kind === 'listItems' ? 'lists' : 'series')
        )
          continue;
        sources.push({ path: mirror.ref.path, digest: hash(mirror.data()) });
        (kind === 'listItems' ? roots : seriesIds).add(parts[1]);
      }
  const nodes: SermonDeletionDestinationNode[] = [],
    requests: FrozenProjectionRequest[] = [],
    resources = [resource('media', input.mediaId)],
    verifications: FrozenProviderVerification[] = [],
    visited = new Set<string>();
  for (const selected of roots) {
    const first = await db.doc(`lists/${selected}`).get();
    if (!first.exists) fail();
    const rootId = id(first.get('rootListId')) ? (first.get('rootListId') as string) : first.id;
    let current = rootId;
    const chainSeen = new Set<string>();
    while (current) {
      if (chainSeen.has(current)) fail();
      chainSeen.add(current);
      const node = await db.doc(`lists/${current}`).get();
      if (!node.exists || !id(node.get('subsplashId')) || (current !== rootId && node.get('rootListId') !== rootId))
        fail();
      const listId = node.get('subsplashId') as string,
        nextListId = node.get('moreSermonsRef');
      if (nextListId !== undefined && !id(nextListId)) fail();
      if (!visited.has(node.id)) {
        const detail = await axios(
          createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${encodeURIComponent(listId)}`, token, 'GET')
        );
        if (
          detail.status !== 200 ||
          object(detail.data).id !== listId ||
          object(detail.data).app_key !== APP ||
          object(detail.data).type !== 'standard'
        )
          fail();
        const rows = await readRows(listId, token);
        for (const row of rows) if (object(object(row._embedded)['source-list']).id !== listId) fail();
        const matching = rows.filter(
          (row) => row.type === 'media-item' && object(object(row._embedded)['media-item']).id === input.mediaId
        );
        for (const row of matching) {
          const request = fixedSermonListRowRemoval(listId, row, input.mediaId);
          requests.push(request);
          resources.push(request.target!);
          verifications.push({
            provider: 'subsplash',
            account: `app:${APP}`,
            resourceType: 'list-row',
            resourceId: request.target!.resourceId,
            expectedState: 'absent',
            expectedProviderFields: {},
            requiredSteps: [request.step],
          });
        }
        const remaining = rows.filter((row) => !matching.includes(row));
        nodes.push({
          path: node.ref.path,
          rootPath: `lists/${rootId}`,
          listId,
          ...(id(nextListId) ? { nextListId } : {}),
          sourceDigest: hash(node.data()),
          remainingDigest: rowsDigest(remaining),
          count: deletionLogicalContentCount(remaining, nextListId as string | undefined),
          removedRowIds: matching.map((row) => String(row.id)),
        });
        resources.push(resource('list', listId));
        sources.push({ path: node.ref.path, digest: hash(node.data()) });
        visited.add(node.id);
      }
      if (!id(nextListId)) break;
      const next = await db.collection('lists').where('subsplashId', '==', nextListId).limit(2).get();
      if (next.size !== 1) fail();
      current = next.docs[0].id;
    }
    if (!chainSeen.has(selected)) fail();
  }
  const media = await axios(
    createAxiosConfig(
      `https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(input.mediaId)}?include=media-series`,
      token,
      'GET'
    )
  );
  if (media.status !== 200 || object(media.data).id !== input.mediaId || object(media.data).app_key !== APP) fail();
  const remoteSeries = object(object(object(media.data)._embedded)['media-series']).id;
  let series: SermonDeletionDestinationSeries | undefined;
  if (remoteSeries !== undefined && !id(remoteSeries)) fail();
  if (id(remoteSeries)) {
    const candidates = [];
    for (const seriesId of seriesIds) {
      const snapshot = await db.doc(`series/${seriesId}`).get();
      if (snapshot.exists && snapshot.get('subsplashId') === remoteSeries) candidates.push(snapshot);
    }
    if (candidates.length !== 1) fail();
    const canonical = candidates[0],
      items = await readSeriesItems(remoteSeries, token);
    if (items.filter((item) => item.id === input.mediaId).length !== 1) fail();
    const remaining = items.filter((item) => item.id !== input.mediaId),
      target = resource('media', input.mediaId),
      payload = { id: input.mediaId, app_key: APP, _embedded: { 'media-series': null } };
    const request: FrozenProjectionRequest = {
      target,
      payload,
      method: 'PATCH',
      step: `sermon-delete-series:${input.mediaId}:${remoteSeries}`,
      fingerprint: publishingMutationRequestFingerprint({ target, payload, method: 'PATCH' }),
    };
    requests.push(request);
    resources.push(resource('series', remoteSeries));
    // The later original media DELETE subsumes verification of this sparse unlink.
    verifications.push({
      provider: 'subsplash',
      account: `app:${APP}`,
      resourceType: 'media',
      resourceId: input.mediaId,
      expectedProviderFields: { '_embedded.media-series': null },
      requiredSteps: [request.step],
    });
    const publishedCount = remaining.filter((item) => item.status === 'published').length,
      subtitle = `${publishedCount} part series`;
    const seriesDetail = await axios(
      createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-series/${encodeURIComponent(remoteSeries)}`,
        token,
        'GET'
      )
    );
    if (
      seriesDetail.status !== 200 ||
      object(seriesDetail.data).id !== remoteSeries ||
      object(seriesDetail.data).app_key !== APP
    )
      fail();
    const seriesTarget = resource('series', remoteSeries),
      seriesPayload = { id: remoteSeries, subtitle };
    const subtitleRequest: FrozenProjectionRequest = {
      target: seriesTarget,
      payload: seriesPayload,
      method: 'PATCH',
      step: `sermon-delete-series-subtitle:${remoteSeries}:${publishedCount}`,
      fingerprint: publishingMutationRequestFingerprint({
        target: seriesTarget,
        payload: seriesPayload,
        method: 'PATCH',
      }),
    };
    requests.push(subtitleRequest);
    verifications.push({
      provider: 'subsplash',
      account: `app:${APP}`,
      resourceType: 'series',
      resourceId: remoteSeries,
      expectedProviderFields: { subtitle },
      requiredSteps: [subtitleRequest.step],
    });
    series = {
      path: canonical.ref.path,
      seriesId: remoteSeries,
      sourceDigest: hash(canonical.data()),
      remainingDigest: seriesItemsDigest(remaining),
      publishedCount,
      subtitle,
    };
    sources.push({ path: canonical.ref.path, digest: hash(canonical.data()) });
  }
  const operation = `durable:${input.projectId}:${input.jobId}:${input.sermonId}:provider-delete:delete`;
  const uniqueResources = [...new Map(resources.map((value) => [hash(value), value])).values()];
  const content = {
    nodes,
    requests,
    verifications,
    sources,
    resources: uniqueResources,
    ...(series ? { series } : {}),
    operation,
    mediaId: input.mediaId,
  };
  const digest = hash(content),
    ref: SermonDeletionDestinationRef = { ...input, planId, digest };
  const header: Header = {
    schemaVersion: 1,
    projectId: input.projectId,
    jobId: input.jobId,
    sermonId: input.sermonId,
    mediaId: input.mediaId,
    ...scope,
    operation,
    digest,
    resources: uniqueResources,
    nodeCount: nodes.length,
    requestCount: requests.length,
    sourceCount: sources.length,
    ...(series ? { series } : {}),
  };
  assertProviderMutationByteBudgets([{ path: local(db, ref).path, data: header }]);
  const records = [
    ...nodes.map((value, index) => ({ path: `nodes/${String(index).padStart(10, '0')}`, value })),
    ...requests.map((value, index) => ({
      path: `requests/${String(index).padStart(10, '0')}`,
      value: { request: value, verification: verifications[index] },
    })),
    ...sources.map((value, index) => ({ path: `sources/${String(index).padStart(10, '0')}`, value })),
  ];
  for (let offset = 0; offset < records.length; offset += 64)
    await runDurableTransaction(db, async (tx) => {
      await authority(tx, db, input);
      const chunk = records.slice(offset, offset + 64);
      assertProviderMutationByteBudgets(
        chunk.map((record) => ({ path: `${local(db, ref).path}/${record.path}`, data: record.value }))
      );
      const refs = chunk.map((record) =>
          local(db, ref).collection(record.path.split('/')[0]).doc(record.path.split('/')[1])
        ),
        existing = await tx.getAll(...refs);
      existing.forEach((snapshot, index) => {
        if (snapshot.exists && hash(snapshot.data()) !== hash(chunk[index].value)) fail();
      });
      refs.forEach((record, index) => {
        if (!existing[index].exists) tx.create(record, chunk[index].value);
      });
    });
  // Revalidate the entire captured canonical graph in bounded transactions before sealing.
  for (let offset = 0; offset < sources.length; offset += 100)
    await runDurableTransaction(db, async (tx) => {
      await authority(tx, db, input);
      const chunk = sources.slice(offset, offset + 100),
        snapshots = await tx.getAll(...chunk.map((source) => db.doc(source.path)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists || hash(snapshot.data()) !== chunk[index].digest) fail();
      });
    });
  await runDurableTransaction(db, async (tx) => {
    await authority(tx, db, input);
    const existing = await tx.get(local(db, ref));
    if (existing.exists) {
      if (existing.get('digest') !== digest) fail();
    } else tx.create(local(db, ref), header);
  });
  return { ref, operation, mediaId: input.mediaId, resources: uniqueResources, requests, verifications };
}

export async function readSermonDeletionDestinationProgram(
  db: Firestore,
  ref: SermonDeletionDestinationRef
): Promise<SermonDeletionDestinationProgram> {
  const header = await runDurableTransaction(db, (tx) => checked(tx, db, ref));
  const requests: FrozenProjectionRequest[] = [],
    verifications: FrozenProviderVerification[] = [],
    nodes: SermonDeletionDestinationNode[] = [],
    sources: Source[] = [];
  for await (const page of pages(local(db, ref).collection('requests')))
    for (const doc of page) {
      requests.push(doc.get('request'));
      verifications.push(doc.get('verification'));
    }
  for await (const page of pages(local(db, ref).collection('nodes')))
    for (const doc of page) nodes.push(doc.data() as SermonDeletionDestinationNode);
  for await (const page of pages(local(db, ref).collection('sources')))
    for (const doc of page) sources.push(doc.data() as Source);
  if (
    nodes.length !== header.nodeCount ||
    requests.length !== header.requestCount ||
    sources.length !== header.sourceCount ||
    hash({
      nodes,
      requests,
      verifications,
      sources,
      resources: header.resources,
      ...(header.series ? { series: header.series } : {}),
      operation: header.operation,
      mediaId: header.mediaId,
    }) !== header.digest
  )
    fail();
  return {
    ref,
    operation: header.operation,
    mediaId: header.mediaId,
    resources: header.resources,
    requests,
    verifications,
  };
}

/** Remote only: frozen claims replay original ACKs without looking up an already deleted row. */
export async function executeSermonDeletionDestinations(
  db: Firestore,
  ref: SermonDeletionDestinationRef,
  token: string
): Promise<void> {
  const program = await readSermonDeletionDestinationProgram(db, ref);
  if (getPublishingMutationOperation() !== program.operation) fail();
  for (const request of program.requests)
    await executeFrozenSermonDeletionDestinationRequest(program.operation, request, token, db);
  await verifySermonDeletionDestinationCounts(db, ref, token);
}

/** Read-only provider proof, so an authorized administrator can finish known original ACKs. */
export type SermonDeletionCountRead = {
  provider: 'subsplash';
  account: 'app:9XTSHD';
  resourceType: 'list' | 'series';
  resourceId: string;
};
export async function verifySermonDeletionDestinationCounts(
  db: Firestore,
  ref: SermonDeletionDestinationRef,
  token: string,
  options?: { authorizeRead: (target: SermonDeletionCountRead) => Promise<void> }
): Promise<void> {
  const header = await runDurableTransaction(db, (tx) => checked(tx, db, ref)),
    nodes: SermonDeletionDestinationNode[] = [];
  for await (const page of pages(local(db, ref).collection('nodes')))
    for (const doc of page) nodes.push(doc.data() as SermonDeletionDestinationNode);
  const counts: SermonDeletionDestinationCounts[] = [],
    logical = new Map<string, number>();
  for (const node of nodes) {
    const rows = await readRows(
      node.listId,
      token,
      options
        ? () =>
            options.authorizeRead({
              provider: 'subsplash',
              account: 'app:9XTSHD',
              resourceType: 'list',
              resourceId: node.listId,
            })
        : undefined
    );
    if (rowsDigest(rows) !== node.remainingDigest || deletionLogicalContentCount(rows, node.nextListId) !== node.count)
      fail();
    counts.push({ path: node.path, expectedSourceDigest: node.sourceDigest, patch: { count: node.count } });
    logical.set(node.rootPath, (logical.get(node.rootPath) ?? 0) + node.count);
  }
  for (const [path, logicalCount] of logical) {
    const count = counts.find((value) => value.path === path);
    if (!count) fail();
    count.patch.logicalCount = logicalCount;
  }
  if (header.series) {
    const remaining = await readSeriesItems(
      header.series.seriesId,
      token,
      options
        ? () =>
            options.authorizeRead({
              provider: 'subsplash',
              account: 'app:9XTSHD',
              resourceType: 'series',
              resourceId: header.series!.seriesId,
            })
        : undefined
    );
    await options?.authorizeRead({
      provider: 'subsplash',
      account: 'app:9XTSHD',
      resourceType: 'series',
      resourceId: header.series.seriesId,
    });
    const detail = await axios(
      createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-series/${encodeURIComponent(header.series.seriesId)}`,
        token,
        'GET'
      )
    );
    if (
      seriesItemsDigest(remaining) !== header.series.remainingDigest ||
      detail.status !== 200 ||
      object(detail.data).id !== header.series.seriesId ||
      object(detail.data).app_key !== APP ||
      object(detail.data).subtitle !== header.series.subtitle
    )
      fail();
    counts.push({
      path: header.series.path,
      expectedSourceDigest: header.series.sourceDigest,
      patch: { publishedItemCount: header.series.publishedCount, subtitle: header.series.subtitle },
    });
  }
  for (let offset = 0; offset < counts.length; offset += 64)
    await runDurableTransaction(db, async (tx) => {
      await checked(tx, db, ref);
      for (const count of counts.slice(offset, offset + 64))
        tx.set(local(db, ref).collection('counts').doc(hash(count.path)), { ...count, destinationDigest: ref.digest });
    });
  await runDurableTransaction(db, async (tx) => {
    await checked(tx, db, ref);
    tx.set(local(db, ref).collection('outcome').doc('verified'), {
      schemaVersion: 1,
      destinationDigest: ref.digest,
      countCount: counts.length,
      countsDigest: hash(counts.sort((a, b) => a.path.localeCompare(b.path))),
    });
  });
}

/** Parent final cleanup reads immutable program separately; this validates the completed remote phase. */
export async function validateSermonDeletionDestinationCounts(
  tx: Transaction,
  db: Firestore,
  ref: SermonDeletionDestinationRef
): Promise<SermonDeletionDestinationCounts[]> {
  await checked(tx, db, ref);
  const outcome = await tx.get(local(db, ref).collection('outcome').doc('verified'));
  if (outcome.get('destinationDigest') !== ref.digest) fail();
  const counts: SermonDeletionDestinationCounts[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = local(db, ref).collection('counts').orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const page = await tx.get(query);
    for (const doc of page.docs) {
      if (doc.get('destinationDigest') !== ref.digest) fail();
      const data = doc.data();
      delete data.destinationDigest;
      counts.push(data as SermonDeletionDestinationCounts);
    }
    if (page.size < PAGE) break;
    cursor = page.docs[page.size - 1];
  }
  counts.sort((a, b) => a.path.localeCompare(b.path));
  if (counts.length !== outcome.get('countCount') || hash(counts) !== outcome.get('countsDigest')) fail();
  return counts;
}

export async function readSermonDeletionDestinationProgramInTransaction(
  tx: Transaction,
  db: Firestore,
  ref: SermonDeletionDestinationRef
): Promise<{
  requests: FrozenProjectionRequest[];
  verifications: FrozenProviderVerification[];
  operation: string;
  mediaId: string;
  countWrites: SermonDeletionDestinationCountWrite[];
}> {
  const header = await checked(tx, db, ref),
    requests: FrozenProjectionRequest[] = [],
    verifications: FrozenProviderVerification[] = [];
  const nodes: SermonDeletionDestinationNode[] = [],
    sources: Source[] = [];
  for (const kind of ['requests', 'nodes', 'sources']) {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = local(db, ref).collection(kind).orderBy(FieldPath.documentId()).limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await tx.get(query);
      for (const doc of page.docs) {
        if (kind === 'requests') {
          requests.push(doc.get('request'));
          verifications.push(doc.get('verification'));
        } else if (kind === 'nodes') nodes.push(doc.data() as SermonDeletionDestinationNode);
        else sources.push(doc.data() as Source);
      }
      if (page.size < PAGE) break;
      cursor = page.docs[page.size - 1];
    }
  }
  if (
    nodes.length !== header.nodeCount ||
    requests.length !== header.requestCount ||
    sources.length !== header.sourceCount ||
    hash({
      nodes,
      requests,
      verifications,
      sources,
      resources: header.resources,
      ...(header.series ? { series: header.series } : {}),
      operation: header.operation,
      mediaId: header.mediaId,
    }) !== ref.digest
  )
    fail();
  return {
    requests,
    verifications,
    operation: header.operation,
    mediaId: header.mediaId,
    countWrites: originalSermonDeletionDestinationCountWrites(nodes, header.series),
  };
}

export async function validateSermonDeletionDestinationCompletion(
  tx: Transaction,
  db: Firestore,
  ref: SermonDeletionDestinationRef
): Promise<{
  evidenceDigest: string;
  countWrites: Array<{ path: string; expectedFields: Record<string, unknown>; patch: Record<string, unknown> }>;
}> {
  const header = await checked(tx, db, ref),
    program = await readSermonDeletionDestinationProgramInTransaction(tx, db, ref);
  const scope = { projectId: ref.projectId, jobId: ref.jobId, operation: header.operation },
    sessionId = providerMutationFingerprint(scope);
  const originals: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let offset = 0; offset < program.requests.length; offset += 100) {
    const chunk = program.requests.slice(offset, offset + 100),
      snapshots = await tx.getAll(
        ...chunk.map((request) =>
          db
            .collection(PROVIDER_MUTATION_SESSIONS)
            .doc(sessionId)
            .collection('requests')
            .doc(providerMutationFingerprint(request.step))
        )
      );
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index],
        request = chunk[index];
      if (
        !snapshot.exists ||
        !['acknowledged', 'rejected_no_effect'].includes(snapshot.get('state')) ||
        snapshot.get('fingerprint') !== request.fingerprint ||
        snapshot.get('method') !== request.method ||
        (snapshot.get('state') === 'rejected_no_effect' && request.method !== 'DELETE')
      )
        fail();
      if (snapshot.get('state') === 'rejected_no_effect')
        await validateOriginalDestinationNoEffect(tx, db, sessionId, snapshot);
      originals.push(snapshot as FirebaseFirestore.QueryDocumentSnapshot);
    }
  }
  await validateProviderMutationOriginalCompletion(
    tx,
    { db, id: sessionId, scope, resources: header.resources },
    originals
  );
  const counts = await validateSermonDeletionDestinationCounts(tx, db, ref),
    countWrites: Array<{ path: string; expectedFields: Record<string, unknown>; patch: Record<string, unknown> }> = [];
  const nodes = await tx.get(local(db, ref).collection('nodes'));
  const identities = new Map(nodes.docs.map((doc) => [doc.get('path'), doc.get('listId')]));
  if (header.series) identities.set(header.series.path, header.series.seriesId);
  for (const count of counts) {
    const subsplashId = identities.get(count.path);
    if (!id(subsplashId)) fail();
    countWrites.push({ path: count.path, expectedFields: { subsplashId }, patch: { ...count.patch } });
  }
  if (
    hash([...countWrites].sort((a, b) => a.path.localeCompare(b.path))) !==
    hash([...program.countWrites].sort((a, b) => a.path.localeCompare(b.path)))
  )
    fail();
  return {
    evidenceDigest: hash({
      destinationDigest: ref.digest,
      originals: originals.map((doc) => ({ path: doc.ref.path, digest: hash(doc.data()) })),
      counts,
    }),
    countWrites,
  };
}

/** The session runtime validates original source-qualified target authority before invoking send. */
export async function executeFrozenSermonDeletionDestinationRequest(
  operation: string,
  request: FrozenProjectionRequest,
  token: string,
  db?: Firestore
): Promise<void> {
  const target = request.target;
  if (
    getPublishingMutationOperation() !== operation ||
    !target ||
    target.provider !== 'subsplash' ||
    target.account !== `app:${APP}` ||
    !id(target.resourceId) ||
    request.fingerprint !==
      publishingMutationRequestFingerprint({ target, payload: request.payload, method: request.method }) ||
    !(
      (target.resourceType === 'list-row' && request.method === 'DELETE') ||
      (['media', 'series'].includes(target.resourceType) && request.method === 'PATCH')
    )
  )
    fail();
  let originalSeries: SermonDeletionDestinationSeries | undefined;
  const preflight = async () => {
    if (target.resourceType === 'media') {
      const originalSeriesId = request.step.split(':').at(-1);
      if (!id(originalSeriesId)) fail();
      const current = await axios(
        createAxiosConfig(
          `https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(
            target.resourceId
          )}?include=media-series`,
          token,
          'GET'
        )
      );
      if (
        current.status !== 200 ||
        object(current.data).id !== target.resourceId ||
        object(current.data).app_key !== APP ||
        object(object(object(current.data)._embedded)['media-series']).id !== originalSeriesId
      )
        fail();
    }
    if (target.resourceType === 'series') {
      const current = await axios(
        createAxiosConfig(
          `https://core.subsplash.com/media/v1/media-series/${encodeURIComponent(target.resourceId)}`,
          token,
          'GET'
        )
      );
      const remaining = await readSeriesItems(target.resourceId, token);
      if (
        current.status !== 200 ||
        object(current.data).id !== target.resourceId ||
        object(current.data).app_key !== APP ||
        object(request.payload).subtitle !==
          `${remaining.filter((item) => item.status === 'published').length} part series` ||
        (originalSeries &&
          (originalSeries.seriesId !== target.resourceId ||
            originalSeries.remainingDigest !== seriesItemsDigest(remaining)))
      )
        fail();
    }
  };
  let originalCompletion: string | undefined;
  if (db) {
    const scope = { projectId: operation.split(':')[1], jobId: getDurablePublishingJobId()!, operation },
      sessionId = providerMutationFingerprint(scope);
    originalSeries = await runDurableTransaction(db, async (tx) => {
      const sermonId = operation.split(':')[3],
        planId = sermonDeletionDestinationPlanId(scope, sermonId),
        snapshot = await tx.get(local(db, { planId }));
      const digest = snapshot.get('digest');
      if (typeof digest !== 'string') fail();
      return (await checked(tx, db, { projectId: scope.projectId, jobId: scope.jobId, sermonId, planId, digest }))
        .series;
    });
    originalCompletion = await runDurableTransaction(db, async (tx) => {
      const snapshot = await tx.get(
        db
          .collection(PROVIDER_MUTATION_SESSIONS)
          .doc(sessionId)
          .collection('requests')
          .doc(providerMutationFingerprint(request.step))
      );
      if (!snapshot.exists || !['acknowledged', 'rejected_no_effect'].includes(snapshot.get('state'))) return undefined;
      if (snapshot.get('fingerprint') !== request.fingerprint || snapshot.get('method') !== request.method) fail();
      await validateProviderMutationOriginalCompletion(tx, { db, id: sessionId, scope, resources: [target] }, [
        snapshot as FirebaseFirestore.QueryDocumentSnapshot,
      ]);
      if (snapshot.get('state') === 'rejected_no_effect') {
        if (request.method !== 'DELETE') fail();
        await validateOriginalDestinationNoEffect(tx, db, sessionId, snapshot);
      }
      return snapshot.get('state') as string;
    });
    if (!originalCompletion) await preflight();
    if (originalCompletion === 'rejected_no_effect') return;
  }
  try {
    await runPublishingProviderMutation({
      operation,
      step: request.step,
      method: request.method,
      target,
      payload: request.payload,
      send: async () => {
        if (!db) await preflight();
        const route =
          target.resourceType === 'list-row'
            ? `/builder/v1/list-rows/${encodeURIComponent(target.resourceId)}`
            : target.resourceType === 'series'
            ? `/media/v1/media-series/${encodeURIComponent(target.resourceId)}`
            : `/media/v1/media-items/${encodeURIComponent(target.resourceId)}`;
        const config = createAxiosConfig(
          `https://core.subsplash.com${route}`,
          token,
          request.method,
          request.method === 'DELETE' ? undefined : request.payload
        );
        let response;
        try {
          response = await axios(Object.assign(config, { maxRedirects: 0, skipSubsplashEdgeRetry: true }));
        } catch (error) {
          const evidence = request.method === 'DELETE' ? originalDestinationNoEffect(error) : undefined;
          if (evidence) return { completion: 'rejected_no_effect', evidence };
          throw error;
        }
        assertSynchronousProviderMutationCompleted(response);
        return { completion: 'acknowledged', result: null };
      },
    });
  } catch (error) {
    if (
      request.method === 'DELETE' &&
      (object(error).code === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT' ||
        (error instanceof Error && error.message === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT'))
    )
      return;
    throw error;
  }
}

/** Check original source again after acquiring the WHOLE provider graph and before a first send. */
export async function revalidateSermonDeletionDestinationSources(
  db: Firestore,
  ref: SermonDeletionDestinationRef
): Promise<void> {
  await readSermonDeletionDestinationProgram(db, ref);
  for await (const page of pages(local(db, ref).collection('sources')))
    for (let offset = 0; offset < page.length; offset += 100) {
      const chunk = page.slice(offset, offset + 100);
      await runDurableTransaction(db, async (tx) => {
        await checked(tx, db, ref);
        const snapshots = await tx.getAll(...chunk.map((doc) => db.doc(doc.get('path'))));
        snapshots.forEach((snapshot, index) => {
          if (!snapshot.exists || hash(snapshot.data()) !== chunk[index].get('digest'))
            throw new Error('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
        });
      });
    }
}

export interface SermonDeletionDestinationCountWrite {
  path: string;
  expectedFields: Record<string, unknown>;
  patch: Record<string, unknown>;
}
export function originalSermonDeletionDestinationCountWrites(
  nodes: SermonDeletionDestinationNode[],
  series?: SermonDeletionDestinationSeries
): SermonDeletionDestinationCountWrite[] {
  const writes: SermonDeletionDestinationCountWrite[] = [],
    logical = new Map<string, number>();
  for (const node of nodes) {
    writes.push({ path: node.path, expectedFields: { subsplashId: node.listId }, patch: { count: node.count } });
    logical.set(node.rootPath, (logical.get(node.rootPath) ?? 0) + node.count);
  }
  for (const [path, logicalCount] of logical) {
    const root = writes.find((write) => write.path === path);
    if (!root) fail();
    root.patch.logicalCount = logicalCount;
  }
  if (series)
    writes.push({
      path: series.path,
      expectedFields: { subsplashId: series.seriesId },
      patch: { publishedItemCount: series.publishedCount, subtitle: series.subtitle },
    });
  return writes;
}

/** Bare proxy/HTML404 is uncertainty. Only the original qualified API JSON rejection can be sealed. */
export function originalDestinationNoEffect(
  error: unknown
): { transport: 'original_http_response'; status: number; providerCode: string } | undefined {
  const response = object(object(error).response),
    status = Number(response.status),
    contentType = object(response.headers)['content-type'],
    body = object(response.data);
  if (
    ![404, 410].includes(status) ||
    typeof contentType !== 'string' ||
    !/^application\/(?:json|hal\+json)(?:;|$)/i.test(contentType) ||
    !Array.isArray(body.errors) ||
    !body.errors.length
  )
    return undefined;
  const accepted = new Set(['resource_not_found', 'not_found', 'resource_gone']);
  if (body.errors.some((value) => !accepted.has(String(object(value).code).toLowerCase()))) return undefined;
  return { transport: 'original_http_response', status, providerCode: 'resource_not_found' };
}
async function validateOriginalDestinationNoEffect(
  tx: Transaction,
  db: Firestore,
  sessionId: string,
  snapshot: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const fact = await tx.get(
      db
        .collection('temporalProviderMutationFacts')
        .doc(providerMutationFingerprint([sessionId, snapshot.get('step'), snapshot.get('claim')]))
    ),
    evidence = object(fact.get('evidence'));
  if (
    fact.get('completion') !== 'rejected_no_effect' ||
    evidence.transport !== 'original_http_response' ||
    ![404, 410].includes(Number(evidence.status)) ||
    evidence.providerCode !== 'resource_not_found'
  )
    fail();
}

export interface SermonDeletionPartialReadTarget {
  provider: 'subsplash';
  account: 'app:9XTSHD';
  resourceType: 'list' | 'series' | 'media';
  resourceId: string;
}
export interface SermonDeletionPartialDestinationObservation {
  step: string;
  target: ProviderMutationResource;
  state: 'absent' | 'present' | 'unlinked' | 'linked';
  observedFields?: Record<string, unknown>;
  matchesFrozenRequest: boolean;
}
/** Read the original fixed destination graph after independently proved partial effects.
 * This is factual observation only: no mutation, projection, session release or fabricated ACK.
 */
export async function readSermonDeletionPartialDestinationCounts(
  db: Firestore,
  ref: SermonDeletionDestinationRef,
  token: string,
  options: { knownRequestSteps: string[]; authorizeRead: (target: SermonDeletionPartialReadTarget) => Promise<void> }
): Promise<{
  countWrites: SermonDeletionDestinationCountWrite[];
  observations: SermonDeletionPartialDestinationObservation[];
  evidenceDigest: string;
}> {
  const program = await readSermonDeletionDestinationProgram(db, ref),
    header = await runDurableTransaction(db, (tx) => checked(tx, db, ref));
  const known = new Set(options.knownRequestSteps);
  if (
    known.size !== options.knownRequestSteps.length ||
    [...known].some((step) => !program.requests.some((request) => request.step === step))
  )
    fail();
  const nodes: SermonDeletionDestinationNode[] = [],
    observations: SermonDeletionPartialDestinationObservation[] = [],
    countWrites: SermonDeletionDestinationCountWrite[] = [],
    logical = new Map<string, number>();
  for await (const page of pages(local(db, ref).collection('nodes')))
    for (const doc of page) nodes.push(doc.data() as SermonDeletionDestinationNode);
  for (const node of nodes) {
    const target: SermonDeletionPartialReadTarget = {
      provider: 'subsplash',
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId: node.listId,
    };
    await options.authorizeRead(target);
    const detail = await axios(
      createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${encodeURIComponent(node.listId)}`, token, 'GET')
    );
    if (detail.status !== 200 || object(detail.data).id !== node.listId || object(detail.data).app_key !== APP) fail();
    const rows = await readRows(node.listId, token, () => options.authorizeRead(target));
    if (rows.some((row) => object(object(row._embedded)['source-list']).id !== node.listId)) fail();
    const count = deletionLogicalContentCount(rows, node.nextListId);
    countWrites.push({ path: node.path, expectedFields: { subsplashId: node.listId }, patch: { count } });
    logical.set(node.rootPath, (logical.get(node.rootPath) ?? 0) + count);
    for (const request of program.requests.filter(
      (request) =>
        known.has(request.step) &&
        request.target?.resourceType === 'list-row' &&
        object(request.payload).listId === node.listId
    )) {
      const present = rows.some((row) => row.id === request.target!.resourceId);
      observations.push({
        step: request.step,
        target: request.target!,
        state: present ? 'present' : 'absent',
        matchesFrozenRequest: !present,
      });
    }
  }
  for (const [path, logicalCount] of logical) {
    const root = countWrites.find((write) => write.path === path);
    if (!root) fail();
    root.patch.logicalCount = logicalCount;
  }
  if (header.series) {
    const series = header.series,
      target: SermonDeletionPartialReadTarget = {
        provider: 'subsplash',
        account: 'app:9XTSHD',
        resourceType: 'series',
        resourceId: series.seriesId,
      };
    const items = await readSeriesItems(series.seriesId, token, () => options.authorizeRead(target));
    await options.authorizeRead(target);
    const detail = await axios(
      createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-series/${encodeURIComponent(series.seriesId)}`,
        token,
        'GET'
      )
    );
    const body = object(detail.data);
    if (
      detail.status !== 200 ||
      body.id !== series.seriesId ||
      body.app_key !== APP ||
      typeof body.subtitle !== 'string'
    )
      fail();
    countWrites.push({
      path: series.path,
      expectedFields: { subsplashId: series.seriesId },
      patch: {
        publishedItemCount: items.filter((item) => item.status === 'published').length,
        subtitle: body.subtitle,
      },
    });
    for (const request of program.requests.filter(
      (request) => known.has(request.step) && request.target?.resourceType === 'series'
    ))
      observations.push({
        step: request.step,
        target: request.target!,
        state: 'present',
        observedFields: { subtitle: body.subtitle },
        matchesFrozenRequest: body.subtitle === object(request.payload).subtitle,
      });
    for (const request of program.requests.filter(
      (request) => known.has(request.step) && request.target?.resourceType === 'media'
    )) {
      const mediaTarget: SermonDeletionPartialReadTarget = {
        provider: 'subsplash',
        account: 'app:9XTSHD',
        resourceType: 'media',
        resourceId: request.target!.resourceId,
      };
      await options.authorizeRead(mediaTarget);
      let response;
      try {
        response = await axios(
          createAxiosConfig(
            `https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(
              mediaTarget.resourceId
            )}?include=media-series`,
            token,
            'GET'
          )
        );
      } catch (error) {
        if (originalDestinationNoEffect(error)) {
          observations.push({
            step: request.step,
            target: request.target!,
            state: 'absent',
            matchesFrozenRequest: true,
          });
          continue;
        }
        throw error;
      }
      const media = object(response.data),
        embedded = object(media._embedded);
      if (
        response.status !== 200 ||
        media.id !== mediaTarget.resourceId ||
        media.app_key !== APP ||
        !Object.prototype.hasOwnProperty.call(embedded, 'media-series')
      )
        fail();
      const linked = embedded['media-series'] !== null;
      if (linked && !id(object(embedded['media-series']).id)) fail();
      observations.push({
        step: request.step,
        target: request.target!,
        state: linked ? 'linked' : 'unlinked',
        observedFields: { seriesId: linked ? object(embedded['media-series']).id : null },
        matchesFrozenRequest: !linked,
      });
    }
  }
  countWrites.sort((a, b) => a.path.localeCompare(b.path));
  observations.sort((a, b) => a.step.localeCompare(b.step));
  if (observations.length !== known.size) fail();
  return {
    countWrites,
    observations,
    evidenceDigest: hash({
      destinationDigest: ref.digest,
      knownRequestSteps: [...known].sort(),
      countWrites,
      observations,
    }),
  };
}
