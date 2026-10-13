import { createHash } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction, type DocumentReference } from 'firebase-admin/firestore';

export const PROVIDER_USAGE_COLLECTION = 'temporalProviderUsage';
export const PROVIDER_USAGE_CONTROL = '_control/temporalProviderUsage';
export const PROVIDER_CANONICAL_COLLECTIONS = ['sermons', 'lists', 'series', 'speakers', 'images'] as const;
export interface ProviderResource {
  projectId: string;
  provider: 'subsplash' | 'soundcloud';
  account: string;
  remoteId: string;
}
export interface ProviderUsageMarker {
  schemaVersion: 1;
  projectId: string;
  epoch: string;
  status: 'building' | 'ready';
  releaseId: string;
  controlRevision: number;
}
export interface ProviderCleanupProof {
  jobId: string;
  receiptId: string;
  fingerprint: string;
  receiptRevision: number;
}
const sameCleanupProof = (value: unknown, proof: ProviderCleanupProof): boolean => {
  const candidate = value as ProviderCleanupProof | undefined;
  return (
    !!candidate &&
    candidate.jobId === proof.jobId &&
    candidate.receiptId === proof.receiptId &&
    candidate.fingerprint === proof.fingerprint &&
    candidate.receiptRevision === proof.receiptRevision
  );
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const providerResourceKey = (resource: ProviderResource) =>
  hash([resource.projectId, resource.provider, resource.account, resource.remoteId]);
export const providerEdgeKey = (canonicalPath: string) => hash(canonicalPath);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/?#]/.test(value);
/** Recognized provider fields are traversed through mirrors and private intent snapshots; generic local IDs are never remote references. */
export function extractProviderResources(projectId: string, canonicalPath: string, data: unknown): ProviderResource[] {
  const found = new Map<string, ProviderResource>();
  const add = (provider: ProviderResource['provider'], id: unknown) => {
    if (!validId(id)) return;
    const resource = {
      projectId,
      provider,
      account: provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
      remoteId: id,
    };
    found.set(providerResourceKey(resource), resource);
  };
  const walk = (value: unknown, context: string) => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, context));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          'subsplashId',
          'subsplashAudioId',
          'subsplashListId',
          'subsplashSeriesId',
          'moreSermonsRef',
          'manualOverflowTargetSubsplashId',
          'sermonSubsplashId',
          'tagId',
        ].includes(key)
      )
        add('subsplash', item);
      if (key === 'soundCloudTrackId') add('soundcloud', item);
      if (item && typeof item === 'object') walk(item, key === 'images' ? 'images' : key);
    }
  };
  walk(data, canonicalPath.split('/')[0] === 'images' ? 'images' : 'root');
  return [...found.values()];
}
export function assertProviderUsageMarker(value: unknown, projectId: string): ProviderUsageMarker {
  const marker = value as ProviderUsageMarker | undefined;
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    marker.projectId !== projectId ||
    marker.status !== 'ready' ||
    !validId(marker.epoch)
  )
    throw new Error('PROVIDER_USAGE_INDEX_NOT_READY');
  return marker;
}
function aggregateRef(db: Firestore, resource: ProviderResource, marker: ProviderUsageMarker) {
  if (
    !validId(resource.projectId) ||
    !validId(resource.remoteId) ||
    !['subsplash', 'soundcloud'].includes(resource.provider) ||
    resource.account !== (resource.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account')
  )
    throw new Error('PROVIDER_RESOURCE_SCOPE_INVALID');
  return db
    .collection(PROVIDER_USAGE_COLLECTION)
    .doc(providerResourceKey(resource))
    .collection('epochs')
    .doc(marker.epoch);
}
/** All reads happen in preparation; invoke returned callback after every other transaction read. */
export interface ProviderUsageChange {
  projectId: string;
  canonicalPath: string;
  before: unknown;
  after: unknown;
}
export interface ProviderUsageReservedProjectionAuthority {
  jobId: string;
  sourceProof: unknown;
  validate(
    tx: Transaction,
    proof: unknown,
    input: {
      change: ProviderUsageChange;
      resource: ProviderResource;
      desiredDeletionProof: Record<string, unknown>;
    }
  ): Promise<void>;
}
export async function prepareProviderUsageChange(tx: Transaction, db: Firestore, input: ProviderUsageChange) {
  return prepareProviderUsageChanges(tx, db, [input]);
}
/** Batch aggregation avoids lost counts when multiple canonical documents reference one resource in the same transaction. */
export async function prepareProviderUsageChanges(
  tx: Transaction,
  db: Firestore,
  changes: ProviderUsageChange[],
  reservedProjection?: ProviderUsageReservedProjectionAuthority
) {
  if (!changes.length) return () => {};
  const projectId = changes[0].projectId;
  if (
    changes.some((change) => change.projectId !== projectId) ||
    new Set(changes.map((change) => change.canonicalPath)).size !== changes.length
  )
    throw new Error('PROVIDER_USAGE_CHANGE_SCOPE_INVALID');
  const marker = assertProviderUsageMarker((await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(), projectId);
  let reservedIntent: Record<string, any> | undefined;
  if (reservedProjection) {
    if (
      !validId(reservedProjection.jobId) ||
      !reservedProjection.sourceProof ||
      typeof reservedProjection.validate !== 'function'
    )
      throw new Error('PROVIDER_RESERVED_PROJECTION_AUTHORITY_INVALID');
    const intent = await tx.get(db.doc(`durableJobIntents/${reservedProjection.jobId}`));
    reservedIntent = objectRecord(intent.data());
    if (!intent.exists || reservedIntent.projectId !== projectId || reservedIntent.jobId !== reservedProjection.jobId)
      throw new Error('PROVIDER_RESERVED_PROJECTION_AUTHORITY_INVALID');
  }
  const resources = new Map<
    string,
    { resource: ProviderResource; edges: Array<{ path: string; adding: boolean; wasPresent: boolean }> }
  >();
  for (const change of changes) {
    const old = new Map(
      extractProviderResources(projectId, change.canonicalPath, change.before).map((r) => [providerResourceKey(r), r])
    );
    const next = new Map(
      extractProviderResources(projectId, change.canonicalPath, change.after).map((r) => [providerResourceKey(r), r])
    );
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const group = resources.get(key) ?? { resource: next.get(key) ?? old.get(key)!, edges: [] };
      group.edges.push({ path: change.canonicalPath, adding: next.has(key), wasPresent: old.has(key) });
      resources.set(key, group);
    }
  }
  const writes: Array<() => void> = [];
  for (const group of resources.values()) {
    const ref = aggregateRef(db, group.resource, marker),
      snapshot = await tx.get(ref);
    const count = snapshot.get('referenceCount') ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
    let delta = 0;
    const edgeWrites: Array<() => void> = [];
    for (const change of group.edges) {
      const edge = ref.collection('edges').doc(providerEdgeKey(change.path)),
        edgeSnapshot = await tx.get(edge);
      if (change.wasPresent !== edgeSnapshot.exists) throw new Error('PROVIDER_USAGE_CANONICAL_EDGE_MISMATCH');
      if (change.adding && ['reserved', 'deleted'].includes(snapshot.get('state'))) {
        const desiredProof = objectRecord(snapshot.get('desiredDeletionProof'));
        if (
          !reservedProjection ||
          snapshot.get('state') !== 'reserved' ||
          !change.wasPresent ||
          !edgeSnapshot.exists ||
          desiredProof.jobId !== reservedProjection.jobId ||
          desiredProof.generation !== reservedIntent?.generation ||
          desiredProof.intentFingerprint !== desiredProviderDeletionIntentFingerprint(reservedIntent)
        )
          throw new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED');
        const canonicalChange = changes.find((input) => input.canonicalPath === change.path)!;
        // Factual stop pages can retain an existing association, never introduce a new one.
        const prior = new Set(
          extractProviderResources(projectId, change.path, canonicalChange.before).map(providerResourceKey)
        );
        if (
          extractProviderResources(projectId, change.path, canonicalChange.after).some(
            (resource) => !prior.has(providerResourceKey(resource))
          )
        )
          throw new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED');
        await reservedProjection.validate(tx, reservedProjection.sourceProof, {
          change: canonicalChange,
          resource: group.resource,
          desiredDeletionProof: desiredProof,
        });
      }
      const difference = Number(change.adding) - Number(edgeSnapshot.exists);
      delta += difference;
      if (difference)
        edgeWrites.push(() => {
          if (change.adding) tx.create(edge, { canonicalPath: change.path, projectId });
          else tx.delete(edge);
        });
    }
    if (count + delta < 0) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
    if (delta || edgeWrites.length)
      writes.push(() => {
        tx.set(
          ref,
          {
            ...group.resource,
            epoch: marker.epoch,
            state: snapshot.get('state') ?? 'active',
            referenceCount: FieldValue.increment(delta),
          },
          { merge: true }
        );
        edgeWrites.forEach((write) => write());
      });
  }
  return () => writes.forEach((write) => write());
}

function receiptResourceId(receipt: Record<string, any>): unknown {
  const result = receipt.result;
  return typeof result === 'string'
    ? result
    : result?.id ?? result?.listId ?? result?.tagId ?? result?.soundCloudTrackId ?? result?.trackIdentifier;
}
/** Claims never expire. A lost DELETE acknowledgement continues blocking association until GET proves absence or explicit review retains it. */
export async function prepareProviderCleanupClaim(
  tx: Transaction,
  db: Firestore,
  resource: ProviderResource,
  proof: ProviderCleanupProof
) {
  const marker = assertProviderUsageMarker((await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(), resource.projectId);
  const ref = aggregateRef(db, resource, marker);
  const [snapshot, receiptSnapshot] = await Promise.all([
    tx.get(ref),
    tx.get(db.collection('temporalProviderReceipts').doc(proof.receiptId)),
  ]);
  const receipt = receiptSnapshot.data();
  if (
    !receipt ||
    receipt.state !== 'confirmed' ||
    receipt.projectId !== resource.projectId ||
    receipt.jobId !== proof.jobId ||
    receipt.fingerprint !== proof.fingerprint ||
    (receipt.revision ?? 0) !== proof.receiptRevision ||
    receiptResourceId(receipt) !== resource.remoteId ||
    (resource.provider === 'soundcloud') !== (receipt.step === 'soundcloud-track')
  )
    throw new Error('PROVIDER_CLEANUP_RECEIPT_PROOF_INVALID');
  // Adoption selects a compatible existing object; it does not establish exclusive ownership or prove the original POST result.
  if (receipt.adoptionAudit?.decision === 'adopt_existing_resource')
    return { state: 'referenced' as const, commit: () => {} };
  const count = snapshot.get('referenceCount') ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  if (count > 0) return { state: 'referenced' as const, commit: () => {} };
  const existingProof = snapshot.get('cleanupProof');
  if (snapshot.get('state') === 'deleted') return { state: 'deleted' as const, commit: () => {} };
  if (snapshot.get('state') === 'reserved' && !sameCleanupProof(existingProof, proof))
    throw new Error('PROVIDER_CLEANUP_ALREADY_RESERVED');
  return {
    state: 'reserved' as const,
    commit: () =>
      tx.set(
        ref,
        {
          ...resource,
          epoch: marker.epoch,
          referenceCount: 0,
          state: 'reserved',
          cleanupProof: proof,
          reservedAtMillis: snapshot.get('reservedAtMillis') ?? Date.now(),
        },
        { merge: true }
      ),
  };
}
export async function prepareProviderCleanupSettlement(
  tx: Transaction,
  db: Firestore,
  resource: ProviderResource,
  proof: ProviderCleanupProof,
  outcome: 'confirmed_absent' | 'reviewed_retain'
) {
  const marker = assertProviderUsageMarker((await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(), resource.projectId);
  const ref = aggregateRef(db, resource, marker),
    snapshot = await tx.get(ref);
  if (
    snapshot.get('state') !== 'reserved' ||
    !sameCleanupProof(snapshot.get('cleanupProof'), proof) ||
    snapshot.get('referenceCount') !== 0
  )
    throw new Error('PROVIDER_CLEANUP_SETTLEMENT_MISMATCH');
  return () =>
    tx.update(ref, {
      state: outcome === 'confirmed_absent' ? 'deleted' : 'active',
      settlement: outcome,
      settledAtMillis: Date.now(),
    });
}

/** Reserve a resource BEFORE an external request can bind it; canonical-only guards are too late. */
export async function prepareReviewedLegacySoundCloudRetentionBinding(
  tx: Transaction,
  db: Firestore,
  input: { ref: { projectId: string; jobId: string }; certificateId: string; resource: ProviderResource }
): Promise<() => void> {
  const invalid = (): never => {
    throw new Error('PROVIDER_REVIEWED_RETENTION_PROOF_INVALID');
  };
  const { ref: owner, certificateId, resource } = input;
  if (
    !/^[a-f0-9]{64}$/.test(certificateId) ||
    resource.projectId !== owner.projectId ||
    resource.provider !== 'soundcloud' ||
    resource.account !== 'configured-account'
  )
    invalid();
  const [certificateDoc, grantDoc, observationDoc, intentDoc, jobDoc, markerDoc] = await Promise.all([
    tx.get(db.doc(`temporalLegacySoundCloudRetentionCertificates/${certificateId}`)),
    tx.get(db.doc(`durableJobCriticalRepairGrants/${owner.jobId}`)),
    tx.get(db.doc(`temporalLegacySoundCloudRetentionObservations/${owner.jobId}`)),
    tx.get(db.doc(`durableJobIntents/${owner.jobId}`)),
    tx.get(db.doc(`durableJobs/${owner.jobId}`)),
    tx.get(db.doc(PROVIDER_USAGE_CONTROL)),
  ]);
  const certificate = objectRecord(certificateDoc.data()),
    grant = objectRecord(grantDoc.data()),
    observation = objectRecord(observationDoc.data()),
    intent = objectRecord(intentDoc.data()),
    job = objectRecord(jobDoc.data());
  if (
    !certificateDoc.exists ||
    hash(sortedValue(certificate)) !== certificateId ||
    certificate.schemaVersion !== 1 ||
    certificate.projectId !== owner.projectId ||
    certificate.jobId !== owner.jobId ||
    certificate.trackId !== resource.remoteId ||
    certificate.sermonId !== intent.entity?.id ||
    intent.entity?.type !== 'sermon' ||
    objectRecord(objectRecord(intent.payload).payload).sermon?.soundCloudTrackId !== resource.remoteId ||
    !/^[a-f0-9]{64}$/.test(certificate.canonicalDocumentDigest ?? '') ||
    hash(sortedValue(certificate.resource)) !== hash(sortedValue(resource)) ||
    certificate.originalOwner !== 'unverified' ||
    certificate.disposition !== 'permanent_retention_without_absence_claim' ||
    !/^soundcloud:users:[0-9]+$/.test(certificate.observedCurrentAccount ?? '') ||
    !intentDoc.exists ||
    intent.projectId !== owner.projectId ||
    intent.jobId !== owner.jobId ||
    certificate.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    certificate.generation !== intent.generation ||
    !jobDoc.exists ||
    job.projectId !== owner.projectId ||
    job.jobId !== owner.jobId ||
    job.generation !== intent.generation ||
    job.workflowId !== certificate.workflowId ||
    !['running', 'retrying', 'reconciling', 'needs_attention', 'cancel_requested'].includes(job.state) ||
    !observationDoc.exists ||
    hash(sortedValue(observation)) !== certificate.observationDigest ||
    observation.projectId !== owner.projectId ||
    observation.jobId !== owner.jobId ||
    observation.trackId !== resource.remoteId ||
    observation.originalOwner !== 'unverified' ||
    observation.originalHttpStatus !== 404 ||
    observation.providerMutationSent !== false ||
    !grantDoc.exists ||
    grant.schemaVersion !== 1 ||
    grant.projectId !== owner.projectId ||
    grant.jobId !== owner.jobId ||
    grant.generation !== certificate.generation ||
    grant.workflowId !== certificate.workflowId ||
    grant.intentFingerprint !== certificate.intentFingerprint ||
    grant.retentionAcknowledged !== true ||
    !grant.actorUid ||
    !grant.commandId ||
    !grant.reason?.trim() ||
    !grant.evidenceReference?.trim() ||
    !Array.isArray(grant.sourceCertificateIds) ||
    !grant.sourceCertificateIds.includes(certificateId) ||
    !Array.isArray(grant.operations) ||
    !grant.operations.some(
      (op: any) =>
        op?.kind === 'legacy_soundcloud_retain' && op.certificateId === certificateId && Object.keys(op).length === 2
    )
  )
    invalid();
  // Even a reviewed certificate cannot override a later sent/uncertain request. Inspect every original session, not just the SC session.
  const sessions = db
    .collection('temporalProviderMutationSessions')
    .where('scope.projectId', '==', owner.projectId)
    .where('scope.jobId', '==', owner.jobId);
  const pages = async function* (query: any): AsyncGenerator<any[]> {
    let cursor: any;
    for (;;) {
      const base = query.orderBy('__name__').limit(100),
        page = await tx.get(cursor ? base.startAfter(cursor) : base);
      yield page.docs;
      if (page.size < 100) return;
      cursor = page.docs.at(-1);
    }
  };
  for await (const page of pages(sessions))
    for (const session of page) {
      const data = objectRecord(session.data());
      if (
        data.schemaVersion !== 1 ||
        data.scope?.projectId !== owner.projectId ||
        data.scope?.jobId !== owner.jobId ||
        session.id !== hash(sortedValue(data.scope)) ||
        !['active', 'committed', 'aborted'].includes(data.state)
      )
        invalid();
      for await (const requests of pages(session.ref.collection('requests')))
        for (const requestDoc of requests) {
          const request = objectRecord(requestDoc.data());
          if (!['acknowledged', 'rejected_no_effect'].includes(request.state)) invalid();
          const planned = await tx.get(
            db.doc(`temporalPublishingAcknowledgedProjections/${session.id}/requestIndex/${hash(request.step)}`)
          );
          const plannedRequest = objectRecord(planned.get('request'));
          if (
            !planned.exists ||
            plannedRequest.step !== request.step ||
            plannedRequest.fingerprint !== request.fingerprint ||
            plannedRequest.method !== request.method ||
            plannedRequest.target?.provider !== 'subsplash'
          )
            invalid();
        }
    }
  for await (const page of pages(
    db
      .collection('temporalPublishingDeletionReceipts')
      .where('projectId', '==', owner.projectId)
      .where('jobId', '==', owner.jobId)
  ))
    if (page.some((row) => row.get('provider') === 'soundcloud')) invalid();
  for await (const page of pages(
    db
      .collection('temporalProviderReceipts')
      .where('projectId', '==', owner.projectId)
      .where('jobId', '==', owner.jobId)
  ))
    if (
      page.some(
        (row) =>
          ['executing', 'needs_review'].includes(row.get('state')) ||
          (row.get('step') === 'soundcloud-track' && row.get('state') !== 'prepared')
      )
    )
      invalid();
  const marker = assertProviderUsageMarker(markerDoc.data(), owner.projectId),
    aggregate = aggregateRef(db, resource, marker);
  const bindingOwner = `retention:${certificateId}`,
    bindingId = 'permanent-legacy-soundcloud',
    path = `providerBindings/${bindingOwner}/${bindingId}`;
  const edgeRef = aggregate.collection('edges').doc(providerEdgeKey(path));
  const [snapshot, edge] = await Promise.all([tx.get(aggregate), tx.get(edgeRef)]);
  const proof = snapshot.get('desiredDeletionProof'),
    count = snapshot.get('referenceCount') ?? 0;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    snapshot.get('state') === 'deleted' ||
    (snapshot.get('state') === 'reserved' &&
      (proof?.jobId !== owner.jobId ||
        proof.resourceType !== 'track' ||
        proof.intentFingerprint !== certificate.intentFingerprint ||
        proof.generation !== certificate.generation)) ||
    (edge.exists &&
      (edge.get('canonicalPath') !== path ||
        edge.get('projectId') !== owner.projectId ||
        edge.get('jobId') !== bindingOwner ||
        edge.get('bindingId') !== bindingId))
  )
    invalid();
  return () => {
    tx.set(
      aggregate,
      {
        ...resource,
        epoch: marker.epoch,
        state: 'active',
        referenceCount: FieldValue.increment(edge.exists ? 0 : 1),
        settlement: 'reviewed_retain',
        reviewedRetention: { jobId: owner.jobId, certificateId, actorUid: grant.actorUid, commandId: grant.commandId },
      },
      { merge: true }
    );
    if (!edge.exists)
      tx.create(edgeRef, {
        projectId: owner.projectId,
        canonicalPath: path,
        jobId: bindingOwner,
        bindingId,
        state: 'pending_effect',
      });
  };
}
export async function prepareProviderBinding(
  tx: Transaction,
  db: Firestore,
  input: {
    resource: ProviderResource;
    jobId: string;
    bindingId: string;
  }
) {
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker);
  const path = `providerBindings/${input.jobId}/${input.bindingId}`;
  const edge = ref.collection('edges').doc(providerEdgeKey(path));
  const [snapshot, existing] = await Promise.all([tx.get(ref), tx.get(edge)]);
  if (['reserved', 'deleted'].includes(snapshot.get('state'))) throw new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED');
  const count = snapshot.get('referenceCount') ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  return () => {
    if (existing.exists) return;
    tx.set(
      ref,
      { ...input.resource, epoch: marker.epoch, referenceCount: FieldValue.increment(1), state: 'active' },
      { merge: true }
    );
    tx.create(edge, {
      projectId: input.resource.projectId,
      canonicalPath: path,
      jobId: input.jobId,
      bindingId: input.bindingId,
      state: 'pending_effect',
    });
  };
}
/** Release only after the remote association is removed/proved absent or durably represented by canonical edges. */
export async function prepareProviderBindingRelease(
  tx: Transaction,
  db: Firestore,
  input: {
    resource: ProviderResource;
    jobId: string;
    bindingId: string;
  }
) {
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker),
    edge = ref.collection('edges').doc(providerEdgeKey(`providerBindings/${input.jobId}/${input.bindingId}`));
  const [snapshot, existing] = await Promise.all([tx.get(ref), tx.get(edge)]);
  if (!existing.exists) return () => {};
  const count = snapshot.get('referenceCount');
  if (!Number.isSafeInteger(count) || count < 1 || snapshot.get('state') !== 'active')
    throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  return () => {
    tx.update(ref, { referenceCount: FieldValue.increment(-1) });
    tx.delete(edge);
  };
}

