const historicalBucket = 'urm-app-staging.firebasestorage.app';
const stagingProjectNumber = '251680231116';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;

type StorageBinding = {
  schemaVersion: 1;
  bucket: string;
  projectNumber: string;
  createdAt: string;
  preparationSHA256: string;
};

export type MediaRecoveryStoragePlan = {
  releaseId: string;
  operationId: string;
  job?: unknown;
  taskAttestationPublicKey?: unknown;
  diagnosticStorage?: StorageBinding;
};

/** The active caller must obtain the plan from the attested private capability.
 * Historical evidence reads also use this parser to verify their sealed bucket. */
export function mediaRecoveryBucketName(plan?: MediaRecoveryStoragePlan, requireIsolated = false) {
  const binding = plan?.diagnosticStorage;
  if (binding === undefined && !requireIsolated) return historicalBucket;
  if (
    !plan ||
    !binding ||
    !plan.job ||
    !plan.taskAttestationPublicKey ||
    !uuid.test(plan.releaseId) ||
    !uuid.test(plan.operationId) ||
    Object.keys(binding).sort().join(',') !== 'bucket,createdAt,preparationSHA256,projectNumber,schemaVersion' ||
    binding.schemaVersion !== 1 ||
    binding.projectNumber !== stagingProjectNumber ||
    binding.bucket !== `urm-app-staging-mr-${plan.releaseId.replaceAll('-', '')}` ||
    typeof binding.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(binding.createdAt)) ||
    !sha256.test(binding.preparationSHA256)
  )
    throw new Error('MEDIA_RECOVERY_STORAGE_BINDING_UNCONFIRMED');
  return binding.bucket;
}
