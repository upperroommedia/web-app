const markerGet = jest.fn();
const actorGet = jest.fn();
const inspect = jest.fn();
jest.mock('./service', () => ({ inspectSandboxJob: (...args: unknown[]) => inspect(...args) }));
const resolveProfile = jest.fn();
const assertCatalog = jest.fn();
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (handler: unknown) => handler,
  HttpsError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: () => ({ getUser: actorGet }), firestore: () => ({ doc: () => ({ get: markerGet }) }) },
}));
jest.mock('./profile', () => ({
  getProviderExecutionProfile: () => resolveProfile(),
  assertSandboxCatalogReady: (...args: unknown[]) => assertCatalog(...args),
  sandboxProfileDocumentPath: () => '_providerSandbox/urm-app-staging-publishing-v1',
}));
import { getProviderSandboxStatus, inspectProviderSandboxJob } from './admin';
const invoke = getProviderSandboxStatus as unknown as (request: {
  auth?: { uid: string; token: { role: string } };
  data: unknown;
}) => Promise<unknown>;
const request = (role = 'admin') => ({ auth: { uid: 'test-actor', token: { role } }, data: { mode: 'live' } });
describe('safe server provider status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    actorGet.mockResolvedValue({ disabled: false, customClaims: { role: 'admin' } });
    resolveProfile.mockReturnValue({ mode: 'sandbox', profileId: 'urm-app-staging-publishing-v1', version: 1 });
    markerGet.mockResolvedValue({ data: () => ({ state: 'ready', privateSecret: 'never-return' }) });
    assertCatalog.mockImplementation(() => {});
  });
  it('requires upload permission before reading profile or catalog', async () => {
    await expect(invoke({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(invoke(request('user'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(markerGet).not.toHaveBeenCalled();
  });
  it('ignores browser mode and returns only safe authoritative fields', async () => {
    const status = await invoke(request());
    expect(status).toEqual({
      mode: 'sandbox',
      ready: true,
      catalogReady: true,
      profileId: 'urm-app-staging-publishing-v1',
      version: 1,
      scenarioSelectionAllowed: true,
    });
    expect(JSON.stringify(status)).not.toContain('never-return');
    expect((await invoke(request('publisher'))) as object).toMatchObject({ scenarioSelectionAllowed: false });
  });
  it('does not claim ready when actual catalog validation or configuration fails', async () => {
    assertCatalog.mockImplementation(() => {
      throw new Error('private cause');
    });
    expect(await invoke(request())).toEqual({
      mode: 'blocked',
      ready: false,
      catalogReady: false,
      scenarioSelectionAllowed: false,
      reason: 'catalog-not-ready',
    });
    resolveProfile.mockImplementation(() => {
      throw new Error('private config');
    });
    expect(await invoke(request())).toMatchObject({ mode: 'blocked', reason: 'configuration-unavailable' });
  });
  it('never reads the sandbox catalog or enables scenarios for live production', async () => {
    resolveProfile.mockReturnValue({ mode: 'live' });
    expect(await invoke(request())).toEqual({
      mode: 'live',
      ready: true,
      catalogReady: false,
      scenarioSelectionAllowed: false,
    });
    expect(markerGet).not.toHaveBeenCalled();
  });
});

const inspectInvoke = inspectProviderSandboxJob as unknown as (request: {
  auth?: { uid: string; token: { role: string } };
  data: unknown;
}) => Promise<unknown>;
describe('current-admin inspector boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    actorGet.mockResolvedValue({ disabled: false, customClaims: { role: 'admin' } });
    resolveProfile.mockReturnValue({ mode: 'sandbox', profileId: 'urm-app-staging-publishing-v1', version: 1 });
    assertCatalog.mockImplementation(() => {});
    markerGet.mockResolvedValue({ data: () => ({ state: 'ready' }) });
  });
  it('denies revoked or disabled administrators before reading provider data', async () => {
    await expect(inspectInvoke({ data: { jobId: 'job-test' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    for (const actor of [
      { disabled: false, customClaims: { role: 'uploader' } },
      { disabled: true, customClaims: { role: 'admin' } },
    ]) {
      actorGet.mockResolvedValue(actor);
      await expect(inspectInvoke({ ...request(), data: { jobId: 'job-test' } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }
    expect(inspect).not.toHaveBeenCalled();
  });
  it('rejects arbitrary paths and profile overrides, and never falls back to live', async () => {
    for (const data of [{ jobId: 'bad/path' }, { jobId: 'job-test', profileId: 'other' }, { jobId: '' }])
      await expect(inspectInvoke({ ...request(), data })).rejects.toMatchObject({ code: 'invalid-argument' });
    resolveProfile.mockReturnValue({ mode: 'live' });
    await expect(inspectInvoke({ ...request(), data: { jobId: 'job-test' } })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(inspect).not.toHaveBeenCalled();
  });
  it('projects only bounded engine summaries without body/URLs or automatic approval', async () => {
    const resource = {
      provider: 'soundcloud',
      family: 'tracks',
      id: 'virtual-track',
      deleted: false,
      title: 'https://private.example',
      body: { access_token: 'never-public' },
      downloadUrl: 'https://private.example',
    };
    inspect.mockResolvedValue({
      profileId: 'urm-app-staging-publishing-v1',
      jobId: 'job-test',
      providerExecution: {
        mode: 'sandbox',
        profileId: 'urm-app-staging-publishing-v1',
        version: 1,
        scenario: 'success',
      },
      requests: [
        {
          provider: 'soundcloud',
          method: 'POST',
          atMillis: 1,
          outcome: 'committed-response-lost',
          fault: 'success',
          resourceRefs: [resource],
          path: '/private',
        },
      ],
      resources: [resource],
      truncated: { requests: false, resources: false },
      privateCredential: 'never-public',
    });
    const result = await inspectInvoke({ ...request(), data: { jobId: 'job-test' } });
    expect(result).toMatchObject({ jobId: 'job-test', resources: [{ id: 'virtual-track', deleted: false }] });
    expect(JSON.stringify(result)).not.toMatch(/never-public|https:|privateCredential|downloadUrl|\"path\"/);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ mode: 'sandbox' }), 'job-test');
  });
});