const sortedValue = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sortedValue(item) ?? null);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, sortedValue(item)])
    );
  return value;
};
export function providerAcknowledgementFactFingerprint(fact: Record<string, unknown>): string {
  const { review: _review, ...immutableFact } = fact;
  return hash(sortedValue(immutableFact));
}
/** The coordinator must authenticate a fixed original ACK-ID GET absence before requesting cleanup_verified. No adopted result is consulted. */
export async function prepareProviderAcknowledgementDisposition(
  tx: Transaction,
  db: Firestore,
  input: {
    resource: ProviderResource;
    jobId: string;
    acknowledgementId: string;
    factFingerprint: string;
    decision: 'retain_after_review' | 'cleanup_verified';
    pendingBinding?: { jobId: string; bindingId: string };
  }
) {
  if (!/^[a-f0-9]{64}$/.test(input.acknowledgementId) || !/^[a-f0-9]{64}$/.test(input.factFingerprint))
    throw new Error('PROVIDER_ACKNOWLEDGEMENT_PROOF_INVALID');
  const fact = (await tx.get(db.collection('temporalProviderAcknowledgements').doc(input.acknowledgementId))).data();
  if (
    !fact ||
    fact.schemaVersion !== 1 ||
    fact.projectId !== input.resource.projectId ||
    fact.jobId !== input.jobId ||
    fact.remoteId !== input.resource.remoteId ||
    fact.disposition !== 'orphaned' ||
    providerAcknowledgementFactFingerprint(fact) !== input.factFingerprint ||
    (fact.step === 'soundcloud-track') !== (input.resource.provider === 'soundcloud') ||
    hash(sortedValue([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId])) !==
      input.acknowledgementId
  )
    throw new Error('PROVIDER_ACKNOWLEDGEMENT_PROOF_INVALID');
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker),
    snapshot = await tx.get(ref);
  let pendingEdge: DocumentReference | undefined;
  let pendingExists = false;
  if (input.pendingBinding) {
    const expectedJobId = hash(['provider-orphan-review', input.resource.projectId, input.acknowledgementId]);
    const expectedBindingId = `pending-provider-ack:${input.acknowledgementId}`;
    if (input.pendingBinding.jobId !== expectedJobId || input.pendingBinding.bindingId !== expectedBindingId)
      throw new Error('PROVIDER_ACKNOWLEDGEMENT_PENDING_BINDING_INVALID');
    const path = `providerBindings/${expectedJobId}/${expectedBindingId}`;
    pendingEdge = ref.collection('edges').doc(providerEdgeKey(path));
    const pending = await tx.get(pendingEdge);
    pendingExists = pending.exists;
    if (
      pendingExists &&
      (pending.get('projectId') !== input.resource.projectId ||
        pending.get('canonicalPath') !== path ||
        pending.get('jobId') !== expectedJobId ||
        pending.get('bindingId') !== expectedBindingId)
    )
      throw new Error('PROVIDER_ACKNOWLEDGEMENT_PENDING_BINDING_INVALID');
  }
  const count = snapshot.get('referenceCount') ?? 0;
  if (!Number.isSafeInteger(count) || count < Number(pendingExists)) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  if (input.decision === 'retain_after_review') {
    const retain = await prepareProviderBinding(tx, db, {
      resource: input.resource,
      jobId: input.jobId,
      bindingId: `retained-orphan:${input.acknowledgementId}`,
    });
    return () => {
      retain();
      if (pendingExists && pendingEdge) {
        tx.update(ref, { referenceCount: FieldValue.increment(-1) });
        tx.delete(pendingEdge);
      }
    };
  }
  if (input.decision !== 'cleanup_verified') throw new Error('PROVIDER_ACKNOWLEDGEMENT_PROOF_INVALID');
  if (
    count - Number(pendingExists) !== 0 ||
    (snapshot.get('state') === 'reserved' && snapshot.get('cleanupProof')?.jobId !== input.jobId)
  )
    throw new Error('PROVIDER_ACKNOWLEDGEMENT_RESOURCE_REFERENCED');
  return () => {
    if (pendingExists && pendingEdge) tx.delete(pendingEdge);
    tx.set(
      ref,
      {
        ...input.resource,
        epoch: marker.epoch,
        state: 'deleted',
        referenceCount: 0,
        acknowledgementProof: {
          jobId: input.jobId,
          acknowledgementId: input.acknowledgementId,
          factFingerprint: input.factFingerprint,
        },
        settlement: 'confirmed_absent',
        settledAtMillis: Date.now(),
      },
      { merge: true }
    );
  };
}

