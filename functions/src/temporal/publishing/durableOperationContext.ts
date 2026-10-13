import { prepareCriticalRepairCatalogSourceAppend } from './criticalRepairCatalog';
import { providerMutationFingerprint } from './providerMutationGuard';
import type {
  FrozenProjectionRequest,
  FrozenProjectionWrite,
  FrozenProviderVerification,
} from './criticalAcknowledgedRepair';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ProviderMutationResource,
  ProviderMutationCompletion,
  ProviderMutationSourceEffectsValidator,
  ProviderMutationSession,
  ProviderMutationClosedEvidenceSeal,
  ProviderMutationReadyCanonicalCompletion,
} from './providerMutationGuard';
import type { Firestore, Transaction, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import {
  prepareProviderBinding,
  prepareProviderBindingRelease,
  extractProviderResources,
  type ProviderResource,
} from '../../../../packages/orchestration/src/provider-usage';

export type DurableCriticalPreparation = (tx: Transaction) => Promise<() => void>;
export type DurableProjectionCommit = (mutate: (tx: Transaction) => Promise<void>) => Promise<void>;
export interface PublishingMutationPlan {
  operation: string;
  resources: ProviderMutationResource[];
}
export const publishingMutationRequestFingerprint = (
  request: Pick<PublishingMutationRequest<unknown>, 'method' | 'target' | 'payload'>
): string => providerMutationFingerprint([request.method, { target: request.target, body: request.payload }]);
export interface PublishingMutationRequest<T> {
  operation: string;
  target: ProviderMutationResource;
  step: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  payload: unknown;
  send: () => Promise<ProviderMutationCompletion<T>>;
}
export interface PublishingAcknowledgedProjectionPlan {
  operation: string;
  requests: FrozenProjectionRequest[];
  writes: FrozenProjectionWrite[];
  verifications: FrozenProviderVerification[];
  uiStepIds?: string[];
  completesActivity?: boolean;
  finalFragment?: boolean;
}
export interface PublishingMutationFinalSettlement {
  operation: string;
  validateSourceCompletion?: (
    tx: Transaction,
    session: ProviderMutationSession,
    seal?: ProviderMutationClosedEvidenceSeal
  ) => Promise<void | ProviderMutationReadyCanonicalCompletion>;
}
export interface PublishingMutationEffectsClosure {
  operation: string;
  validateSourceEffects: ProviderMutationSourceEffectsValidator;
}
export interface DurablePublishingContextOptions {
  getSourceStepIds?: () => string[];
  prepareProviderMutationEffectsClosed?: (
    tx: Transaction,
    plan: PublishingMutationEffectsClosure
  ) => Promise<{ alreadyClosed: boolean; commit: () => void }>;
  abortProviderMutationPlan?: (plan: { operation: string }) => Promise<void>;
  prepareAcknowledgedProjectionPlan?: (
    tx: Transaction,
    plan: PublishingAcknowledgedProjectionPlan
  ) => Promise<{ projectionDigest: string; commit: () => void }>;
  prepareProviderMutationPlanCommit?: (
    tx: Transaction,
    plan: PublishingMutationFinalSettlement
  ) => Promise<{ alreadyCommitted: boolean; commit: () => void }>;
  beginProviderMutationPlan?: (plan: PublishingMutationPlan) => Promise<void>;
  runPublishingProviderMutation?: <T>(request: PublishingMutationRequest<T>) => Promise<T>;
  markCritical?: (reasonCode: string, prepare?: DurableCriticalPreparation) => Promise<void>;
  cancelOnly?: boolean;
  purpose?: 'desired' | 'critical_repair' | 'factual_cleanup';
}
const context = new AsyncLocalStorage<
  {
    jobId: string;
    commitCurrent?: DurableProjectionCommit;
    activeMutationOperation?: string;
  } & DurablePublishingContextOptions
>();

/** Trusted worker context, never activated by a client-supplied operation key. */
export const runDurablePublishingOperation = <T>(
  jobId: string,
  operation: () => Promise<T>,
  commitCurrent?: DurableProjectionCommit,
  options: DurablePublishingContextOptions = {}
): Promise<T> => context.run({ jobId, commitCurrent, ...options }, operation);
export const runCriticalPublishingRepair = <T>(
  jobId: string,
  operation: () => Promise<T>,
  commitCurrent?: DurableProjectionCommit
): Promise<T> => runDurablePublishingOperation(jobId, operation, commitCurrent, { purpose: 'critical_repair' });
/** Actual parent SDK step identities supplied by the trusted worker kernel. */
export const getPublishingSourceStepIds = (expectedJobId?: string): string[] => {
  if (expectedJobId !== undefined && context.getStore()?.jobId !== expectedJobId)
    throw new Error('PUBLISHING_SOURCE_STEP_SCOPE_MISMATCH');
  const sourceStepIds = [...new Set(context.getStore()?.getSourceStepIds?.() ?? [])].sort();
  if (
    !sourceStepIds.length ||
    sourceStepIds.length > 32 ||
    sourceStepIds.some((step) => !/^[a-z][a-z0-9-]{0,79}$/.test(step))
  )
    throw new Error('PUBLISHING_SOURCE_STEP_AUTHORITY_REQUIRED');
  return sourceStepIds;
};
export const isCriticalPublishingRepair = (): boolean => context.getStore()?.purpose === 'critical_repair';
export const isFactualPublishingCleanup = (): boolean => context.getStore()?.purpose === 'factual_cleanup';
export const isPublishingProviderCreateForbidden = (): boolean =>
  isCriticalPublishingRepair() || isFactualPublishingCleanup();
export async function abortProviderMutationPlan(plan: { operation: string }): Promise<void> {
  const scope = context.getStore();
  if (!scope) return;
  if (!scope.abortProviderMutationPlan) throw new Error('PROVIDER_MUTATION_ABORT_CONTEXT_REQUIRED');
  await scope.abortProviderMutationPlan(plan);
}
export async function prepareAcknowledgedProjectionPlan(
  tx: Transaction,
  plan: PublishingAcknowledgedProjectionPlan
): Promise<{ projectionDigest: string; commit: () => void }> {
  const scope = context.getStore();
  if (!scope) return { projectionDigest: 'legacy', commit: () => {} };
  if (
    scope.purpose === 'critical_repair' ||
    scope.purpose === 'factual_cleanup' ||
    !scope.prepareAcknowledgedProjectionPlan
  )
    throw new Error('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
  return scope.prepareAcknowledgedProjectionPlan(tx, plan);
}
export async function prepareProviderMutationEffectsClosed(
  tx: Transaction,
  plan: PublishingMutationEffectsClosure
): Promise<{ alreadyClosed: boolean; commit: () => void }> {
  const scope = context.getStore();
  if (!scope) return { alreadyClosed: false, commit: () => {} };
  if (scope.purpose === 'critical_repair' || !scope.prepareProviderMutationEffectsClosed)
    throw new Error('PROVIDER_MUTATION_EFFECTS_CLOSURE_CONTEXT_REQUIRED');
  return scope.prepareProviderMutationEffectsClosed(tx, plan);
}
export async function prepareProviderMutationPlanCommit(
  tx: Transaction,
  plan: PublishingMutationFinalSettlement
): Promise<{ alreadyCommitted: boolean; commit: () => void }> {
  const scope = context.getStore();
  if (!scope) return { alreadyCommitted: false, commit: () => {} };
  if (scope.purpose === 'critical_repair' || !scope.prepareProviderMutationPlanCommit)
    throw new Error('PROVIDER_MUTATION_COMMIT_CONTEXT_REQUIRED');
  return scope.prepareProviderMutationPlanCommit(tx, plan);
}
export async function beginProviderMutationPlan(plan: PublishingMutationPlan): Promise<void> {
  const scope = context.getStore();
  if (!scope) return;
  if (scope.purpose === 'critical_repair' || scope.purpose === 'factual_cleanup' || !scope.beginProviderMutationPlan)
    throw new Error('PROVIDER_MUTATION_PLAN_CONTEXT_REQUIRED');
  await scope.beginProviderMutationPlan(plan);
  scope.activeMutationOperation = plan.operation;
}
export const getPublishingMutationOperation = (): string | undefined => context.getStore()?.activeMutationOperation;
export async function runPublishingProviderMutation<T>(request: PublishingMutationRequest<T>): Promise<T> {
  const scope = context.getStore();
  if (!scope) {
    const result = await request.send();
    if (result.completion !== 'acknowledged') throw new Error('PROVIDER_MUTATION_REJECTED_NO_EFFECT');
    return result.result;
  }
  if (
    scope.purpose === 'critical_repair' ||
    scope.purpose === 'factual_cleanup' ||
    !scope.runPublishingProviderMutation
  )
    throw new Error('PROVIDER_MUTATION_SESSION_CONTEXT_REQUIRED');
  return scope.runPublishingProviderMutation(request);
}

export interface PublishingCriticalEffect {
  provider: 'subsplash' | 'soundcloud';
  resourceType: 'media' | 'audio' | 'track' | 'series' | 'list' | 'list-row' | 'tag';
  resourceId: string;
  accountId: string;
  method: 'PATCH' | 'PUT' | 'DELETE';
  canonicalPaths?: string[];
  requestFingerprint?: string;
}
export const PUBLISHING_EFFECT_PLANS = 'temporalPublishingEffectPlans';
export async function markPublishingCritical(
  reasonCode: string,
  effect?: PublishingCriticalEffect,
  prepare?: DurableCriticalPreparation
): Promise<void> {
  const scope = context.getStore();
  if (!scope || scope.cancelOnly) return;
  if (!/^[A-Z0-9_]{1,100}$/.test(reasonCode) || !scope.markCritical)
    throw new Error('PUBLISHING_CRITICAL_CONTEXT_REQUIRED');
  if (scope.purpose === 'critical_repair' || scope.purpose === 'factual_cleanup')
    throw new Error('PUBLISHING_CRITICAL_REPAIR_NEW_EFFECT_FORBIDDEN');
  if (effect) {
    if (
      !effect.resourceId ||
      effect.resourceId.length > 256 ||
      /[\s/?#]/.test(effect.resourceId) ||
      !effect.accountId ||
      effect.accountId.length > 256 ||
      effect.canonicalPaths?.some(
        (path) =>
          !/^((sermons|lists|series|speakers)\/[^/]+)(\/(sermonLists|listItems|seriesItems)\/[^/]+)?$/.test(path)
      )
    )
      throw new Error('PUBLISHING_CRITICAL_EFFECT_INVALID');
    const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
    const projectId = admin.app().options.projectId;
    if (!projectId) throw new Error('PUBLISHING_CRITICAL_PROJECT_MISSING');
    const sourceStepIds = getPublishingSourceStepIds();
    const descriptor = {
      sourceStepIds,
      sourceParentRef: { projectId, jobId: scope.jobId },
      ...effect,
      ...(effect.canonicalPaths ? { canonicalPaths: [...effect.canonicalPaths].sort() } : {}),
      projectId,
      jobId: scope.jobId,
      reasonCode,
    };
    const ordered = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(ordered)
        : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, ordered(item)])
          )
        : value;
    const id = createHash('sha256')
        .update(JSON.stringify(ordered(descriptor)))
        .digest('hex'),
      target = admin.firestore().collection(PUBLISHING_EFFECT_PLANS).doc(scope.jobId).collection('operations').doc(id);
    await runDurableTransaction(admin.firestore(), async (tx) => {
      const existing = await tx.get(target);
      const source = existing.exists
        ? existing.data()!
        : { schemaVersion: 1, ...descriptor, plannedAtMillis: Date.now() };
      const append = await prepareCriticalRepairCatalogSourceAppend(
        tx,
        admin.firestore(),
        { projectId, jobId: scope.jobId },
        { sourcePath: target.path, source }
      );
      if (!existing.exists) tx.create(target, source);
      append.commit();
    });
  }
  await scope.markCritical(reasonCode, prepare);
}

