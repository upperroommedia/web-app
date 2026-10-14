/** Server-only onboarding authority. Schema hash is synchronized from staging-search.json. */
export const STAGING_SEARCH_PROJECT_ID = 'urm-app-staging';
export const STAGING_SEARCH_APPLICATION_ID = '2VZFOFLFHE';
export const STAGING_SEARCH_SCHEMA_SHA256 = '4fb46413685e5bc7cf5d5170ca98263804c14317e984e89a04a7e752cfeb1b52';
export const STAGING_SEARCH_READINESS_PATH = '_control/temporalSearchReadiness';
export interface StagingSearchReadiness {
  schemaVersion: 1;
  projectId: string;
  appId: string;
  recordSchemaSha256: string;
  releaseId: string;
  compatibilityCommit: string;
  controlRevision: number;
  jobIds: string[];
  generations: number[];
  counts: number[];
  settingsReceiptCanonicalSha256: string;
}
/** Private marker survives later non-search releases; browsers cannot author it. */
export function validateStagingSearchReadiness(
  control: unknown,
  marker: unknown
): asserts marker is StagingSearchReadiness {
  const c = control as {
    schemaVersion?: unknown;
    revision?: unknown;
    domains?: { search?: { owner?: unknown } };
  } | null;
  const m = marker as StagingSearchReadiness | null;
  const keys = [
    'schemaVersion',
    'projectId',
    'appId',
    'recordSchemaSha256',
    'releaseId',
    'compatibilityCommit',
    'controlRevision',
    'jobIds',
    'generations',
    'counts',
    'settingsReceiptCanonicalSha256',
  ];
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !Number.isSafeInteger(c.revision) ||
    (c.revision as number) < 1 ||
    c.domains?.search?.owner !== 'temporal' ||
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).length !== keys.length ||
    Object.keys(m).some((k) => !keys.includes(k)) ||
    m.schemaVersion !== 1 ||
    m.projectId !== STAGING_SEARCH_PROJECT_ID ||
    m.appId !== STAGING_SEARCH_APPLICATION_ID ||
    m.recordSchemaSha256 !== STAGING_SEARCH_SCHEMA_SHA256 ||
    typeof m.releaseId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(m.releaseId) ||
    typeof m.compatibilityCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(m.compatibilityCommit) ||
    !Number.isSafeInteger(m.controlRevision) ||
    m.controlRevision < 1 ||
    m.controlRevision > (c.revision as number) ||
    !Array.isArray(m.jobIds) ||
    m.jobIds.length !== 5 ||
    new Set(m.jobIds).size !== 5 ||
    m.jobIds.some((id) => typeof id !== 'string' || !/^job-[a-f0-9]{48}$/.test(id)) ||
    !Array.isArray(m.generations) ||
    m.generations.length !== 5 ||
    m.generations.some((g) => !Number.isSafeInteger(g) || g < 1) ||
    !Array.isArray(m.counts) ||
    m.counts.length !== 5 ||
    m.counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    typeof m.settingsReceiptCanonicalSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(m.settingsReceiptCanonicalSha256)
  )
    throw new Error('Staging search has not completed its reviewed bootstrap');
}
