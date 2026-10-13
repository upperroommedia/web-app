import { createHash, randomUUID } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

/** Private, non-expiring: a provider RPC can outlive every local lease and worker. */
export const PROVIDER_MUTATION_SESSIONS = 'temporalProviderMutationSessions';
export const PROVIDER_MUTATION_LOCKS = 'temporalProviderMutationLocks';
export const PROVIDER_MUTATION_FACTS = 'temporalProviderMutationFacts';
export interface ProviderMutationResource {
  provider: 'subsplash' | 'soundcloud';
  account: string;
  resourceType: string;
  resourceId: string;
}
export interface ProviderMutationScope {
  projectId: string;
  jobId: string;
  operation: string;
}
export interface ProviderMutationSession {
  db: Firestore;
  id: string;
  scope: ProviderMutationScope;
  resources: ProviderMutationResource[];
}
export type ProviderMutationFence = (transaction: Transaction) => Promise<void>;
export type ProviderMutationTransactionRunner = <T>(mutate: (transaction: Transaction) => Promise<T>) => Promise<T>;
interface FencedOptions {
  assertCurrentInTransaction?: ProviderMutationFence;
  transactionRunner?: ProviderMutationTransactionRunner;
}
async function runFenced<T>(
  db: Firestore,
  options: FencedOptions,
  mutate: (tx: Transaction) => Promise<T>
): Promise<T> {
  if (options.transactionRunner)
    return options.transactionRunner(async (tx) => {
      if (options.assertCurrentInTransaction) await options.assertCurrentInTransaction(tx);
      return mutate(tx);
    });
  if (!options.assertCurrentInTransaction) throw new Error('PROVIDER_MUTATION_CURRENT_FENCE_REQUIRED');
  return db.runTransaction(async (tx) => {
    await options.assertCurrentInTransaction!(tx);
    return mutate(tx);
  });
}
interface SessionRecord {
  schemaVersion: 1;
  scope: ProviderMutationScope;
  resourceKeys: string[];
  resources: ProviderMutationResource[];
  state: 'active' | 'committed' | 'aborted';
  createdAtMillis: number;
  effectsClosed?: boolean;
}
interface MutationRecord {
  state: 'sending' | 'unknown' | 'acknowledged' | 'acknowledged_unprojectable' | 'rejected_no_effect';
  fingerprint: string;
  method: string;
  executionId: string;
  claim: string;
  result?: unknown;
}
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ProviderMutationGuardError('PROVIDER_MUTATION_PAYLOAD_INVALID');
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  throw new ProviderMutationGuardError('PROVIDER_MUTATION_PAYLOAD_INVALID');
};
export const providerMutationFingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'null')
    .digest('hex');
/** Versioned terminal claim chain supports independent bounded source catalogue compilation.
 * Callers fold exact original request document IDs in lexicographic order, without omissions. */
export interface ProviderMutationClaimSummary {
  requestId: string;
  step: string;
  method: string;
  fingerprint: string;
  claim: string;
  executionId: string;
  state: 'acknowledged' | 'rejected_no_effect';
}
export function providerMutationClaimSetSeed(sessionId: string): string {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) throw blocked();
  return providerMutationFingerprint(['provider_mutation_claim_set', 2, sessionId]);
}
export function providerMutationClaimSetFold(previous: string, record: ProviderMutationClaimSummary): string {
  if (
    !/^[a-f0-9]{64}$/.test(previous) ||
    !/^[a-f0-9]{64}$/.test(record.requestId) ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    !['acknowledged', 'rejected_no_effect'].includes(record.state)
  )
    throw blocked();
  [record.step, record.method, record.claim, record.executionId].forEach(validate);
  return providerMutationFingerprint([
    previous,
    {
      requestId: record.requestId,
      step: record.step,
      method: record.method,
      fingerprint: record.fingerprint,
      claim: record.claim,
      executionId: record.executionId,
      state: record.state,
    },
  ]);
}
const validate = (value: string): void => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n]/.test(value))
    throw new Error('PROVIDER_MUTATION_ID_INVALID');
};
const resourceKey = (scope: ProviderMutationScope, resource: ProviderMutationResource): string =>
  providerMutationFingerprint([scope.projectId, resource.provider, resource.account, resource.resourceId]);
export class ProviderMutationGuardError extends Error {
  readonly code: string;
  readonly mutationSessionId?: string;
  constructor(code = 'PROVIDER_MUTATION_UNRESOLVED', sessionId?: string) {
    super(code);
    this.name = 'ProviderMutationGuardError';
    this.code = code;
    if (sessionId && /^[a-f0-9]{64}$/.test(sessionId)) this.mutationSessionId = sessionId;
  }
}
const blocked = (sessionId?: string): ProviderMutationGuardError =>
  new ProviderMutationGuardError('PROVIDER_MUTATION_UNRESOLVED', sessionId);
/** Firestore limits are bytes, not resource counts. Leave room for protobuf/index overhead and fence writes.
 * https://docs.cloud.google.com/firestore/docs/release-notes#March_29_2023
 * https://firebase.google.com/docs/firestore/quotas */
