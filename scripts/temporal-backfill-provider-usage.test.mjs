import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillProviderUsage,
  assertProviderBackfillControl,
  parseProviderBackfillArgs,
  assertProviderBackfillReleaseState,
  PROVIDER_USAGE_SCAN_GROUPS,
  reviewedProviderUsageSource,
  retainedProviderUsageSource,
  retainedLegacySoundCloudUsageSource,
  retainedImageUsageSource,
  imageAcknowledgementUsageSource,
  orphanProviderAcknowledgementUsageSource,
} from './temporal-backfill-provider-usage.mjs';
function legacyRetentionFixture() {
  const ordered = (value) =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, ordered(entry)])
        )
      : value;
  const digest = (value) =>
    createHash('sha256')
      .update(JSON.stringify(ordered(value)))
      .digest('hex');
  const projectId = 'urm-app-staging',
    jobId = 'legacy-review',
    generation = 1,
    workflowId = 'original-workflow';
  const intent = { projectId, jobId, generation, kind: 'sermon.delete', entity: { type: 'sermon', id: 'sermon' } };
  const observation = {
    schemaVersion: 1,
    projectId,
    jobId,
    generation,
    workflowId,
    trackId: 'track',
    originalOwner: 'unverified',
    originalHttpStatus: 404,
    providerMutationSent: false,
    observedCurrentAccount: 'soundcloud:users:123',
  };
  const certificate = {
    schemaVersion: 1,
    projectId,
    jobId,
    generation,
    workflowId,
    trackId: 'track',
    originalOwner: 'unverified',
    disposition: 'permanent_retention_without_absence_claim',
    observedCurrentAccount: observation.observedCurrentAccount,
    observationDigest: digest(observation),
    intentFingerprint: digest(intent),
    resource: { projectId, provider: 'soundcloud', account: 'configured-account', remoteId: 'track' },
  };
  const certificateId = digest(certificate);
  const grant = {
    schemaVersion: 1,
    projectId,
    jobId,
    generation,
    workflowId,
    intentFingerprint: digest(intent),
    retentionAcknowledged: true,
    actorUid: 'admin',
    commandId: 'review',
    reason: 'Keep the unverified original resource',
    evidenceReference: 'case-123',
    sourceCertificateIds: [certificateId],
    operations: [{ kind: 'legacy_soundcloud_retain', certificateId }],
  };
  const doc = {
    path: `temporalLegacySoundCloudRetentions/${certificateId}`,
    data: {
      schemaVersion: 1,
      projectId,
      jobId,
      certificateId,
      certificateDigest: certificateId,
      disposition: certificate.disposition,
      canonicalAfterDigest: 'a'.repeat(64),
      resource: certificate.resource,
      retentionOwner: `retention:${certificateId}`,
      bindingId: 'permanent-legacy-soundcloud',
    },
  };
  return { doc, certificate, observation, grant, intent, projectId, digest };
}
test('backfill retains an explicitly reviewed unverified SoundCloud resource under a permanent owner', () => {
  const f = legacyRetentionFixture();
  assert.ok(PROVIDER_USAGE_SCAN_GROUPS.includes('temporalLegacySoundCloudRetentions'));
  const source = retainedLegacySoundCloudUsageSource(
    f.doc,
    f.certificate,
    f.observation,
    f.grant,
    f.intent,
    f.projectId,
    f.digest
  );
  assert.deepEqual(source.resource, f.certificate.resource);
  assert.equal(source.decision, 'retain_existing_resource');
  assert.equal(source.path, `providerBindings/${f.doc.data.retentionOwner}/permanent-legacy-soundcloud`);
});
test('backfill rejects missing review, changed source, false absence and foreign retention resources', () => {
  const f = legacyRetentionFixture();
  const check = (
    doc = f.doc,
    certificate = f.certificate,
    observation = f.observation,
    grant = f.grant,
    intent = f.intent
  ) => retainedLegacySoundCloudUsageSource(doc, certificate, observation, grant, intent, f.projectId, f.digest);
  assert.throws(
    () =>
      retainedLegacySoundCloudUsageSource(
        f.doc,
        f.certificate,
        f.observation,
        undefined,
        f.intent,
        f.projectId,
        f.digest
      ),
    /RETENTION_INVALID/
  );
  for (const grant of [
    { ...f.grant, retentionAcknowledged: false },
    { ...f.grant, sourceCertificateIds: [] },
    { ...f.grant, operations: [] },
    { ...f.grant, actorUid: '' },
  ])
    assert.throws(
      () => check(f.doc, f.certificate, f.observation, grant),
      /PROVIDER_BACKFILL_LEGACY_SOUNDCLOUD_RETENTION_INVALID/
    );
  assert.throws(() => check(f.doc, { ...f.certificate, trackId: 'foreign' }), /RETENTION_INVALID/);
  assert.throws(
    () => check(f.doc, f.certificate, { ...f.observation, providerMutationSent: true }),
    /RETENTION_INVALID/
  );
  assert.throws(
    () => check({ ...f.doc, data: { ...f.doc.data, disposition: 'absence_confirmed' } }),
    /RETENTION_INVALID/
  );
  assert.throws(
    () => check(f.doc, f.certificate, f.observation, f.grant, { ...f.intent, generation: 2 }),
    /RETENTION_INVALID/
  );
});
const options = {
  projectId: 'urm-app-staging',
  releaseId: 'release',
  controlRevision: 8,
  apply: true,
  epoch: 'epoch',
  drainProof: {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    releaseId: 'release',
    controlRevision: 8,
    result: 'passed',
    legacyDrained: true,
  },
};
const control = {
  schemaVersion: 1,
  releaseId: 'release',
  revision: 8,
  admission: 'paused',
  legacyDrainedAt: 1,
  domains: Object.fromEntries(
    ['media', 'publishing', 'images', 'accounts'].map((domain) => [domain, { owner: 'legacy', admission: 'paused' }])
  ),
};
function dependencies(count = 1205) {
  const indexed = [];
  let began = false,
    finished = false;
  return {
    indexed,
    get began() {
      return began;
    },
    get finished() {
      return finished;
    },
    readControl: async () => structuredClone(control),
    assertLegacyDrained: async () => {},
    begin: async () => {
      began = true;
    },
    finish: async () => {
      finished = true;
    },
    inspectDocument: async () => 1,
    indexDocument: async (doc) => {
      indexed.push(doc.path);
      return 1;
    },
    page: async (group, cursor, limit) => {
      if (group !== 'sermons') return { documents: [], hasMore: false };
      const start = Number(cursor ?? 0),
        end = Math.min(start + limit, count);
      return {
        documents: Array.from({ length: end - start }, (_, i) => ({ path: `sermons/${start + i}` })),
        hasMore: end < count,
        cursor: String(end),
      };
    },
  };
}
test('complete paginated backfill has no 500-document fleet ceiling', async () => {
  const deps = dependencies();
  const result = await backfillProviderUsage(options, deps);
  assert.equal(result.documentCount, 1205);
  assert.equal(new Set(deps.indexed).size, 1205);
  assert.equal(deps.finished, true);
});
test('dry run performs no writes or readiness promotion', async () => {
  const deps = dependencies();
  const result = await backfillProviderUsage({ ...options, apply: false }, deps);
  assert.equal(result.result, 'dry_run');
  assert.equal(deps.began, false);
  assert.equal(deps.finished, false);
  assert.equal(deps.indexed.length, 0);
});
test('paused admission alone does not prove legacy ownership or drained mutations', () => {
  assert.throws(
    () =>
      assertProviderBackfillControl(
        { ...control, domains: { ...control.domains, images: { owner: 'temporal', admission: 'paused' } } },
        options,
        options.drainProof
      ),
    /NOT_FROZEN/
  );
  assert.throws(
    () => assertProviderBackfillControl(control, options, { ...options.drainProof, legacyDrained: false }),
    /DRAIN_PROOF/
  );
});
test('control change during scan leaves index unready', async () => {
  const deps = dependencies(3);
  let read = 0;
  deps.readControl = async () => ({ ...control, revision: ++read > 2 ? 9 : 8 });
  await assert.rejects(backfillProviderUsage(options, deps), /NOT_FROZEN/);
  assert.equal(deps.finished, false);
});
test('unresolved legacy leases fail before building an index', async () => {
  const deps = dependencies();
  deps.assertLegacyDrained = async () => {
    throw Error('LEGACY_UNRESOLVED');
  };
  await assert.rejects(backfillProviderUsage(options, deps), /LEGACY_UNRESOLVED/);
  assert.equal(deps.began, false);
});
test('CLI defaults to dry run and rejects extra flags', () => {
  assert.equal(
    parseProviderBackfillArgs([
      '--project',
      'urm-app',
      '--release',
      'release',
      '--control-revision',
      '1',
      '--drain-proof',
      'proof.json',
    ]).apply,
    false
  );
  assert.throws(() => parseProviderBackfillArgs(['--unknown', 'value']));
});

