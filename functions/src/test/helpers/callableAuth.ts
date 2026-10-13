import type { CallableRequest } from 'firebase-functions/v2/https';
export type AuthData = NonNullable<CallableRequest['auth']>;

/** A fully shaped authenticated caller for direct, mocked-onCall handler tests. */
export function testCallableAuth(role: string, uid = 'legacy-test-user'): AuthData {
  return {
    uid,
    rawToken: 'synthetic-handler-test-token',
    token: {
      uid,
      sub: uid,
      aud: 'urm-app',
      iss: 'https://securetoken.google.com/urm-app',
      iat: 1,
      exp: 9999999999,
      auth_time: 1,
      firebase: { identities: {}, sign_in_provider: 'custom' },
      role,
    },
  };
}
