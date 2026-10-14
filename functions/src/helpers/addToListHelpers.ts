import {
  markPublishingCritical,
  getPublishingMutationOperation,
  runPublishingProviderMutation,
  isDurablePublishingOperation,
  runDurableTransaction,
  prepareAcknowledgedProjectionPlan,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import type { FrozenProjectionWrite } from '../temporal/publishing/criticalAcknowledgedRepair';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'firebase-admin/firestore';
import type { ProviderMutationResource } from '../temporal/publishing/providerMutationGuard';
import { reserveSubsplashAssociation } from '../temporal/publishing/providerAssociations';
import axios from '../providerSandbox/http';
import { executeProviderCreate, providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import { normalizeSubsplashListPatchAck } from './subsplashMutationAck';
import { assertSynchronousProviderMutationCompleted } from '../temporal/publishing/providerMutationCompletion';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { createAxiosConfig } from '../subsplashUtils';
import {
  SubsplashList,
  SubsplashListRow,
  SubsplashMediaType,
  SubsplashPatchPayload,
  SubsplashListRowPatch,
} from '../types/Subsplash';

export const mediaTypes: SubsplashMediaType[] = [
  'media-item',
  'media-series',
  'song',
  'link',
  'rss',
  'list',
  'album',
  'calendar',
  'event',
];

type FrozenListMutationProgram = { operation: string; step: string; listId: string; writes: FrozenProjectionWrite[] };
type PendingListCanonicalWrite = { path: string; data: Record<string, unknown>; merge?: boolean };
export interface PreparedListMutation {
  listId: string;
  step: string;
  method: 'PATCH' | 'DELETE';
  target: ProviderMutationResource;
  payload: unknown;
  rows: SubsplashListRow[];
}
export type ListProjectionProgramHook = (
  tx: Transaction,
  request: PreparedListMutation
) => Promise<FrozenProjectionWrite[]>;
const listProjectionHooks = new AsyncLocalStorage<ListProjectionProgramHook>();
/** Trusted domain composition, never activated through callable input flags. */
export const runWithListProjectionProgram = <T>(
  hook: ListProjectionProgramHook,
  operation: () => Promise<T>
): Promise<T> => listProjectionHooks.run(hook, operation);
const plainRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const setField = (record: Record<string, unknown>, field: string, value: unknown): void => {
  const parts = field.split('.');
  let cursor = record;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = { ...plainRecord(cursor[part]) };
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
};
/** Capture original desired canonical truth before this exact mutable HTTP claim. */
export async function freezeListMutationProjection(options: {
  listId: string;
  rows: SubsplashListRow[];
  method: 'PATCH' | 'DELETE';
  step: string;
  payload: unknown;
  rowId?: string;
  continuationListId?: string;
  pendingCanonicalWrites?: PendingListCanonicalWrite[];
}): Promise<FrozenListMutationProgram | undefined> {
  if (!isDurablePublishingOperation()) return undefined;
  const operation = getPublishingMutationOperation();
  if (!operation) throw new Error('PROVIDER_MUTATION_PLAN_CONTEXT_REQUIRED');
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const db = admin.firestore();
  let writes: FrozenProjectionWrite[] = [];
  let normalWrites: FrozenProjectionWrite[] = [];
  await runDurableTransaction(db, async (tx) => {
    const physicalMatches = await tx.get(db.collection('lists').where('subsplashId', '==', options.listId).limit(2));
    if (physicalMatches.size !== 1) throw new Error('PUBLISHING_LIST_CANONICAL_SCOPE_AMBIGUOUS');
    const physical = physicalMatches.docs[0],
      physicalData = physical.data();
    const rootId = typeof physicalData.rootListId === 'string' ? physicalData.rootListId : physical.id;
    const root = await tx.get(db.collection('lists').doc(rootId));
    if (!root.exists) throw new Error('PUBLISHING_LIST_CANONICAL_ROOT_MISSING');
    const rootData = root.data()!,
      projection = await tx.get(root.ref.collection('listItems'));
    const content = options.rows.filter(
      (row) =>
        !(row.type === 'list' && row._embedded.list?.id === (options.continuationListId ?? physicalData.moreSermonsRef))
    );
    const contentCount = content.length,
      rootMembershipData = { ...rootData };
    delete rootMembershipData.count;
    delete rootMembershipData.updatedAtMillis;
    let logicalOffset = 0,
      logicalCount = contentCount,
      current = rootId;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) throw new Error('PUBLISHING_LIST_OVERFLOW_CYCLE');
      visited.add(current);
      const node = await tx.get(db.collection('lists').doc(current));
      if (!node.exists) throw new Error('PUBLISHING_LIST_CANONICAL_GRAPH_CHANGED');
      if (node.id !== physical.id) {
        const count = Number(node.get('count')) || 0;
        logicalCount += count;
        if (!visited.has(physical.id)) logicalOffset += count;
      }
      const next = node.get('moreSermonsRef');
      if (typeof next !== 'string' || !next) break;
      const matches = await tx.get(db.collection('lists').where('subsplashId', '==', next).limit(2));
      if (matches.size !== 1) throw new Error('PUBLISHING_LIST_CANONICAL_SCOPE_AMBIGUOUS');
      current = matches.docs[0].id;
    }
    if (!visited.has(physical.id)) throw new Error('PUBLISHING_LIST_CANONICAL_GRAPH_CHANGED');
    writes = [
      { path: physical.ref.path, expectedFields: { subsplashId: options.listId }, patch: { count: contentCount } },
    ];
    if (rootId === physical.id) writes[0].patch.logicalCount = logicalCount;
    else
      writes.push({
        path: root.ref.path,
        expectedFields: { subsplashId: rootData.subsplashId },
        patch: { logicalCount },
      });
    const byMedia = new Map<string, { id: string; data: Record<string, unknown> }>();
    for (const doc of projection.docs) {
      const remote = doc.get('subsplashId');
      if (typeof remote === 'string') {
        if (byMedia.has(remote)) throw new Error('PUBLISHING_LIST_MEDIA_MAPPING_AMBIGUOUS');
        byMedia.set(remote, { id: doc.id, data: doc.data() });
      }
    }
    const desiredMedia = new Set(
      content
        .filter((row) => row.type === 'media-item')
        .map((row) => row._embedded['media-item']?.id)
        .filter((id): id is string => !!id)
    );
    const preservedRowIds = new Set(content.map((row) => row.id).filter((id): id is string => !!id));
    const unresolved = [...desiredMedia].filter((id) => !byMedia.has(id));
    for (let offset = 0; offset < unresolved.length; offset += 10) {
      const sermons = await tx.get(
        db.collection('sermons').where('subsplashId', 'in', unresolved.slice(offset, offset + 10))
      );
      for (const sermon of sermons.docs) {
        const remote = sermon.get('subsplashId');
        if (byMedia.has(remote)) throw new Error('PUBLISHING_LIST_MEDIA_MAPPING_AMBIGUOUS');
        byMedia.set(remote, { id: sermon.id, data: sermon.data() });
      }
    }
    const append = async (
      path: string,
      patch: Record<string, unknown>,
      seed: Record<string, unknown>,
      bindings: NonNullable<FrozenProjectionWrite['listRowBindings']>,
      deleteFields?: string[]
    ) => {
      const snapshot = await tx.get(db.doc(path));
      const expectedFields: Record<string, unknown> = {};
      if (snapshot.exists) {
        for (const field of ['id', 'subsplashId'] as const) {
          const value = snapshot.get(field);
          if (value !== undefined) expectedFields[field] = value;
        }
      }
      const created = { ...seed };
      for (const [field, value] of Object.entries(patch)) setField(created, field, value);
      writes.push(
        snapshot.exists
          ? {
              path,
              expectedFields,
              patch,
              listRowBindings: bindings,
              ...(deleteFields?.length ? { deleteFields } : {}),
            }
          : { path, mode: 'set', expectedExists: false, expectedFields: {}, patch: created, listRowBindings: bindings }
      );
    };
    for (let index = 0; index < content.length; index++) {
      const row = content[index];
      if (row.type !== 'media-item') continue;
      const mediaId = row._embedded['media-item']?.id;
      if (!mediaId) {
        if (row.id) continue;
        throw new Error('PUBLISHING_LIST_ROW_RESOURCE_MISSING');
      }
      const canonical = byMedia.get(mediaId);
      if (!canonical) continue;
      const placement = {
        firestoreListId: physical.id,
        subsplashListId: options.listId,
        overflowDepth: Number(physicalData.overflowDepth) || 0,
        position: row.position,
      };
      const fields = {
        position: logicalOffset + index + 1,
        'uploadStatus.status': uploadStatus.UPLOADED,
        physicalPlacement: placement,
      };
      const rootRow = projection.docs.find((doc) => doc.id === canonical.id);
      const previous = plainRecord(rootRow?.get('physicalPlacement'));
      if (
        rootRow?.get('position') === fields.position &&
        rootRow.get('uploadStatus.status') === uploadStatus.UPLOADED &&
        row.id &&
        rootRow.get('uploadStatus.listItemId') === row.id &&
        Object.entries(placement).every(([key, value]) => previous[key] === value)
      )
        continue;
      await append(`${root.ref.path}/listItems/${canonical.id}`, fields, canonical.data, [
        { field: 'uploadStatus.listItemId', requestStep: options.step, listId: options.listId, mediaId },
        { field: 'physicalPlacement.listItemId', requestStep: options.step, listId: options.listId, mediaId },
      ]);
      await append(
        `sermons/${canonical.id}/sermonLists/${rootId}`,
        { 'uploadStatus.status': uploadStatus.UPLOADED },
        { ...rootMembershipData, id: rootId },
        [{ field: 'uploadStatus.listItemId', requestStep: options.step, listId: options.listId, mediaId }]
      );
    }
    for (const existing of projection.docs) {
      const remote = existing.get('subsplashId'),
        placement = plainRecord(existing.get('physicalPlacement'));
      if (
        existing.get('uploadStatus.status') !== uploadStatus.UPLOADED ||
        placement.subsplashListId !== options.listId ||
        desiredMedia.has(remote) ||
        preservedRowIds.has(existing.get('uploadStatus.listItemId'))
      )
        continue;
      await append(
        existing.ref.path,
        { 'uploadStatus.status': uploadStatus.NOT_UPLOADED },
        {},
        [],
        ['uploadStatus.listItemId', 'physicalPlacement', 'position']
      );
      await append(
        `sermons/${existing.id}/sermonLists/${rootId}`,
        { 'uploadStatus.status': uploadStatus.NOT_UPLOADED },
        { ...rootMembershipData, id: rootId },
        [],
        ['uploadStatus.listItemId']
      );
    }
    for (const pending of options.pendingCanonicalWrites ?? []) {
      if (!/^lists\/[^/]+$/.test(pending.path)) throw new Error('PUBLISHING_LIST_PENDING_SCOPE_INVALID');
      const snapshot = await tx.get(db.doc(pending.path));
      if (
        (pending.path !== physical.ref.path &&
          (pending.data.rootListId !== rootId ||
            (pending.data.subsplashId ?? snapshot.get('subsplashId')) !== options.continuationListId ||
            (snapshot.exists && snapshot.get('rootListId') !== undefined && snapshot.get('rootListId') !== rootId))) ||
        (pending.path === physical.ref.path && pending.data.moreSermonsRef !== options.continuationListId)
      )
        throw new Error('PUBLISHING_LIST_PENDING_SCOPE_INVALID');
      const patch = { ...pending.data };
      if (pending.path === physical.ref.path) {
        delete patch.count;
        delete patch.logicalCount;
      }
      const expectedFields: Record<string, unknown> = {};
      if (snapshot.exists) {
        for (const field of ['id', 'subsplashId', 'rootListId']) {
          const value = snapshot.get(field);
          if (value !== undefined) expectedFields[field] = value;
        }
      }
      writes.push(
        snapshot.exists
          ? { path: pending.path, expectedFields, patch }
          : { path: pending.path, mode: 'set', expectedExists: false, expectedFields: {}, patch }
      );
    }
    const target = {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: options.method === 'DELETE' ? 'list-row' : 'list',
      resourceId: options.rowId ?? options.listId,
    };
    // Parent final writes are frozen now, but its normal execution owns their
    // timing after the nested domain has finished refreshing intermediate state.
    normalWrites = [...writes];
    const hook = listProjectionHooks.getStore();
    if (hook)
      writes.push(
        ...(await hook(tx, {
          listId: options.listId,
          step: options.step,
          method: options.method,
          target,
          payload: options.payload,
          rows: options.rows,
        }))
      );
    const verificationRows = options.rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      type: row.type,
      position: row.position,
      ...(row._embedded[row.type]?.id ? { _embedded: { [row.type]: { id: row._embedded[row.type]!.id } } } : {}),
    }));
    const providerFields =
      options.method === 'DELETE'
        ? {}
        : {
            id: options.listId,
            app_key: '9XTSHD',
            '_embedded.list-rows': verificationRows,
          };
    const frozen = await prepareAcknowledgedProjectionPlan(tx, {
      operation,
      completesActivity: false,
      requests: [
        {
          step: options.step,
          method: options.method,
          target,
          payload: options.payload,
          fingerprint: publishingMutationRequestFingerprint({
            method: options.method,
            target,
            payload: options.payload,
          }),
        },
      ],
      writes,
      verifications:
        options.method === 'DELETE'
          ? [
              { ...target, resourceType: 'list-row', expectedState: 'absent', expectedProviderFields: {} },
              {
                provider: 'subsplash',
                account: 'app:9XTSHD',
                resourceType: 'list',
                resourceId: options.listId,
                expectedProviderFields: {
                  id: options.listId,
                  app_key: '9XTSHD',
                  '_embedded.list-rows': verificationRows,
                },
              },
            ]
          : [{ ...target, resourceType: 'list', expectedProviderFields: providerFields }],
    });
    frozen.commit();
  });
  return { operation, step: options.step, listId: options.listId, writes: normalWrites };
}

