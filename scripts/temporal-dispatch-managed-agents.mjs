import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
const projectNumber = '251680231116';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_MANAGED_AGENTS_UNCONFIRMED'); };
/** Read-only direct policy prerequisites. Managed service-agent roles belong to
 * the exact Google-managed principals, never the application caller accounts.
 */
export async function verifyDispatchManagedAgents(platform, api, mode) {
  validateCloudRunReleasePlatform(platform);
  if (!['managed-only', 'dispatch-caller'].includes(mode) || typeof api !== 'function') fail();
  try {
    const policy = await api('https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:getIamPolicy',
      'POST', { options: { requestedPolicyVersion: 3 } });
    if (!policy || typeof policy.etag !== 'string' || !policy.etag || ![1, 3].includes(policy.version ?? 1) ||
      !Array.isArray(policy.bindings)) fail();
    const expected = ['eventarc', 'cloudscheduler', 'pubsub'].map(service => ({
      role: `roles/${service}.serviceAgent`,
      member: `serviceAccount:service-${projectNumber}@gcp-sa-${service}.iam.gserviceaccount.com`,
    }));
    if (mode === 'dispatch-caller') expected.push({ role: 'roles/eventarc.eventReceiver',
      member: `serviceAccount:${platform.dispatch.eventServiceAccount}` });
    for (const { role, member } of expected) {
      if (!policy.bindings.some(binding => binding?.role === role && binding.condition === undefined &&
        Array.isArray(binding.members) && binding.members.includes(member))) fail();
    }
    return { projectId: 'urm-app-staging', projectNumber, policySHA256: proofDigest(policy), mode,
      scope: 'required unconditional direct bindings only; no inherited isolation, effective permission or delivery proof' };
  } catch { return fail(); }
}
