import type { Firestore, Transaction, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint as hash,
  type ProviderMutationResource,
  type ProviderMutationSession,
} from './providerMutationGuard';
import type { ProviderReceipt } from './providerReceipts';

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
function reject(): never {
  throw new Error('PROVIDER_MUTATION_TARGET_UNPROVEN');
}
const same = (a: ProviderMutationResource, b: ProviderMutationResource): boolean =>
  a.provider === b.provider &&
  a.account === b.account &&
  a.resourceId === b.resourceId &&
  a.resourceType === b.resourceType;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const receiptCanonical = (value: unknown): unknown =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
    ? value.map((v) => receiptCanonical(v) ?? null)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, receiptCanonical(v)])
      )
    : value;
const receiptHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(receiptCanonical(value)) ?? 'null')
    .digest('hex');
export interface PublishingMutationTargetReader {
  getList(id: string): Promise<Data>;
  /** Complete authenticated parent-filtered collection, including unlisted rows. */
  getListRows(id: string): Promise<Data[]>;
}
interface SourceSnapshot {
  path: string;
  fingerprint: string;
}
interface QuerySnapshot {
  field: string;
  value: string;
  fingerprint: string;
}
const issued = new WeakSet<object>();
export interface PublishingMutationTargetProof {
  readonly kind: 'planned' | 'list_row' | 'created_overflow';
  readonly target: ProviderMutationResource;
  readonly rootResource: ProviderMutationResource;
  readonly proofHash: string;
  readonly canonicalPaths: readonly string[];
  readonly receiptId?: string;
}
interface InternalProof extends PublishingMutationTargetProof {
  readonly db: Firestore;
  readonly sessionId: string;
  readonly sessionFingerprint: string;
  readonly sessionResourcesFingerprint: string;
  readonly sources: readonly SourceSnapshot[];
  readonly queries: readonly QuerySnapshot[];
}

async function defaultReader(): Promise<PublishingMutationTargetReader> {
  const [{ default: axios }, { authenticateSubsplash, createAxiosConfig }] = await Promise.all([
    import('axios'),
    import('../../subsplashUtils'),
  ]);
  const token = await authenticateSubsplash();
  const read = async (url: string): Promise<Data> =>
    object((await axios({ ...createAxiosConfig(url, token, 'GET'), maxRedirects: 0 })).data);
  return {
    getList: (id) => read(`https://core.subsplash.com/builder/v1/lists/${encodeURIComponent(id)}`),
    async getListRows(id) {
      const rows: Data[] = [],
        seen = new Set<string>();
      for (let page = 1; ; page++) {
        const result = await read(
          `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${encodeURIComponent(
            id
          )}&filter[unlisted]=include&page[size]=200&page[number]=${page}&sort=position`
        );
        const values = object(result._embedded)['list-rows'];
        if (!Array.isArray(values)) reject();
        for (const value of values as unknown[]) {
          const row = object(value);
          if (!validId(row.id) || seen.has(row.id)) reject();
          seen.add(row.id);
          rows.push(row);
        }
        const total = result.total;
        if (total !== undefined && (!Number.isInteger(total) || Number(total) < rows.length)) reject();
        if ((values as unknown[]).length < 200) {
          if (total !== undefined && Number(total) !== rows.length) reject();
          if (object(result._links).next) reject();
          return rows;
        }
      }
    },
  };
}
const validateList = (data: Data, id: string): void => {
  if (data.id !== id || data.app_key !== '9XTSHD') reject();
};