test('actual release state must record the drained phase at the current control revision', () => {
  assertProviderBackfillReleaseState(
    { releaseId: 'release', controlRevision: 8, phase: 'legacy-drained', legacyDrainedAt: 1 },
    options
  );
  assert.throws(
    () =>
      assertProviderBackfillReleaseState(
        { releaseId: 'release', controlRevision: 8, phase: 'compatibility-ready', legacyDrainedAt: 1 },
        options
      ),
    /RELEASE_NOT_DRAINED/
  );
  assert.throws(
    () =>
      assertProviderBackfillReleaseState(
        { releaseId: 'release', controlRevision: 7, phase: 'legacy-drained', legacyDrainedAt: 1 },
        options
      ),
    /RELEASE_NOT_DRAINED/
  );
});
test('interrupted page retries in the same epoch from the last committed checkpoint', async () => {
  const deps = dependencies(305),
    records = new Set();
  let saved = { epoch: 'stable-epoch', groupIndex: 0, cursor: null, documentCount: 0, edgeCount: 0 };
  deps.begin = async () => ({ ...saved });
  deps.checkpoint = async (epoch, previous, next) => {
    assert.equal(epoch, 'stable-epoch');
    assert.equal(saved.groupIndex, previous.groupIndex);
    assert.equal(saved.cursor, previous.cursor);
    saved = { epoch, ...next };
  };
  let failed = false;
  deps.indexDocument = async (doc) => {
    if (doc.path === 'sermons/150' && !failed) {
      failed = true;
      throw Error('INTERRUPTED');
    }
    records.add(doc.path);
    return 1;
  };
  await assert.rejects(backfillProviderUsage(options, deps), /INTERRUPTED/);
  assert.equal(saved.cursor, '100');
  assert.equal(saved.documentCount, 100);
  const result = await backfillProviderUsage(options, deps);
  assert.equal(result.epoch, 'stable-epoch');
  assert.equal(result.documentCount, 305);
  assert.equal(result.edgeCount, 305);
  assert.equal(records.size, 305);
  assert.equal(saved.groupIndex, PROVIDER_USAGE_SCAN_GROUPS.length);
});
test('concurrent checkpoint owner change prevents readiness promotion', async () => {
  const deps = dependencies(10);
  deps.begin = async () => ({ epoch: 'epoch', groupIndex: 0, cursor: null, documentCount: 0, edgeCount: 0 });
  deps.checkpoint = async () => {
    throw Error('CONCURRENT_CHECKPOINT');
  };
  await assert.rejects(backfillProviderUsage(options, deps), /CONCURRENT_CHECKPOINT/);
  assert.equal(deps.finished, false);
});

