#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code) => Object.assign(new Error(code), { code });
export const PROVIDER_USAGE_SCAN_GROUPS = [
  'sermons',
  'lists',
  'series',
  'speakers',
  'images',
  'listItems',
  'sermonLists',
  'seriesItems',
  'durableJobIntents',
  'temporalProviderAcknowledgementReviews',
  'temporalProviderRetentions',
  'temporalImageResourceRetentions',
  'temporalImageAllocationAcknowledgements',
  'temporalProviderAcknowledgements',
  'temporalLegacySoundCloudRetentions',
];
export function assertProviderBackfillControl(control, options, proof) {
  if (
    !['urm-app', 'urm-app-staging'].includes(options.projectId) ||
    !options.releaseId ||
    !Number.isSafeInteger(options.controlRevision) ||
    options.controlRevision < 1
  )
    throw fail('PROVIDER_BACKFILL_OPTIONS_INVALID');
  if (
    proof?.schemaVersion !== 1 ||
    proof.projectId !== options.projectId ||
    proof.releaseId !== options.releaseId ||
    proof.controlRevision !== options.controlRevision ||
    proof.result !== 'passed' ||
    proof.legacyDrained !== true
  )
    throw fail('PROVIDER_BACKFILL_DRAIN_PROOF_INVALID');
  if (
    control?.schemaVersion !== 1 ||
    control.releaseId !== options.releaseId ||
    control.revision !== options.controlRevision ||
    control.admission !== 'paused' ||
    !['media', 'publishing', 'images', 'accounts'].every(
      (domain) => control.domains?.[domain]?.owner === 'legacy' && control.domains?.[domain]?.admission === 'paused'
    )
  )
    throw fail('PROVIDER_BACKFILL_CONTROL_NOT_FROZEN');
}
export function assertProviderBackfillReleaseState(state, options) {
  if (
    state?.releaseId !== options.releaseId ||
    state.controlRevision !== options.controlRevision ||
    !['legacy-drained', 'provider-usage-ready'].includes(state.phase) ||
    !Number.isFinite(state.legacyDrainedAt)
  )
    throw fail('PROVIDER_BACKFILL_RELEASE_NOT_DRAINED');
}
/** Pages are bounded; the number of canonical documents is deliberately unbounded. */
export async function backfillProviderUsage(options, deps) {
  const proof = options.drainProof;
  let epoch = options.epoch ?? randomUUID();
  assertProviderBackfillControl(await deps.readControl(), options, proof);
  await deps.assertLegacyDrained();
  const resumed = options.apply ? await deps.begin(epoch) : undefined;
  if (resumed) epoch = resumed.epoch;
  let documentCount = resumed?.documentCount ?? 0,
    edgeCount = resumed?.edgeCount ?? 0;
  let progress = { groupIndex: resumed?.groupIndex ?? 0, cursor: resumed?.cursor ?? null };
  for (let groupIndex = progress.groupIndex; groupIndex < PROVIDER_USAGE_SCAN_GROUPS.length; groupIndex++) {
    const group = PROVIDER_USAGE_SCAN_GROUPS[groupIndex];
    let cursor = groupIndex === progress.groupIndex ? progress.cursor ?? undefined : undefined;
    do {
      const page = await deps.page(group, cursor, 100);
      for (const doc of page.documents) {
        assertProviderBackfillControl(await deps.readControl(), options, proof);
        if (options.apply) edgeCount += await deps.indexDocument(doc, epoch);
        else edgeCount += await deps.inspectDocument(doc);
        documentCount++;
      }
      if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw fail('PROVIDER_BACKFILL_PAGINATION_INVALID');
      const next = {
        groupIndex: page.hasMore ? groupIndex : groupIndex + 1,
        cursor: page.hasMore ? page.cursor : null,
      };
      if (options.apply && deps.checkpoint)
        await deps.checkpoint(epoch, progress, { ...next, documentCount, edgeCount });
      progress = next;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  await deps.assertLegacyDrained();
  assertProviderBackfillControl(await deps.readControl(), options, proof);
  if (options.apply) await deps.finish(epoch, { documentCount, edgeCount });
  return {
    schemaVersion: 1,
    projectId: options.projectId,
    releaseId: options.releaseId,
    controlRevision: options.controlRevision,
    epoch,
    documentCount,
    edgeCount,
    result: options.apply ? 'passed' : 'dry_run',
  };
}
export function reviewedProviderUsageSource(doc, fact, projectId, fingerprint) {
  const acknowledgementId = doc.path.split('/')[1],
    review = doc.data;
  const resource = review.resource;
  if (
    review.schemaVersion !== 1 ||
    createHash('sha256')
      .update(JSON.stringify([fact?.receiptId, fact?.attemptOwner, fact?.claimRevision, fact?.remoteId]))
      .digest('hex') !== acknowledgementId ||
    !['retain_after_review', 'cleanup_verified'].includes(review.decision) ||
    !fact ||
    fact.schemaVersion !== 1 ||
    fact.disposition !== 'orphaned' ||
    review.projectId !== projectId ||
    fact.projectId !== projectId ||
    review.jobId !== fact.jobId ||
    resource?.projectId !== projectId ||
    resource.remoteId !== fact.remoteId ||
    resource.provider !== (fact.step === 'soundcloud-track' ? 'soundcloud' : 'subsplash') ||
    resource.account !== (resource.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account') ||
    fingerprint(fact) !== review.acknowledgementFingerprint ||
    fact.review?.decision !== review.decision ||
    fact.review?.acknowledgementFingerprint !== review.acknowledgementFingerprint
  )
    throw fail('PROVIDER_BACKFILL_RETAINED_REVIEW_INVALID');
  return {
    resource,
    decision: review.decision,
    path: `providerBindings/${fact.jobId}/retained-orphan:${acknowledgementId}`,
  };
}
export function retainedLegacySoundCloudUsageSource(
  doc,
  certificate,
  observation,
  grant,
  intent,
  projectId,
  fingerprint
) {
  const retained = doc.data,
    certificateId = doc.path.split('/')[1],
    resource = certificate?.resource;
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (
    !sha(certificateId) ||
    retained?.schemaVersion !== 1 ||
    retained.projectId !== projectId ||
    retained.certificateId !== certificateId ||
    retained.certificateDigest !== certificateId ||
    !certificate ||
    certificate.schemaVersion !== 1 ||
    certificate.projectId !== projectId ||
    certificate.jobId !== retained.jobId ||
    fingerprint(certificate) !== certificateId ||
    certificate.originalOwner !== 'unverified' ||
    certificate.disposition !== 'permanent_retention_without_absence_claim' ||
    retained.disposition !== certificate.disposition ||
    !sha(retained.canonicalAfterDigest) ||
    retained.retentionOwner !== `retention:${certificateId}` ||
    retained.bindingId !== 'permanent-legacy-soundcloud' ||
    resource?.projectId !== projectId ||
    resource.provider !== 'soundcloud' ||
    resource.account !== 'configured-account' ||
    resource.remoteId !== certificate.trackId ||
    fingerprint(retained.resource) !== fingerprint(resource) ||
    !observation ||
    fingerprint(observation) !== certificate.observationDigest ||
    observation.projectId !== projectId ||
    observation.jobId !== retained.jobId ||
    observation.originalOwner !== 'unverified' ||
    observation.originalHttpStatus !== 404 ||
    observation.providerMutationSent !== false ||
    observation.trackId !== resource.remoteId ||
    observation.observedCurrentAccount !== certificate.observedCurrentAccount ||
    !/^soundcloud:users:[0-9]+$/.test(certificate.observedCurrentAccount ?? '') ||
    !intent ||
    intent.projectId !== projectId ||
    intent.jobId !== retained.jobId ||
    intent.generation !== certificate.generation ||
    fingerprint(intent) !== certificate.intentFingerprint ||
    !grant ||
    grant.schemaVersion !== 1 ||
    grant.projectId !== projectId ||
    grant.jobId !== retained.jobId ||
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
      (operation) =>
        operation?.kind === 'legacy_soundcloud_retain' &&
        operation.certificateId === certificateId &&
        Object.keys(operation).length === 2
    )
  )
    throw fail('PROVIDER_BACKFILL_LEGACY_SOUNDCLOUD_RETENTION_INVALID');
  // This permanent reference outlives the source job and later canonical edits.
  // An initial unverified read is deliberately never converted into an absence tombstone.
  return {
    resource,
    decision: 'retain_existing_resource',
    path: `providerBindings/${retained.retentionOwner}/${retained.bindingId}`,
  };
}
export function retainedProviderUsageSource(doc, receipt, projectId) {
  const retained = doc.data,
    resource = retained.resource,
    review = receipt?.cleanupReview;
  const result = receipt?.result;
  const remoteId =
    typeof result === 'string'
      ? result
      : result?.id ?? result?.listId ?? result?.tagId ?? result?.soundCloudTrackId ?? result?.trackIdentifier;
  if (
    retained.schemaVersion !== 1 ||
    retained.decision !== 'retain_existing_resource' ||
    doc.path.split('/')[1] !== retained.commandId ||
    retained.projectId !== projectId ||
    resource?.projectId !== projectId ||
    receipt?.state !== 'confirmed' ||
    receipt.projectId !== projectId ||
    receipt.jobId !== retained.jobId ||
    resource.remoteId !== retained.remoteId ||
    resource.remoteId !== remoteId ||
    resource.provider !== (receipt.step === 'soundcloud-track' ? 'soundcloud' : 'subsplash') ||
    resource.account !== (resource.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account') ||
    retained.bindingId !== `retained-existing:${retained.receiptId}` ||
    retained.providerReceiptFingerprint !== receipt.fingerprint ||
    retained.receiptRevision !== receipt.revision ||
    review?.providerReceiptFingerprint !== receipt.fingerprint ||
    review.currentReceiptRevision !== receipt.revision ||
    review.retainedResourceId !== remoteId ||
    review.commandId !== retained.commandId ||
    review.actorUid !== retained.actorUid ||
    review.audit?.decision !== 'retain_existing_resource' ||
    !retained.evidenceReference ||
    !retained.reason ||
    review.audit.evidenceReference !== retained.evidenceReference ||
    review.audit.reason !== retained.reason
  )
    throw fail('PROVIDER_BACKFILL_EXISTING_RETENTION_INVALID');
  return { resource, decision: retained.decision, path: `providerBindings/${retained.jobId}/${retained.bindingId}` };
}
export function retainedImageUsageSource(doc, audit, receipt, projectId) {
  const retained = doc.data,
    commandId = doc.path.split('/')[1],
    resource = retained.resource;
  const keys = [
    'schemaVersion',
    'projectId',
    'jobId',
    'inputHash',
    'state',
    'actorUid',
    'remoteId',
    'generation',
    'revision',
    'decision',
    'evidenceReference',
    'reason',
    'receiptFingerprint',
    'originalAllocationMayExist',
    'reviewedAt',
  ];
  if (
    !audit ||
    !receipt ||
    retained.schemaVersion !== 1 ||
    retained.projectId !== projectId ||
    retained.state !== 'completed' ||
    retained.decision !== 'retain_existing_resource' ||
    !retained.jobId ||
    !retained.actorUid ||
    !retained.evidenceReference ||
    !retained.reason ||
    !/^[a-f0-9]{64}$/.test(retained.inputHash ?? '') ||
    !/^[a-f0-9]{64}$/.test(retained.receiptFingerprint ?? '') ||
    !Number.isSafeInteger(retained.generation) ||
    retained.generation < 1 ||
    !Number.isSafeInteger(retained.revision) ||
    retained.revision < 1 ||
    !Number.isFinite(retained.reviewedAt) ||
    typeof retained.originalAllocationMayExist !== 'boolean' ||
    keys.some((key) => audit[key] !== retained[key]) ||
    resource?.projectId !== projectId ||
    resource.provider !== 'subsplash' ||
    resource.account !== 'app:9XTSHD' ||
    resource.remoteId !== retained.remoteId ||
    !audit.resource ||
    ['projectId', 'provider', 'account', 'remoteId'].some((key) => audit.resource[key] !== resource[key]) ||
    retained.bindingId !== `retained-image:${retained.jobId}:${commandId}` ||
    (receipt.remoteId ?? receipt.deletion?.remoteId) !== retained.remoteId ||
    !(
      (receipt.state === 'retained' && receipt.reviewCommandId === commandId) ||
      (receipt.state === 'reviewed' &&
        receipt.deletion?.remoteState === 'retained' &&
        receipt.deletion?.reviewCommandId === commandId)
    )
  )
    throw fail('PROVIDER_BACKFILL_IMAGE_RETENTION_INVALID');
  return { resource, decision: retained.decision, path: `providerBindings/${retained.jobId}/${retained.bindingId}` };
}
export function imageAcknowledgementUsageSource(doc, originalReceipt, child, retainedSource, projectId) {
  const fact = doc.data,
    ackId = doc.path.split('/')[1];
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const possibleIds = [
    digest([fact.projectId, fact.jobId, fact.claimId, fact.remoteId]),
    digest([{ projectId: fact.projectId, jobId: fact.jobId }, fact.claimId, fact.remoteId]),
    digest([{ jobId: fact.jobId, projectId: fact.projectId }, fact.claimId, fact.remoteId]),
  ];
  if (
    fact.schemaVersion !== 1 ||
    fact.projectId !== projectId ||
    !fact.jobId ||
    !fact.claimId ||
    !fact.remoteId ||
    !fact.payloadFingerprint ||
    fact.source !== 'authenticated_post_response' ||
    !Number.isFinite(fact.acknowledgedAt) ||
    !possibleIds.includes(ackId) ||
    !['owned_allocation', 'retained_original_allocation', 'additional_original_allocation'].includes(
      fact.disposition
    ) ||
    originalReceipt?.allocationClaim?.claimId !== fact.claimId ||
    originalReceipt.allocationClaim.fingerprint !== fact.payloadFingerprint
  )
    throw fail('PROVIDER_BACKFILL_IMAGE_ACK_INVALID');
  if (fact.disposition === 'retained_original_allocation') {
    if (
      originalReceipt.state !== 'retained' ||
      originalReceipt.remoteId !== fact.remoteId ||
      !originalReceipt.reviewCommandId ||
      !retainedSource ||
      retainedSource.resource.remoteId !== fact.remoteId ||
      retainedSource.path !==
        `providerBindings/${fact.jobId}/retained-image:${fact.jobId}:${originalReceipt.reviewCommandId}`
    )
      throw fail('PROVIDER_BACKFILL_IMAGE_ACK_RETENTION_INVALID');
    return { data: undefined, path: doc.path };
  }
  if (fact.disposition === 'owned_allocation') return { data: undefined, path: doc.path };
  const childId = digest(`image-ack-review:${projectId}:${ackId}`),
    bindingId = `pending-image-ack:${ackId}`;
  if (
    fact.reconciliationJobId !== childId ||
    (child &&
      (child.sourceAcknowledgementId !== ackId ||
        child.originalJobId !== fact.jobId ||
        child.remoteId !== fact.remoteId ||
        child.pendingAcknowledgementBinding !== bindingId))
  )
    throw fail('PROVIDER_BACKFILL_IMAGE_ACK_INVALID');
  const resource = { projectId, provider: 'subsplash', account: 'app:9XTSHD', remoteId: fact.remoteId };
  if (child?.state === 'cleaned') {
    const proof = child.absenceProof;
    if (
      proof?.source !== 'authenticated_fixed_id_404' ||
      proof.remoteId !== fact.remoteId ||
      !Number.isFinite(proof.verifiedAt) ||
      proof.verifiedAt < fact.acknowledgedAt ||
      !fact.providerAccount ||
      fact.providerAccount.appKey !== '9XTSHD' ||
      !fact.providerAccount.principalHash ||
      proof.providerAccount?.appKey !== fact.providerAccount.appKey ||
      proof.providerAccount.principalHash !== fact.providerAccount.principalHash
    )
      throw fail('PROVIDER_BACKFILL_IMAGE_ACK_ABSENCE_INVALID');
    return { resource, decision: 'cleanup_verified', path: doc.path };
  }
  if (child?.state === 'retained') {
    if (
      !retainedSource ||
      retainedSource.resource.remoteId !== fact.remoteId ||
      retainedSource.resource.projectId !== projectId ||
      retainedSource.path !== `providerBindings/${childId}/retained-image:${childId}:${child.reviewCommandId}`
    )
      throw fail('PROVIDER_BACKFILL_IMAGE_ACK_RETENTION_INVALID');
    return { data: undefined, path: doc.path };
  }
  return { resource, decision: 'pending_acknowledgement', path: `providerBindings/${childId}/${bindingId}` };
}
export function orphanProviderAcknowledgementUsageSource(doc, receipt, review, projectId, fingerprint) {
  const fact = doc.data,
    ackId = doc.path.split('/')[1];
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const provider = fact.step === 'soundcloud-track' ? 'soundcloud' : 'subsplash';
  if (
    fact.schemaVersion !== 1 ||
    fact.projectId !== projectId ||
    !fact.jobId ||
    !['orphaned', 'same_resource'].includes(fact.disposition) ||
    digest([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]) !== ackId ||
    !receipt ||
    receipt.projectId !== projectId ||
    receipt.jobId !== fact.jobId ||
    receipt.step !== fact.step ||
    receipt.fingerprint !== fact.payloadFingerprint ||
    fact.providerAccount?.provider !== provider ||
    !fact.providerAccount.account ||
    receipt.providerAccount?.provider !== fact.providerAccount.provider ||
    receipt.providerAccount.account !== fact.providerAccount.account
  )
    throw fail('PROVIDER_BACKFILL_ORPHAN_ACK_INVALID');
  if (fact.disposition === 'same_resource') return { data: undefined, path: doc.path };
  if (fact.review || review) {
    reviewedProviderUsageSource(
      { path: `temporalProviderAcknowledgementReviews/${ackId}`, data: review },
      fact,
      projectId,
      fingerprint
    );
    return { data: undefined, path: doc.path };
  }
  const childId = digest(['provider-orphan-review', projectId, ackId]),
    bindingId = `pending-provider-ack:${ackId}`;
  return {
    resource: {
      projectId,
      provider,
      account: provider === 'soundcloud' ? 'configured-account' : 'app:9XTSHD',
      remoteId: fact.remoteId,
    },
    decision: 'pending_acknowledgement',
    path: `providerBindings/${childId}/${bindingId}`,
  };
}
async function firebaseDependencies(options) {
  if (Object.keys(process.env).some((key) => /EMULATOR/.test(key) && process.env[key]))
    throw fail('PROVIDER_BACKFILL_EMULATOR_FORBIDDEN');
  const require = createRequire(resolve(root, 'package.json'));
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore, FieldPath } = require('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ projectId: options.projectId });
  if (app.options.projectId !== options.projectId) throw fail('PROVIDER_BACKFILL_PROJECT_MISMATCH');
  const db = getFirestore(app);
  require('ts-node').register({ project: resolve(root, 'packages/orchestration/tsconfig.json'), transpileOnly: true });
  const {
    extractProviderResources,
    providerResourceKey,
    providerEdgeKey,
    providerAcknowledgementFactFingerprint,
    PROVIDER_USAGE_CONTROL,
    PROVIDER_USAGE_COLLECTION,
  } = require(resolve(root, 'packages/orchestration/src/provider-usage.ts'));
  const { acknowledgedProjectionDigest } = require(resolve(
    root,
    'functions/src/temporal/publishing/criticalAcknowledgedRepair.ts'
  ));
  const control = db.doc('_control/temporalRelease'),
    releaseState = db.doc('_control/temporalReleaseState'),
    marker = db.doc(PROVIDER_USAGE_CONTROL);
  const frozen = async (tx) => {
    const [current, state] = await Promise.all([tx.get(control), tx.get(releaseState)]);
    assertProviderBackfillControl(current.data(), options, options.drainProof);
    assertProviderBackfillReleaseState(state.data(), options);
  };
  const drainedInTransaction = async (tx) => {
    for (const state of ['active', 'needs_attention'])
      if (!(await tx.get(db.collection('legacyAdmissionLeases').where('state', '==', state).limit(1))).empty)
        throw fail('PROVIDER_BACKFILL_LEGACY_NOT_DRAINED');
  };
  const dataFor = async (doc, tx) => {
    if (!doc.path.startsWith('durableJobIntents/')) return doc.data;
    const jobId = doc.path.split('/')[1];
    const job = await (tx ? tx.get(db.doc(`durableJobs/${jobId}`)) : db.doc(`durableJobs/${jobId}`).get());
    return job.exists && !['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.get('state'))
      ? doc.data
      : undefined;
  };
  const sourceFor = async (doc, tx) => {
    if (doc.path.startsWith('temporalLegacySoundCloudRetentions/')) {
      const paths = [
        `temporalLegacySoundCloudRetentionCertificates/${doc.path.split('/')[1]}`,
        `temporalLegacySoundCloudRetentionObservations/${doc.data.jobId}`,
        `durableJobCriticalRepairGrants/${doc.data.jobId}`,
        `durableJobIntents/${doc.data.jobId}`,
      ];
      const [certificate, observation, grant, intent] = await Promise.all(
        paths.map((path) => (tx ? tx.get(db.doc(path)) : db.doc(path).get()))
      );
      return retainedLegacySoundCloudUsageSource(
        doc,
        certificate.data(),
        observation.data(),
        grant.data(),
        intent.data(),
        options.projectId,
        acknowledgedProjectionDigest
      );
    }
    if (doc.path.startsWith('temporalProviderAcknowledgements/')) {
      const receiptRef = db.doc(`temporalProviderReceipts/${doc.data.receiptId}`),
        reviewRef = db.doc(`temporalProviderAcknowledgementReviews/${doc.path.split('/')[1]}`);
      const [receipt, review] = await Promise.all([
        tx ? tx.get(receiptRef) : receiptRef.get(),
        tx ? tx.get(reviewRef) : reviewRef.get(),
      ]);
      return orphanProviderAcknowledgementUsageSource(
        doc,
        receipt.data(),
        review.data(),
        options.projectId,
        providerAcknowledgementFactFingerprint
      );
    }
    if (doc.path.startsWith('temporalImageAllocationAcknowledgements/')) {
      const originalRef = db.doc(`temporalImageReceipts/${doc.data.jobId}`),
        childRef = doc.data.reconciliationJobId
          ? db.doc(`temporalImageReceipts/${doc.data.reconciliationJobId}`)
          : undefined;
      const [original, child] = await Promise.all([
        tx ? tx.get(originalRef) : originalRef.get(),
        childRef ? (tx ? tx.get(childRef) : childRef.get()) : undefined,
      ]);
      const childData = child?.data();
      const reviewedReceipt = doc.data.disposition === 'retained_original_allocation' ? original.data() : childData;
      let retainedSource;
      if (reviewedReceipt?.state === 'retained' && reviewedReceipt.reviewCommandId) {
        const retainedRef = db.doc(`temporalImageResourceRetentions/${reviewedReceipt.reviewCommandId}`),
          auditRef = db.doc(`temporalImageResolutionAudits/${reviewedReceipt.reviewCommandId}`);
        const [retained, audit] = await Promise.all([
          tx ? tx.get(retainedRef) : retainedRef.get(),
          tx ? tx.get(auditRef) : auditRef.get(),
        ]);
        retainedSource = retainedImageUsageSource(
          { path: retainedRef.path, data: retained.data() },
          audit.data(),
          reviewedReceipt,
          options.projectId
        );
      }
      return imageAcknowledgementUsageSource(doc, original.data(), childData, retainedSource, options.projectId);
    }
    if (doc.path.startsWith('temporalImageResourceRetentions/')) {
      const auditRef = db.doc(`temporalImageResolutionAudits/${doc.path.split('/')[1]}`),
        receiptRef = db.doc(`temporalImageReceipts/${doc.data.jobId}`);
      const [audit, receipt] = await Promise.all([
        tx ? tx.get(auditRef) : auditRef.get(),
        tx ? tx.get(receiptRef) : receiptRef.get(),
      ]);
      return retainedImageUsageSource(doc, audit.data(), receipt.data(), options.projectId);
    }
    if (doc.path.startsWith('temporalProviderRetentions/')) {
      const receiptRef = db.doc(`temporalProviderReceipts/${doc.data.receiptId}`);
      const receipt = (await (tx ? tx.get(receiptRef) : receiptRef.get())).data();
      return retainedProviderUsageSource(doc, receipt, options.projectId);
    }
    if (!doc.path.startsWith('temporalProviderAcknowledgementReviews/'))
      return { data: await dataFor(doc, tx), path: doc.path };
    const acknowledgementId = doc.path.split('/')[1];
    const factRef = db.doc(`temporalProviderAcknowledgements/${acknowledgementId}`);
    const fact = (await (tx ? tx.get(factRef) : factRef.get())).data();
    return reviewedProviderUsageSource(doc, fact, options.projectId, providerAcknowledgementFactFingerprint);
  };
  return {
    readControl: async () => {
      const [current, state] = await Promise.all([control.get(), releaseState.get()]);
      assertProviderBackfillReleaseState(state.data(), options);
      return current.data();
    },
    assertLegacyDrained: async () => {
      for (const state of ['active', 'needs_attention'])
        if (!(await db.collection('legacyAdmissionLeases').where('state', '==', state).limit(1).get()).empty)
          throw fail('PROVIDER_BACKFILL_LEGACY_NOT_DRAINED');
    },
    begin: (epoch) =>
      db.runTransaction(async (tx) => {
        await frozen(tx);
        await drainedInTransaction(tx);
        const existing = (await tx.get(marker)).data();
        if (
          existing?.status === 'building' &&
          existing.projectId === options.projectId &&
          existing.releaseId === options.releaseId &&
          existing.controlRevision === options.controlRevision
        ) {
          if (
            typeof existing.epoch !== 'string' ||
            !Number.isSafeInteger(existing.groupIndex) ||
            existing.groupIndex < 0 ||
            existing.groupIndex > PROVIDER_USAGE_SCAN_GROUPS.length ||
            !Number.isSafeInteger(existing.documentCount) ||
            !Number.isSafeInteger(existing.edgeCount) ||
            existing.documentCount < 0 ||
            existing.edgeCount < 0
          )
            throw fail('PROVIDER_BACKFILL_CHECKPOINT_INVALID');
          return existing;
        }
        tx.set(marker, {
          schemaVersion: 1,
          projectId: options.projectId,
          releaseId: options.releaseId,
          controlRevision: options.controlRevision,
          epoch,
          status: 'building',
          groupIndex: 0,
          cursor: null,
          documentCount: 0,
          edgeCount: 0,
        });
        return { epoch, groupIndex: 0, cursor: null, documentCount: 0, edgeCount: 0 };
      }),
    page: async (group, cursor, limit) => {
      let query = ['listItems', 'sermonLists', 'seriesItems'].includes(group)
        ? db.collectionGroup(group)
        : db.collection(group);
      query = query.orderBy(FieldPath.documentId()).limit(limit + 1);
      if (cursor) query = query.startAfter(db.doc(cursor));
      const snapshot = await query.get(),
        docs = snapshot.docs.slice(0, limit);
      return {
        documents: docs.map((doc) => ({ path: doc.ref.path, data: doc.data(), updateTime: doc.updateTime })),
        hasMore: snapshot.size > limit,
        cursor: docs.at(-1)?.ref.path,
      };
    },
    inspectDocument: async (doc) => {
      const source = await sourceFor(doc);
      return source.resource
        ? Number(source.decision !== 'cleanup_verified')
        : extractProviderResources(options.projectId, source.path, source.data).length;
    },
    indexDocument: (doc, epoch) =>
      db.runTransaction(async (tx) => {
        await frozen(tx);
        const current = await tx.get(db.doc(doc.path)),
          markerDoc = await tx.get(marker);
        if (
          !current.exists ||
          !current.updateTime.isEqual(doc.updateTime) ||
          markerDoc.get('epoch') !== epoch ||
          markerDoc.get('status') !== 'building'
        )
          throw fail('PROVIDER_BACKFILL_CANONICAL_CHANGED');
        const source = await sourceFor(doc, tx);
        const resources = source.resource
          ? [source.resource]
          : extractProviderResources(options.projectId, source.path, source.data);
        const records = [];
        for (const resource of resources) {
          const ref = db
              .collection(PROVIDER_USAGE_COLLECTION)
              .doc(providerResourceKey(resource))
              .collection('epochs')
              .doc(epoch),
            edge = ref.collection('edges').doc(providerEdgeKey(source.path));
          const [aggregate, existingEdge] = await Promise.all([tx.get(ref), tx.get(edge)]);
          records.push({
            resource,
            ref,
            edge,
            count: aggregate.get('referenceCount') ?? 0,
            state: aggregate.get('state'),
            exists: existingEdge.exists,
          });
        }
        if (source.decision === 'cleanup_verified') {
          for (const record of records) {
            if (record.count !== 0) throw fail('PROVIDER_BACKFILL_DELETED_RESOURCE_REFERENCED');
            tx.set(record.ref, { ...record.resource, epoch, state: 'deleted', referenceCount: 0 }, { merge: true });
          }
          return 0;
        }
        for (const record of records)
          if (!record.exists) {
            if (['reserved', 'deleted'].includes(record.state))
              throw fail('PROVIDER_BACKFILL_RETAINED_RESOURCE_DELETED');
            tx.set(
              record.ref,
              { ...record.resource, epoch, state: 'active', referenceCount: record.count + 1 },
              { merge: true }
            );
            const binding = source.path.startsWith('providerBindings/') ? source.path.split('/') : undefined;
            tx.create(record.edge, {
              projectId: options.projectId,
              canonicalPath: source.path,
              ...(binding ? { jobId: binding[1], bindingId: binding[2], state: 'pending_effect' } : {}),
            });
          }
        return resources.length;
      }),
    checkpoint: (epoch, previous, next) =>
      db.runTransaction(async (tx) => {
        await frozen(tx);
        const current = await tx.get(marker);
        if (
          current.get('epoch') !== epoch ||
          current.get('status') !== 'building' ||
          current.get('groupIndex') !== previous.groupIndex ||
          (current.get('cursor') ?? null) !== previous.cursor
        )
          throw fail('PROVIDER_BACKFILL_CONCURRENT_CHECKPOINT');
        tx.update(marker, { ...next, checkpointAtMillis: Date.now() });
      }),
    finish: (epoch, counts) =>
      db.runTransaction(async (tx) => {
        await frozen(tx);
        await drainedInTransaction(tx);
        const snapshot = await tx.get(marker);
        if (
          snapshot.get('epoch') !== epoch ||
          snapshot.get('status') !== 'building' ||
          snapshot.get('groupIndex') !== PROVIDER_USAGE_SCAN_GROUPS.length
        )
          throw fail('PROVIDER_BACKFILL_EPOCH_CHANGED');
        tx.update(marker, {
          status: 'ready',
          ...counts,
          groups: PROVIDER_USAGE_SCAN_GROUPS,
          completedAtMillis: Date.now(),
        });
      }),
  };
}
export function parseProviderBackfillArgs(args) {
  const values = {},
    apply = args.includes('--apply');
  args = args.filter((arg) => arg !== '--apply');
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--project', '--release', '--control-revision', '--drain-proof'].includes(args[i]) ||
      !args[i + 1] ||
      values[args[i]]
    )
      throw fail('PROVIDER_BACKFILL_OPTIONS_INVALID');
    values[args[i]] = args[i + 1];
  }
  return {
    projectId: values['--project'],
    releaseId: values['--release'],
    controlRevision: Number(values['--control-revision']),
    drainProofPath: values['--drain-proof'],
    apply,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--help')
    console.log(
      'Usage: node scripts/temporal-backfill-provider-usage.mjs --project PROJECT --release UUID --control-revision N --drain-proof FILE [--apply]. Default dry run; requires frozen legacy ownership and a matching drain proof.'
    );
  else
    try {
      const options = parseProviderBackfillArgs(process.argv.slice(2));
      options.drainProof = JSON.parse(await readFile(options.drainProofPath, 'utf8'));
      console.log(JSON.stringify(await backfillProviderUsage(options, await firebaseDependencies(options))));
    } catch (error) {
      console.error(error.code?.startsWith('PROVIDER_BACKFILL_') ? error.code : 'PROVIDER_BACKFILL_FAILED');
      process.exitCode = 1;
    }
}