/** Original ACK remains private even if this original actor can no longer project. */
export async function commitListMutationProjection(
  program: FrozenListMutationProgram | undefined,
  rows: SubsplashListRow[],
  token: string
): Promise<void> {
  if (!program) return;
  let actualRows = rows;
  if (
    program.writes.some((write) =>
      write.listRowBindings?.some(
        (binding) =>
          !actualRows.some(
            (row) => row.id && row.type === 'media-item' && row._embedded['media-item']?.id === binding.mediaId
          )
      )
    )
  )
    actualRows = await getFullListRows(program.listId, token);
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const { FieldValue } = await import('firebase-admin/firestore');
  const db = admin.firestore();
  const { acknowledgedProjectionDigest } = await import('../temporal/publishing/criticalAcknowledgedRepair');
  for (let offset = 0; offset < program.writes.length; offset += 64) {
    const chunk = program.writes.slice(offset, offset + 64);
    await runDurableTransaction(db, async (tx) => {
      const snapshots = await tx.getAll(...chunk.map((write) => db.doc(write.path)));
      const ready = chunk.map((write, index) => {
        const snapshot = snapshots[index];
        if (
          snapshot.exists !== (write.expectedExists ?? true) ||
          (write.expectedDocumentDigest !== undefined &&
            acknowledgedProjectionDigest(snapshot.data()) !== write.expectedDocumentDigest) ||
          Object.entries(write.expectedFields).some(
            ([field, value]) => providerPayloadFingerprint(snapshot.get(field)) !== providerPayloadFingerprint(value)
          )
        )
          throw new Error('PUBLISHING_LIST_CANONICAL_GRAPH_CHANGED');
        const patch = { ...write.patch };
        for (const binding of write.listRowBindings ?? []) {
          const matches = actualRows.filter(
            (row) => row.type === 'media-item' && row._embedded['media-item']?.id === binding.mediaId
          );
          if (
            matches.length !== 1 ||
            !matches[0].id ||
            matches[0].app_key !== '9XTSHD' ||
            matches[0]._embedded['source-list']?.id !== binding.listId
          )
            throw new Error('PUBLISHING_LIST_ACK_ROW_ID_UNPROVEN');
          if (write.mode === 'set') setField(patch, binding.field, matches[0].id);
          else patch[binding.field] = matches[0].id;
        }
        return { write, patch };
      });
      for (const { write, patch } of ready) {
        for (const field of write.deleteFields ?? []) patch[field] = FieldValue.delete();
        if (write.mode === 'delete') tx.delete(db.doc(write.path));
        else if (write.mode === 'set') tx.set(db.doc(write.path), patch);
        else tx.update(db.doc(write.path), patch);
      }
    });
  }
}