/** Server verifier only. A payload's claimed parent is never evidence of ownership. */
export async function verifyPublishingMutationTarget(options: {
  db: Firestore;
  ref: DurableJobRef;
  session: ProviderMutationSession;
  target: ProviderMutationResource;
  parentHint?: string;
  reader?: PublishingMutationTargetReader;
}): Promise<PublishingMutationTargetProof> {
  const { db, ref, session, target } = options;
  if (
    session.db !== db ||
    session.scope.projectId !== ref.projectId ||
    session.scope.jobId !== ref.jobId ||
    session.id !== hash(session.scope) ||
    !validId(target.resourceId)
  )
    reject();
  const snapshot = await db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).get();
  const stored = snapshot.data();
  if (
    !stored ||
    stored.state !== 'active' ||
    hash(stored.scope) !== hash(session.scope) ||
    hash(stored.resources) !== hash(session.resources)
  )
    reject();
  const sourceSnapshots = new Map<string, SourceSnapshot>();
  const querySnapshots: QuerySnapshot[] = [];
  const findList = async (remoteId: string) => {
    const result = await db.collection('lists').where('subsplashId', '==', remoteId).limit(2).get();
    querySnapshots.push({
      field: 'subsplashId',
      value: remoteId,
      fingerprint: hash(
        result.docs
          .map((doc) => ({ path: doc.ref.path, data: doc.data() }))
          .sort((a, b) => a.path.localeCompare(b.path))
      ),
    });
    return result;
  };
  const read = async (path: string): Promise<Data> => {
    const doc = await db.doc(path).get();
    if (!doc.exists) reject();
    const data = doc.data()!;
    sourceSnapshots.set(path, { path, fingerprint: hash(data) });
    return data;
  };
  const finish = (
    kind: PublishingMutationTargetProof['kind'],
    rootResource: ProviderMutationResource,
    evidence: unknown,
    receiptId?: string
  ): PublishingMutationTargetProof => {
    const sources = [...sourceSnapshots.values()].sort((a, b) => a.path.localeCompare(b.path));
    const sessionFingerprint = hash(stored);
    const queries = Object.freeze(querySnapshots.map((query) => Object.freeze(query)));
    const publicProof: PublishingMutationTargetProof = {
      kind,
      target: Object.freeze({ ...target }),
      rootResource: Object.freeze({ ...rootResource }),
      proofHash: hash({
        kind,
        target,
        rootResource,
        sessionId: session.id,
        sessionFingerprint,
        sources,
        queries,
        evidence,
        receiptId,
      }),
      canonicalPaths: Object.freeze(sources.map((source) => source.path)),
      ...(receiptId ? { receiptId } : {}),
    };
    // Private SDK handles and canonical snapshots never enter serialized audits.
    Object.defineProperties(publicProof, {
      db: { value: db },
      sessionId: { value: session.id },
      sessionFingerprint: { value: sessionFingerprint },
      sessionResourcesFingerprint: { value: hash(session.resources) },
      sources: { value: Object.freeze(sources) },
      queries: { value: queries },
    });
    const value = Object.freeze(publicProof) as InternalProof;
    issued.add(value);
    return value;
  };
  const planned = session.resources.find((resource) => same(resource, target));
  if (planned) return finish('planned', planned, { planned: true });
  if (
    target.provider !== 'subsplash' ||
    target.account !== 'app:9XTSHD' ||
    !['list', 'list-row'].includes(target.resourceType)
  )
    reject();
  const heldLists = session.resources.filter(
    (resource) =>
      resource.provider === 'subsplash' && resource.account === 'app:9XTSHD' && resource.resourceType === 'list'
  );
  if (!heldLists.length) reject();
  const reader = options.reader ?? (await defaultReader());
  if (target.resourceType === 'list-row') {
    let candidates = options.parentHint
      ? heldLists.filter((resource) => resource.resourceId === options.parentHint)
      : heldLists;
    let descendantParent: InternalProof | undefined;
    if (!candidates.length && validId(options.parentHint)) {
      // An unplanned parent must independently prove original creation under this
      // held root. A supplied parent ID still grants no authority on its own.
      const parentTarget: ProviderMutationResource = {
        ...target,
        resourceType: 'list',
        resourceId: options.parentHint,
      };
      descendantParent = (await verifyPublishingMutationTarget({
        ...options,
        target: parentTarget,
        parentHint: undefined,
        reader,
      })) as InternalProof;
      if (descendantParent.kind !== 'created_overflow' || descendantParent.sessionFingerprint !== hash(stored))
        reject();
      for (const source of descendantParent.sources) sourceSnapshots.set(source.path, source);
      querySnapshots.push(...descendantParent.queries);
      candidates = [parentTarget];
    }
    if (!candidates.length) reject();
    for (const parent of candidates) {
      const metadata = await reader.getList(parent.resourceId);
      validateList(metadata, parent.resourceId);
      const rows = await reader.getListRows(parent.resourceId);
      const matches = rows.filter((row) => row.id === target.resourceId);
      if (!matches.length) continue;
      if (matches.length !== 1) reject();
      const row = matches[0],
        embedded = object(row._embedded),
        source = object(embedded['source-list']);
      if (
        (row.app_key !== undefined && row.app_key !== '9XTSHD') ||
        !['media-item', 'media-series', 'song', 'link', 'rss', 'list', 'album', 'calendar', 'event'].includes(
          String(row.type)
        ) ||
        (source.id !== undefined && source.id !== parent.resourceId) ||
        (source.app_key !== undefined && source.app_key !== '9XTSHD')
      )
        reject();
      return finish(
        'list_row',
        descendantParent?.rootResource ?? parent,
        { row, parent: { id: metadata.id, app_key: metadata.app_key } },
        descendantParent?.receiptId
      );
    }
    return reject();
  }
  // A newly created list is covered only through original confirmed creation and
  // a canonical chain anchored at the session's actually held logical root.
  const matches = await findList(target.resourceId);
  if (matches.size !== 1) reject();
  const targetDoc = matches.docs[0],
    targetData = await read(targetDoc.ref.path);
  if (
    targetDoc.ref.path !== `lists/${targetDoc.id}` ||
    !validId(targetData.rootListId) ||
    targetData.rootListId === targetDoc.id
  )
    reject();
  const rootData = await read(`lists/${targetData.rootListId}`);
  const root = heldLists.find((resource) => resource.resourceId === rootData.subsplashId);
  if (!root) reject();
  const visited = new Set<string>();
  let currentId = targetData.rootListId as string;
  for (;;) {
    if (visited.has(currentId)) reject();
    visited.add(currentId);
    const data = await read(`lists/${currentId}`);
    if (currentId !== targetData.rootListId && data.rootListId !== targetData.rootListId) reject();
    if (currentId === targetDoc.id) break;
    if (!validId(data.moreSermonsRef)) reject();
    const next = await findList(data.moreSermonsRef);
    if (next.size !== 1 || next.docs[0].ref.path !== `lists/${next.docs[0].id}`) reject();
    currentId = next.docs[0].id;
  }
  const query = db
    .collection('temporalProviderReceipts')
    .where('projectId', '==', ref.projectId)
    .where('jobId', '==', ref.jobId)
    .orderBy('__name__')
    .limit(400);
  let cursor: QueryDocumentSnapshot | undefined, receiptId: string | undefined;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      const receipt = doc.data() as ProviderReceipt;
      const result = object(receipt.result);
      if (
        !['overflow-list-create', 'list-create'].includes(receipt.step) ||
        (result.id ?? result.listId) !== target.resourceId
      )
        continue;
      const qualified =
        typeof receipt.operationKey === 'string'
          ? /^durable:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([^\s/]{1,1024})$/.exec(
              receipt.operationKey
            )
          : null;
      if (
        receiptId ||
        receipt.state !== 'confirmed' ||
        receipt.projectId !== ref.projectId ||
        receipt.jobId !== ref.jobId ||
        qualified?.[1] !== ref.projectId ||
        qualified?.[2] !== ref.jobId ||
        doc.id !== receiptHash([receipt.operationKey, receipt.step]) ||
        typeof receipt.owner !== 'string' ||
        !receipt.owner ||
        !Number.isInteger(receipt.revision) ||
        Number(receipt.revision) < 1 ||
        receipt.resolvedBy ||
        receipt.adoptionAudit ||
        receipt.resolutionCommandId ||
        receipt.providerAccount?.provider !== 'subsplash' ||
        receipt.providerAccount.account !== 'app:9XTSHD' ||
        object(receipt.intentPayload).app_key !== '9XTSHD' ||
        (result.app_key !== undefined && result.app_key !== '9XTSHD') ||
        receipt.fingerprint !== receiptHash(receipt.intentPayload)
      )
        reject();
      receiptId = doc.id;
      await read(doc.ref.path);
    }
    if (page.size < 400) break;
    cursor = page.docs[page.docs.length - 1];
  }
  if (!receiptId) reject();
  const remote = await reader.getList(target.resourceId);
  validateList(remote, target.resourceId);
  return finish('created_overflow', root!, { id: remote.id, app_key: remote.app_key }, receiptId);
}