export const PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET = 1024 * 1024 - 64 * 1024;
export const PROVIDER_MUTATION_REQUEST_BYTE_BUDGET = 8 * 1024 * 1024;
export function assertProviderMutationByteBudgets(documents: Array<{ path: string; data: unknown }>): {
  largestDocumentBytes: number;
  requestBytes: number;
} {
  let largestDocumentBytes = 0,
    requestBytes = 2048;
  for (const document of documents) {
    // Fourfold JSON allowance is deliberately conservative for Firestore field/value and index encoding.
    const documentBytes = 4 * Buffer.byteLength(JSON.stringify(canonical(document.data)) ?? 'null', 'utf8') + 2048;
    largestDocumentBytes = Math.max(largestDocumentBytes, documentBytes);
    requestBytes += documentBytes + 4 * Buffer.byteLength(document.path, 'utf8') + 1024;
  }
  if (
    largestDocumentBytes > PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET ||
    requestBytes > PROVIDER_MUTATION_REQUEST_BYTE_BUDGET
  )
    throw new ProviderMutationGuardError('PROVIDER_MUTATION_PLAN_TOO_LARGE');
  return { largestDocumentBytes, requestBytes };
}
async function readDocumentsInChunks(
  tx: Transaction,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const result: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let offset = 0; offset < refs.length; offset += 200)
    result.push(...(await tx.getAll(...refs.slice(offset, offset + 200))));
  return result;
}
async function readLockOwners(
  tx: Transaction,
  db: Firestore,
  locks: FirebaseFirestore.DocumentSnapshot[]
): Promise<Map<string, FirebaseFirestore.DocumentSnapshot>> {
  const ids = new Set<string>();
  for (const lock of locks) {
    if (!lock.exists) continue;
    if (
      lock.get('state') !== 'held' ||
      typeof lock.get('sessionId') !== 'string' ||
      !/^[a-f0-9]{64}$/.test(lock.get('sessionId'))
    )
      throw blocked();
    ids.add(lock.get('sessionId'));
  }
  const owners = await readDocumentsInChunks(
    tx,
    [...ids].map((id) => db.collection(PROVIDER_MUTATION_SESSIONS).doc(id))
  );
  return new Map(owners.map((owner) => [owner.id, owner]));
}
const assertSession = async (tx: Transaction, session: ProviderMutationSession): Promise<SessionRecord> => {
  const ref = session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id);
  const snap = await tx.get(ref);
  const record = snap.data() as SessionRecord | undefined;
  if (
    !record ||
    record.schemaVersion !== 1 ||
    providerMutationFingerprint(record.scope) !== providerMutationFingerprint(session.scope) ||
    providerMutationFingerprint(record.resourceKeys) !==
      providerMutationFingerprint(session.resources.map((r) => resourceKey(session.scope, r))) ||
    providerMutationFingerprint(record.resources) !== providerMutationFingerprint(session.resources)
  )
    throw blocked(session.id);
  const locks = await readDocumentsInChunks(
    tx,
    record.resourceKeys.map((key) => session.db.collection(PROVIDER_MUTATION_LOCKS).doc(key))
  );
  if (
    record.state === 'active' &&
    locks.some((lock) => lock.get('sessionId') !== session.id || lock.get('state') !== 'held')
  )
    throw blocked(session.id);
  return record;
};
/** Acquire the complete resource set atomically. Never acquire additional resources while holding a set. */
export async function acquireProviderMutationSession(options: {
  db: Firestore;
  scope: ProviderMutationScope;
  resources: ProviderMutationResource[];
  assertCurrentInTransaction?: ProviderMutationFence;
  transactionRunner?: ProviderMutationTransactionRunner;
}): Promise<ProviderMutationSession> {
  Object.values(options.scope).forEach(validate);
  if (!options.resources.length) throw new Error('PROVIDER_MUTATION_RESOURCE_SET_INVALID');
  options.resources.forEach((resource) => {
    Object.values(resource).forEach(validate);
    if (!['subsplash', 'soundcloud'].includes(resource.provider)) throw new Error('PROVIDER_MUTATION_PROVIDER_INVALID');
  });
  const resources = [
    ...new Map(options.resources.map((resource) => [resourceKey(options.scope, resource), resource])).entries(),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, resource]) => resource);
  const keys = resources.map((resource) => resourceKey(options.scope, resource));
  const id = providerMutationFingerprint(options.scope);
  const session = { db: options.db, id, scope: options.scope, resources };
  const record: SessionRecord = {
    schemaVersion: 1,
    scope: options.scope,
    resourceKeys: keys,
    resources,
    state: 'active',
    createdAtMillis: Date.now(),
  };
  const lockRecord = {
    schemaVersion: 1,
    state: 'held',
    sessionId: id,
    projectId: options.scope.projectId,
    jobId: options.scope.jobId,
  };
  assertProviderMutationByteBudgets([
    {
      path: `projects/${options.scope.projectId}/databases/(default)/documents/${PROVIDER_MUTATION_SESSIONS}/${id}`,
      data: record,
    },
    ...keys.map((key) => ({
      path: `projects/${options.scope.projectId}/databases/(default)/documents/${PROVIDER_MUTATION_LOCKS}/${key}`,
      data: lockRecord,
    })),
  ]);
  await runFenced(options.db, options, async (tx) => {
    const ref = options.db.collection(PROVIDER_MUTATION_SESSIONS).doc(id);
    const existing = await tx.get(ref);
    const locks = await readDocumentsInChunks(
      tx,
      keys.map((key) => options.db.collection(PROVIDER_MUTATION_LOCKS).doc(key))
    );
    if (existing.exists) {
      if (
        existing.get('schemaVersion') !== 1 ||
        existing.get('state') !== 'active' ||
        providerMutationFingerprint(existing.get('resources')) !== providerMutationFingerprint(resources) ||
        providerMutationFingerprint(existing.get('scope')) !== providerMutationFingerprint(options.scope) ||
        providerMutationFingerprint(existing.get('resourceKeys')) !== providerMutationFingerprint(keys) ||
        locks.some((lock) => lock.get('state') !== 'held' || lock.get('sessionId') !== id)
      )
        throw blocked(id);
      return;
    }
    const previousOwners = await readLockOwners(tx, options.db, locks);
    for (const lock of locks) {
      if (!lock.exists) continue;
      if (lock.get('state') !== 'held') throw blocked();
      const ownerId = lock.get('sessionId');
      if (typeof ownerId !== 'string') throw blocked();
      const owner = previousOwners.get(ownerId);
      if (
        !owner?.exists ||
        owner.get('schemaVersion') !== 1 ||
        providerMutationFingerprint(owner.get('scope')) !== ownerId ||
        !Array.isArray(owner.get('resourceKeys')) ||
        !owner.get('resourceKeys').includes(lock.id)
      )
        throw blocked(ownerId);
      if (!['committed', 'aborted'].includes(owner.get('state'))) throw blocked(ownerId);
    }
    tx.create(ref, record);
    locks.forEach((lock) => tx.set(lock.ref, lockRecord));
  });
  return session;
}
/** Only normalized provider JSON is retained; Axios response/request objects contain credentials. */
function boundedAcknowledgementResult(value: unknown): { valid: true; value: unknown } | { valid: false } {
  try {
    const visit = (item: unknown, depth: number): unknown => {
      if (depth > 20) throw Error('deep');
      if (item === undefined || item === null) return null;
      if (typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
      if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
        if (
          Object.keys(item).some((key) =>
            [
              'config',
              'request',
              'headers',
              'authorization',
              'access_token',
              'refresh_token',
              'client_secret',
            ].includes(key.toLowerCase())
          )
        )
          throw Error('transport');
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]));
      }
      throw Error('non-json');
    };
    const result = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) return { valid: false };
    return { valid: true, value: result };
  } catch {
    return { valid: false };
  }
}
/** Opaque original completion references only; business payloads never enter the wakeup command. */
export interface ProviderMutationEvidenceFact {
  factId: string;
  step: string;
  claim: string;
  executionId: string;
  completion: 'acknowledged' | 'rejected_no_effect';
}
export type PrepareProviderMutationEvidenceWakeup = (
  tx: Transaction,
  session: ProviderMutationSession,
  fact: ProviderMutationEvidenceFact
) => Promise<(() => void) | undefined>;
export type ProviderMutationCompletion<T> =
  | { completion: 'acknowledged'; result: T }
  | {
      completion: 'rejected_no_effect';
      evidence: { transport: 'original_http_response'; status: number; providerCode: string };
    };
