import { proofDigest } from './temporal-release-runtime.mjs';

const project = 'urm-app-staging';
const projectNumber = '251680231116';
const permissions = ['storage.objects.create', 'storage.objects.delete', 'storage.objects.get', 'storage.objects.list'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const revision = /^[0-9a-f]{40}$/;

function fail() {
  throw new Error('MEDIA_RECOVERY_DIAGNOSTIC_STORAGE_UNCONFIRMED');
}

/** Native, read-only attestation of the separate synthetic bucket and exact grant. */
export async function observeMediaDiagnosticStorage({ api, releaseId, buildId, requireEmpty = false }) {
  if (!uuid.test(releaseId) || !revision.test(buildId)) fail();
  const bucket = `${project}-mr-${releaseId.replaceAll('-', '')}`;
  const suffix = buildId.slice(0, 20);
  const roleName = `projects/${project}/roles/tw_media_recovery_storage_${suffix}`;
  const member = `serviceAccount:tw-m-${suffix}@${project}.iam.gserviceaccount.com`;
  const resource = 'https://storage.googleapis.com/storage/v1/b/' + bucket;
  const [metadata, policy, role, listing] = await Promise.all([
    api(resource),
    api(resource + '/iam?optionsRequestedPolicyVersion=3'),
    api('https://iam.googleapis.com/v1/' + roleName),
    requireEmpty ? api(resource + '/o?versions=true&maxResults=1') : null,
  ]);
  if (
    metadata?.name !== bucket ||
    metadata.id !== bucket ||
    metadata.projectNumber !== projectNumber ||
    metadata.location !== 'US-CENTRAL1' ||
    !Number.isFinite(Date.parse(metadata.timeCreated)) ||
    !/^[1-9][0-9]*$/.test(metadata.metageneration) ||
    metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
    metadata.iamConfiguration?.publicAccessPrevention !== 'enforced' ||
    metadata.versioning?.enabled !== true ||
    metadata.lifecycle?.rule?.length ||
    !policy?.etag ||
    !Array.isArray(policy.bindings) ||
    policy.bindings.some(
      (binding) =>
        !Array.isArray(binding.members) ||
        binding.members.some((principal) => principal === 'allUsers' || principal === 'allAuthenticatedUsers')
    ) ||
    role?.name !== roleName ||
    role.deleted === true ||
    !role.etag ||
    !Array.isArray(role.includedPermissions) ||
    JSON.stringify([...role.includedPermissions].sort()) !== JSON.stringify(permissions) ||
    (requireEmpty &&
      (!listing ||
        listing.kind !== 'storage#objects' ||
        listing.nextPageToken ||
        (listing.items !== undefined && (!Array.isArray(listing.items) || listing.items.length))))
  )
    fail();
  const grants = policy.bindings.filter((binding) => binding.role === roleName || binding.members.includes(member));
  if (
    grants.length !== 1 ||
    grants[0].role !== roleName ||
    grants[0].condition !== undefined ||
    grants[0].members.length !== 1 ||
    grants[0].members[0] !== member
  )
    fail();
  return {
    schemaVersion: 1,
    bucket,
    projectNumber,
    createdAt: metadata.timeCreated,
    preparationSHA256: proofDigest({
      metageneration: metadata.metageneration,
      policyETag: policy.etag,
      roleETag: role.etag,
      permissions,
    }),
  };
}

/** A later normal activation must establish that this diagnostic's temporary
 * bucket grant was removed. Historical reads use the operator's own access. */
export async function readRetiredMediaDiagnosticStorage({ db, api, plan, terminalProof }) {
  if (!plan.diagnosticStorage) return null;
  if (
    db.projectId !== project ||
    db.databaseId !== '(default)' ||
    !uuid.test(plan.releaseId) ||
    !revision.test(plan.buildId) ||
    !terminalProof?.dataDigest
  )
    fail();
  const receiptSet = await db
    .collection('_control')
    .where('identityState.plan.terminalProof.dataDigest', '==', terminalProof.dataDigest)
    .limit(2)
    .get();
  if (receiptSet.size !== 1) fail();
  const [doc] = receiptSet.docs;
  const receipt = doc.data(),
    state = receipt.identityState,
    revocation = state?.revocation;
  const bucket = `${project}-mr-${plan.releaseId.replaceAll('-', '')}`;
  if (
    !doc.createTime?.isEqual(doc.updateTime) ||
    !uuid.test(receipt.operationId) ||
    doc.id !== 'temporalMediaDiagnosticStorageRetirement-' + receipt.operationId ||
    receipt.releaseId !== plan.releaseId ||
    state?.stage !== 'completed' ||
    state.plan?.operationId !== receipt.operationId ||
    state.plan.releaseId !== plan.releaseId ||
    state.plan.buildId !== plan.buildId ||
    state.plan.bindingDigest !== receipt.bindingDigest ||
    state.plan.action !== 'retire-media-diagnostic-storage-grant' ||
    state.plan.bucket !== bucket ||
    plan.diagnosticStorage.bucket !== bucket ||
    state.retiredBucket?.name !== bucket ||
    state.retiredBucket.timeCreated !== plan.diagnosticStorage.createdAt ||
    proofDigest(state.plan.terminalProof) !== proofDigest(terminalProof) ||
    proofDigest(revocation?.before?.certificate ?? null) !== proofDigest(plan.diagnosticStorage) ||
    revocation?.stage !== 'acknowledged' ||
    !state.retiredPolicyETag ||
    revocation.ack?.etag !== state.retiredPolicyETag
  )
    fail();
  const url = 'https://storage.googleapis.com/storage/v1/b/' + bucket;
  const [policy, metadata] = await Promise.all([api(url + '/iam?optionsRequestedPolicyVersion=3'), api(url)]);
  if (!metadata) fail();
  const { etag, metageneration, updated: _updated, ...configuration } = metadata;
  if (
    metadata.kind !== 'storage#bucket' ||
    metadata.name !== bucket ||
    metadata.id !== bucket ||
    metadata.projectNumber !== projectNumber ||
    metadata.location !== 'US-CENTRAL1' ||
    metadata.timeCreated !== plan.diagnosticStorage.createdAt ||
    proofDigest(configuration) !== state.retiredBucket.configurationSHA256 ||
    etag !== state.retiredBucket.etag ||
    metageneration !== state.retiredBucket.metageneration
  )
    fail();
  const runtimeMember = 'serviceAccount:' + plan.runner;
  const role = `projects/${project}/roles/tw_media_recovery_storage_${plan.buildId.slice(0, 20)}`;
  const bindingsDigest = (bindings) =>
    proofDigest(
      bindings
        .map((binding) => ({
          ...binding,
          members: [...binding.members].sort(),
        }))
        .sort((a, b) => proofDigest(a).localeCompare(proofDigest(b)))
    );
  if (
    policy?.kind !== 'storage#policy' ||
    policy.resourceId !== 'projects/_/buckets/' + bucket ||
    policy.etag !== state.retiredPolicyETag ||
    (policy.version ?? 1) !== revocation.ack.version ||
    !Array.isArray(policy.bindings) ||
    policy.bindings.some(
      (binding) => binding.role === role || !Array.isArray(binding.members) || binding.members.includes(runtimeMember)
    ) ||
    bindingsDigest(policy.bindings) !== bindingsDigest(revocation.ack.bindings)
  )
    fail();
  return proofDigest({ receipt, policyETag: policy.etag, bucketETag: etag, metageneration });
}