/** Invoke in the fenced mutation-claim transaction, before its first write. */
export async function assertPublishingMutationTargetProofCurrent(
  tx: Transaction,
  proof: PublishingMutationTargetProof
): Promise<void> {
  if (!issued.has(proof)) reject();
  const internal = proof as InternalProof;
  const session = await tx.get(internal.db.collection(PROVIDER_MUTATION_SESSIONS).doc(internal.sessionId));
  if (session.get('state') !== 'active' || hash(session.data()) !== internal.sessionFingerprint) reject();
  for (const source of internal.sources) {
    const snapshot = await tx.get(internal.db.doc(source.path));
    if (!snapshot.exists || hash(snapshot.data()) !== source.fingerprint) reject();
  }
  for (const query of internal.queries) {
    const current = await tx.get(internal.db.collection('lists').where(query.field, '==', query.value).limit(2));
    if (
      hash(
        current.docs
          .map((doc) => ({ path: doc.ref.path, data: doc.data() }))
          .sort((a, b) => a.path.localeCompare(b.path))
      ) !== query.fingerprint
    )
      reject();
  }
}

/** Prevent a valid proof for one active session being reused in another claim. */
export async function assertPublishingMutationTargetProofForSession(
  tx: Transaction,
  proof: PublishingMutationTargetProof,
  session: ProviderMutationSession
): Promise<void> {
  if (!issued.has(proof)) reject();
  const internal = proof as InternalProof;
  if (
    internal.db !== session.db ||
    internal.sessionId !== session.id ||
    session.id !== hash(session.scope) ||
    internal.sessionResourcesFingerprint !== hash(session.resources)
  )
    reject();
  await assertPublishingMutationTargetProofCurrent(tx, proof);
}