/** send MUST perform one HTTP attempt with retries/redirects disabled. Rejections require documented provider no-effect semantics. */
export async function executeProviderMutationOnce<T>(options: {
  session: ProviderMutationSession;
  step: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  payload: unknown;
  executionId: string;
  assertCurrentInTransaction?: ProviderMutationFence;
  transactionRunner?: ProviderMutationTransactionRunner;
  prepareEvidenceWakeup?: PrepareProviderMutationEvidenceWakeup;
  send: () => Promise<ProviderMutationCompletion<T>>;
}): Promise<T> {
  validate(options.step);
  validate(options.executionId);
  const { session } = options;
  const fingerprint = providerMutationFingerprint([options.method, options.payload]);
  const ref = session.db
    .collection(PROVIDER_MUTATION_SESSIONS)
    .doc(session.id)
    .collection('requests')
    .doc(providerMutationFingerprint(options.step));
  const claim = randomUUID();
  const previous = await runFenced(session.db, options, async (tx) => {
    const record = await assertSession(tx, session);
    if (record.state !== 'active') throw blocked(session.id);
    const existing = await tx.get(ref);
    const request = existing.data() as MutationRecord | undefined;
    if (request) {
      if (request.fingerprint !== fingerprint || request.method !== options.method) throw blocked(session.id);
      if (request.state === 'acknowledged') {
        await validateProviderMutationOriginalCompletion(tx, session, [
          existing as FirebaseFirestore.QueryDocumentSnapshot,
        ]);
        return request;
      }
      throw blocked(session.id);
    }
    if (record.effectsClosed === true) throw blocked(session.id);
    const unsettled = await tx.get(
      session.db
        .collection(PROVIDER_MUTATION_SESSIONS)
        .doc(session.id)
        .collection('requests')
        .where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable'])
        .limit(1)
    );
    if (!unsettled.empty) throw blocked(session.id);
    tx.create(ref, {
      step: options.step,
      state: 'sending',
      fingerprint,
      method: options.method,
      executionId: options.executionId,
      claim,
      startedAtMillis: Date.now(),
    });
    return undefined;
  });
  if (previous) return previous.result as T;
  try {
    const completion = await options.send();
    const normalized =
      completion.completion === 'acknowledged' ? boundedAcknowledgementResult(completion.result) : undefined;
    if (
      completion.completion === 'rejected_no_effect' &&
      (completion.evidence.transport !== 'original_http_response' ||
        !Number.isInteger(completion.evidence.status) ||
        completion.evidence.status < 400 ||
        completion.evidence.status >= 500 ||
        !completion.evidence.providerCode)
    )
      throw blocked(session.id);
    // Original response fact is preserved even if the actor or SDK execution was revoked meanwhile.
    await session.db.runTransaction(async (tx) => {
      const record = await assertSession(tx, session);
      const existing = await tx.get(ref);
      if (
        record.state !== 'active' ||
        existing.get('claim') !== claim ||
        existing.get('fingerprint') !== fingerprint ||
        !['sending', 'unknown'].includes(existing.get('state'))
      )
        throw blocked(session.id);
      const factId = providerMutationFingerprint([session.id, options.step, claim]);
      const fact = {
        sessionId: session.id,
        step: options.step,
        claim,
        fingerprint,
        executionId: options.executionId,
        completion: completion.completion,
        completedAtMillis: Date.now(),
        ...(completion.completion === 'acknowledged'
          ? normalized?.valid
            ? { result: normalized.value }
            : { resultUnavailable: true }
          : { evidence: completion.evidence }),
      };
      // Trusted routing reads happen before any write. A stale/terminal parent returns no closure;
      // it never fences or discards the original provider completion fact.
      const wake = await options.prepareEvidenceWakeup?.(tx, session, {
        factId,
        step: options.step,
        claim,
        executionId: options.executionId,
        completion: completion.completion,
      });
      tx.create(session.db.collection(PROVIDER_MUTATION_FACTS).doc(factId), fact);
      tx.update(ref, {
        state:
          completion.completion === 'acknowledged' && !normalized?.valid
            ? 'acknowledged_unprojectable'
            : completion.completion,
        ...(completion.completion === 'acknowledged' && normalized?.valid ? { result: normalized.value } : {}),
        completedAtMillis: Date.now(),
      });
      wake?.();
    });
    if (completion.completion === 'acknowledged' && !normalized?.valid)
      throw new ProviderMutationGuardError('PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED', session.id);
    if (completion.completion === 'rejected_no_effect')
      throw new ProviderMutationGuardError('PROVIDER_MUTATION_REJECTED_NO_EFFECT', session.id);
    return completion.result;
  } catch (error) {
    await session.db
      .runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (existing.get('claim') === claim && existing.get('state') === 'sending')
          tx.update(ref, { state: 'unknown' });
      })
      .catch(() => undefined);
    if (error instanceof ProviderMutationGuardError) throw error;
    throw blocked(session.id);
  }
}
/** Canonical repair and release are one generation/execution-fenced transaction. No GET-match can settle an unknown RPC. */
export async function commitProviderMutationSession(options: {
  session: ProviderMutationSession;
  assertCurrentInTransaction?: ProviderMutationFence;
  transactionRunner?: ProviderMutationTransactionRunner;
  mutate: (transaction: Transaction) => Promise<void>;
}): Promise<void> {
  const { session } = options;
  await runFenced(session.db, options, async (tx) => {
    const record = await assertSession(tx, session);
    if (record.state === 'committed') return;
    if (record.state !== 'active') throw blocked(session.id);
    const requests = await tx.get(
      session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).collection('requests')
    );
    if (requests.docs.some((doc) => !['acknowledged', 'rejected_no_effect'].includes(doc.get('state'))))
      throw blocked(session.id);
    await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
    await options.mutate(tx);
    tx.update(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id), {
      state: 'committed',
      committedAtMillis: Date.now(),
    });
  });
}
/** Safe abandoned preflight/rejected intent only. Any positive or uncertain sent effect requires canonical settlement. */
export async function abortUnsentProviderMutationSession(options: {
  session: ProviderMutationSession;
  assertCurrentInTransaction?: ProviderMutationFence;
  transactionRunner?: ProviderMutationTransactionRunner;
}): Promise<void> {
  const { session } = options;
  await runFenced(session.db, options, async (tx) => {
    const record = await assertSession(tx, session);
    if (record.state !== 'active' || record.effectsClosed === true) throw blocked(session.id);
    const requests = await tx.get(
      session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).collection('requests')
    );
    if (requests.docs.some((doc) => doc.get('state') !== 'rejected_no_effect')) throw blocked(session.id);
    await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
    tx.update(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id), {
      state: 'aborted',
      abortedAtMillis: Date.now(),
    });
  });
}