test('backfill restores retained orphan edge using original acknowledgement identity rather than an adopted ID', () => {
  const fact = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    jobId: 'original-job',
    receiptId: 'receipt',
    attemptOwner: 'owner',
    claimRevision: 1,
    remoteId: 'original-image',
    disposition: 'orphaned',
    step: 'image-create',
    review: { decision: 'retain_after_review', acknowledgementFingerprint: 'fingerprint' },
  };
  const ackID = createHash('sha256')
    .update(JSON.stringify([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]))
    .digest('hex');
  const resource = {
    projectId: 'urm-app-staging',
    provider: 'subsplash',
    account: 'app:9XTSHD',
    remoteId: 'original-image',
  };
  const doc = {
    path: `temporalProviderAcknowledgementReviews/${ackID}`,
    data: {
      schemaVersion: 1,
      projectId: 'urm-app-staging',
      jobId: 'original-job',
      decision: 'retain_after_review',
      acknowledgementFingerprint: 'fingerprint',
      resource,
    },
  };
  const source = reviewedProviderUsageSource(doc, fact, 'urm-app-staging', () => 'fingerprint');
  assert.equal(source.path, `providerBindings/original-job/retained-orphan:${ackID}`);
  assert.equal(source.resource.remoteId, 'original-image');
  assert.throws(
    () =>
      reviewedProviderUsageSource(
        { ...doc, data: { ...doc.data, resource: { ...resource, remoteId: 'adopted-image' } } },
        fact,
        'urm-app-staging',
        () => 'fingerprint'
      ),
    /RETAINED_REVIEW_INVALID/
  );
  assert.throws(
    () => reviewedProviderUsageSource(doc, fact, 'urm-app-staging', () => 'changed-fact'),
    /RETAINED_REVIEW_INVALID/
  );
});

