import { GoogleAuth } from 'google-auth-library';

export const ACCOUNT_CLAIMS_TRANSPORT = 'single_shot_identity_toolkit' as const;
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

const REJECTION_STATUSES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
};
export class AccountTransportRejectedError extends Error {
  constructor(public readonly rejectionCode: string) {
    super('ACCOUNT_MUTATION_REJECTED');
  }
}
export const isConfirmedAccountTransportRejection = (error: unknown): error is AccountTransportRejectedError =>
  error instanceof AccountTransportRejectedError;
const supportsRejectionProof = (endpoint: string) => {
  const url = new URL(endpoint);
  return (
    (url.protocol === 'https:' && url.hostname === 'identitytoolkit.googleapis.com') ||
    (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  );
};

/** Supported Identity Toolkit REST API. One POST; no mutation retry or redirect replay. */
function createSingleShotAccountUpdateTransport(options: {
  getAccessToken: () => Promise<string>;
  endpoint?: string;
  timeoutMs?: number;
}) {
  return async (
    projectId: string,
    uid: string,
    fields: Record<string, unknown>,
    beforeSend?: () => Promise<void>
  ): Promise<void> => {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !uid || uid.length > 128)
      throw new Error('ACCOUNT_CLAIMS_TRANSPORT_INVALID_TARGET');
    const token = await options.getAccessToken();
    if (!token) throw new Error('ACCOUNT_CLAIMS_TRANSPORT_CREDENTIAL_UNAVAILABLE');
    await beforeSend?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(
        `${options.endpoint ?? 'https://identitytoolkit.googleapis.com'}/v1/projects/${encodeURIComponent(
          projectId
        )}/accounts:update`,
        {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ localId: uid, ...fields }),
        }
      );
      // Consume the response before drain confirmation, while never exposing Auth
      // response bodies/credentials to logs, Firestore errors, or Workflow history.
      const bytes = await response.arrayBuffer();
      if (!response.ok) {
        const expected = REJECTION_STATUSES[response.status];
        if (expected && supportsRejectionProof(options.endpoint ?? 'https://identitytoolkit.googleapis.com')) {
          let structured: { error?: { code?: unknown; status?: unknown } } | undefined;
          try {
            structured = JSON.parse(Buffer.from(bytes).toString('utf8'));
          } catch {
            /* unknown */
          }
          if (structured?.error?.code === response.status && structured.error.status === expected)
            throw new AccountTransportRejectedError(expected);
        }
        throw new Error('ACCOUNT_CLAIMS_TRANSPORT_RESPONSE_UNCONFIRMED');
      }
    } catch (error) {
      if (isConfirmedAccountTransportRejection(error)) throw error;
      // Even a timeout/connection loss may have committed. The resource owner
      // remains started; reconciliation is required before another mutation.
      throw new Error('ACCOUNT_CLAIMS_TRANSPORT_RESULT_UNKNOWN');
    } finally {
      clearTimeout(timer);
    }
  };
}

const productionAccountTransport = createSingleShotAccountUpdateTransport({
  getAccessToken: async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('ACCOUNT_CLAIMS_TRANSPORT_CREDENTIAL_UNAVAILABLE');
    return token;
  },
});

/** Follow the documented Auth emulator route without ever falling through to production. */
async function updateAccountSingleShot(
  projectId: string,
  uid: string,
  fields: Record<string, unknown>,
  beforeSend?: () => Promise<void>
): Promise<void> {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) {
    if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(emulatorHost))
      throw new Error('ACCOUNT_CLAIMS_TRANSPORT_INVALID_EMULATOR_HOST');
    return createSingleShotAccountUpdateTransport({
      endpoint: `http://${emulatorHost}/identitytoolkit.googleapis.com`,
      getAccessToken: async () => 'owner',
    })(projectId, uid, fields, beforeSend);
  }
  return productionAccountTransport(projectId, uid, fields, beforeSend);
}

const RESERVED_CLAIMS = new Set([
  'acr',
  'amr',
  'at_hash',
  'aud',
  'auth_time',
  'azp',
  'cnf',
  'c_hash',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'nonce',
  'sub',
  'firebase',
]);
/** Validate the complete frozen payload, including our acknowledgement marker, before reservation. */
export function validateFrozenAccountClaims(claims: Record<string, unknown>): string {
  if (Object.keys(claims).some((key) => RESERVED_CLAIMS.has(key))) throw new Error('ACCOUNT_CLAIMS_RESERVED_KEY');
  const serialized = JSON.stringify(claims);
  if (Buffer.byteLength(serialized, 'utf8') > 1000) throw new Error('ACCOUNT_CLAIMS_PAYLOAD_TOO_LARGE');
  return serialized;
}
export function createSingleShotClaimsTransport(options: Parameters<typeof createSingleShotAccountUpdateTransport>[0]) {
  const send = createSingleShotAccountUpdateTransport(options);
  return (projectId: string, uid: string, claims: Record<string, unknown>, beforeSend?: () => Promise<void>) =>
    send(projectId, uid, { customAttributes: validateFrozenAccountClaims(claims) }, beforeSend);
}
export function createSingleShotSessionTransport(
  options: Parameters<typeof createSingleShotAccountUpdateTransport>[0]
) {
  const send = createSingleShotAccountUpdateTransport(options);
  return (
    projectId: string,
    uid: string,
    cutoffSeconds: string,
    claims: Record<string, unknown>,
    beforeSend?: () => Promise<void>
  ) => {
    if (!/^[0-9]{1,12}$/.test(cutoffSeconds)) throw new Error('ACCOUNT_SESSION_CUTOFF_INVALID');
    return send(
      projectId,
      uid,
      { validSince: cutoffSeconds, customAttributes: validateFrozenAccountClaims(claims) },
      beforeSend
    );
  };
}
export const setAccountClaimsSingleShot = (
  projectId: string,
  uid: string,
  claims: Record<string, unknown>,
  beforeSend?: () => Promise<void>
) => updateAccountSingleShot(projectId, uid, { customAttributes: validateFrozenAccountClaims(claims) }, beforeSend);
export const revokeAccountSessionsSingleShot = (
  projectId: string,
  uid: string,
  cutoffSeconds: string,
  claims: Record<string, unknown>,
  beforeSend?: () => Promise<void>
) => {
  if (!/^[0-9]{1,12}$/.test(cutoffSeconds)) throw new Error('ACCOUNT_SESSION_CUTOFF_INVALID');
  return updateAccountSingleShot(
    projectId,
    uid,
    { validSince: cutoffSeconds, customAttributes: validateFrozenAccountClaims(claims) },
    beforeSend
  );
};