const zeroEffectsProofBrand: unique symbol = Symbol('providerMutationZeroEffectsProof');
export interface ProviderMutationZeroEffectsProof {
  readonly [zeroEffectsProofBrand]: true;
}
const zeroEffectsProofs = new WeakMap<
  ProviderMutationZeroEffectsProof,
  { tx: Transaction; sessionId: string; scope: ProviderMutationScope }
>();
/** Transaction-bound authority, never a serializable caller boolean. */
export function assertProviderMutationZeroEffectsProof(
  tx: Transaction,
  proof: ProviderMutationZeroEffectsProof,
  scope: { projectId: string; jobId: string; sessionId?: string }
): void {
  const issued = proof && zeroEffectsProofs.get(proof);
  if (
    !issued ||
    issued.tx !== tx ||
    issued.scope.projectId !== scope.projectId ||
    issued.scope.jobId !== scope.jobId ||
    (scope.sessionId !== undefined && issued.sessionId !== scope.sessionId)
  )
    throw blocked(scope.sessionId);
}
/** Compose a true zero-effect stop with source index/tombstone changes in one fresh fenced
 * transaction. Source MUST read its immutable sealed zero-effect catalogue and prove no partial
 * canonical cleanup; zero transport alone cannot prove that source disposition. No claimed or
 * rejected request qualifies. The issued proof is private and bound to this exact transaction. */
export async function prepareZeroEffectsProviderMutationAbort(
  tx: Transaction,
  session: ProviderMutationSession,
  validateZeroSource: (tx: Transaction, session: ProviderMutationSession) => Promise<{ sourceProgramDigest: string }>
): Promise<{ alreadyAborted: boolean; proof: ProviderMutationZeroEffectsProof; commit: () => void }> {
  const record = await assertSession(tx, session);
  if (!['active', 'aborted'].includes(record.state)) throw blocked(session.id);
  const ref = session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id),
    snapshot = await tx.get(ref);
  if ((await tx.get(ref.collection('requests').count())).data().count !== 0) throw blocked(session.id);
  const seed = providerMutationClaimSetSeed(session.id);
  if (
    record.effectsClosed === true &&
    (snapshot.get('effectsClosedClaimSetDigestVersion') !== 2 ||
      snapshot.get('effectsClosedActualRequestCount') !== 0 ||
      snapshot.get('effectsClosedClaimSetDigest') !== seed)
  )
    throw blocked(session.id);
  const source = await validateZeroSource(tx, session);
  if (!source || typeof source.sourceProgramDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceProgramDigest))
    throw blocked(session.id);
  if (
    record.state === 'aborted' &&
    (snapshot.get('sourceZeroEffectsValidated') !== true ||
      snapshot.get('sourceZeroEffectsProgramDigest') !== source.sourceProgramDigest)
  )
    throw blocked(session.id);
  const proof = Object.freeze({ [zeroEffectsProofBrand]: true as const });
  zeroEffectsProofs.set(proof, { tx, sessionId: session.id, scope: { ...session.scope } });
  return {
    alreadyAborted: record.state === 'aborted',
    proof,
    commit: () => {
      if (record.state === 'aborted') return;
      tx.update(ref, {
        state: 'aborted',
        abortedAtMillis: Date.now(),
        effectsClosed: true,
        effectsClosedSourceDispositionValidated: true,
        effectsClosedClaimSetDigestVersion: 2,
        effectsClosedClaimSetDigest: seed,
        effectsClosedActualRequestCount: 0,
        sourceZeroEffectsValidated: true,
        sourceZeroEffectsProgramDigest: source.sourceProgramDigest,
      });
    },
  };
}