type SubsplashRequestContext = {
  operation: string;
  url: string;
  method: string;
  listId?: string;
  rowId?: string;
};

const getAxiosStatus = (error: unknown): number | undefined =>
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined;

const getAxiosData = (error: unknown): unknown =>
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { data?: unknown } }).response?.data
    : undefined;

const isTransientSubsplashError = (status?: number): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getConfigUrl = (config: ReturnType<typeof createAxiosConfig>): string => config.url ?? 'unknown-url';

async function runSubsplashRequest<T>(
  config: ReturnType<typeof createAxiosConfig>,
  context: SubsplashRequestContext
): Promise<T> {
  const maxAttempts = context.method === 'GET' ? 3 : 1;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await axios(config);
      return response.data as T;
    } catch (error) {
      lastError = error;
      const upstreamStatus = getAxiosStatus(error);
      const upstream = getAxiosData(error);
      const isRetryable = isTransientSubsplashError(upstreamStatus);

      logger.warn('Subsplash request failed', {
        ...context,
        attempt,
        maxAttempts,
        upstreamStatus,
        upstream,
        isRetryable,
      });

      if (!isRetryable || attempt >= maxAttempts) {
        throw new HttpsError(
          'internal',
          `Subsplash ${context.operation} failed for list ${context.listId ?? 'unknown'}`,
          {
            code: 'SUBSPLASH_REQUEST_FAILED',
            operation: context.operation,
            method: context.method,
            url: context.url,
            ...(context.listId ? { listId: context.listId } : {}),
            ...(context.rowId ? { rowId: context.rowId } : {}),
            ...(typeof upstreamStatus === 'number' ? { upstream_status: upstreamStatus } : {}),
            ...(upstream !== undefined ? { upstream } : {}),
          }
        );
      }

      await sleep(250 * attempt);
    }
  }

  throw lastError;
}

