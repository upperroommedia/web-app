import type { ProviderSimulationScenario, DurableJob } from '@upperroom/contracts/temporal';
import type { ProviderSandboxStatus } from '@upperroom/contracts/providerSandbox';

export const SIMULATION_SCENARIO_LABELS: Record<ProviderSimulationScenario, string> = {
  success: 'Successful request',
  'delayed-processing': 'Slow processing',
  'transient-failure': 'Temporary failure',
  'permanent-failure': 'Permanent failure',
  'commit-then-lost-response': 'Confirmation lost after saving',
};

export function isProviderSandboxStatus(value: unknown): value is ProviderSandboxStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.mode === 'live') return v.ready === true && v.catalogReady === false && v.scenarioSelectionAllowed === false;
  if (v.mode === 'blocked')
    return (
      v.ready === false &&
      v.catalogReady === false &&
      v.scenarioSelectionAllowed === false &&
      (v.reason === 'configuration-unavailable' || v.reason === 'catalog-not-ready')
    );
  return (
    v.mode === 'sandbox' &&
    v.ready === true &&
    v.catalogReady === true &&
    v.version === 1 &&
    v.profileId === 'urm-app-staging-publishing-v1' &&
    typeof v.scenarioSelectionAllowed === 'boolean'
  );
}

export const stagingPasswordResetMessage = (projectId: string): string | undefined =>
  projectId === 'urm-app-staging'
    ? 'Password reset is unavailable on staging. Use your test account or contact an administrator.'
    : undefined;

/** Reject malformed/oversized inspector responses before rendering time or identity fields. */
export function isProviderSandboxJobInspection(
  value: unknown
): value is import('@upperroom/contracts/providerSandbox').ProviderSandboxJobInspection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, any>;
  const timestamp = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 8_640_000_000_000_000;
  const resource = (r: any) =>
    r &&
    ['subsplash', 'soundcloud'].includes(r.provider) &&
    typeof r.family === 'string' &&
    r.family.length <= 128 &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    r.id.length <= 256 &&
    !/[\s/?#]/.test(r.id) &&
    typeof r.deleted === 'boolean' &&
    (r.title === undefined ||
      (typeof r.title === 'string' && r.title.length <= 128 && !/(?:https?|gs):\/\/|www\./i.test(r.title))) &&
    (r.readyAtMillis === undefined || timestamp(r.readyAtMillis));
  if (
    v.profileId !== 'urm-app-staging-publishing-v1' ||
    typeof v.jobId !== 'string' ||
    !timestamp(v.observedAtMillis) ||
    v.providerExecution?.mode !== 'sandbox' ||
    v.providerExecution?.profileId !== v.profileId ||
    v.providerExecution?.version !== 1 ||
    !Object.hasOwn(SIMULATION_SCENARIO_LABELS, v.providerExecution?.scenario) ||
    !Array.isArray(v.requests) ||
    v.requests.length > 100 ||
    !Array.isArray(v.resources) ||
    v.resources.length > 200 ||
    typeof v.truncated?.requests !== 'boolean' ||
    typeof v.truncated?.resources !== 'boolean'
  )
    return false;
  let refs = 0;
  return (
    v.resources.every(resource) &&
    v.requests.every((r: any) => {
      if (
        !r ||
        !['subsplash', 'soundcloud'].includes(r.provider) ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) ||
        !['acknowledged', 'rejected-before-effect', 'committed-response-lost'].includes(r.outcome) ||
        !Object.hasOwn(SIMULATION_SCENARIO_LABELS, r.fault) ||
        !timestamp(r.atMillis) ||
        !Array.isArray(r.resourceRefs)
      )
        return false;
      refs += r.resourceRefs.length;
      return refs <= 200 && r.resourceRefs.every(resource);
    })
  );
}

/** Profile evidence can say external delivery is disabled without claiming a completed capture. */
export function hasStagingEmailCaptureProfile(job: DurableJob): boolean {
  const transport = job.result?.deliveryTransport as Record<string, unknown> | undefined;
  return (
    job.kind === 'email.deliver' &&
    job.projectId === 'urm-app-staging' &&
    job.result?.externalDelivery === false &&
    transport?.schemaVersion === 1 &&
    transport.mode === 'capture' &&
    transport.projectId === 'urm-app-staging' &&
    transport.profileId === 'urm-app-staging-mail-capture-v1' &&
    transport.version === 1
  );
}
/** A capture claim requires a completed, server-recorded receipt, never current UI mode. */
export function hasConfirmedCapturedEmail(job: DurableJob): boolean {
  const transport = job.result?.deliveryTransport as Record<string, unknown> | undefined;
  return (
    hasStagingEmailCaptureProfile(job) &&
    job.state === 'succeeded' &&
    typeof transport?.captureId === 'string' &&
    /^[a-f0-9]{64}$/.test(transport.captureId) &&
    typeof transport.payloadSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(transport.payloadSha256)
  );
}