/** Read phase for an existing fenced canonical transaction. Invoke closure only after every canonical read. */
export async function prepareProviderMutationSessionCommit(
  tx: Transaction,
  session: ProviderMutationSession
): Promise<{ alreadyCommitted: boolean; commit: () => void }> {
  const record = await assertSession(tx, session);
  if (record.state === 'committed') return { alreadyCommitted: true, commit: () => {} };
  if (record.state !== 'active') throw blocked(session.id);
  const requests = await tx.get(
    session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).collection('requests')
  );
  if (requests.docs.some((doc) => !['acknowledged', 'rejected_no_effect'].includes(doc.get('state'))))
    throw blocked(session.id);
  await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
  return {
    alreadyCommitted: false,
    commit: () => {
      tx.update(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id), {
        state: 'committed',
        committedAtMillis: Date.now(),
      });
    },
  };
}

/** Original transport closure is immutable: only the source-owned READY compiler may
 * attest that this exact catalogue has completed every canonical page. */
export interface ProviderMutationClosedEvidenceSeal {
  sessionId: string;
  claimSetDigest: string;
  claimSetDigestVersion: 2;
  actualRequestCount: number;
  sourceDispositionValidated: true;
  sourceProgramDigest?: string;
  expectedRequestCount?: number;
}
export interface ProviderMutationReadyCanonicalCompletion {
  closedClaimSetDigest: string;
  originalRequestCount: number;
  immutableCatalogDigest: string;
  canonicalCompletionDigest: string;
  expectedCanonicalPageCount: number;
  completedCanonicalPageCount: number;
}
export type ProviderMutationReadyCanonicalCompletionValidator = (
  tx: Transaction,
  session: ProviderMutationSession,
  seal: ProviderMutationClosedEvidenceSeal
) => Promise<ProviderMutationReadyCanonicalCompletion>;
/** Bounded final settlement for paged factual repair, inside the caller's fresh SDK/actor/generation
 * fenced transaction. The validator MUST read immutable private READY/catalogue headers, current
 * source generation/namespace, exact original claim coverage and canonical EOF checkpoints. Raw
 * caller hashes, root absence and GET matches cannot substitute for those source reads.
 * No original request bodies are materialized here: the immutable closure count/digest was minted
 * only after original fact validation, and closed admission forbids subsequent claims. */
export async function prepareProviderMutationSessionCommitFromClosedEvidence(
  tx: Transaction,
  session: ProviderMutationSession,
  validateReadyCanonicalCompletion: ProviderMutationReadyCanonicalCompletionValidator
): Promise<{ alreadyCommitted: boolean; commit: () => void }> {
  const record = await assertSession(tx, session);
  if (!['active', 'committed'].includes(record.state) || record.effectsClosed !== true) throw blocked(session.id);
  const ref = session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id),
    snapshot = await tx.get(ref);
  const claimSetDigest = snapshot.get('effectsClosedClaimSetDigest'),
    actualRequestCount = snapshot.get('effectsClosedActualRequestCount');
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const sourceProgramDigest = snapshot.get('effectsClosedSourceProgramDigest'),
    expectedRequestCount = snapshot.get('effectsClosedExpectedRequestCount');
  if (snapshot.get('effectsClosedClaimSetDigestVersion') !== 2 || !sha(claimSetDigest) || !count(actualRequestCount))
    throw blocked(session.id);
  if (
    snapshot.get('effectsClosedSourceDispositionValidated') !== true &&
    (!sha(sourceProgramDigest) ||
      !sha(snapshot.get('effectsClosedNoSendSetDigest')) ||
      !count(expectedRequestCount) ||
      expectedRequestCount < actualRequestCount)
  )
    throw blocked(session.id);
  const unsettled = await tx.get(
    ref.collection('requests').where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable']).limit(1)
  );
  if (!unsettled.empty) throw blocked(session.id);
  const seal: ProviderMutationClosedEvidenceSeal = {
    sessionId: session.id,
    claimSetDigest,
    claimSetDigestVersion: 2,
    actualRequestCount,
    sourceDispositionValidated: true,
    ...(sha(sourceProgramDigest) ? { sourceProgramDigest } : {}),
    ...(count(expectedRequestCount) ? { expectedRequestCount } : {}),
  };
  const proof = await validateReadyCanonicalCompletion(tx, session, seal);
  if (
    !proof ||
    proof.closedClaimSetDigest !== claimSetDigest ||
    proof.originalRequestCount !== actualRequestCount ||
    !sha(proof.immutableCatalogDigest) ||
    !sha(proof.canonicalCompletionDigest) ||
    !count(proof.expectedCanonicalPageCount) ||
    !count(proof.completedCanonicalPageCount) ||
    proof.completedCanonicalPageCount !== proof.expectedCanonicalPageCount
  )
    throw blocked(session.id);
  if (record.state === 'committed') return { alreadyCommitted: true, commit: () => {} };
  return {
    alreadyCommitted: false,
    commit: () => {
      tx.update(ref, {
        state: 'committed',
        committedAtMillis: Date.now(),
        canonicalCompletionCatalogDigest: proof.immutableCatalogDigest,
        canonicalCompletionDigest: proof.canonicalCompletionDigest,
      });
    },
  };
}

/** Server-only complete job scan. Public projections should expose only opaque session IDs and unresolved state. */
export async function listProviderMutationSessionsForJob(
  db: Firestore,
  scope: { projectId: string; jobId: string }
): Promise<
  Array<{
    sessionId: string;
    state: SessionRecord['state'];
    resources: ProviderMutationResource[];
    operation: string;
    requests: Array<{
      requestId: string;
      step: string;
      method: string;
      state: MutationRecord['state'];
      claim: string;
      executionId: string;
      fingerprint: string;
    }>;
  }>