export async function getFullListRows(listId: string, token: string): Promise<SubsplashListRow[]> {
  // Max page size is 200, which is also the list limit, so one call is enough usually.
  // Include unlisted items to get the true total count (unlisted items count toward the 200 limit)
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&filter[unlisted]=include&page[size]=200&sort=position`,
    token,
    'GET'
  );
  const response = await runSubsplashRequest<{ _embedded: { 'list-rows': SubsplashListRow[] } }>(listConfig, {
    operation: 'getListRows',
    method: 'GET',
    url: getConfigUrl(listConfig),
    listId,
  });
  return response['_embedded']['list-rows'];
}

export async function getFullListRowsWithTotal(
  listId: string,
  token: string
): Promise<{ rows: SubsplashListRow[]; total: number }> {
  // Max page size is 200, which is also the list limit, so one call is enough usually.
  // Include unlisted items to get the true total count (unlisted items count toward the 200 limit)
  const listConfig = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${listId}&filter[unlisted]=include&page[size]=200&sort=position`,
    token,
    'GET'
  );
  const response = await runSubsplashRequest<{ _embedded?: { 'list-rows'?: SubsplashListRow[] }; total?: number }>(
    listConfig,
    {
      operation: 'getListRowsWithTotal',
      method: 'GET',
      url: getConfigUrl(listConfig),
      listId,
    }
  );
  const rows = response._embedded?.['list-rows'] || [];
  const total = response.total ?? rows.length;
  return {
    rows,
    total,
  };
}