test('backfill preserves exact same-ID administrator retention and rejects stale revision or asset substitution', () => {
  const resource = {
    projectId: 'urm-app-staging',
    provider: 'subsplash',
    account: 'app:9XTSHD',
    remoteId: 'same-image',
  };
  const retained = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    jobId: 'job',
    receiptId: 'receipt',
    remoteId: 'same-image',
    resource,
    bindingId: 'retained-existing:receipt',
    providerReceiptFingerprint: 'fp',
    receiptRevision: 3,
    actorUid: 'admin',
    commandId: 'command',
    decision: 'retain_existing_resource',
    evidenceReference: 'review-evidence',
    reason: 'shared-resource',
  };
  const receipt = {
    projectId: 'urm-app-staging',
    jobId: 'job',
    step: 'image-create',
    state: 'confirmed',
    result: { id: 'same-image' },
    fingerprint: 'fp',
    revision: 3,
    cleanupReview: {
      actorUid: 'admin',
      commandId: 'command',
      retainedResourceId: 'same-image',
      providerReceiptFingerprint: 'fp',
      currentReceiptRevision: 3,
      audit: { decision: 'retain_existing_resource', evidenceReference: 'review-evidence', reason: 'shared-resource' },
    },
  };
  const doc = { path: 'temporalProviderRetentions/command', data: retained };
  assert.equal(
    retainedProviderUsageSource(doc, receipt, 'urm-app-staging').path,
    'providerBindings/job/retained-existing:receipt'
  );
  assert.throws(
    () => retainedProviderUsageSource(doc, { ...receipt, revision: 4 }, 'urm-app-staging'),
    /RETENTION_INVALID/
  );
  assert.throws(
    () => retainedProviderUsageSource(doc, { ...receipt, result: { id: 'other-image' } }, 'urm-app-staging'),
    /RETENTION_INVALID/
  );
});

test('image retention rebuild validates immutable review audit and sealed receipt without comparing pre-review hash to current receipt', () => {
  const resource = {
    projectId: 'urm-app-staging',
    provider: 'subsplash',
    account: 'app:9XTSHD',
    remoteId: 'retained-image',
  };
  const audit = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    jobId: 'image-job',
    inputHash: 'a'.repeat(64),
    state: 'completed',
    actorUid: 'admin',
    remoteId: 'retained-image',
    generation: 1,
    revision: 5,
    decision: 'retain_existing_resource',
    evidenceReference: 'evidence',
    reason: 'shared-image',
    resource,
    receiptFingerprint: 'b'.repeat(64),
    originalAllocationMayExist: true,
    reviewedAt: 100,
  };
  const doc = {
    path: 'temporalImageResourceRetentions/command',
    data: { ...audit, bindingId: 'retained-image:image-job:command' },
  };
  const receipt = { state: 'retained', remoteId: 'retained-image', reviewCommandId: 'command', reviewedAt: 100 };
  assert.equal(
    retainedImageUsageSource(doc, audit, receipt, 'urm-app-staging').path,
    'providerBindings/image-job/retained-image:image-job:command'
  );
  assert.throws(
    () => retainedImageUsageSource(doc, { ...audit, receiptFingerprint: 'c'.repeat(64) }, receipt, 'urm-app-staging'),
    /IMAGE_RETENTION_INVALID/
  );
  assert.throws(
    () => retainedImageUsageSource(doc, audit, { ...receipt, remoteId: 'adopted-other-image' }, 'urm-app-staging'),
    /IMAGE_RETENTION_INVALID/
  );
  const deletionAudit = { ...audit, originalAllocationMayExist: false },
    deletionDoc = { ...doc, data: { ...deletionAudit, bindingId: doc.data.bindingId } };
  const deletionReceipt = {
    state: 'reviewed',
    remoteId: 'retained-image',
    deletion: { remoteState: 'retained', reviewCommandId: 'command' },
  };
  assert.equal(
    retainedImageUsageSource(deletionDoc, deletionAudit, deletionReceipt, 'urm-app-staging').decision,
    'retain_existing_resource'
  );
});