> {
  Object.values(scope).forEach(validate);
  const result: Array<{
    sessionId: string;
    state: SessionRecord['state'];
    resources: ProviderMutationResource[];
    operation: string;
    requests: Array<{
      requestId: string;
      step: string;
      method: string;
      state: MutationRecord['state'];
      claim: string;
      executionId: string;
      fingerprint: string;
    }>;
  }> = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    const query = db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .where('scope.projectId', '==', scope.projectId)
      .where('scope.jobId', '==', scope.jobId)
      .orderBy('__name__')
      .limit(400);
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      const record = doc.data() as SessionRecord;
      if (
        record.schemaVersion !== 1 ||
        record.scope.projectId !== scope.projectId ||
        record.scope.jobId !== scope.jobId ||
        providerMutationFingerprint(record.scope) !== doc.id ||
        !['active', 'committed', 'aborted'].includes(record.state) ||
        !Array.isArray(record.resources) ||
        providerMutationFingerprint(record.resourceKeys) !==
          providerMutationFingerprint(record.resources.map((resource) => resourceKey(record.scope, resource)))
      )
        throw blocked(doc.id);
      const requests = await doc.ref.collection('requests').get();
      result.push({
        sessionId: doc.id,
        state: record.state,
        resources: record.resources,
        operation: record.scope.operation,
        requests: requests.docs.map((request) => ({
          requestId: request.id,
          step: request.get('step'),
          method: request.get('method'),
          state: request.get('state'),
          claim: request.get('claim'),
          executionId: request.get('executionId'),
          fingerprint: request.get('fingerprint'),
        })),
      });
    }
    if (page.size < 400) return result;
    cursor = page.docs[page.docs.length - 1];
  }
}

/** This validates stored original HTTP completions, never a fresh GET, operator assertion, or worker termination. */
export async function validateProviderMutationOriginalCompletion(
  tx: Transaction,
  session: ProviderMutationSession,
  requests?: FirebaseFirestore.QueryDocumentSnapshot[]
): Promise<void> {
  const docs =
    requests ??
    (await tx.get(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).collection('requests'))).docs;
  const claims = docs.map((request) => {
    const data = request.data();
    if (
      !['acknowledged', 'rejected_no_effect'].includes(data.state) ||
      typeof data.step !== 'string' ||
      providerMutationFingerprint(data.step) !== request.id
    )
      throw blocked(session.id);
    return {
      data,
      ref: session.db
        .collection(PROVIDER_MUTATION_FACTS)
        .doc(providerMutationFingerprint([session.id, data.step, data.claim])),
    };
  });
  // One bounded read RPC per chunk, rather than one network round trip per provider request.
  // Every exact immutable fact is still read before any canonical or settlement write.
  for (let offset = 0; offset < claims.length; offset += 200) {
    const chunk = claims.slice(offset, offset + 200);
    const snapshots = await tx.getAll(...chunk.map((claim) => claim.ref));
    const facts = new Map(snapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
    for (const { data, ref } of chunk) {
      const fact = facts.get(ref.path);
      if (
        !fact?.exists ||
        fact.get('sessionId') !== session.id ||
        fact.get('step') !== data.step ||
        fact.get('claim') !== data.claim ||
        fact.get('fingerprint') !== data.fingerprint ||
        fact.get('executionId') !== data.executionId ||
        fact.get('completion') !== data.state ||
        (data.state === 'acknowledged' &&
          (fact.get('resultUnavailable') === true ||
            providerMutationFingerprint(fact.get('result')) !== providerMutationFingerprint(data.result)))
      )
        throw blocked(session.id);
    }
  }
}

/** Strict terminal/cancellation barrier: even acknowledged effects retain their lock until canonical settlement. */
export async function assertProviderMutationResourcesSettled(options: {
  db: Firestore;
  projectId: string;
  resources: ProviderMutationResource[];
}): Promise<void> {
  if (!options.resources.length) return;
  const scope = { projectId: options.projectId, jobId: 'inspection', operation: 'inspection' };
  const refs = [...new Set(options.resources.map((resource) => resourceKey(scope, resource)))].map((key) =>
    options.db.collection(PROVIDER_MUTATION_LOCKS).doc(key)
  );
  await options.db.runTransaction(async (tx) => {
    const snapshots = await readDocumentsInChunks(tx, refs);
    const previousOwners = await readLockOwners(tx, options.db, snapshots);
    for (const lock of snapshots) {
      if (!lock.exists) continue;
      if (lock.get('state') !== 'held' || typeof lock.get('sessionId') !== 'string') throw blocked();
      const ownerId = lock.get('sessionId');
      const owner = previousOwners.get(ownerId);
      if (
        !owner?.exists ||
        providerMutationFingerprint(owner.get('scope')) !== lock.get('sessionId') ||
        !Array.isArray(owner.get('resourceKeys')) ||
        !owner.get('resourceKeys').includes(lock.id) ||
        !['committed', 'aborted'].includes(owner.get('state'))
      )
        throw blocked(lock.get('sessionId'));
    }
  });
}
/** Read-only repair barrier. Known original ACKs may be repaired by their owner; uncertain RPCs remain quarantined. */
export async function assertProviderMutationResourcesHaveNoUnknownRequests(options: {
  db: Firestore;
  projectId: string;
  resources: ProviderMutationResource[];
}): Promise<void> {
  if (!options.resources.length) return;
  const scope = { projectId: options.projectId, jobId: 'inspection', operation: 'inspection' };
  const refs = [...new Set(options.resources.map((resource) => resourceKey(scope, resource)))].map((key) =>
    options.db.collection(PROVIDER_MUTATION_LOCKS).doc(key)
  );
  await options.db.runTransaction(async (tx) => {
    const locks = await readDocumentsInChunks(tx, refs);
    const owners = await readLockOwners(tx, options.db, locks);
    const inspectedOwners = new Set<string>();
    for (const lock of locks) {
      if (lock.get('state') !== 'held') continue;
      const sessionId = lock.get('sessionId');
      if (typeof sessionId !== 'string') throw blocked();
      const sessionRef = options.db.collection(PROVIDER_MUTATION_SESSIONS).doc(sessionId),
        session = owners.get(sessionId);
      if (
        !session?.exists ||
        session.get('schemaVersion') !== 1 ||
        providerMutationFingerprint(session.get('scope')) !== sessionId ||
        !Array.isArray(session.get('resourceKeys')) ||
        !session.get('resourceKeys').includes(lock.id)
      )
        throw blocked(sessionId);
      if (inspectedOwners.has(sessionId)) continue;
      inspectedOwners.add(sessionId);
      if (['committed', 'aborted'].includes(session.get('state'))) continue;
      if (session.get('state') !== 'active') throw blocked(sessionId);
      const requests = await tx.get(sessionRef.collection('requests'));
      if (requests.docs.some((request) => !['acknowledged', 'rejected_no_effect'].includes(request.get('state'))))
        throw blocked();
    }
  });
}

