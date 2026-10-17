/** Fixed-incident private publication reads. No authentication, provider transport or mutation API. */
import { proofDigest, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const same = (a, b) => proofDigest(a) === proofDigest(b);
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const sha = (v) => /^[a-f0-9]{64}$/.test(v ?? '');

/** Complete allocation closure, including intermediary uploads and any late acknowledgement facts. */
export function validateOwnedAllocationClosure(receipts, acknowledgements, runtime) {
  const steps = ['soundcloud-track', 'subsplash-audio', 'subsplash-transcode', 'subsplash-media-item'];
  need(
    Array.isArray(receipts) &&
      receipts.length === steps.length &&
      Array.isArray(acknowledgements) &&
      acknowledgements.length <= 32,
    'PUBLICATION_ALLOCATION_BOUND'
  );
  for (const step of steps) {
    const matches = receipts.filter((row) => row.receipt?.step === step);
    need(matches.length === 1, 'PUBLICATION_ALLOCATION_SET');
    const { receiptId, receipt } = matches[0];
    const family = step === 'soundcloud-track' ? 'soundcloud' : 'subsplash';
    need(
      receipt.state === 'confirmed' &&
        receipt.projectId === incident.projectId &&
        receipt.jobId === incident.publicationJobId &&
        receipt.operationKey ===
          `durable:${incident.projectId}:${incident.publicationJobId}:${incident.sermonId}:${family}-create` &&
        receiptId === runtime.providerReceiptId(receipt.operationKey, step) &&
        receipt.intentPayload !== undefined &&
        receipt.fingerprint === runtime.providerPayloadFingerprint(receipt.intentPayload) &&
        receipt.providerExecutionProfile?.mode === 'sandbox' &&
        receipt.providerExecutionProfile.profileId === 'urm-app-staging-publishing-v1' &&
        receipt.providerExecutionProfile.version === 1 &&
        typeof receipt.owner === 'string' &&
        receipt.owner.length > 0 &&
        Number.isSafeInteger(receipt.revision) &&
        receipt.revision >= 2,
      'PUBLICATION_ALLOCATION_UNRESOLVED'
    );
  }
  const subsplash = receipts.filter((row) => row.receipt.step !== 'soundcloud-track');
  need(
    subsplash.every((row) => row.receipt.fingerprint === subsplash[0].receipt.fingerprint),
    'PUBLICATION_ALLOCATION_PAYLOAD'
  );
  need(
    new Set(acknowledgements.map((row) => row.acknowledgementId)).size === acknowledgements.length &&
      acknowledgements.every((row) =>
        receipts.some(({ receipt }) => runtime.sameResourceAcknowledgementProvesReceipt(row.acknowledgement, receipt))
      ),
    'PUBLICATION_ACK_UNJOINED'
  );
}

/**
 * Read-only SDK view for pinned production validators. Tokens and returned snapshots expose no
 * real DocumentReference/Firestore handles. Private contents never enter returned proof records.
 * Every distinct document is native-pinned; queries require explicit bounds and cannot truncate
 * silently when a complete scan is requested by the collector.
 */
export function publicationReadonlyView(db, transaction, allowed) {
  const handles = new WeakMap(),
    snapshots = new WeakMap(),
    proofs = new Map(),
    queries = new Map(),
    clocks = new WeakSet();
  let reads = 0;
  const content = (value, depth = 0) => {
    need(depth <= 30, 'PUBLICATION_CONTENT_BOUND');
    if (value && typeof value === 'object' && clocks.has(value)) return value;
    if (value === null || value === undefined || ['string', 'boolean', 'number'].includes(typeof value)) return value;
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map((v) => content(v, depth + 1));
    if (
      value?.constructor?.name === 'Timestamp' &&
      Number.isSafeInteger(value.seconds) &&
      Number.isInteger(value.nanoseconds) &&
      value.nanoseconds >= 0 &&
      value.nanoseconds < 1e9
    ) {
      const seconds = value.seconds,
        nanoseconds = value.nanoseconds;
      const clock = Object.freeze({
        seconds,
        nanoseconds,
        toMillis: () => seconds * 1000 + nanoseconds / 1e6,
        toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6),
      });
      clocks.add(clock);
      return clock;
    }
    need(value && Object.getPrototypeOf(value) === Object.prototype, 'PUBLICATION_SDK_VALUE_REJECTED');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, content(v, depth + 1)]));
  };
  const remember = (snapshot) => {
    const path = snapshot.ref.path;
    need(allowed(path) && ++reads <= 2000, 'PUBLICATION_READ_SCOPE_OR_BOUND');
    // Reject SDK reference values before canonical hashing can traverse their client graph.
    const data = snapshot.exists ? content(snapshot.data()) : undefined;
    const proof = snapshot.exists ? { path, native: nativeSnapshotProof(snapshot) } : { path, exists: false };
    need(!proofs.has(path) || same(proofs.get(path), proof), 'PUBLICATION_NATIVE_CHANGED');
    proofs.set(path, proof);
    need(proofs.size <= 450, 'PUBLICATION_DOCUMENT_BOUND');
    const value = Object.freeze({
      id: snapshot.id,
      exists: snapshot.exists,
      ref: document(path),
      data: () => content(data),
      get: (field) => content(field.split('.').reduce((v, k) => v?.[k], data)),
    });
    snapshots.set(value, snapshot);
    return value;
  };
  const read = async (token) => {
    const handle = handles.get(token);
    need(handle, 'PUBLICATION_FOREIGN_HANDLE');
    if (handle.kind === 'doc') return remember(await transaction.get(handle.ref));
    need(
      Number.isSafeInteger(handle.limit) && handle.limit >= 1 && handle.limit <= 400,
      'PUBLICATION_QUERY_BOUND_REQUIRED'
    );
    const result = await transaction.get(handle.ref);
    const docs = result.docs.map(remember);
    const proof = { queryDigest: handle.digest, paths: docs.map((s) => s.ref.path) };
    need(
      !queries.has(handle.digest) || same(queries.get(handle.digest), proof),
      'PUBLICATION_QUERY_MEMBERSHIP_CHANGED'
    );
    queries.set(handle.digest, proof);
    return Object.freeze({ docs: Object.freeze(docs), size: docs.length, empty: docs.length === 0 });
  };
  const query = (path, ref, shape = [], limit) => {
    need(allowed(path), 'PUBLICATION_READ_SCOPE_OR_BOUND');
    const token = { path, doc: (id) => document(path + '/' + id), get: () => read(token) };
    for (const method of ['where', 'orderBy', 'limit'])
      token[method] = (...args) => {
        if (method === 'limit')
          need(
            args.length === 1 && Number.isSafeInteger(args[0]) && args[0] >= 1 && args[0] <= 400,
            'PUBLICATION_QUERY_BOUND_REQUIRED'
          );
        return query(
          path,
          ref[method](...args),
          [...shape, [method, ...args.map((v) => proofDigest(v))]],
          method === 'limit' ? args[0] : limit
        );
      };
    token.startAfter = (snapshot) => {
      need(snapshots.has(snapshot), 'PUBLICATION_CURSOR_REQUIRED');
      return query(path, ref.startAfter(snapshots.get(snapshot)), [...shape, ['after', snapshot.ref.path]], limit);
    };
    handles.set(token, { ref, kind: 'query', limit, digest: proofDigest([path, shape]) });
    return Object.freeze(token);
  };
  function document(path) {
    need(typeof path === 'string' && allowed(path), 'PUBLICATION_READ_SCOPE_OR_BOUND');
    const token = {
      path,
      id: path.split('/').at(-1),
      get: () => read(token),
      collection: (name) => collection(path + '/' + name),
    };
    handles.set(token, { ref: db.doc(path), kind: 'doc' });
    return Object.freeze(token);
  }
  function collection(path) {
    return query(path, db.collection(path));
  }
  return {
    db: Object.freeze({ doc: document, collection }),
    tx: Object.freeze({ get: read, getAll: (...refs) => Promise.all(refs.map(read)) }),
    proof: () => ({
      protectedDocuments: [...proofs.values()].sort((a, b) => a.path.localeCompare(b.path)),
      queries: [...queries.values()].sort((a, b) => a.queryDigest.localeCompare(b.queryDigest)),
    }),
  };
}