export const isDurablePublishingOperation = (): boolean => context.getStore() !== undefined;
/** Read-only server context identity; never derived from a callable payload. */
export const getDurablePublishingJobId = (): string | undefined => context.getStore()?.jobId;

/** Domain transactions share the job generation read and canonical writes atomically. */
export async function runDurableTransaction<T>(db: Firestore, mutate: (tx: Transaction) => Promise<T>): Promise<T> {
  const commit = context.getStore()?.commitCurrent;
  if (!commit) return db.runTransaction(mutate);
  let result!: T;
  await commit(async (tx) => {
    result = await mutate(tx);
  });
  return result;
}

export async function commitDurableProjection(
  mutate: (tx: Transaction) => Promise<void>,
  legacy: () => Promise<void>
): Promise<void> {
  const commit = context.getStore()?.commitCurrent;
  if (commit) await commit(mutate);
  else await legacy();
}

const captureBatchValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(captureBatchValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, captureBatchValue(item)]));
  // Firestore references, Timestamp and FieldValue objects are opaque immutable SDK values.
  return value;
};

/** Native-compatible batch; durable canonical writes share the generation fence transaction. */
export function createDurableWriteBatch(db: Firestore): ReturnType<Firestore['batch']> {
  const native = db.batch();
  const writes: Array<{ method: 'set' | 'update' | 'delete' | 'create'; args: unknown[] }> = [];
  let committed = false;
  const batch = new Proxy(native, {
    get(target, property) {
      if (property === 'commit')
        return async () => {
          const commit = context.getStore()?.commitCurrent;
          if (!commit) return native.commit();
          if (committed) throw new Error('A write batch may only be committed once.');
          committed = true;
          await commit(async (tx) => {
            for (const write of writes) Reflect.apply(tx[write.method], tx, write.args);
          });
          // Transaction commits do not expose individual write times; callers consume completion.
          return [];
        };
      if (['set', 'update', 'delete', 'create'].includes(String(property)))
        return (...args: unknown[]) => {
          if (committed) throw new Error('A committed write batch cannot be changed.');
          const method = property as 'set' | 'update' | 'delete' | 'create';
          Reflect.apply(target[method], target, args);
          writes.push({ method, args: [args[0], ...args.slice(1).map(captureBatchValue)] });
          return batch;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return batch;
}

export type DurableProviderBindingTarget = {
  provider: 'subsplash' | 'soundcloud';
  kind: 'media-item' | 'series' | 'list' | 'tag' | 'transcode';
  remoteId: string;
};
export type DurableProviderBindingResource = Pick<ProviderResource, 'provider' | 'account' | 'remoteId'>;
const sameBindingTarget = (value: unknown, target: DurableProviderBindingTarget | undefined): boolean => {
  if (!target) return value === undefined;
  const stored = value as DurableProviderBindingTarget | undefined;
  return (
    !!stored &&
    stored.provider === target.provider &&
    stored.kind === target.kind &&
    stored.remoteId === target.remoteId
  );
};
export const PUBLISHING_PROVIDER_BINDINGS = 'temporalPublishingProviderBindings';
const bindingKey = (bindingId: string, resource: DurableProviderBindingResource) =>
  createHash('sha256')
    .update(JSON.stringify([bindingId, resource.provider, resource.account, resource.remoteId]))
    .digest('hex');
/** Reserve before an external association. Unknown effects retain the edge until explicit proof. */
export async function reserveDurableProviderBindings(
  resources: DurableProviderBindingResource[],
  bindingId: string,
  options: { targetReceiptId?: string; target?: DurableProviderBindingTarget } = {}
): Promise<void> {
  const scope = context.getStore();
  if (!scope) return;
  if (!scope.commitCurrent) throw new Error('PROVIDER_BINDING_REQUIRES_FENCED_CONTEXT');
  if (
    !bindingId ||
    bindingId.length > 2048 ||
    (options.targetReceiptId !== undefined && !/^[a-f0-9]{64}$/.test(options.targetReceiptId))
  )
    throw new Error('PROVIDER_BINDING_ID_INVALID');
  if (
    options.target &&
    (!['subsplash', 'soundcloud'].includes(options.target.provider) ||
      !['media-item', 'series', 'list', 'tag', 'transcode'].includes(options.target.kind) ||
      !options.target.remoteId ||
      options.target.remoteId.length > 256 ||
      /[\s/?#]/.test(options.target.remoteId))
  )
    throw new Error('PROVIDER_BINDING_TARGET_INVALID');
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const projectId = admin.app().options.projectId;
  if (!projectId) throw new Error('PROVIDER_BINDING_PROJECT_MISSING');
  const db = admin.firestore();
  for (const resource of resources) {
    if (!resource.remoteId || resource.remoteId.length > 256 || /[\s/?#]/.test(resource.remoteId))
      throw new Error('PROVIDER_BINDING_RESOURCE_INVALID');
    const id = bindingKey(bindingId, resource),
      ref = db.collection(PUBLISHING_PROVIDER_BINDINGS).doc(scope.jobId).collection('bindings').doc(id);
    await runDurableTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (
          existing.get('projectId') !== projectId ||
          existing.get('jobId') !== scope.jobId ||
          existing.get('remoteId') !== resource.remoteId ||
          existing.get('targetReceiptId') !== options.targetReceiptId ||
          !sameBindingTarget(existing.get('target'), options.target)
        )
          throw new Error('PROVIDER_BINDING_CONTEXT_MISMATCH');
        if (existing.get('state') !== 'released') return;
      }
      const commit = await prepareProviderBinding(tx, db, {
        resource: { ...resource, projectId },
        jobId: scope.jobId,
        bindingId: id,
      });
      commit();
      const record = {
        ...resource,
        projectId,
        jobId: scope.jobId,
        bindingId: id,
        state: 'reserved',
        ...(options.targetReceiptId ? { targetReceiptId: options.targetReceiptId } : {}),
        ...(options.target ? { target: options.target } : {}),
        createdAtMillis: Date.now(),
      };
      if (existing.exists) tx.set(ref, record);
      else tx.create(ref, record);
    });
  }
}
/** Caller must prove this exact association absent or protected by an identical canonical resource edge. */
export async function releaseDurableProviderBindings(
  resources: DurableProviderBindingResource[],
  bindingId: string,
  options: { canonicalPaths?: string[] } = {}
): Promise<void> {
  const scope = context.getStore();
  if (!scope) return;
  if (!scope.commitCurrent) throw new Error('PROVIDER_BINDING_REQUIRES_FENCED_CONTEXT');
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const projectId = admin.app().options.projectId;
  if (!projectId) throw new Error('PROVIDER_BINDING_PROJECT_MISSING');
  const db = admin.firestore();
  for (const resource of resources) {
    const id = bindingKey(bindingId, resource),
      ref = db.collection(PUBLISHING_PROVIDER_BINDINGS).doc(scope.jobId).collection('bindings').doc(id);
    await runDurableTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (!existing.exists || existing.get('state') === 'released') return;
      if (
        existing.get('projectId') !== projectId ||
        existing.get('jobId') !== scope.jobId ||
        existing.get('remoteId') !== resource.remoteId
      )
        throw new Error('PROVIDER_BINDING_CONTEXT_MISMATCH');
      if (options.canonicalPaths) {
        if (!options.canonicalPaths.length || options.canonicalPaths.length > 200)
          throw new Error('PROVIDER_BINDING_CANONICAL_PROOF_INVALID');
        let matched = false;
        for (const path of options.canonicalPaths) {
          const canonical = await tx.get(db.doc(path));
          if (
            canonical.exists &&
            extractProviderResources(projectId, path, canonical.data()).some(
              (candidate) =>
                candidate.provider === resource.provider &&
                candidate.account === resource.account &&
                candidate.remoteId === resource.remoteId
            )
          )
            matched = true;
        }
        if (!matched) throw new Error('PROVIDER_BINDING_CANONICAL_PROOF_MISSING');
      }
      const commit = await prepareProviderBindingRelease(tx, db, {
        resource: { ...resource, projectId },
        jobId: scope.jobId,
        bindingId: id,
      });
      commit();
      tx.update(ref, { state: 'released', releasedAtMillis: Date.now() });
    });
  }
}

/** Reconcile successful association guards only against exact canonical resource protection. */
export async function releaseCanonicalProviderBindingsForCurrentJob(): Promise<void> {
  const scope = context.getStore();
  if (!scope) return;
  if (!scope.commitCurrent) throw new Error('PROVIDER_BINDING_REQUIRES_FENCED_CONTEXT');
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const projectId = admin.app().options.projectId;
  if (!projectId) throw new Error('PROVIDER_BINDING_PROJECT_MISSING');
  const db = admin.firestore(),
    bindings = db.collection(PUBLISHING_PROVIDER_BINDINGS).doc(scope.jobId).collection('bindings');
  const cache = new Map<string, string[]>();
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const base = bindings.orderBy('__name__').limit(400),
      page = await (cursor ? base.startAfter(cursor) : base).get();
    for (const doc of page.docs) {
      if (doc.get('state') !== 'reserved') continue;
      const resource = {
        projectId,
        provider: doc.get('provider'),
        account: doc.get('account'),
        remoteId: doc.get('remoteId'),
      } as ProviderResource;
      if (
        doc.get('projectId') !== projectId ||
        doc.get('jobId') !== scope.jobId ||
        !['subsplash', 'soundcloud'].includes(resource.provider) ||
        typeof resource.remoteId !== 'string'
      )
        throw new Error('PROVIDER_BINDING_CONTEXT_MISMATCH');
      const cacheKey = JSON.stringify(resource);
      let paths = cache.get(cacheKey);
      if (!paths) {
        paths = [];
        const fields: Array<[string, string]> =
          resource.provider === 'soundcloud'
            ? [['sermons', 'soundCloudTrackId']]
            : [
                ['sermons', 'subsplashId'],
                ['lists', 'subsplashId'],
                ['series', 'subsplashId'],
                ['images', 'subsplashId'],
                ['speakers', 'tagId'],
                ['speakers', 'subsplashId'],
              ];
        for (const [collection, field] of fields) {
          const match = await db.collection(collection).where(field, '==', resource.remoteId).limit(1).get();
          if (!match.empty) paths.push(match.docs[0].ref.path);
        }
        cache.set(cacheKey, paths);
      }
      if (!paths.length) continue;
      await runDurableTransaction(db, async (tx) => {
        const current = await tx.get(doc.ref);
        if (current.get('state') !== 'reserved') return;
        let protectedByCanonical = false;
        for (const path of paths!) {
          const canonical = await tx.get(db.doc(path));
          if (
            canonical.exists &&
            extractProviderResources(projectId, path, canonical.data()).some(
              (candidate) =>
                candidate.provider === resource.provider &&
                candidate.account === resource.account &&
                candidate.remoteId === resource.remoteId
            )
          )
            protectedByCanonical = true;
        }
        if (!protectedByCanonical) return;
        const commit = await prepareProviderBindingRelease(tx, db, { resource, jobId: scope.jobId, bindingId: doc.id });
        commit();
        tx.update(doc.ref, { state: 'released', releasedAtMillis: Date.now(), proof: 'canonical_resource' });
      });
    }
    if (page.size < 400) return;
    cursor = page.docs[page.docs.length - 1];
  }
}
