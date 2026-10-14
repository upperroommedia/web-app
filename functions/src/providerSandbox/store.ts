import { createHash, randomUUID } from 'node:crypto';
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  getProviderExecutionProfile,
  sandboxProfileDocumentPath,
  SandboxProviderProfile,
  assertSandboxCatalogReady,
  assertMatchingSandboxProfile,
} from './profile';
import { DURABLE_COLLECTIONS, durableEntityKey } from '@upperroom/orchestration/job-store';
import {
  SandboxHttpError,
  SandboxResource,
  SandboxRequestContext,
  SandboxFaultPlan,
  SandboxScriptedFault,
  SandboxAssetEvidence,
} from './types';

/** Profile.ts validates and brands this server-owned configuration before reaching the engine. */
export type SandboxStoreProfile = SandboxProviderProfile;
export const sandboxResourceKey = (provider: string, family: string, id: string): string =>
  createHash('sha256')
    .update(JSON.stringify([provider, family, id]))
    .digest('hex');
export const sandboxScopeKey = (context: SandboxRequestContext): string => {
  const steps = context.stepId ? [context.stepId] : context.sourceStepIds;
  if (
    !context.jobId ||
    context.jobId.length > 256 ||
    !steps?.length ||
    steps.length > 32 ||
    steps.some((step) => !step || step.length > 256)
  )
    throw new SandboxHttpError(400, 'A server-owned job and step scope is required');
  return createHash('sha256')
    .update(JSON.stringify([context.jobId, [...steps].sort()]))
    .digest('hex');
};
export function sandboxRoot(profile: SandboxStoreProfile): DocumentReference {
  const actual = getProviderExecutionProfile();
  if (
    actual.mode !== 'sandbox' ||
    profile.projectId !== actual.projectId ||
    profile.profileId !== actual.profileId ||
    profile.schemaVersion !== 1 ||
    profile.version !== actual.version ||
    profile.mode !== 'sandbox' ||
    profile.namespace !== actual.namespace
  )
    throw new SandboxHttpError(403, 'Sandbox project/profile mismatch');
  return admin.firestore().doc(sandboxProfileDocumentPath(profile));
}
export class SandboxTransaction {
  private readonly writes = new Map<string, { ref: DocumentReference; data: SandboxResource }>();
  constructor(readonly tx: Transaction, readonly root: DocumentReference, readonly now: number) {}
  ref(provider: string, family: string, id: string): DocumentReference {
    if (!id || id.length > 256 || /[\s/?#]/.test(id)) throw new SandboxHttpError(400, 'Invalid resource identity');
    return this.root.collection('resources').doc(sandboxResourceKey(provider, family, id));
  }
  async hasIdentity(provider: string, family: string, id: string): Promise<boolean> {
    const ref = this.ref(provider, family, id);
    return this.writes.has(ref.path) || (await this.tx.get(ref)).exists;
  }
  async get(provider: string, family: string, id: string, optional = false): Promise<SandboxResource | undefined> {
    const ref = this.ref(provider, family, id);
    const staged = this.writes.get(ref.path)?.data;
    const snap = staged ? undefined : await this.tx.get(ref);
    const value = staged ?? (snap?.data() as SandboxResource | undefined);
    if (
      value &&
      (value.schemaVersion !== 1 || value.provider !== provider || value.family !== family || value.id !== id)
    )
      throw new SandboxHttpError(409, 'Sandbox resource namespace conflict');
    if (!value || value.deleted) {
      if (optional) return undefined;
      throw new SandboxHttpError(404, 'Sandbox resource not found');
    }
    return JSON.parse(JSON.stringify(value)) as SandboxResource;
  }
  async list(provider: string, family: string, filters: Record<string, string> = {}): Promise<SandboxResource[]> {
    let query = this.root.collection('resources').where('provider', '==', provider).where('family', '==', family);
    for (const [field, value] of Object.entries(filters)) {
      if (
        ![
          'body._embedded.source-list.id',
          'body._embedded.media-series.id',
          'body._embedded.media-item.id',
          'body._embedded.audio.id',
          'body._embedded.tag.id',
          'body.type',
          'body.status',
        ].includes(field)
      )
        throw new SandboxHttpError(400, 'Unsupported indexed resource filter');
      query = query.where(field, '==', value);
    }
    const snapshot = await this.tx.get(query.limit(2001));
    if (snapshot.size > 2000) throw new SandboxHttpError(422, 'Sandbox family exceeds bounded test catalog capacity');
    const values = new Map<string, SandboxResource>();
    for (const doc of snapshot.docs) {
      const value = doc.data() as SandboxResource;
      if (
        value.schemaVersion !== 1 ||
        value.provider !== provider ||
        value.family !== family ||
        doc.id !== sandboxResourceKey(provider, family, value.id)
      )
        throw new SandboxHttpError(409, 'Sandbox catalog corruption');
      values.set(value.id, value);
    }
    for (const { data } of this.writes.values())
      if (data.provider === provider && data.family === family) values.set(data.id, data);
    return [...values.values()]
      .filter(
        (value) =>
          !value.deleted &&
          Object.entries(filters).every(
            ([field, expected]) => field.split('.').reduce<any>((current, key) => current?.[key], value) === expected
          )
      )
      .map((value) => JSON.parse(JSON.stringify(value)) as SandboxResource);
  }
  put(value: SandboxResource): void {
    if (this.writes.size >= 400) throw new SandboxHttpError(422, 'Sandbox transaction exceeds bounded write capacity');
    this.writes.set(this.ref(value.provider, value.family, value.id).path, {
      ref: this.ref(value.provider, value.family, value.id),
      data: value,
    });
  }
  resourceReferences(): Array<{ provider: string; family: string; id: string; revision: number; deleted: boolean }> {
    return [...this.writes.values()].map(({ data }) => ({
      provider: data.provider,
      family: data.family,
      id: data.id,
      revision: data.revision,
      deleted: data.deleted,
    }));
  }
  commit(): void {
    for (const { ref, data } of this.writes.values()) this.tx.set(ref, data);
  }
}
export interface SandboxOperation {
  provider: string;
  method: string;
  path: string;
  context?: SandboxRequestContext;
}
async function readAssetAuthority(tx: Transaction, profile: SandboxStoreProfile, context: SandboxRequestContext) {
  const db = admin.firestore();
  sandboxScopeKey(context);
  const intent = (await tx.get(db.collection(DURABLE_COLLECTIONS.intents).doc(context.jobId))).data();
  const job = (await tx.get(db.collection(DURABLE_COLLECTIONS.jobs).doc(context.jobId))).data();
  if (
    !intent ||
    !job ||
    intent.projectId !== profile.projectId ||
    job.projectId !== profile.projectId ||
    intent.jobId !== context.jobId ||
    job.jobId !== context.jobId ||
    intent.generation !== job.generation ||
    ['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)
  )
    throw new SandboxHttpError(409, 'Sandbox job generation is not current');
  const entity = (
    await tx.get(
      db.collection(DURABLE_COLLECTIONS.entities).doc(durableEntityKey(profile.projectId, intent.entity, intent.kind))
    )
  ).data();
  if (!entity || entity.generation !== intent.generation || entity.activeJobId !== intent.jobId)
    throw new SandboxHttpError(409, 'Sandbox intent was superseded');
  const pin = intent.payload?.providerExecution;
  assertMatchingSandboxProfile(profile, pin);
  assertMatchingSandboxProfile(profile, job.providerExecution);
  if (pin.scenario !== job.providerExecution.scenario)
    throw new SandboxHttpError(409, 'Sandbox scenario provenance changed');
  return { pin, generation: intent.generation };
}
/** No request idempotency is invented: every accepted POST is a distinct provider creation. */
export async function runSandboxOperation<T>(
  profile: SandboxStoreProfile,
  operation: SandboxOperation,
  work: (store: SandboxTransaction, fault: SandboxFaultPlan | undefined) => Promise<T>
): Promise<T> {
  const db = admin.firestore(),
    root = sandboxRoot(profile),
    attemptId = randomUUID(),
    now = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const store = new SandboxTransaction(tx, root, now);
    const marker = await tx.get(root);
    assertSandboxCatalogReady(profile, marker.data());
    const stepScope = operation.context ? sandboxScopeKey(operation.context) : undefined;
    // One fault authority per job/provider. New activity attempts and changing step sets cannot re-arm it.
    const scopeKey = operation.context
      ? createHash('sha256')
          .update(JSON.stringify([operation.context.jobId, operation.provider]))
          .digest('hex')
      : undefined;
    const faultRef = scopeKey ? root.collection('faultPlans').doc(scopeKey) : undefined;
    const faultSnap = faultRef ? await tx.get(faultRef) : undefined;
    let configured = faultSnap?.data() as SandboxFaultPlan | undefined;
    let initialize = false;
    if (operation.context) {
      const { pin } = await readAssetAuthority(tx, profile, operation.context);
      if (configured && configured.fault !== pin.scenario)
        throw new SandboxHttpError(409, 'Pinned sandbox fault scenario changed');
      const eligible =
        pin.scenario === 'transient-failure'
          ? operation.method === 'GET'
          : pin.scenario === 'delayed-processing'
          ? operation.method === 'POST' && (operation.path === '/transcoder/v1/jobs' || operation.path === '/tracks')
          : !['GET', 'HEAD'].includes(operation.method);
      if (!configured && eligible) {
        configured = {
          schemaVersion: 1,
          jobId: operation.context.jobId,
          stepId: stepScope!,
          provider: operation.provider as SandboxFaultPlan['provider'],
          method: operation.method,
          path: operation.path,
          fault: pin.scenario,
          remaining: pin.scenario === 'success' ? 0 : 1,
          ...(pin.scenario === 'delayed-processing' ? { delayMillis: 15_000 } : {}),
        };
        initialize = true;
      }
    }
    if (
      configured &&
      (configured.schemaVersion !== 1 ||
        configured.jobId !== operation.context?.jobId ||
        configured.provider !== operation.provider ||
        ![
          'success',
          'delayed-processing',
          'transient-failure',
          'permanent-failure',
          'commit-then-lost-response',
        ].includes(configured.fault) ||
        !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(configured.method) ||
        !configured.path.startsWith('/') ||
        configured.path.length > 2048 ||
        configured.remaining < 0 ||
        configured.remaining > 1 ||
        !Number.isInteger(configured.remaining))
    )
      throw new SandboxHttpError(409, 'Invalid sandbox fault plan');
    const fault =
      configured &&
      configured.remaining > 0 &&
      configured.provider === operation.provider &&
      configured.method === operation.method &&
      configured.path === operation.path
        ? configured
        : undefined;
    const rejection =
      fault?.fault === 'transient-failure' ? 503 : fault?.fault === 'permanent-failure' ? 403 : undefined;
    const value = rejection ? undefined : await work(store, fault);
    // All reads precede all writes, including fault consumption and the immutable request journal.
    store.commit();
    if (initialize && faultRef && configured)
      tx.create(faultRef, {
        ...configured,
        remaining: fault && fault.fault !== 'permanent-failure' ? fault.remaining - 1 : configured.remaining,
      });
    else if (fault && faultRef && fault.fault !== 'permanent-failure')
      tx.update(faultRef, { remaining: fault.remaining - 1 });
    tx.create(root.collection('requests').doc(attemptId), {
      schemaVersion: 1,
      profileId: profile.profileId,
      provider: operation.provider,
      method: operation.method,
      path: operation.path,
      atMillis: now,
      ...(operation.context ? { jobId: operation.context.jobId, scopeKey } : {}),
      outcome: rejection
        ? 'rejected-before-effect'
        : fault?.fault === 'commit-then-lost-response'
        ? 'committed-response-lost'
        : 'acknowledged',
      fault: fault?.fault ?? 'success',
      resources: store.resourceReferences(),
    });
    return { value, rejection, lost: fault?.fault === 'commit-then-lost-response' };
  });
  if (result.rejection)
    throw new SandboxScriptedFault(
      result.rejection,
      result.rejection === 503 ? 'transient-failure' : 'permanent-failure',
      'Simulated provider rejection'
    );
  if (result.lost)
    throw new SandboxScriptedFault(
      undefined,
      'commit-then-lost-response',
      'Simulated provider committed; acknowledgement was lost',
      'ECONNRESET'
    );
  return result.value as T;
}

/** Read-only guard before allocating any private provider-owned Storage object. */
export async function assertSandboxAssetPreparation(
  profile: SandboxStoreProfile,
  context?: SandboxRequestContext
): Promise<void> {
  if (!context) throw new SandboxHttpError(403, 'Provider asset preparation requires a trusted current job');
  const root = sandboxRoot(profile),
    db = admin.firestore();
  await db.runTransaction(async (tx) => {
    assertSandboxCatalogReady(profile, (await tx.get(root)).data());
    await readAssetAuthority(tx, profile, context);
  });
}
/** A nonexpiring preparation record precedes Storage writes, including uncertain/stale outcomes. */
export interface SandboxAssetPreparation {
  id: string;
  target?: SandboxAssetEvidence;
  origin?: SandboxAssetEvidence;
}
const preparationOriginKey = (origin: SandboxAssetEvidence | undefined) =>
  origin
    ? JSON.stringify([origin.bucket, origin.path, origin.generation, origin.sha256, origin.size, origin.contentType])
    : null;
export async function beginSandboxAssetPreparation(
  profile: SandboxStoreProfile,
  context: SandboxRequestContext | undefined,
  path: string,
  origin?: SandboxAssetEvidence
): Promise<SandboxAssetPreparation> {
  if (
    !context ||
    !path.startsWith(`_providerSandbox/${profile.profileId}/`) ||
    path.length > 1024 ||
    /[\x00-\x1f]/.test(path)
  )
    throw new SandboxHttpError(403, 'Invalid provider asset preparation');
  const root = sandboxRoot(profile),
    db = admin.firestore(),
    id = createHash('sha256')
      .update(JSON.stringify([profile.profileId, context.jobId, path]))
      .digest('hex');
  return db.runTransaction(async (tx) => {
    assertSandboxCatalogReady(profile, (await tx.get(root)).data());
    const authority = await readAssetAuthority(tx, profile, context);
    const ref = root.collection('preparedAssets').doc(id),
      existing = (await tx.get(ref)).data();
    if (existing) {
      if (
        existing.schemaVersion !== 1 ||
        existing.profileId !== profile.profileId ||
        existing.projectId !== profile.projectId ||
        existing.jobId !== context.jobId ||
        existing.generation !== authority.generation ||
        existing.path !== path ||
        existing.bucket !== 'urm-app-staging.firebasestorage.app' ||
        preparationOriginKey(existing.origin) !== preparationOriginKey(origin) ||
        !['preparing', 'retained', 'write-uncertain'].includes(existing.state)
      )
        throw new SandboxHttpError(409, 'Private asset preparation identity conflict');
      if (
        existing.origin?.durationSeconds !== undefined &&
        origin?.durationSeconds !== undefined &&
        existing.origin.durationSeconds !== origin.durationSeconds
      )
        throw new SandboxHttpError(409, 'Private asset measurement provenance changed');
      return {
        id,
        ...(existing.target ? { target: existing.target as SandboxAssetEvidence } : {}),
        ...(existing.origin ? { origin: existing.origin as SandboxAssetEvidence } : {}),
      };
    }
    tx.create(ref, {
      schemaVersion: 1,
      profileId: profile.profileId,
      projectId: profile.projectId,
      jobId: context.jobId,
      generation: authority.generation,
      path,
      bucket: 'urm-app-staging.firebasestorage.app',
      state: 'preparing',
      createdAtMillis: Date.now(),
      retention: 'retain-until-explicit-owned-artifact-review',
      ...(origin ? { origin } : {}),
    });
    return { id, ...(origin ? { origin } : {}) };
  });
}
export async function completeSandboxAssetPreparation(
  profile: SandboxStoreProfile,
  id: string,
  evidence: SandboxAssetEvidence
): Promise<void> {
  const root = sandboxRoot(profile),
    db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const ref = root.collection('preparedAssets').doc(id),
      record = (await tx.get(ref)).data();
    if (
      !record ||
      record.profileId !== profile.profileId ||
      record.projectId !== profile.projectId ||
      record.path !== evidence.path ||
      record.bucket !== evidence.bucket ||
      !['preparing', 'write-uncertain', 'retained'].includes(record.state)
    )
      throw new SandboxHttpError(409, 'Owned provider preparation changed');
    if (
      record.target &&
      (record.target.generation !== evidence.generation ||
        record.target.sha256 !== evidence.sha256 ||
        record.target.size !== evidence.size)
    )
      throw new SandboxHttpError(409, 'Private asset target identity changed');
    tx.update(ref, { state: 'retained', target: evidence, completedAtMillis: Date.now() });
  });
}
export async function markSandboxAssetPreparationUncertain(profile: SandboxStoreProfile, id: string): Promise<void> {
  const root = sandboxRoot(profile),
    db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const ref = root.collection('preparedAssets').doc(id),
      record = (await tx.get(ref)).data();
    if (!record || record.projectId !== profile.projectId || record.profileId !== profile.profileId)
      throw new SandboxHttpError(409, 'Owned preparation evidence unavailable');
    if (record.state === 'preparing') tx.update(ref, { state: 'write-uncertain', observedAtMillis: Date.now() });
  });
}