/** Only after SDK effects have drained and the supplied runner verifies the exact cancel/certificate authority. */
export async function abortProvablyUnsentProviderMutationSessionsForJob(
  db: Firestore,
  scope: { projectId: string; jobId: string },
  transactionRunner: ProviderMutationTransactionRunner,
  options?: { preserveSessionIds?: readonly string[] }
): Promise<Awaited<ReturnType<typeof listProviderMutationSessionsForJob>>> {
  // Trusted source controllers preserve their exact certified preflight session across restarts.
  // Preserving never releases ownership: the returned active set still includes every preserved ID.
  const preserved = new Set(options?.preserveSessionIds ?? []);
  for (const id of preserved)
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      throw new ProviderMutationGuardError('PROVIDER_MUTATION_ID_INVALID');
  const sessions = await listProviderMutationSessionsForJob(db, scope);
  for (const candidate of sessions) {
    if (
      preserved.has(candidate.sessionId) ||
      candidate.state !== 'active' ||
      candidate.requests.some((request) => request.state !== 'rejected_no_effect')
    )
      continue;
    const session: ProviderMutationSession = {
      db,
      id: candidate.sessionId,
      scope: { ...scope, operation: candidate.operation },
      resources: candidate.resources,
    };
    try {
      await abortUnsentProviderMutationSession({ session, transactionRunner });
    } catch (error) {
      if (!(error instanceof ProviderMutationGuardError) || error.code !== 'PROVIDER_MUTATION_UNRESOLVED') throw error;
    }
  }
  return (await listProviderMutationSessionsForJob(db, scope)).filter((session) => session.state === 'active');
}

export interface ProviderMutationEffectsClosureProof {
  /** Digest of the private immutable source program, not an operator supplied explanation. */
  sourceProgramDigest: string;
  expectedRequestSteps: string[];
  /** These are proved NoSEND by the source validator from its initial frozen server evidence. */
  qualifiedNoSendSteps: string[];
}
/** Proof produced by the source's immutable READY original-fact catalogue, not caller input. */
export interface ProviderMutationReadyEffectsClosureProof {
  sourceProgramDigest: string;
  expectedRequestCount: number;
  actualRequestCount: number;
  claimSetDigest: string;
  claimSetDigestVersion: 2;
}
export type ProviderMutationReadyEffectsClosureValidator = (
  tx: Transaction,
  session: ProviderMutationSession
) => Promise<ProviderMutationReadyEffectsClosureProof>;
/** Bounded transport closure in a fresh SDK/actor/source fenced transaction. Source validation
 * must verify the entire immutable READY original-fact catalogue and qualified initial NoSEND
 * coverage in this transaction. Its independently compiled ordered v2 terminal claim digest
 * cannot be copied from a new closure or inferred from root absence/current GET state.
 * The aggregate query checks original cardinality without materializing bodies; admission and
 * closure both read/write this session document, preventing a new claim crossing closure. */
export async function prepareProviderMutationEffectsClosedFromReadyEvidence(
  tx: Transaction,
  session: ProviderMutationSession,
  validateReadySourceEffects: ProviderMutationReadyEffectsClosureValidator
): Promise<{ alreadyClosed: boolean; commit: () => void }> {
  const record = await assertSession(tx, session);
  if (record.state !== 'active') throw blocked(session.id);
  const ref = session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id),
    requests = ref.collection('requests');
  const unsettled = await tx.get(
    requests.where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable']).limit(1)
  );
  if (!unsettled.empty) throw blocked(session.id);
  const actualCount = (await tx.get(requests.count())).data().count;
  const proof = await validateReadySourceEffects(tx, session);
  const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (
    !proof ||
    proof.claimSetDigestVersion !== 2 ||
    !sha(proof.sourceProgramDigest) ||
    !sha(proof.claimSetDigest) ||
    !count(proof.expectedRequestCount) ||
    !count(proof.actualRequestCount) ||
    proof.actualRequestCount !== actualCount ||
    proof.expectedRequestCount < actualCount ||
    (actualCount === 0 && proof.claimSetDigest !== providerMutationClaimSetSeed(session.id))
  )
    throw blocked(session.id);
  if (record.effectsClosed === true) {
    const closed = await tx.get(ref);
    if (
      closed.get('effectsClosedClaimSetDigestVersion') !== 2 ||
      closed.get('effectsClosedClaimSetDigest') !== proof.claimSetDigest ||
      closed.get('effectsClosedActualRequestCount') !== actualCount ||
      closed.get('effectsClosedSourceProgramDigest') !== proof.sourceProgramDigest ||
      closed.get('effectsClosedExpectedRequestCount') !== proof.expectedRequestCount ||
      closed.get('effectsClosedSourceDispositionValidated') !== true
    )
      throw blocked(session.id);
    return { alreadyClosed: true, commit: () => {} };
  }
  return {
    alreadyClosed: false,
    commit: () => {
      tx.update(ref, {
        effectsClosed: true,
        effectsClosedSourceDispositionValidated: true,
        effectsClosedSourceProgramDigest: proof.sourceProgramDigest,
        effectsClosedExpectedRequestCount: proof.expectedRequestCount,
        effectsClosedActualRequestCount: actualCount,
        effectsClosedClaimSetDigest: proof.claimSetDigest,
        effectsClosedClaimSetDigestVersion: 2,
        effectsClosedAtMillis: Date.now(),
      });
    },
  };
}
export type ProviderMutationSourceEffectsValidator = (
  tx: Transaction,
  session: ProviderMutationSession,
  requests: FirebaseFirestore.QueryDocumentSnapshot[]
) => Promise<ProviderMutationEffectsClosureProof | void>;
/** Close transport admission without releasing ownership or claiming canonical cleanup complete.
 * The source-owned validator MUST read the immutable full expected program and its qualified initial
 * NoSEND dispositions in this transaction. Neither a current GET match nor operator text is such proof. */