test('pending additional image ACK binding retires only after sealed original-account absence or permanent retention', () => {
  const fact = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    jobId: 'original-job',
    claimId: 'claim',
    payloadFingerprint: 'payload',
    remoteId: 'original-image',
    providerAccount: { appKey: '9XTSHD', principalHash: 'original-account' },
    source: 'authenticated_post_response',
    acknowledgedAt: 100,
    disposition: 'additional_original_allocation',
  };
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ackID = digest([fact.projectId, fact.jobId, fact.claimId, fact.remoteId]),
    childID = digest(`image-ack-review:${fact.projectId}:${ackID}`);
  fact.reconciliationJobId = childID;
  const doc = { path: `temporalImageAllocationAcknowledgements/${ackID}`, data: fact },
    original = { allocationClaim: { claimId: 'claim', fingerprint: 'payload' } };
  const pending = imageAcknowledgementUsageSource(doc, original, undefined, undefined, fact.projectId);
  assert.equal(pending.path, `providerBindings/${childID}/pending-image-ack:${ackID}`);
  const child = {
    state: 'cleaned',
    sourceAcknowledgementId: ackID,
    originalJobId: fact.jobId,
    remoteId: fact.remoteId,
    pendingAcknowledgementBinding: `pending-image-ack:${ackID}`,
    absenceProof: {
      source: 'authenticated_fixed_id_404',
      remoteId: fact.remoteId,
      providerAccount: fact.providerAccount,
      verifiedAt: 101,
    },
  };
  assert.equal(
    imageAcknowledgementUsageSource(doc, original, child, undefined, fact.projectId).decision,
    'cleanup_verified'
  );
  assert.throws(
    () =>
      imageAcknowledgementUsageSource(doc, original, { ...child, absenceProof: undefined }, undefined, fact.projectId),
    /ABSENCE_INVALID/
  );
  assert.throws(
    () =>
      imageAcknowledgementUsageSource(
        doc,
        original,
        {
          ...child,
          absenceProof: {
            ...child.absenceProof,
            providerAccount: { appKey: '9XTSHD', principalHash: 'rotated-account' },
          },
        },
        undefined,
        fact.projectId
      ),
    /ABSENCE_INVALID/
  );
  const retainedChild = { ...child, state: 'retained', reviewCommandId: 'review' };
  assert.throws(
    () => imageAcknowledgementUsageSource(doc, original, retainedChild, undefined, fact.projectId),
    /RETENTION_INVALID/
  );
  const retention = {
    resource: pending.resource,
    path: `providerBindings/${childID}/retained-image:${childID}:review`,
  };
  assert.equal(
    imageAcknowledgementUsageSource(doc, original, retainedChild, retention, fact.projectId).resource,
    undefined
  );
});

test('unreviewed orphan provider acknowledgement rebuilds the exact temporary review binding and preserves original account proof', () => {
  const fact = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    jobId: 'original',
    receiptId: 'receipt',
    step: 'soundcloud-track',
    attemptOwner: 'attempt',
    claimRevision: 3,
    payloadFingerprint: 'fp',
    remoteId: 'original-track',
    disposition: 'orphaned',
    acknowledgedAtMillis: 1,
    providerAccount: { provider: 'soundcloud', account: 'original-user-urn' },
  };
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    ackID = digest([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]);
  const doc = { path: `temporalProviderAcknowledgements/${ackID}`, data: fact };
  const receipt = {
    projectId: fact.projectId,
    jobId: fact.jobId,
    step: fact.step,
    fingerprint: 'fp',
    result: { id: 'adopted-track' },
    providerAccount: fact.providerAccount,
  };
  const source = orphanProviderAcknowledgementUsageSource(doc, receipt, undefined, fact.projectId, () => 'fact-fp');
  assert.equal(source.resource.remoteId, 'original-track');
  assert.equal(source.resource.account, 'configured-account');
  assert.equal(
    source.path,
    `providerBindings/${digest(['provider-orphan-review', fact.projectId, ackID])}/pending-provider-ack:${ackID}`
  );
  assert.throws(
    () =>
      orphanProviderAcknowledgementUsageSource(
        doc,
        { ...receipt, providerAccount: { provider: 'soundcloud', account: 'different-account' } },
        undefined,
        fact.projectId,
        () => 'fact-fp'
      ),
    /ORPHAN_ACK_INVALID/
  );
  const review = {
    schemaVersion: 1,
    projectId: fact.projectId,
    jobId: fact.jobId,
    decision: 'retain_after_review',
    resource: source.resource,
    acknowledgementFingerprint: 'fact-fp',
  };
  const reviewed = { ...fact, review: { decision: 'retain_after_review', acknowledgementFingerprint: 'fact-fp' } };
  assert.equal(
    orphanProviderAcknowledgementUsageSource(
      { ...doc, data: reviewed },
      receipt,
      review,
      fact.projectId,
      () => 'fact-fp'
    ).resource,
    undefined
  );
  assert.throws(() =>
    orphanProviderAcknowledgementUsageSource(
      { ...doc, data: reviewed },
      receipt,
      undefined,
      fact.projectId,
      () => 'fact-fp'
    )
  );
});