export type ReconciledSubsplashListState = {
  listDetails: SubsplashList;
  rows: SubsplashListRow[];
  materializedRowCount: number;
  listRowsCount: number;
  enforcedRowCount: number;
  phantomRowCount: number;
  maxItemCount: number;
};

export async function getReconciledListState(listId: string, token: string): Promise<ReconciledSubsplashListState> {
  const [listDetails, { rows }] = await Promise.all([
    getListDetails(listId, token),
    getFullListRowsWithTotal(listId, token),
  ]);

  const materializedRowCount = rows.length;
  const listRowsCount = Math.max(0, listDetails.list_rows_count ?? 0);
  const enforcedRowCount = Math.max(listRowsCount, materializedRowCount);
  const maxItemCount = listDetails.max_item_count ?? enforcedRowCount;
  const phantomRowCount = Math.max(0, enforcedRowCount - materializedRowCount);

  if (phantomRowCount > 0) {
    logger.warn('Subsplash list count mismatch detected', {
      listId,
      listRowsCount,
      materializedRowCount,
      enforcedRowCount,
      phantomRowCount,
      maxItemCount,
    });
  }

  return {
    listDetails,
    rows,
    materializedRowCount,
    listRowsCount,
    enforcedRowCount,
    phantomRowCount,
    maxItemCount,
  };
}