export type DesiredProviderDeletionType = 'media' | 'track' | 'tag' | 'list' | 'series';
export interface DesiredProviderDeletionInput {
  resource: ProviderResource;
  jobId: string;
  resourceType: DesiredProviderDeletionType;
}
export const desiredProviderDeletionPlanId = (input: DesiredProviderDeletionInput): string =>
  hash([input.resource.projectId, input.jobId, input.resourceType, providerResourceKey(input.resource)]);
export const desiredProviderDeletionIntentFingerprint = (intent: unknown): string => hash(sortedValue(intent));
export const desiredProviderDeletionDocumentFingerprint = (data: unknown): string => hash(sortedValue(data));
const desiredProjectionHeaderFingerprint = (header: Record<string, any>): string =>
  hash(
    sortedValue(
      Object.fromEntries(
        [
          'schemaVersion',
          'projectId',
          'jobId',
          'resource',
          'resourceType',
          'entity',
          'generation',
          'intentFingerprint',
          'method',
          'requestFingerprint',
        ].map((key) => [key, header[key]])
      )
    )
  );
interface DesiredDeletionScope {
  kind: string;
  entityType: string;
  entityId: string;
  generation: number;
  intentFingerprint: string;
  rootPath: string;
  chainIds?: Set<string>;
}
const objectRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const desiredInvalid = (): never => {
  throw new Error('PROVIDER_DESIRED_DELETION_PROOF_INVALID');
};
const sermonDeletionHeaderFingerprint = (plan: Record<string, any>): string =>
  hash(
    sortedValue({
      planId: plan.planId,
      intentFingerprint: plan.intentFingerprint,
      generation: plan.generation,
      workflowId: plan.workflowId,
      frozenProgramDigest: plan.frozenProgramDigest,
    })
  );