/** Actual runtime leaf/module exports are supplied only by the future source-pinned CLI. */
export async function collectOwnedPublicationEvidence({ db, tx, runtime }) {
  const required = [
    'loadValidatedPublishingCriticalRepairCertificate',
    'publishingCriticalRepairDigest',
    'readCertifiedCriticalRepairOperations',
    'validateCertifiedCriticalRepairOperation',
    'validateAcknowledgedProjectionEvidence',
    'readAcknowledgedProjectionFragments',
    'acknowledgedProjectionDigest',
    'listProviderReceiptsForJob',
    'listProviderAcknowledgementsForJob',
    'sameResourceAcknowledgementProvesReceipt',
    'providerReceiptId',
    'providerPayloadFingerprint',
    'sandboxResourceKey',
    'assertSandboxCatalogReady',
    'STAGING_SANDBOX_PROFILE',
    'durableEntityKey',
    'readOriginalProviderMutationAcknowledgement',
    'capturePublishingAllocationSource',
  ];
  need(
    required.every((key) =>
      key === 'STAGING_SANDBOX_PROFILE' ? runtime?.[key] : typeof runtime?.[key] === 'function'
    ),
    'PUBLICATION_PINNED_RUNTIME_REQUIRED'
  );
  const ref = { projectId: incident.projectId, jobId: incident.publicationJobId };
  const jobPath = 'durableJobs/' + ref.jobId,
    intentPath = 'durableJobIntents/' + ref.jobId,
    criticalPath = 'durableJobCriticalSections/' + ref.jobId;
  const entityPath =
    'durableJobEntities/' +
    runtime.durableEntityKey(ref.projectId, { type: 'sermon', id: incident.sermonId }, 'sermon.publish');
  const roots = [
    'temporalPublishingCriticalRepairs',
    'temporalPublishingCriticalRepairSourceCatalogs',
    'temporalPublishingCriticalRepairCatalogs',
    'temporalPublishingAcknowledgedProjections',
    'temporalPublishingEffectPlans',
    'temporalPublishingDeletionReceipts',
    'temporalProviderMutationSessions',
    'temporalProviderMutationLocks',
    'temporalProviderMutationFacts',
    'temporalProviderReceipts',
    'temporalProviderAcknowledgements',
    'temporalPublishingAllocations',
  ];
  const sandboxPath = '_providerSandbox/urm-app-staging-publishing-v1';
  const allow = (path) =>
    [
      jobPath,
      intentPath,
      criticalPath,
      entityPath,
      'durableJobCancellationIntents/' + ref.jobId,
      'sermons/' + incident.sermonId,
    ].includes(path) ||
    roots.some((root) => path === root || path.startsWith(root + '/')) ||
    path === sandboxPath ||
    path.startsWith(sandboxPath + '/');
  const view = publicationReadonlyView(db, tx, allow),
    read = (path) => view.tx.get(view.db.doc(path));
  const [jobSnap, intentSnap, criticalSnap, entitySnap, cancelSnap] = await Promise.all(
    [jobPath, intentPath, criticalPath, entityPath, 'durableJobCancellationIntents/' + ref.jobId].map(read)
  );
  const job = jobSnap.data(),
    intent = intentSnap.data(),
    critical = criticalSnap.data(),
    entity = entitySnap.data();
  need(
    job?.projectId === ref.projectId &&
      job.jobId === ref.jobId &&
      job.kind === 'sermon.publish' &&
      job.state === 'needs_attention' &&
      job.generation === incident.publicationGeneration &&
      job.entity?.type === 'sermon' &&
      job.entity.id === incident.sermonId &&
      same(job.actions, ['resolve']) &&
      job.attention?.resolutionKind === 'critical_repair' &&
      job.attention.certificateId === incident.certificateId &&
      intent?.projectId === ref.projectId &&
      intent.jobId === ref.jobId &&
      intent.generation === job.generation &&
      critical?.projectId === ref.projectId &&
      critical.jobId === ref.jobId &&
      critical.generation === job.generation &&
      critical.workflowId === job.workflowId &&
      entity?.activeJobId === job.jobId &&
      entity.generation === job.generation &&
      !cancelSnap.exists,
    'HELD_PUBLICATION_CHANGED'
  );
  const certificate = await runtime.loadValidatedPublishingCriticalRepairCertificate(
    view.db,
    ref,
    incident.certificateId,
    view.tx
  );
  need(
    runtime.publishingCriticalRepairDigest(certificate) === incident.certificateId &&
      certificate.generation === job.generation &&
      certificate.workflowId === job.workflowId &&
      certificate.intentFingerprint === runtime.publishingCriticalRepairDigest(intent) &&
      certificate.criticalFingerprint === runtime.publishingCriticalRepairDigest(critical) &&
      certificate.acceptedUserCancellation === false &&
      certificate.operations?.length === 1 &&
      certificate.operations[0].kind === 'acknowledged_projection' &&
      certificate.operations[0].sessionId === incident.sessionId,
    'ORIGINAL_PUBLICATION_CERTIFICATE_REQUIRED'
  );
  const operation = certificate.operations[0];
  const catalog = certificate.catalog;
  need(
    catalog?.ready === true && catalog.operationCount === 1 && catalog.pageCount >= 1 && catalog.pageCount <= 32,
    'PUBLICATION_CATALOG_BOUND'
  );
  const operations = [];
  for (let cursor = 0, pages = 0; cursor !== null; pages++) {
    need(pages < 32, 'PUBLICATION_CATALOG_BOUND');
    const page = await runtime.readCertifiedCriticalRepairOperations(view.tx, view.db, ref, catalog, cursor);
    operations.push(...page.entries.map((row) => row.operation));
    need(page.nextCursor === null || page.nextCursor === cursor + 1, 'PUBLICATION_CURSOR_CHANGED');
    cursor = page.nextCursor;
  }
  need(same(operations, certificate.operations), 'PUBLICATION_CATALOG_OPERATION_CHANGED');
  await runtime.validateCertifiedCriticalRepairOperation(view.tx, view.db, ref, catalog, operation, 'claim');
  const rootPath = 'temporalPublishingAcknowledgedProjections/' + incident.sessionId;
  const plan = (await read(rootPath)).data();
  need(
    plan?.projectId === ref.projectId &&
      plan.jobId === ref.jobId &&
      plan.sessionId === incident.sessionId &&
      runtime.acknowledgedProjectionDigest(plan) === operation.projectionDigest,
    'PUBLICATION_PROJECTION_CHANGED'
  );
  await runtime.validateAcknowledgedProjectionEvidence(view.tx, view.db, ref, {
    path: rootPath,
    digest: operation.projectionDigest,
  });
  const plannedRequests = plan.schemaVersion === 1 ? [...plan.requests] : [];
  if (plan.schemaVersion === 2) {
    need(plan.pageCount >= 1 && plan.pageCount <= 64, 'PUBLICATION_FRAGMENT_BOUND');
    let offset = 0,
      chain = runtime.acknowledgedProjectionDigest([]);
    while (offset < plan.pageCount) {
      const page = await runtime.readAcknowledgedProjectionFragments(
        view.tx,
        view.db,
        ref,
        incident.sessionId,
        offset,
        32
      );
      need(page.nextOffset > offset && page.nextOffset <= plan.pageCount, 'PUBLICATION_CURSOR_CHANGED');
      for (const fragment of page.fragments) {
        plannedRequests.push(...fragment.plan.requests);
        await runtime.validateAcknowledgedProjectionEvidence(view.tx, view.db, ref, {
          path: rootPath + '/pages/' + fragment.digest,
          digest: fragment.digest,
        });
        chain = runtime.acknowledgedProjectionDigest([chain, fragment.index, fragment.digest]);
      }
      offset = page.nextOffset;
    }
    need(chain === plan.chainDigest, 'PUBLICATION_FRAGMENT_CHAIN_CHANGED');
  }
  const session = (await read('temporalProviderMutationSessions/' + incident.sessionId)).data();
  need(
    session?.schemaVersion === 1 &&
      session.state === 'active' &&
      session.scope?.projectId === ref.projectId &&
      session.scope.jobId === ref.jobId &&
      session.scope.operation === plan.operation &&
      Array.isArray(session.resources) &&
      session.resources.length === 3 &&
      same(session.resources.map((r) => r.resourceId).sort(), [...incident.listIds].sort()),
    'PUBLICATION_SESSION_CHANGED'
  );
  const requests = await view.tx.get(
    view.db.collection('temporalProviderMutationSessions/' + incident.sessionId + '/requests').limit(101)
  );
  need(requests.size >= 1 && requests.size < 101, 'FULL_ORIGINAL_MUTATION_REQUESTS_REQUIRED');
  for (const snapshot of requests.docs) {
    const request = snapshot.data();
    need(
      plannedRequests.some(
        (p) => p.step === request.step && p.method === request.method && p.fingerprint === request.fingerprint
      ),
      'ORIGINAL_MUTATION_PLAN_CHANGED'
    );
    const original = await runtime.readOriginalProviderMutationAcknowledgement(
      view.tx,
      { db: view.db, id: incident.sessionId, scope: session.scope, resources: session.resources },
      { step: request.step, method: request.method, fingerprint: request.fingerprint }
    );
    need(original !== undefined, 'ORIGINAL_MUTATION_ACK_REQUIRED');
  }
  const receipts = await runtime.listProviderReceiptsForJob(ref, view.db);
  const acknowledgements = await runtime.listProviderAcknowledgementsForJob(ref, view.db);
  validateOwnedAllocationClosure(receipts, acknowledgements, runtime);
  const allocations = [];
  const sermon = (await read('sermons/' + incident.sermonId)).data();
  for (const resource of incident.resources) {
    const step = resource.provider === 'soundcloud' ? 'soundcloud-track' : 'subsplash-media-item';
    const found = receipts.filter((row) => row.receipt.step === step);
    need(found.length === 1, 'ORIGINAL_PROVIDER_RECEIPT_REQUIRED');
    const { receiptId, receipt } = found[0];
    const resultId =
      typeof receipt.result === 'string' ? receipt.result : receipt.result?.id ?? receipt.result?.trackIdentifier;
    need(
      receipt.state === 'confirmed' &&
        receipt.projectId === ref.projectId &&
        receipt.jobId === ref.jobId &&
        receiptId === runtime.providerReceiptId(receipt.operationKey, receipt.step) &&
        String(resultId) === resource.remoteId &&
        receipt.providerExecutionProfile?.mode === 'sandbox' &&
        receipt.providerExecutionProfile.profileId === 'urm-app-staging-publishing-v1' &&
        receipt.providerExecutionProfile.version === 1 &&
        receipt.owner &&
        Number.isSafeInteger(receipt.revision) &&
        receipt.revision >= 2 &&
        sha(receipt.fingerprint),
      'ORIGINAL_PROVIDER_RECEIPT_CHANGED'
    );
    const allocationPath =
      'temporalPublishingAllocations/' +
      runtime.providerPayloadFingerprint([ref.projectId, incident.sermonId, resource.provider]);
    const allocation = (await read(allocationPath)).data();
    need(
      allocation?.schemaVersion === 1 &&
        allocation.projectId === ref.projectId &&
        allocation.sermonId === incident.sermonId &&
        allocation.provider === resource.provider &&
        allocation.ownerJobId === ref.jobId &&
        allocation.state === 'bound' &&
        allocation.remoteId === resource.remoteId &&
        allocation.operationKey === receipt.operationKey &&
        allocation.receiptIds?.includes(receiptId) &&
        same(allocation.source, runtime.capturePublishingAllocationSource(sermon)) &&
        sermon?.[resource.provider === 'soundcloud' ? 'soundCloudTrackId' : 'subsplashId'] === resource.remoteId,
      'ORIGINAL_ALLOCATION_CANONICAL_CHANGED'
    );
    allocations.push({ provider: resource.provider, remoteId: resource.remoteId, receiptId });
  }
  const marker = await read(sandboxPath);
  runtime.assertSandboxCatalogReady(runtime.STAGING_SANDBOX_PROFILE, marker.data());
  const journal = await view.tx.get(
    view.db
      .collection(sandboxPath + '/requests')
      .where('jobId', '==', ref.jobId)
      .limit(101)
  );
  need(journal.size >= 2 && journal.size < 101, 'FULL_SANDBOX_JOURNAL_REQUIRED');
  const linked = new Map();
  for (const doc of journal.docs) {
    const row = doc.data();
    need(
      row.schemaVersion === 1 &&
        row.profileId === 'urm-app-staging-publishing-v1' &&
        row.jobId === ref.jobId &&
        ['subsplash', 'soundcloud'].includes(row.provider) &&
        ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(row.method) &&
        row.fault === 'success' &&
        row.outcome === 'acknowledged' &&
        Number.isSafeInteger(row.atMillis) &&
        Array.isArray(row.resources) &&
        row.resources.length <= 32,
      'SANDBOX_JOURNAL_CHANGED'
    );
    for (const resource of row.resources) {
      need(
        ['subsplash', 'soundcloud'].includes(resource.provider) &&
          /^[a-z][a-z0-9-]{0,60}$/.test(resource.family ?? '') &&
          /^[A-Za-z0-9_.:-]{1,256}$/.test(resource.id ?? ''),
        'SANDBOX_RESOURCE_SCOPE_CHANGED'
      );
      linked.set(runtime.sandboxResourceKey(resource.provider, resource.family, resource.id), resource);
      need(linked.size <= 200, 'SANDBOX_RESOURCE_BOUND');
    }
  }
  for (const [key, resource] of linked) {
    const snapshot = await read(sandboxPath + '/resources/' + key),
      value = snapshot.data();
    need(
      value?.schemaVersion === 1 &&
        value.provider === resource.provider &&
        value.family === resource.family &&
        value.id === resource.id &&
        typeof value.deleted === 'boolean',
      'SANDBOX_LINKED_RESOURCE_CHANGED'
    );
  }
  for (const resource of incident.resources) {
    const family = resource.provider === 'soundcloud' ? 'tracks' : 'media-items';
    const id =
      resource.provider === 'soundcloud' ? resource.remoteId.replace(/^soundcloud:tracks:/, '') : resource.remoteId;
    need(
      journal.docs.some((doc) => {
        const r = doc.data();
        return (
          r.schemaVersion === 1 &&
          r.profileId === 'urm-app-staging-publishing-v1' &&
          r.jobId === ref.jobId &&
          r.provider === resource.provider &&
          r.method === 'POST' &&
          r.outcome === 'acknowledged' &&
          r.fault === 'success' &&
          r.resources?.some((x) => x.provider === resource.provider && x.family === family && x.id === id)
        );
      }),
      'ORIGINAL_SANDBOX_ALLOCATION_ACK_REQUIRED'
    );
    const remote = await read(sandboxPath + '/resources/' + runtime.sandboxResourceKey(resource.provider, family, id));
    const value = remote.data();
    need(
      value?.schemaVersion === 1 &&
        value.provider === resource.provider &&
        value.family === family &&
        value.id === id &&
        value.deleted === false,
      'PERSISTENT_SANDBOX_ALLOCATION_REQUIRED'
    );
  }
  return {
    certificateId: incident.certificateId,
    sessionId: incident.sessionId,
    allocationAcknowledgements: allocations,
    ...view.proof(),
  };
}