export async function getListDetails(listId: string, token: string): Promise<SubsplashList> {
  const config = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${listId}`, token, 'GET');
  return await runSubsplashRequest<SubsplashList>(config, {
    operation: 'getListDetails',
    method: 'GET',
    url: getConfigUrl(config),
    listId,
  });
}

export async function createNewList(
  title: string,
  token: string,
  subtitle?: string,
  operationKey?: string
): Promise<SubsplashList> {
  const payload: Record<string, unknown> = {
    app_key: '9XTSHD',
    title: title,
    type: 'standard',
    status: 'published',
  };

  if (subtitle) {
    payload.subtitle = subtitle;
  }

  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists`,
    token,
    'POST',
    JSON.stringify(payload)
  );

  Object.assign(config, { skipSubsplashEdgeRetry: true });
  const execute = () =>
    runSubsplashRequest<SubsplashList>(config, {
      operation: 'createList',
      method: 'POST',
      url: getConfigUrl(config),
    });
  return operationKey
    ? executeProviderCreate({ operationKey, step: 'overflow-list-create', payload, execute })
    : execute();
}

export function createListRow(
  item: { id: string; type: SubsplashMediaType },
  listId: string,
  position: number
): SubsplashListRow {
  return {
    app_key: '9XTSHD',
    method: 'static',
    position,
    type: item.type,
    _embedded: {
      [item.type]: { id: item.id },
      'source-list': { id: listId },
    },
  };
}