const desiredSpeakerMatches = (speaker: unknown, speakerId: string, tagId: string): boolean => {
  const value = objectRecord(speaker);
  return typeof value.id === 'string' && value.id.length > 0 ? value.id === speakerId : value.tagId === tagId;
};
/** Authority comes from the immutable server intent and canonical graph, never supplied path lists. */
async function desiredDeletionScope(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput,
  intent: Record<string, any>,
  job: Record<string, any>
): Promise<DesiredDeletionScope> {
  const entity = objectRecord(intent.entity),
    domain = objectRecord(intent.payload);
  if (
    intent.projectId !== input.resource.projectId ||
    intent.jobId !== input.jobId ||
    job.projectId !== intent.projectId ||
    job.jobId !== intent.jobId ||
    job.kind !== intent.kind ||
    job.generation !== intent.generation ||
    job.entity?.type !== entity.type ||
    job.entity?.id !== entity.id ||
    !validId(entity.id) ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state)
  )
    desiredInvalid();
  if ((input.resourceType === 'track') !== (input.resource.provider === 'soundcloud')) desiredInvalid();
  const scope: DesiredDeletionScope = {
    kind: intent.kind,
    entityType: entity.type,
    entityId: entity.id,
    generation: intent.generation,
    intentFingerprint: hash(sortedValue(intent)),
    rootPath: '',
  };
  if (entity.type === 'sermon' && ['media', 'track'].includes(input.resourceType)) {
    if (domain.sermonId !== entity.id || domain.generation !== intent.generation) desiredInvalid();
    const content = objectRecord(domain.payload),
      snapshot = objectRecord(content.sermon);
    const action = domain.action;
    const permitted =
      input.resourceType === 'media'
        ? intent.kind === 'sermon.delete' && action === 'delete'
        : (intent.kind === 'sermon.delete' && action === 'delete') ||
          (intent.kind === 'sermon.unpublish' && action === 'unpublish' && domain.destinations?.soundcloud === true) ||
          (intent.kind === 'sermon.update' &&
            action === 'update' &&
            (content.removals?.soundcloud === true || content.processAudio?.soundcloudPolicy === 'recreate_track'));
    if (!permitted) desiredInvalid();
    const field = input.resourceType === 'media' ? 'subsplashId' : 'soundCloudTrackId';
    if (snapshot[field] !== input.resource.remoteId) desiredInvalid();
    scope.rootPath = `sermons/${entity.id}`;
    const current = (await tx.get(db.doc(scope.rootPath))).data();
    if (!current) return desiredInvalid();
    if (current[field] !== input.resource.remoteId) {
      if (
        input.resourceType !== 'track' ||
        intent.kind !== 'sermon.update' ||
        content.processAudio?.soundcloudPolicy !== 'recreate_track'
      )
        desiredInvalid();
      const replacement = (
        await tx.get(db.doc(`temporalPublishingAudioReplacements/${input.jobId}-${entity.id}`))
      ).data();
      if (
        !replacement ||
        replacement.oldSoundCloudId !== input.resource.remoteId ||
        replacement.soundcloudBound !== true ||
        !validId(replacement.newSoundCloudId) ||
        replacement.newSoundCloudId === input.resource.remoteId ||
        current.soundCloudTrackId !== replacement.newSoundCloudId ||
        !replacement.oldSoundCloudAccount
      )
        desiredInvalid();
    }
    return scope;
  }
  const normalized = objectRecord(domain.payload),
    operation = normalized.operation,
    source = objectRecord(normalized.input);
  if (domain.kind !== intent.kind || domain.entity?.type !== entity.type || domain.entity?.id !== entity.id)
    desiredInvalid();
  if (
    input.resourceType === 'series' &&
    entity.type === 'series' &&
    intent.kind === 'series.delete' &&
    operation === 'delete'
  ) {
    scope.rootPath = `series/${entity.id}`;
    if ((await tx.get(db.doc(scope.rootPath))).get('subsplashId') !== input.resource.remoteId) desiredInvalid();
    return scope;
  }
  let selectedListId: string | undefined;
  if (
    input.resourceType === 'tag' &&
    entity.type === 'speaker' &&
    intent.kind === 'speaker.mutate' &&
    operation === 'delete' &&
    source.speakerId === entity.id
  ) {
    scope.rootPath = `speakers/${entity.id}`;
    if ((await tx.get(db.doc(scope.rootPath))).get('tagId') !== input.resource.remoteId) desiredInvalid();
    return scope;
  }
  if (input.resourceType === 'list') {
    if (
      entity.type === 'list' &&
      intent.kind === 'list.delete' &&
      operation === 'delete' &&
      (source.listId === undefined || source.listId === entity.id)
    )
      selectedListId = entity.id;
    if (
      entity.type === 'speaker' &&
      intent.kind === 'speaker.mutate' &&
      ['delete', 'update'].includes(operation) &&
      source.speakerId === entity.id &&
      source.deleteAssociatedList === true
    ) {
      const speaker = await tx.get(db.doc(`speakers/${entity.id}`));
      if (validId(speaker.get('listId'))) selectedListId = speaker.get('listId');
    }
  }
  if (!selectedListId) return desiredInvalid();
  const selected = await tx.get(db.doc(`lists/${selectedListId}`));
  if (!selected.exists) desiredInvalid();
  const rootId = selected.get('rootListId') || selectedListId;
  if (!validId(rootId)) desiredInvalid();
  scope.rootPath = `lists/${rootId}`;
  const chain = new Set<string>();
  let node = await tx.get(db.doc(scope.rootPath)),
    targetFound = false;
  for (;;) {
    if (!node.exists || chain.has(node.id) || (node.id !== rootId && node.get('rootListId') !== rootId))
      desiredInvalid();
    chain.add(node.id);
    if (node.get('subsplashId') === input.resource.remoteId) targetFound = true;
    const next = node.get('moreSermonsRef');
    if (!next) break;
    if (!validId(next)) desiredInvalid();
    const mapping = await tx.get(db.collection('lists').where('subsplashId', '==', next).limit(2));
    if (mapping.size !== 1) desiredInvalid();
    node = mapping.docs[0];
  }
  if (!chain.has(selectedListId) || !targetFound) desiredInvalid();
  scope.chainIds = chain;
  return scope;
}
function desiredOwnCanonicalEdge(
  input: DesiredProviderDeletionInput,
  scope: DesiredDeletionScope,
  path: string,
  data: unknown
): boolean {
  // Sermon deletion has a complete frozen root/mirror ledger; ownership alone is insufficient.
  if (scope.kind === 'sermon.delete') return false;
  if (path === scope.rootPath && !scope.chainIds) return true;
  const parts = path.split('/');
  if (scope.chainIds)
    return (
      parts[0] === 'lists' &&
      scope.chainIds.has(parts[1]) &&
      (parts.length === 2 || (parts.length === 4 && parts[2] === 'listItems'))
    );
  if (input.resourceType === 'series' && scope.kind === 'series.delete')
    return parts.length === 4 && parts[0] === 'series' && parts[1] === scope.entityId && parts[2] === 'seriesItems';
  if (input.resourceType === 'media' && scope.kind === 'sermon.delete')
    return (
      parts.length === 4 &&
      ['lists', 'series'].includes(parts[0]) &&
      ['listItems', 'seriesItems'].includes(parts[2]) &&
      parts[3] === scope.entityId
    );
  if (input.resourceType === 'tag' && scope.kind === 'speaker.mutate' && parts.length === 2 && parts[0] === 'sermons') {
    const canonical = objectRecord(data),
      speakers = Array.isArray(canonical.speakers) ? canonical.speakers : [];
    const next = {
      ...canonical,
      speakers: speakers.filter((speaker) => !desiredSpeakerMatches(speaker, scope.entityId, input.resource.remoteId)),
    };
    return extractProviderResources(input.resource.projectId, path, next).every(
      (resource) => providerResourceKey(resource) !== providerResourceKey(input.resource)
    );
  }
  return false;
}
async function plannedDesiredCanonicalRemoval(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput,
  scope: DesiredDeletionScope,
  path: string,
  data: unknown,
  prepared?: { plan: Record<string, any>; removal: Record<string, any> }
): Promise<string | undefined> {
  const parts = path.split('/'),
    before = objectRecord(data);
  const listMirror =
    !!scope.chainIds &&
    parts.length === 4 &&
    parts[0] === 'sermons' &&
    parts[2] === 'sermonLists' &&
    scope.chainIds.has(parts[3]);
  if (scope.kind === 'sermon.delete') {
    const owned =
      path === scope.rootPath ||
      (parts.length === 4 &&
        ((parts[0] === 'sermons' && parts[1] === scope.entityId && parts[2] === 'sermonLists') ||
          (['lists', 'series'].includes(parts[0]) &&
            ['listItems', 'seriesItems'].includes(parts[2]) &&
            parts[3] === scope.entityId)));
    const plan = prepared?.plan ?? {},
      row = prepared?.removal ?? {};
    if (
      !owned ||
      plan.schemaVersion !== 1 ||
      plan.projectId !== input.resource.projectId ||
      plan.jobId !== input.jobId ||
      plan.sermonId !== scope.entityId ||
      plan.generation !== scope.generation ||
      plan.intentFingerprint !== scope.intentFingerprint ||
      plan.state !== 'prepared' ||
      !/^[a-f0-9]{64}$/.test(plan.frozenProgramDigest ?? '') ||
      !plan.workflowId ||
      plan.planId !== hash([input.resource.projectId, input.jobId, scope.entityId])
    )
      return undefined;
    if (path === scope.rootPath) {
      if (
        desiredProviderDeletionDocumentFingerprint(plan.originalRoot) !==
        desiredProviderDeletionDocumentFingerprint(data)
      )
        return undefined;
    } else if (row.canonicalPath !== path || row.sourceFingerprint !== desiredProviderDeletionDocumentFingerprint(data))
      return undefined;
    return sermonDeletionHeaderFingerprint(plan);
  }
  const tagMirror =
    input.resourceType === 'tag' &&
    scope.kind === 'speaker.mutate' &&
    parts.length === 4 &&
    ['lists', 'series'].includes(parts[0]) &&
    ['listItems', 'seriesItems'].includes(parts[2]) &&
    [before.speakers, objectRecord(before.mediaItem).speakers].some(
      (value) =>
        Array.isArray(value) &&
        value.some((speaker) => desiredSpeakerMatches(speaker, scope.entityId, input.resource.remoteId))
    );
  const seriesMirror =
    input.resourceType === 'series' &&
    scope.kind === 'series.delete' &&
    ((parts.length === 2 && parts[0] === 'sermons') ||
      (parts.length === 4 && parts[0] === 'lists' && parts[2] === 'listItems')) &&
    (before.seriesId === scope.entityId || objectRecord(before.mediaItem).seriesId === scope.entityId);
  if (!listMirror && !tagMirror && !seriesMirror) return undefined;
  const target = db.collection('temporalProviderDesiredDeletionPlans').doc(desiredProviderDeletionPlanId(input));
  const loaded = prepared
    ? undefined
    : await Promise.all([tx.get(target), tx.get(target.collection('removals').doc(providerEdgeKey(path)))]);
  const plan = prepared?.plan ?? objectRecord(loaded?.[0].data()),
    removal = prepared?.removal ?? objectRecord(loaded?.[1].data());
  if (
    plan.schemaVersion !== 1 ||
    plan.projectId !== input.resource.projectId ||
    plan.jobId !== input.jobId ||
    plan.resourceType !== input.resourceType ||
    providerResourceKey(objectRecord(plan.resource) as ProviderResource) !== providerResourceKey(input.resource) ||
    plan.entity?.type !== scope.entityType ||
    plan.entity?.id !== scope.entityId ||
    plan.generation !== scope.generation ||
    plan.intentFingerprint !== scope.intentFingerprint ||
    plan.method !== 'DELETE' ||
    !['prepared', 'delete_started', 'absence_confirmed'].includes(plan.state) ||
    !/^([a-f0-9]{64})$/.test(plan.requestFingerprint ?? '') ||
    removal.canonicalPath !== path ||
    removal.sourceFingerprint !== desiredProviderDeletionDocumentFingerprint(data)
  )
    return undefined;
  if (listMirror && removal.after !== 'absent') return undefined;
  if (tagMirror) {
    if (
      removal.after !== 'resource_removed' ||
      !removal.afterData ||
      typeof removal.afterData !== 'object' ||
      Array.isArray(removal.afterData)
    )
      return undefined;
    const prune = (speakers: unknown[]) =>
      speakers.filter((speaker) => !desiredSpeakerMatches(speaker, scope.entityId, input.resource.remoteId));
    const expectedAfter = { ...before };
    if (Array.isArray(before.speakers)) expectedAfter.speakers = prune(before.speakers);
    if (Array.isArray(objectRecord(before.mediaItem).speakers))
      expectedAfter.mediaItem = { ...objectRecord(before.mediaItem), speakers: prune(before.mediaItem.speakers) };
    for (const field of ['editedAtMillis', 'updatedAtMillis', 'updatedAt'])
      if (Object.prototype.hasOwnProperty.call(removal.afterData, field))
        expectedAfter[field] = removal.afterData[field];
    if (
      desiredProviderDeletionDocumentFingerprint(expectedAfter) !==
        desiredProviderDeletionDocumentFingerprint(removal.afterData) ||
      extractProviderResources(input.resource.projectId, path, removal.afterData).some(
        (resource) => providerResourceKey(resource) === providerResourceKey(input.resource)
      )
    )
      return undefined;
  }
  if (seriesMirror) {
    if (
      removal.after !== 'resource_removed' ||
      !removal.afterData ||
      typeof removal.afterData !== 'object' ||
      Array.isArray(removal.afterData)
    )
      return undefined;
    const clear = (value: Record<string, any>) => {
      const next: Record<string, any> = { ...value, seriesId: null, seriesPublishedToSubsplash: false };
      if (next.subsplashSeriesId === input.resource.remoteId) delete next.subsplashSeriesId;
      return next;
    };
    let expectedAfter = { ...before };
    if (before.seriesId === scope.entityId) expectedAfter = clear(before);
    if (objectRecord(before.mediaItem).seriesId === scope.entityId)
      expectedAfter.mediaItem = clear(objectRecord(before.mediaItem));
    if (
      desiredProviderDeletionDocumentFingerprint(expectedAfter) !==
        desiredProviderDeletionDocumentFingerprint(removal.afterData) ||
      extractProviderResources(input.resource.projectId, path, removal.afterData).some(
        (resource) => providerResourceKey(resource) === providerResourceKey(input.resource)
      )
    )
      return undefined;
  }
  return desiredProjectionHeaderFingerprint(plan);
}
/** All reference edges are paged under the aggregate transaction fence. Unknown associations never become allowed by timeout or job ownership. */
export async function prepareDesiredProviderDeletion(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput
) {
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker);
  const [intentSnapshot, jobSnapshot, aggregate] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${input.jobId}`)),
    tx.get(db.doc(`durableJobs/${input.jobId}`)),
    tx.get(ref),
  ]);
  const intent = objectRecord(intentSnapshot.data()),
    job = objectRecord(jobSnapshot.data());
  const proof: Record<string, any> = {
    schemaVersion: 1,
    jobId: input.jobId,
    resourceType: input.resourceType,
    intentFingerprint: hash(sortedValue(intent)),
    generation: intent.generation,
  };
  if (aggregate.get('state') === 'reserved') {
    const reservedProof = aggregate.get('desiredDeletionProof');
    if (
      !reservedProof ||
      hash(sortedValue(Object.fromEntries(Object.keys(proof).map((key) => [key, reservedProof[key]])))) !==
        hash(sortedValue(proof))
    )
      throw new Error('PROVIDER_DESIRED_DELETION_ALREADY_RESERVED');
    if (reservedProof.projectionPlanFingerprint) {
      const sermonDeletion = intent.kind === 'sermon.delete';
      const plan = objectRecord(
        (
          await tx.get(
            sermonDeletion
              ? db
                  .collection('temporalSermonDeletionMirrorPlans')
                  .doc(hash([input.resource.projectId, input.jobId, intent.entity?.id]))
              : db.collection('temporalProviderDesiredDeletionPlans').doc(desiredProviderDeletionPlanId(input))
          )
        ).data()
      );
      if (
        (sermonDeletion ? sermonDeletionHeaderFingerprint(plan) : desiredProjectionHeaderFingerprint(plan)) !==
        reservedProof.projectionPlanFingerprint
      )
        throw new Error('PROVIDER_DESIRED_DELETION_PROOF_INVALID');
    }
    if (
      intent.projectId !== input.resource.projectId ||
      intent.jobId !== input.jobId ||
      job.projectId !== intent.projectId ||
      job.jobId !== input.jobId ||
      job.generation !== intent.generation ||
      ['cancel_requested', 'succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)
    )
      desiredInvalid();
    return { state: 'reserved' as const, commit: () => {} };
  }
  if (aggregate.get('state') === 'deleted') throw new Error('PROVIDER_RESOURCE_ALREADY_DELETED');
  const scope = await desiredDeletionScope(tx, db, input, intent, job);
  const count = aggregate.get('referenceCount') ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  let seen = 0,
    cursor: any;
  const query = ref.collection('edges').orderBy('__name__').limit(100);
  let projectionHeader: Record<string, any> | undefined;
  const sermonDeletion = scope.kind === 'sermon.delete';
  const projectionRef = sermonDeletion
    ? db
        .collection('temporalSermonDeletionMirrorPlans')
        .doc(hash([input.resource.projectId, input.jobId, scope.entityId]))
    : db.collection('temporalProviderDesiredDeletionPlans').doc(desiredProviderDeletionPlanId(input));
  for (;;) {
    const page = await tx.get(cursor ? query.startAfter(cursor) : query);
    const paths: string[] = [];
    for (const edge of page.docs) {
      seen++;
      const path = edge.get('canonicalPath');
      if (
        edge.get('projectId') !== input.resource.projectId ||
        typeof path !== 'string' ||
        edge.id !== providerEdgeKey(path)
      )
        throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
      if (path === `durableJobIntents/${input.jobId}`) continue;
      if (path.startsWith('durableJobIntents/') || path.startsWith('providerBindings/'))
        throw new Error('PROVIDER_DESIRED_DELETION_REFERENCED');
      paths.push(path);
    }
    // One read RPC per page avoids a network round trip per reference on remote workers.
    const canonicals = paths.length ? await tx.getAll(...paths.map((path) => db.doc(path))) : [];
    const fallback = canonicals.filter(
      (canonical) => !desiredOwnCanonicalEdge(input, scope, canonical.ref.path, canonical.data())
    );
    let removalRecords = new Map<string, Record<string, any>>();
    if (fallback.length) {
      projectionHeader ??= objectRecord((await tx.get(projectionRef)).data());
      if (sermonDeletion && projectionHeader.workflowId !== job.workflowId)
        throw new Error('PROVIDER_DESIRED_DELETION_PROOF_INVALID');
      const removals = await tx.getAll(
        ...fallback.map((canonical) =>
          projectionRef.collection(sermonDeletion ? 'rows' : 'removals').doc(providerEdgeKey(canonical.ref.path))
        )
      );
      removalRecords = new Map(removals.map((removal) => [removal.id, objectRecord(removal.data())]));
    }
    for (const canonical of canonicals) {
      const path = canonical.ref.path;
      if (
        !canonical.exists ||
        !extractProviderResources(input.resource.projectId, path, canonical.data()).some(
          (resource) => providerResourceKey(resource) === providerResourceKey(input.resource)
        )
      )
        throw new Error('PROVIDER_USAGE_CANONICAL_EDGE_MISMATCH');
      if (!desiredOwnCanonicalEdge(input, scope, path, canonical.data())) {
        const projectionFingerprint = await plannedDesiredCanonicalRemoval(
          tx,
          db,
          input,
          scope,
          path,
          canonical.data(),
          { plan: projectionHeader!, removal: removalRecords.get(providerEdgeKey(path)) ?? {} }
        );
        if (!projectionFingerprint) throw new Error('PROVIDER_DESIRED_DELETION_REFERENCED');
        if (proof.projectionPlanFingerprint && proof.projectionPlanFingerprint !== projectionFingerprint)
          throw new Error('PROVIDER_DESIRED_DELETION_PROOF_INVALID');
        proof.projectionPlanFingerprint = projectionFingerprint;
      }
    }
    if (page.size < 100) break;
    cursor = page.docs.at(-1);
  }
  if (seen !== count) throw new Error('PROVIDER_USAGE_INDEX_CORRUPT');
  return {
    state: 'reserved' as const,
    commit: () =>
      tx.set(
        ref,
        {
          ...input.resource,
          epoch: marker.epoch,
          state: 'reserved',
          desiredDeletionProof: proof,
          reservedAtMillis: Date.now(),
        },
        { merge: true }
      ),
  };
}
/** Call after canonical and active-intent retirement. Fixed-ID authenticated absence is verified by the domain before this transaction. */
export async function prepareDesiredProviderDeletionSettlement(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput
) {
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker);
  const intentPath = `durableJobIntents/${input.jobId}`,
    intentEdge = ref.collection('edges').doc(providerEdgeKey(intentPath));
  const [snapshot, intentSnapshot, edge] = await Promise.all([
    tx.get(ref),
    tx.get(db.doc(intentPath)),
    tx.get(intentEdge),
  ]);
  const proof = snapshot.get('desiredDeletionProof'),
    intent = objectRecord(intentSnapshot.data());
  const count = snapshot.get('referenceCount');
  if (
    !['reserved', 'deleted'].includes(snapshot.get('state')) ||
    proof?.jobId !== input.jobId ||
    proof.resourceType !== input.resourceType ||
    proof.intentFingerprint !== hash(sortedValue(intent)) ||
    intent.projectId !== input.resource.projectId ||
    intent.jobId !== input.jobId ||
    !Number.isSafeInteger(count) ||
    count !== Number(edge.exists) ||
    (edge.exists && (edge.get('projectId') !== input.resource.projectId || edge.get('canonicalPath') !== intentPath))
  )
    throw new Error('PROVIDER_DESIRED_DELETION_SETTLEMENT_PENDING');
  // Keep the owner intent edge truthful until normal terminal projection releases it.
  return () => {
    if (snapshot.get('state') !== 'deleted')
      tx.update(ref, { state: 'deleted', settlement: 'confirmed_absent', settledAtMillis: Date.now() });
  };
}

/** The source cancellation runner supplies fresh cleanup/drain authority. This helper independently requires every original target guard to be permanently closed with no positive or uncertain request. */
export async function prepareDesiredProviderDeletionAbort(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput
) {
  const marker = assertProviderUsageMarker(
    (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
    input.resource.projectId
  );
  const ref = aggregateRef(db, input.resource, marker);
  const [aggregate, intentSnapshot] = await Promise.all([
    tx.get(ref),
    tx.get(db.doc(`durableJobIntents/${input.jobId}`)),
  ]);
  const proof = aggregate.get('desiredDeletionProof'),
    intent = objectRecord(intentSnapshot.data());
  if (
    aggregate.get('state') !== 'reserved' ||
    proof?.jobId !== input.jobId ||
    proof.resourceType !== input.resourceType ||
    proof.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    intent.projectId !== input.resource.projectId ||
    intent.jobId !== input.jobId
  )
    throw new Error('PROVIDER_DESIRED_DELETION_ABORT_PROOF_INVALID');
  const query = db
    .collection('temporalProviderMutationSessions')
    .where('scope.projectId', '==', input.resource.projectId)
    .where('scope.jobId', '==', input.jobId)
    .orderBy('__name__')
    .limit(100);
  let cursor: any,
    targets = 0;
  for (;;) {
    const page = await tx.get(cursor ? query.startAfter(cursor) : query);
    for (const sessionSnapshot of page.docs) {
      const session = objectRecord(sessionSnapshot.data());
      const targetsResource =
        Array.isArray(session.resources) &&
        session.resources.some(
          (resource) =>
            resource.provider === input.resource.provider &&
            resource.resourceType === input.resourceType &&
            resource.resourceId === input.resource.remoteId &&
            (input.resource.provider !== 'subsplash' || resource.account === input.resource.account) &&
            typeof resource.account === 'string' &&
            !!resource.account
        );
      if (!targetsResource) continue;
      targets++;
      if (
        session.schemaVersion !== 1 ||
        session.scope?.projectId !== input.resource.projectId ||
        session.scope.jobId !== input.jobId ||
        sessionSnapshot.id !== hash(sortedValue(session.scope)) ||
        session.state !== 'aborted'
      )
        throw new Error('PROVIDER_DESIRED_DELETION_ABORT_UNPROVEN');
      const requestQuery = sessionSnapshot.ref.collection('requests').orderBy('__name__').limit(100);
      let requestCursor: any;
      for (;;) {
        const requests = await tx.get(requestCursor ? requestQuery.startAfter(requestCursor) : requestQuery);
        for (const requestSnapshot of requests.docs) {
          const request = objectRecord(requestSnapshot.data());
          if (
            request.state !== 'rejected_no_effect' ||
            typeof request.step !== 'string' ||
            requestSnapshot.id !== hash(request.step) ||
            !request.claim ||
            !request.executionId ||
            !request.fingerprint
          )
            throw new Error('PROVIDER_DESIRED_DELETION_ABORT_UNPROVEN');
          const fact = (
            await tx.get(
              db
                .collection('temporalProviderMutationFacts')
                .doc(hash([sessionSnapshot.id, request.step, request.claim]))
            )
          ).data();
          if (
            !fact ||
            fact.sessionId !== sessionSnapshot.id ||
            fact.step !== request.step ||
            fact.claim !== request.claim ||
            fact.executionId !== request.executionId ||
            fact.fingerprint !== request.fingerprint ||
            fact.completion !== 'rejected_no_effect' ||
            fact.evidence?.transport !== 'original_http_response' ||
            !Number.isInteger(fact.evidence.status) ||
            fact.evidence.status < 400 ||
            fact.evidence.status >= 500 ||
            !fact.evidence.providerCode
          )
            throw new Error('PROVIDER_DESIRED_DELETION_ABORT_UNPROVEN');
        }
        if (requests.size < 100) break;
        requestCursor = requests.docs.at(-1);
      }
    }
    if (page.size < 100) break;
    cursor = page.docs.at(-1);
  }
  if (!targets) throw new Error('PROVIDER_DESIRED_DELETION_ABORT_UNPROVEN');
  return () =>
    tx.update(ref, {
      state: 'active',
      desiredDeletionAbort: {
        jobId: input.jobId,
        intentFingerprint: proof.intentFingerprint,
        proof: 'permanently_aborted_original_guards',
        abortedAtMillis: Date.now(),
      },
    });
}

/** Compose only with a transaction-bound opaque guard witness. The trusted source adapter asserts the guard witness and exact resource containment; this module independently refuses every sent effect. */
export async function prepareDesiredProviderDeletionZeroEffectsAbort(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput,
  issuedCoreZeroAbortProof: unknown,
  validateCoreZeroAbort: (
    tx: Transaction,
    proof: unknown,
    scope: {
      projectId: string;
      jobId: string;
      resource: ProviderResource;
      resourceType: DesiredProviderDeletionType;
    }
  ) => Promise<void>
): Promise<() => void> {
  const invalid = (): never => {
    throw new Error('PROVIDER_DESIRED_DELETION_ZERO_ABORT_UNPROVEN');
  };
  if (!issuedCoreZeroAbortProof || typeof validateCoreZeroAbort !== 'function') invalid();
  await validateCoreZeroAbort(tx, issuedCoreZeroAbortProof, {
    projectId: input.resource.projectId,
    jobId: input.jobId,
    resource: input.resource,
    resourceType: input.resourceType,
  });
  const marker = assertProviderUsageMarker(
      (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
      input.resource.projectId
    ),
    ref = aggregateRef(db, input.resource, marker);
  const [aggregate, intentDoc] = await Promise.all([tx.get(ref), tx.get(db.doc(`durableJobIntents/${input.jobId}`))]);
  const intent = objectRecord(intentDoc.data()),
    proof = aggregate.get('desiredDeletionProof'),
    count = aggregate.get('referenceCount');
  if (
    !intentDoc.exists ||
    intent.projectId !== input.resource.projectId ||
    intent.jobId !== input.jobId ||
    proof?.jobId !== input.jobId ||
    proof.resourceType !== input.resourceType ||
    proof.generation !== intent.generation ||
    proof.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (aggregate.get('state') !== 'reserved' &&
      !(
        aggregate.get('state') === 'active' &&
        aggregate.get('desiredDeletionAbort')?.proof === 'source_zero_effects_original_guard' &&
        aggregate.get('desiredDeletionAbort')?.jobId === input.jobId
      ))
  )
    invalid();
  const sessions = db
    .collection('temporalProviderMutationSessions')
    .where('scope.projectId', '==', input.resource.projectId)
    .where('scope.jobId', '==', input.jobId)
    .orderBy('__name__')
    .limit(100);
  let cursor: any,
    targets = 0;
  for (;;) {
    const page = await tx.get(cursor ? sessions.startAfter(cursor) : sessions);
    for (const sessionDoc of page.docs) {
      const session = objectRecord(sessionDoc.data());
      if (
        session.schemaVersion !== 1 ||
        session.scope?.projectId !== input.resource.projectId ||
        session.scope?.jobId !== input.jobId ||
        sessionDoc.id !== hash(sortedValue(session.scope)) ||
        !['active', 'aborted'].includes(session.state) ||
        !Array.isArray(session.resources)
      )
        invalid();
      if (
        session.resources.some(
          (resource: any) =>
            resource.provider === input.resource.provider &&
            resource.resourceType === input.resourceType &&
            resource.resourceId === input.resource.remoteId &&
            (input.resource.provider !== 'subsplash' || resource.account === input.resource.account)
        )
      )
        targets++;
      const requests = await tx.get(sessionDoc.ref.collection('requests').orderBy('__name__').limit(1));
      if (!requests.empty) invalid();
    }
    if (page.size < 100) break;
    cursor = page.docs.at(-1);
  }
  if (!targets) invalid();
  const deletionReceipts = db
    .collection('temporalPublishingDeletionReceipts')
    .where('projectId', '==', input.resource.projectId)
    .where('jobId', '==', input.jobId)
    .orderBy('__name__')
    .limit(100);
  cursor = undefined;
  for (;;) {
    const page = await tx.get(cursor ? deletionReceipts.startAfter(cursor) : deletionReceipts);
    if (
      page.docs.some(
        (row: any) =>
          !['prepared', 'preparing', 'authorized'].includes(row.get('state')) ||
          row.get('absenceProof') ||
          row.get('absenceConfirmedAtMillis') ||
          row.get('reconciledAtMillis')
      )
    )
      invalid();
    if (page.size < 100) break;
    cursor = page.docs.at(-1);
  }
  const receipts = db
    .collection('temporalProviderReceipts')
    .where('projectId', '==', input.resource.projectId)
    .where('jobId', '==', input.jobId)
    .orderBy('__name__')
    .limit(100);
  cursor = undefined;
  for (;;) {
    const page = await tx.get(cursor ? receipts.startAfter(cursor) : receipts);
    if (page.docs.some((row: any) => row.get('state') !== 'prepared')) invalid();
    if (page.size < 100) break;
    cursor = page.docs.at(-1);
  }
  return () => {
    if (aggregate.get('state') === 'active') return;
    tx.update(ref, {
      state: 'active',
      desiredDeletionAbort: {
        jobId: input.jobId,
        intentFingerprint: proof.intentFingerprint,
        proof: 'source_zero_effects_original_guard',
        abortedAtMillis: Date.now(),
      },
    });
  };
}

/** Prepare the complete desired DELETE set before committing any reservation. A blocked later target cannot strand an earlier preflight claim. */
export async function prepareDesiredProviderDeletionPartialStopAbort(
  tx: Transaction,
  db: Firestore,
  input: DesiredProviderDeletionInput,
  sourceProof: unknown,
  validateSourcePartialStop: (
    tx: Transaction,
    proof: unknown,
    scope: {
      projectId: string;
      jobId: string;
      resource: ProviderResource;
      resourceType: DesiredProviderDeletionType;
    }
  ) => Promise<void>
): Promise<() => void> {
  const invalid = (): never => {
    throw new Error('PROVIDER_DESIRED_DELETION_PARTIAL_STOP_UNPROVEN');
  };
  if (!sourceProof || typeof validateSourcePartialStop !== 'function') invalid();
  await validateSourcePartialStop(tx, sourceProof, {
    projectId: input.resource.projectId,
    jobId: input.jobId,
    resource: input.resource,
    resourceType: input.resourceType,
  });
  const marker = assertProviderUsageMarker(
      (await tx.get(db.doc(PROVIDER_USAGE_CONTROL))).data(),
      input.resource.projectId
    ),
    ref = aggregateRef(db, input.resource, marker);
  const [aggregate, intentDoc] = await Promise.all([tx.get(ref), tx.get(db.doc(`durableJobIntents/${input.jobId}`))]);
  const intent = objectRecord(intentDoc.data()),
    proof = aggregate.get('desiredDeletionProof'),
    count = aggregate.get('referenceCount');
  if (
    !intentDoc.exists ||
    intent.projectId !== input.resource.projectId ||
    intent.jobId !== input.jobId ||
    intent.kind !== 'sermon.delete' ||
    !['media', 'track'].includes(input.resourceType) ||
    proof?.jobId !== input.jobId ||
    proof.resourceType !== input.resourceType ||
    proof.generation !== intent.generation ||
    proof.intentFingerprint !== desiredProviderDeletionIntentFingerprint(intent) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (aggregate.get('state') !== 'reserved' &&
      !(
        aggregate.get('state') === 'active' &&
        aggregate.get('desiredDeletionAbort')?.proof === 'source_partial_stop_no_delete_effect' &&
        aggregate.get('desiredDeletionAbort')?.jobId === input.jobId
      ))
  )
    invalid();
  const issued = objectRecord(sourceProof);
  if (
    !/^[a-f0-9]{64}$/.test(issued.sessionId ?? '') ||
    !/^[a-f0-9]{64}$/.test(issued.sourceEvidenceDigest ?? '') ||
    !['unclaimed', 'rejected_no_effect'].includes(issued.disposition) ||
    typeof issued.originalRequestStep !== 'string' ||
    !/^[a-f0-9]{64}$/.test(issued.originalRequestFingerprint ?? '')
  )
    invalid();
  const planId = hash([input.resource.projectId, input.jobId, intent.entity?.id]);
  const [headerDoc, sessionDoc, plannedDoc, requestDoc] = await Promise.all([
    tx.get(db.doc(`temporalSermonDeletionMirrorPlans/${planId}`)),
    tx.get(db.doc(`temporalProviderMutationSessions/${issued.sessionId}`)),
    tx.get(
      db.doc(
        `temporalPublishingAcknowledgedProjections/${issued.sessionId}/requestIndex/${hash(issued.originalRequestStep)}`
      )
    ),
    tx.get(db.doc(`temporalProviderMutationSessions/${issued.sessionId}/requests/${hash(issued.originalRequestStep)}`)),
  ]);
  const header = objectRecord(headerDoc.data()),
    session = objectRecord(sessionDoc.data()),
    planned = objectRecord(plannedDoc.get('request'));
  const matches = (request: Record<string, any>) =>
    request.method === 'DELETE' &&
    request.target?.provider === input.resource.provider &&
    request.target?.resourceType === input.resourceType &&
    request.target?.resourceId === input.resource.remoteId &&
    typeof request.target?.account === 'string' &&
    !!request.target.account &&
    (input.resource.provider !== 'subsplash' || request.target.account === input.resource.account);
  // The source validator certifies the paged READY claim summary. Independently read the sealed session and bounded original root DELETE manifest here.
  if (
    !headerDoc.exists ||
    header.schemaVersion !== 1 ||
    header.projectId !== input.resource.projectId ||
    header.jobId !== input.jobId ||
    header.sermonId !== intent.entity?.id ||
    header.generation !== intent.generation ||
    header.intentFingerprint !== proof.intentFingerprint ||
    !/^[a-f0-9]{64}$/.test(header.frozenProgramDigest ?? '') ||
    !Array.isArray(header.requests) ||
    header.requests.length > 2 ||
    !header.requests.some(
      (request: any) =>
        matches(request) &&
        request.step === issued.originalRequestStep &&
        request.fingerprint === issued.originalRequestFingerprint
    ) ||
    !sessionDoc.exists ||
    session.schemaVersion !== 1 ||
    session.scope?.projectId !== input.resource.projectId ||
    session.scope?.jobId !== input.jobId ||
    session.scope?.operation !== header.operation ||
    issued.sessionId !== hash(sortedValue(session.scope)) ||
    !['active', 'committed'].includes(session.state) ||
    session.effectsClosed !== true ||
    session.effectsClosedClaimSetDigestVersion !== 2 ||
    !/^[a-f0-9]{64}$/.test(session.effectsClosedClaimSetDigest ?? '') ||
    !Number.isSafeInteger(session.effectsClosedActualRequestCount) ||
    session.effectsClosedActualRequestCount < 0 ||
    !plannedDoc.exists ||
    !matches(planned) ||
    planned.step !== issued.originalRequestStep ||
    planned.fingerprint !== issued.originalRequestFingerprint
  )
    invalid();
  if (issued.disposition === 'unclaimed') {
    if (requestDoc.exists) invalid();
  } else {
    const request = objectRecord(requestDoc.data());
    if (
      !requestDoc.exists ||
      request.state !== 'rejected_no_effect' ||
      request.step !== planned.step ||
      request.method !== 'DELETE' ||
      request.fingerprint !== planned.fingerprint ||
      !request.claim ||
      !request.executionId
    )
      invalid();
    const factDoc = await tx.get(
      db.doc(`temporalProviderMutationFacts/${hash([issued.sessionId, request.step, request.claim])}`)
    );
    const fact = objectRecord(factDoc.data()),
      status = fact.evidence?.status;
    if (
      !factDoc.exists ||
      fact.sessionId !== issued.sessionId ||
      fact.step !== request.step ||
      fact.claim !== request.claim ||
      fact.executionId !== request.executionId ||
      fact.fingerprint !== request.fingerprint ||
      fact.completion !== 'rejected_no_effect' ||
      fact.evidence?.transport !== 'original_http_response' ||
      !Number.isInteger(status) ||
      status < 400 ||
      status >= 500 ||
      status === 404 ||
      status === 410 ||
      !fact.evidence.providerCode
    )
      invalid();
  }
  return () => {
    if (aggregate.get('state') === 'active') return;
    tx.update(ref, {
      state: 'active',
      desiredDeletionAbort: {
        jobId: input.jobId,
        intentFingerprint: proof.intentFingerprint,
        proof: 'source_partial_stop_no_delete_effect',
        abortedAtMillis: Date.now(),
      },
    });
  };
}

/** Prepare the complete desired DELETE set before committing any reservation. A blocked later target cannot strand an earlier preflight claim. */
export async function prepareDesiredProviderDeletions(
  tx: Transaction,
  db: Firestore,
  inputs: DesiredProviderDeletionInput[]
) {
  if (
    !inputs.length ||
    new Set(inputs.map((input) => providerResourceKey(input.resource))).size !== inputs.length ||
    inputs.some((input) => input.jobId !== inputs[0].jobId || input.resource.projectId !== inputs[0].resource.projectId)
  )
    throw new Error('PROVIDER_DESIRED_DELETION_SET_INVALID');
  const prepared: Array<Awaited<ReturnType<typeof prepareDesiredProviderDeletion>>> = [];
  for (const input of inputs) prepared.push(await prepareDesiredProviderDeletion(tx, db, input));
  return () => prepared.forEach((item) => item.commit());
}