export async function prepareProviderMutationEffectsClosed(
  tx: Transaction,
  session: ProviderMutationSession,
  validateSourceEffects: ProviderMutationSourceEffectsValidator
): Promise<{ alreadyClosed: boolean; commit: () => void }> {
  const record = await assertSession(tx, session);
  if (record.state !== 'active') throw blocked(session.id);
  const requests = await tx.get(
    session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id).collection('requests')
  );
  await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
  const claimDigest = [...requests.docs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .reduce(
      (previous, request) =>
        providerMutationClaimSetFold(previous, {
          requestId: request.id,
          step: request.get('step'),
          method: request.get('method'),
          fingerprint: request.get('fingerprint'),
          claim: request.get('claim'),
          executionId: request.get('executionId'),
          state: request.get('state'),
        }),
      providerMutationClaimSetSeed(session.id)
    );
  const proof = await validateSourceEffects(tx, session, requests.docs);
  if (proof === undefined) {
    // Trusted source composition checks full expected coverage and private qualified NoSEND evidence.
    // This mode accepts a server validator callback, never a client/operator disposition parameter.
    if (record.effectsClosed === true) {
      const closed = await tx.get(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id));
      if (
        closed.get('effectsClosedSourceDispositionValidated') !== true ||
        closed.get('effectsClosedClaimSetDigestVersion') !== 2 ||
        closed.get('effectsClosedClaimSetDigest') !== claimDigest ||
        closed.get('effectsClosedActualRequestCount') !== requests.size
      )
        throw blocked(session.id);
      return { alreadyClosed: true, commit: () => {} };
    }
    return {
      alreadyClosed: false,
      commit: () => {
        tx.update(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id), {
          effectsClosed: true,
          effectsClosedSourceDispositionValidated: true,
          effectsClosedClaimSetDigest: claimDigest,
          effectsClosedClaimSetDigestVersion: 2,
          effectsClosedActualRequestCount: requests.size,
          effectsClosedAtMillis: Date.now(),
        });
      },
    };
  }
  if (
    !/^[a-f0-9]{64}$/.test(proof.sourceProgramDigest) ||
    !Array.isArray(proof.expectedRequestSteps) ||
    !Array.isArray(proof.qualifiedNoSendSteps)
  )
    throw blocked(session.id);
  [...proof.expectedRequestSteps, ...proof.qualifiedNoSendSteps].forEach(validate);
  const expected = new Set(proof.expectedRequestSteps),
    noSend = new Set(proof.qualifiedNoSendSteps),
    actual = new Set(requests.docs.map((request) => request.get('step') as string));
  if (
    !expected.size ||
    expected.size !== proof.expectedRequestSteps.length ||
    noSend.size !== proof.qualifiedNoSendSteps.length ||
    actual.size !== requests.size ||
    [...actual].some((step) => !expected.has(step) || noSend.has(step)) ||
    [...noSend].some((step) => !expected.has(step)) ||
    [...expected].some((step) => !actual.has(step) && !noSend.has(step))
  )
    throw blocked(session.id);

  const noSendDigest = providerMutationFingerprint([...noSend].sort());
  if (record.effectsClosed === true) {
    const closed = await tx.get(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id));
    if (
      closed.get('effectsClosedSourceProgramDigest') !== proof.sourceProgramDigest ||
      closed.get('effectsClosedClaimSetDigestVersion') !== 2 ||
      closed.get('effectsClosedClaimSetDigest') !== claimDigest ||
      closed.get('effectsClosedNoSendSetDigest') !== noSendDigest ||
      closed.get('effectsClosedActualRequestCount') !== requests.size
    )
      throw blocked(session.id);
    return { alreadyClosed: true, commit: () => {} };
  }
  return {
    alreadyClosed: false,
    commit: () => {
      tx.update(session.db.collection(PROVIDER_MUTATION_SESSIONS).doc(session.id), {
        effectsClosed: true,
        effectsClosedSourceProgramDigest: proof.sourceProgramDigest,
        effectsClosedClaimSetDigest: claimDigest,
        effectsClosedClaimSetDigestVersion: 2,
        effectsClosedNoSendSetDigest: noSendDigest,
        effectsClosedExpectedRequestCount: expected.size,
        effectsClosedActualRequestCount: requests.size,
        effectsClosedAtMillis: Date.now(),
      });
    },
  };
}
/** Selected original ACK replay; unrelated unknown steps do not erase a completed fact. No new effects are authorized. */
export async function readOriginalProviderMutationAcknowledgement(
  tx: Transaction,
  session: ProviderMutationSession,
  request: { step: string; method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; fingerprint: string }
): Promise<{ result: unknown } | undefined> {
  validate(request.step);
  if (!/^[a-f0-9]{64}$/.test(request.fingerprint)) throw blocked(session.id);
  await assertSession(tx, session);
  const snapshot = await tx.get(
    session.db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .doc(session.id)
      .collection('requests')
      .doc(providerMutationFingerprint(request.step))
  );
  if (!snapshot.exists) return undefined;
  if (
    snapshot.get('step') !== request.step ||
    snapshot.get('method') !== request.method ||
    snapshot.get('fingerprint') !== request.fingerprint
  )
    throw blocked(session.id);
  if (snapshot.get('state') !== 'acknowledged') return undefined;
  await validateProviderMutationOriginalCompletion(tx, session, [snapshot as FirebaseFirestore.QueryDocumentSnapshot]);
  return { result: snapshot.get('result') };
}
