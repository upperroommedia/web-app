import { beforeUserCreated, beforeUserSignedIn } from 'firebase-functions/v2/identity';
import './setUserRoleOnCreate';

jest.mock('firebase-functions/v2/identity', () => ({
  beforeUserCreated: jest.fn((handler) => ({ run: handler })),
  beforeUserSignedIn: jest.fn((handler) => ({ run: handler })),
}));

type IdentityEvent = { data: { uid: string; email: string; emailVerified?: boolean } };
type IdentityHandler = (event: IdentityEvent) => unknown;
// The SDK's final overload is (options, handler); these registrations use (handler).
const createHandler = jest.mocked(beforeUserCreated).mock.calls[0][0] as unknown as IdentityHandler;
const signInHandler = jest.mocked(beforeUserSignedIn).mock.calls[0][0] as unknown as IdentityHandler;
const event = (email: string, emailVerified?: boolean): IdentityEvent =>
  ({ data: { uid: 'identity-test-user', email, emailVerified } });

describe('staging administrator identity bootstrap', () => {
  const originalProject = process.env.GCLOUD_PROJECT;
  const originalAllowlist = process.env.ALWAYS_ADMIN_EMAILS;
  beforeEach(() => {
    process.env.GCLOUD_PROJECT = 'urm-app-staging';
    process.env.ALWAYS_ADMIN_EMAILS = 'verified-admin@example.test';
  });
  afterAll(() => {
    if (originalProject === undefined) delete process.env.GCLOUD_PROJECT;
    else process.env.GCLOUD_PROJECT = originalProject;
    if (originalAllowlist === undefined) delete process.env.ALWAYS_ADMIN_EMAILS;
    else process.env.ALWAYS_ADMIN_EMAILS = originalAllowlist;
  });

  it.each([false, undefined])('never grants an allowlisted unverified registration admin (%s)', async (verified) => {
    expect(await createHandler(event('verified-admin@example.test', verified))).toEqual({
      customClaims: { role: 'user' },
    });
  });

  it('grants the verified allowlisted identity after verification', async () => {
    expect(await signInHandler(event(' VERIFIED-ADMIN@example.test ', true))).toEqual({
      customClaims: { role: 'admin' },
    });
    expect(await createHandler(event('verified-admin@example.test', true))).toEqual({
      customClaims: { role: 'admin' },
    });
  });

  it('removes a formerly bootstrapped privilege when the allowlisted identity is unverified', async () => {
    expect(await signInHandler(event('verified-admin@example.test', false))).toEqual({
      customClaims: { role: 'user' },
    });
  });

  it('preserves independently managed claims for other identities', async () => {
    expect(await signInHandler(event('another-user@example.test', true))).toBeUndefined();
    expect(await createHandler(event('another-user@example.test', true))).toEqual({
      customClaims: { role: 'user' },
    });
  });

  it('does not bootstrap allowlisted staging administrators in production', async () => {
    process.env.GCLOUD_PROJECT = 'urm-app';
    expect(await signInHandler(event('verified-admin@example.test', true))).toBeUndefined();
    expect(await createHandler(event('verified-admin@example.test', true))).toEqual({
      customClaims: { role: 'user' },
    });
  });
});
