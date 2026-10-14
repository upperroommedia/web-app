const mockProject = { value: 'urm-app-staging' };
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: mockProject.value } }) },
}));
import {
  resolveProviderExecutionProfile,
  getProviderExecutionProfile,
  STAGING_SANDBOX_PROFILE,
  assertSandboxIntentProfile,
  assertSandboxCatalogReady,
} from './profile';
import { prepareProviderAdmission, isSandboxProviderIntent } from './admission';
describe('authoritative staging provider profile', () => {
  beforeEach(() => {
    mockProject.value = 'urm-app-staging';
    process.env.STAGING_PROVIDER_MODE = 'sandbox';
  });
  afterAll(() => {
    delete process.env.STAGING_PROVIDER_MODE;
  });
  test('exact actual staging project and explicit server mode are required', () => {
    expect(getProviderExecutionProfile()).toEqual(STAGING_SANDBOX_PROFILE);
    expect(() => getProviderExecutionProfile('urm-app')).toThrow('PROJECT_MISMATCH');
    for (const mode of [undefined, 'live', 'true', 'SANDBOX'])
      expect(() => resolveProviderExecutionProfile('urm-app-staging', { STAGING_PROVIDER_MODE: mode })).toThrow();
    expect(() => resolveProviderExecutionProfile('other', { STAGING_PROVIDER_MODE: 'sandbox' })).toThrow();
    expect(resolveProviderExecutionProfile('urm-app', {}).mode).toBe('live');
    expect(() => resolveProviderExecutionProfile('urm-app', { STAGING_PROVIDER_MODE: '' })).toThrow();
    expect(() => resolveProviderExecutionProfile('urm-app', { STAGING_PROVIDER_MODE: 'sandbox' })).toThrow('FORBIDDEN');
  });
  test('new private intents require exact immutable profile and recognized scenario', () => {
    const pin = { mode: 'sandbox', profileId: STAGING_SANDBOX_PROFILE.profileId, version: 1, scenario: 'success' };
    expect(
      assertSandboxIntentProfile(STAGING_SANDBOX_PROFILE, {
        projectId: 'urm-app-staging',
        payload: { providerExecution: pin },
      })
    ).toEqual(pin);
    for (const value of [
      undefined,
      { ...pin, profileId: 'foreign' },
      { ...pin, version: 2 },
      { ...pin, scenario: 'unknown' },
    ])
      expect(() =>
        assertSandboxIntentProfile(STAGING_SANDBOX_PROFILE, { payload: { providerExecution: value } })
      ).toThrow('PROFILE_MISMATCH');
    expect(() =>
      assertSandboxIntentProfile(STAGING_SANDBOX_PROFILE, { projectId: 'urm-app', providerExecution: pin })
    ).toThrow();
  });
  test('catalog marker certifies only same private profile and completed virtual import', () => {
    const marker = {
      state: 'ready',
      profile: STAGING_SANDBOX_PROFILE,
      catalogImportId: 'import',
      sourceDigest: 'a'.repeat(64),
      resourceCount: 3,
    };
    expect(() => assertSandboxCatalogReady(STAGING_SANDBOX_PROFILE, marker)).not.toThrow();
    for (const patch of [
      { state: 'building' },
      { sourceDigest: '' },
      { catalogImportId: null },
      { catalogImportId: '' },
      { profile: { ...STAGING_SANDBOX_PROFILE, projectId: 'urm-app' } },
      { profile: { ...STAGING_SANDBOX_PROFILE, namespace: 'foreign' } },
      { profile: { ...STAGING_SANDBOX_PROFILE, schemaVersion: 2 } },
      { resourceCount: -1 },
      { profile: { ...STAGING_SANDBOX_PROFILE, profileId: 'other' } },
    ])
      expect(() => assertSandboxCatalogReady(STAGING_SANDBOX_PROFILE, { ...marker, ...patch })).toThrow();
  });
  test('only administrators can select scenarios, while publishers get server defaultsuccess', () => {
    expect(
      prepareProviderAdmission('urm-app-staging', 'sermon.publish', {}, 'publisher', undefined)?.execution.scenario
    ).toBe('success');
    expect(
      prepareProviderAdmission('urm-app-staging', 'sermon.publish', {}, 'admin', 'commit-then-lost-response')?.execution
        .scenario
    ).toBe('commit-then-lost-response');
    expect(() => prepareProviderAdmission('urm-app-staging', 'sermon.publish', {}, 'publisher', 'success')).toThrow();
    expect(() => prepareProviderAdmission('urm-app-staging', 'sermon.publish', {}, 'admin', 'bad')).toThrow();
    expect(() => prepareProviderAdmission('urm-app', 'sermon.publish', {}, 'admin', 'success')).toThrow();
    expect(prepareProviderAdmission('urm-app', 'sermon.publish', {}, 'admin', undefined)).toBeUndefined();
  });
  test('media/email/search/bundle and unrelated accounts are unaffected; image and accepted speaker routes are enrolled', () => {
    for (const kind of ['audio.process', 'email.deliver', 'search.sync', 'bundle.regenerate', 'role.resolve'] as const)
      expect(isSandboxProviderIntent(kind, {})).toBe(false);
    expect(isSandboxProviderIntent('speaker.resolve', { action: 'speaker-accept' })).toBe(true);
    expect(isSandboxProviderIntent('speaker.resolve', { action: 'speaker-deny' })).toBe(false);
    expect(isSandboxProviderIntent('image.ingest', {})).toBe(true);
  });
});