export async function patchListRows(
  listId: string,
  rows: SubsplashListRow[],
  token: string,
  options?: {
    forceFullRows?: boolean;
    /** Server-derived overflow routing; never supplied by a public callable. */
    continuationListId?: string;
    pendingCanonicalWrites?: PendingListCanonicalWrite[];
  }
): Promise<SubsplashListRow[]> {
  logger.log(`Patching list ${listId} with ${rows.length} rows`);

  // Get current list details to preserve display-options and images
  const currentList = await getListDetails(listId, token);

  // Build list-rows array: existing rows use {id, position}, new rows use full object
  // Ensure positions are correct 1..N
  const reindexedRows: SubsplashListRowPatch[] = rows.map((row, index) => {
    const position = index + 1;

    // If row has an ID, it's an existing row - send only {id, position} (matching HAR file)
    if (row.id && !options?.forceFullRows) {
      return {
        id: row.id,
        position,
      };
    }

    // If row doesn't have an ID, it's a new row - send full object
    return {
      ...row,
      position,
    };
  });

  // Build payload matching HAR file structure
  const payload: SubsplashPatchPayload = {
    id: listId,
    list_rows_count: reindexedRows.length,
    _embedded: {
      // Preserve existing display-options if they exist
      ...(currentList._embedded['display-options']
        ? {
            'display-options': currentList._embedded['display-options'].map((opt: { id: string }) => ({
              id: opt.id,
            })),
          }
        : {}),
      // Preserve existing images if they exist
      ...(currentList._embedded.images
        ? {
            images: currentList._embedded.images.map((img: { id: string; type: string }) => ({
              id: img.id,
              type: img.type,
            })),
          }
        : {}),
      'list-rows': reindexedRows,
    },
  };

  const config = createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${listId}`, token, 'PATCH', payload);

  const associationIds = [listId, ...(currentList._embedded.images ?? []).map((image) => image.id)];
  for (const row of rows) {
    for (const type of ['media-item', 'media-series', 'list'] as const) {
      const embedded = row._embedded?.[type];
      if (embedded?.id) associationIds.push(embedded.id);
    }
  }
  const step = `patch-list-rows:${listId}:${providerPayloadFingerprint(payload)}`;
  const desiredRows = rows.map((row, index) => ({ ...row, position: index + 1 }));
  const program = await freezeListMutationProjection({
    listId,
    rows: desiredRows,
    method: 'PATCH',
    step,
    payload,
    continuationListId: options?.continuationListId,
    pendingCanonicalWrites: options?.pendingCanonicalWrites,
  });
  await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL', {
    provider: 'subsplash',
    resourceType: 'list',
    resourceId: listId,
    accountId: 'app:9XTSHD',
    method: 'PATCH',
    requestFingerprint: providerPayloadFingerprint(payload),
  });
  await reserveSubsplashAssociation(`listrows:${listId}`, associationIds, payload, {
    target: { provider: 'subsplash', kind: 'list', remoteId: listId },
  });
  try {
    Object.assign(config, { skipSubsplashEdgeRetry: true, maxRedirects: 0 });
    const response = await runPublishingProviderMutation<{ _embedded?: { 'list-rows'?: SubsplashListRow[] } } | null>({
      operation: getPublishingMutationOperation() ?? 'legacy-list-mutation',
      step,
      target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: listId },
      method: 'PATCH',
      payload,
      send: async () => {
        const response = await axios(config);
        assertSynchronousProviderMutationCompleted(response);
        return { completion: 'acknowledged', result: normalizeSubsplashListPatchAck(response.data, listId) };
      },
    });
    const patchedRows = response?._embedded?.['list-rows'];
    if (Array.isArray(patchedRows)) {
      await commitListMutationProjection(program, patchedRows, token);
      return patchedRows as SubsplashListRow[];
    }

    const fallback = rows.map((row, index) => ({
      ...row,
      position: index + 1,
    }));
    await commitListMutationProjection(program, fallback, token);
    return fallback;
  } catch (error: unknown) {
    logger.error(`Failed to patch list ${listId}`, getAxiosData(error) ?? error);
    throw error;
  }
}

export async function deleteListRow(rowId: string, listId: string, token: string): Promise<void> {
  const payload = { id: rowId, listId };
  const step = `delete-list-row:${rowId}:${providerPayloadFingerprint(payload)}`;
  const originalRows = isDurablePublishingOperation() ? await getFullListRows(listId, token) : [];
  const remainingRows = originalRows.filter((row) => row.id !== rowId);
  const program = await freezeListMutationProjection({
    listId,
    rows: remainingRows,
    method: 'DELETE',
    step,
    payload,
    rowId,
  });
  await markPublishingCritical('PUBLISHING_DELETE_CRITICAL', {
    provider: 'subsplash',
    resourceType: 'list-row',
    resourceId: rowId,
    accountId: 'app:9XTSHD',
    method: 'DELETE',
  });
  const config = createAxiosConfig(`https://core.subsplash.com/builder/v1/list-rows/${rowId}`, token, 'DELETE');

  Object.assign(config, { skipSubsplashEdgeRetry: true, maxRedirects: 0 });
  await runPublishingProviderMutation({
    operation: getPublishingMutationOperation() ?? 'legacy-list-mutation',
    step,
    target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list-row', resourceId: rowId },
    method: 'DELETE',
    payload,
    send: async () => {
      assertSynchronousProviderMutationCompleted(await axios(config));
      return { completion: 'acknowledged', result: null };
    },
  });
  await commitListMutationProjection(program, remainingRows, token);
}
