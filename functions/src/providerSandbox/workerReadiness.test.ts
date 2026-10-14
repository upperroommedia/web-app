let mockProject = 'urm-app-staging';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: mockProject } }) },
}));
import { verifyProviderSandboxReadiness } from '../../../apps/temporal-worker/src/runtime/provider-sandbox-readiness';
import { STAGING_SANDBOX_PROFILE } from './profile';
const pin = { mode: 'sandbox', profileId: STAGING_SANDBOX_PROFILE.profileId, version: 1, scenario: 'success' };
let marker: any, jobs: any[], intent: any, queries: number;
const db: any = {
  doc: (path: string) => ({ path }),
  collection: (path: string) => ({
    where: (_field: string, _op: string, states: string[]) => ({
      limit: (limit: number) => ({ query: true, states, limit }),
    }),
    doc: (id: string) => ({ path: `${path}/${id}` }),
  }),
  runTransaction: async (run: (tx: any) => Promise<void>, options: any) => {
    expect(options).toEqual({ readOnly: true });
    return run({
      get: async (ref: any) => {
        if (ref.query) {
          queries++;
          expect(ref.limit).toBe(1001);
          expect(ref.states).toContain('needs_attention');
          return { size: jobs.length, docs: jobs.map((data) => ({ id: data.jobId, data: () => data })) };
        }
        if (ref.path.startsWith('durableJobIntents/')) return { data: () => intent };
        return { data: () => marker };
      },
    });
  },
};
beforeEach(() => {
  mockProject = 'urm-app-staging';
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  queries = 0;
  marker = {
    state: 'ready',
    profile: STAGING_SANDBOX_PROFILE,
    catalogImportId: 'import',
    sourceDigest: 'a'.repeat(64),
    resourceCount: 2,
  };
  jobs = [
    { jobId: 'job', kind: 'sermon.publish', projectId: mockProject, generation: 1, providerExecution: { ...pin } },
  ];
  intent = {
    jobId: 'job',
    kind: 'sermon.publish',
    projectId: mockProject,
    generation: 1,
    payload: { providerExecution: { ...pin } },
  };
});
afterEach(() => {
  delete process.env.STAGING_PROVIDER_MODE;
});
test.each(['urm-orchestration', 'urm-controls', 'urm-images'])(
  'provider role %s verifies catalog and actual private/public pins at startup',
  async (role) => {
    await expect(verifyProviderSandboxReadiness(db, mockProject, [role], true)).resolves.toEqual({
      mode: 'sandbox',
      profileId: pin.profileId,
      ready: true,
    });
    expect(queries).toBe(1);
  }
);
test.each(['urm-media', 'urm-email', 'urm-search'])(
  'unrelated role %s does not require publishing simulation or read Firestore',
  async (role) => {
    delete process.env.STAGING_PROVIDER_MODE;
    await expect(verifyProviderSandboxReadiness(db, mockProject, [role], true)).resolves.toBeUndefined();
    expect(queries).toBe(0);
  }
);
test('production stays unchanged', async () => {
  mockProject = 'urm-app';
  delete process.env.STAGING_PROVIDER_MODE;
  await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).resolves.toBeUndefined();
  expect(queries).toBe(0);
});
test('a missing selected stage mode fails before worker creation', async () => {
  delete process.env.STAGING_PROVIDER_MODE;
  await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).rejects.toThrow(
    'PROFILE_NOT_CONFIGURED'
  );
});
test.each([
  undefined,
  { state: 'building' },
  { state: 'ready', profile: { ...STAGING_SANDBOX_PROFILE, profileId: 'foreign' } },
])('unready marker rejects startup', async (value) => {
  marker = value;
  await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).rejects.toThrow();
});
test.each(['missing-private-pin', 'missing-public-pin', 'scenario-mismatch', 'generation-mismatch', 'foreign-project'])(
  'unprofiled active job boundary %s rejects startup',
  async (boundary) => {
    if (boundary === 'missing-private-pin') delete intent.payload.providerExecution;
    if (boundary === 'missing-public-pin') delete jobs[0].providerExecution;
    if (boundary === 'scenario-mismatch') jobs[0].providerExecution.scenario = 'permanent-failure';
    if (boundary === 'generation-mismatch') intent.generation = 2;
    if (boundary === 'foreign-project') intent.projectId = 'urm-app';
    await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).rejects.toThrow();
  }
);
test('startup scan is explicitly bounded', async () => {
  jobs = Array(1001).fill(jobs[0]);
  await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).rejects.toThrow('JOB_BOUND');
});

test('a claimed production project cannot bypass the actual staging startup gate', async () => {
  await expect(verifyProviderSandboxReadiness(db, 'urm-app', ['urm-controls'], true)).rejects.toThrow(
    'PROJECT_MISMATCH'
  );
});
test.each(['projectId', 'namespace', 'schemaVersion'])(
  'full catalog profile field %s is authoritative',
  async (field) => {
    marker.profile = { ...STAGING_SANDBOX_PROFILE, [field]: field === 'schemaVersion' ? 2 : 'foreign' };
    await expect(verifyProviderSandboxReadiness(db, mockProject, ['urm-controls'], true)).rejects.toThrow();
  }
);
