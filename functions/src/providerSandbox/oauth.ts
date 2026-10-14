import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { withAdministrativeCredentialSetupLease } from '../temporal/legacyAdmissionLease';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  getProviderExecutionProfile,
  sandboxProfileDocumentPath,
  STAGING_SANDBOX_PROFILE,
  type SandboxProviderProfile,
} from './profile';
import { SandboxHttpError } from './types';

export const SANDBOX_SOUNDCLOUD_USER_ID = 9000000000001;
export const SANDBOX_SOUNDCLOUD_ORIGIN = 'https://staging.uploader.upperroommedia.org';
const CALLBACK = `${SANDBOX_SOUNDCLOUD_ORIGIN}/auth/soundcloud/callback`;
const ACCESS_SECONDS = 3600;
const REFRESH_MILLIS = 30 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
const opaque = (kind: string) => `sandbox-sc-${kind}-${randomBytes(32).toString('base64url')}`;
function reject(): never {
  throw new SandboxHttpError(401, 'Invalid or expired sandbox OAuth grant', 'invalid_grant');
}
const equal = (a: unknown, b: string): boolean =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function assertProfile(profile: SandboxProviderProfile): void {
  if (
    !isDeepStrictEqual(profile, STAGING_SANDBOX_PROFILE) ||
    !isDeepStrictEqual(getProviderExecutionProfile(), STAGING_SANDBOX_PROFILE)
  )
    throw new SandboxHttpError(403, 'Sandbox OAuth requires the selected staging profile');
}
const validState = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
const validChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validVerifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
const validUid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
const nativeNow = (snapshot: DocumentSnapshot): Timestamp => {
  if (!(snapshot.readTime instanceof Timestamp)) reject();
  return snapshot.readTime;
};
function liveRecord(snapshot: DocumentSnapshot, profile: SandboxProviderProfile, kind: string): Record<string, any> {
  const value = snapshot.data();
  const now = nativeNow(snapshot);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.profileId !== profile.profileId ||
    value.kind !== kind ||
    !(value.expiresAt instanceof Timestamp) ||
    value.expiresAt.toMillis() <= now.toMillis() ||
    value.consumedAt !== undefined ||
    value.revokedAt !== undefined ||
    !validUid(value.adminUid)
  )
    reject();
  return value;
}
function validatePending(
  snapshot: DocumentSnapshot,
  input: { adminUid: string; state: string; redirectUri: string; codeChallenge: string }
): Record<string, any> {
  const pending = snapshot.data();
  const now = nativeNow(snapshot);
  if (
    !pending ||
    pending.state !== input.state ||
    pending.redirectUri !== input.redirectUri ||
    (pending.adminUid !== undefined && pending.adminUid !== input.adminUid) ||
    !validVerifier(pending.codeVerifier) ||
    !equal(challenge(pending.codeVerifier), input.codeChallenge) ||
    !Number.isSafeInteger(pending.createdAtMillis) ||
    !Number.isSafeInteger(pending.expiresAtMillis) ||
    pending.expiresAtMillis <= pending.createdAtMillis ||
    pending.expiresAtMillis - pending.createdAtMillis > 15 * 60_000 ||
    Timestamp.fromMillis(pending.expiresAtMillis).toMillis() <= now.toMillis() ||
    (pending.expiresAt !== undefined &&
      (!(pending.expiresAt instanceof Timestamp) || pending.expiresAt.toMillis() !== pending.expiresAtMillis))
  )
    reject();
  return pending;
}
export function getSandboxOAuthConfiguration(profile: SandboxProviderProfile): {
  clientId: string;
  clientSecret: string;
} {
  assertProfile(profile);
  return { clientId: 'urm-app-staging-sandbox-soundcloud', clientSecret: 'synthetic-stage-only-soundcloud-client-v1' };
}
export function sandboxSoundCloudAuthDocumentPath(profile: SandboxProviderProfile): string {
  assertProfile(profile);
  return `${sandboxProfileDocumentPath(profile)}/auth/soundcloud`;
}
export function buildSandboxSoundCloudAuthorizeUrl(
  profile: SandboxProviderProfile,
  input: { redirectUri: string; state: string; codeChallenge: string; clientId: string }
): string {
  const configuration = getSandboxOAuthConfiguration(profile);
  if (
    input.redirectUri !== CALLBACK ||
    !validState(input.state) ||
    !validChallenge(input.codeChallenge) ||
    input.clientId !== configuration.clientId
  )
    reject();
  const url = new URL('/auth/soundcloud/sandbox', SANDBOX_SOUNDCLOUD_ORIGIN);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}
export async function issueSandboxSoundCloudAuthorizationCode(
  profile: SandboxProviderProfile,
  input: { adminUid: string; state: string; redirectUri: string; codeChallenge: string },
  beforeEffects: () => Promise<void> = async () => undefined
): Promise<{ code: string; redirectUri: string; state: string }> {
  assertProfile(profile);
  if (
    !validUid(input.adminUid) ||
    !validState(input.state) ||
    !validChallenge(input.codeChallenge) ||
    input.redirectUri !== CALLBACK
  )
    reject();
  const db = admin.firestore();
  const root = db.doc(sandboxSoundCloudAuthDocumentPath(profile));
  const code = opaque('code');
  await beforeEffects();
  await db.runTransaction(async (tx) => {
    const pendingRef = root.collection('pendingOAuthSessions').doc(input.adminUid);
    const pendingSnapshot = await tx.get(pendingRef);
    const pending = validatePending(pendingSnapshot, input);
    if (pending.sandboxAuthorizationCodeHash || pending.exchangeAttempt) reject();
    const now = nativeNow(pendingSnapshot);
    tx.create(root.collection('authorizationCodes').doc(hash(code)), {
      schemaVersion: 1,
      kind: 'authorization-code',
      profileId: profile.profileId,
      adminUid: input.adminUid,
      stateHash: hash(input.state),
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      clientId: getSandboxOAuthConfiguration(profile).clientId,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(Math.min(now.toMillis() + 5 * 60_000, pending.expiresAtMillis)),
    });
    tx.update(pendingRef, { sandboxAuthorizationCodeHash: hash(code) });
  });
  return { code, redirectUri: input.redirectUri, state: input.state };
}
export async function exchangeSandboxSoundCloudToken(
  profile: SandboxProviderProfile,
  payload: URLSearchParams
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const configuration = getSandboxOAuthConfiguration(profile);
  if (
    !(payload instanceof URLSearchParams) ||
    !equal(payload.get('client_id'), configuration.clientId) ||
    !equal(payload.get('client_secret'), configuration.clientSecret)
  )
    reject();
  const grant = payload.get('grant_type');
  const required =
    grant === 'authorization_code'
      ? ['grant_type', 'client_id', 'client_secret', 'redirect_uri', 'code_verifier', 'code']
      : grant === 'refresh_token'
      ? ['grant_type', 'client_id', 'client_secret', 'refresh_token']
      : [];
  if (
    !required.length ||
    [...payload.keys()].length !== required.length ||
    required.some((key) => payload.getAll(key).length !== 1)
  )
    reject();
  const rawGrant = payload.get(grant === 'authorization_code' ? 'code' : 'refresh_token');
  if (
    !rawGrant ||
    !new RegExp(`^sandbox-sc-${grant === 'authorization_code' ? 'code' : 'refresh'}-[A-Za-z0-9_-]{43}$`).test(rawGrant)
  )
    reject();
  if (
    grant === 'authorization_code' &&
    (payload.get('redirect_uri') !== CALLBACK || !validVerifier(payload.get('code_verifier')))
  )
    reject();
  const accessToken = opaque('access'),
    refreshToken = opaque('refresh');
  const db = admin.firestore(),
    root = db.doc(sandboxSoundCloudAuthDocumentPath(profile));
  await db.runTransaction(async (tx) => {
    const grantRef = root
      .collection(grant === 'authorization_code' ? 'authorizationCodes' : 'refreshTokens')
      .doc(hash(rawGrant));
    const snapshot = await tx.get(grantRef);
    const record = liveRecord(
      snapshot,
      profile,
      grant === 'authorization_code' ? 'authorization-code' : 'refresh-token'
    );
    const now = nativeNow(snapshot);
    if (record.clientId !== configuration.clientId) reject();
    let oldAccessRef;
    if (grant === 'authorization_code') {
      if (
        record.redirectUri !== payload.get('redirect_uri') ||
        !equal(record.codeChallenge, challenge(payload.get('code_verifier')!))
      )
        reject();
      const pendingSnapshot = await tx.get(root.collection('pendingOAuthSessions').doc(record.adminUid));
      const pendingState = pendingSnapshot.get('state');
      if (!validState(pendingState)) reject();
      const pending = validatePending(pendingSnapshot, {
        adminUid: record.adminUid,
        state: pendingState,
        redirectUri: record.redirectUri,
        codeChallenge: record.codeChallenge,
      });
      if (!equal(record.stateHash, hash(pending.state)) || pending.sandboxAuthorizationCodeHash !== hash(rawGrant))
        reject();
    } else {
      if (typeof record.accessTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.accessTokenHash)) reject();
      oldAccessRef = root.collection('accessTokens').doc(record.accessTokenHash);
      const oldAccess = await tx.get(oldAccessRef);
      if (
        !oldAccess.exists ||
        oldAccess.get('adminUid') !== record.adminUid ||
        oldAccess.get('profileId') !== profile.profileId
      )
        reject();
    }
    tx.update(grantRef, { consumedAt: now });
    if (oldAccessRef) tx.update(oldAccessRef, { revokedAt: now });
    tx.create(root.collection('accessTokens').doc(hash(accessToken)), {
      schemaVersion: 1,
      kind: 'access-token',
      profileId: profile.profileId,
      adminUid: record.adminUid,
      clientId: configuration.clientId,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + ACCESS_SECONDS * 1000),
    });
    tx.create(root.collection('refreshTokens').doc(hash(refreshToken)), {
      schemaVersion: 1,
      kind: 'refresh-token',
      profileId: profile.profileId,
      adminUid: record.adminUid,
      clientId: configuration.clientId,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + REFRESH_MILLIS),
      accessTokenHash: hash(accessToken),
    });
  });
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_SECONDS };
}
export async function verifySandboxSoundCloudAccessToken(
  profile: SandboxProviderProfile,
  token: string
): Promise<{ id: number; urn: string }> {
  assertProfile(profile);
  if (typeof token !== 'string' || !/^sandbox-sc-access-[A-Za-z0-9_-]{43}$/.test(token)) reject();
  const snapshot = await admin
    .firestore()
    .doc(sandboxSoundCloudAuthDocumentPath(profile))
    .collection('accessTokens')
    .doc(hash(token))
    .get();
  const record = liveRecord(snapshot, profile, 'access-token');
  if (record.clientId !== getSandboxOAuthConfiguration(profile).clientId) reject();
  return { id: SANDBOX_SOUNDCLOUD_USER_ID, urn: `soundcloud:users:${SANDBOX_SOUNDCLOUD_USER_ID}` };
}

export type ConsentSoundCloudSandboxAuthorizationInput = { state: string; redirectUri: string; codeChallenge: string };
export type ConsentSoundCloudSandboxAuthorizationOutput = { code: string; state: string; redirectUri: string };
export async function consentSoundCloudSandboxAuthorizationHandler(
  request: CallableRequest<ConsentSoundCloudSandboxAuthorizationInput>
): Promise<ConsentSoundCloudSandboxAuthorizationOutput> {
  const uid = request.auth?.uid;
  if (!uid || request.auth?.token.role !== 'admin')
    throw new HttpsError('permission-denied', 'Only admins can authorize sandbox SoundCloud.');
  const profile = getProviderExecutionProfile();
  if (profile.mode !== 'sandbox')
    throw new HttpsError('failed-precondition', 'Sandbox consent is available only in staging.');
  assertProfile(profile);
  const account = await admin.auth().getUser(uid);
  if (account.disabled || account.customClaims?.role !== 'admin')
    throw new HttpsError('permission-denied', 'Only admins can authorize sandbox SoundCloud.');
  const input = request.data;
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => !['state', 'redirectUri', 'codeChallenge'].includes(key))
  )
    throw new HttpsError('invalid-argument', 'Invalid sandbox consent request.');
  try {
    return await withAdministrativeCredentialSetupLease(
      admin.firestore(),
      {
        actorUid: uid,
        actorRole: 'admin',
        operation: 'createSoundCloudAuthSession',
        projectId: admin.app().options.projectId || '',
      },
      (lease) =>
        issueSandboxSoundCloudAuthorizationCode(profile, { ...input, adminUid: uid }, () => lease.markEffectsStarted())
    );
  } catch (error) {
    if (error instanceof SandboxHttpError) throw new HttpsError('failed-precondition', error.message);
    throw error;
  }
}
export const consentSoundCloudSandboxAuthorization = onCall(
  { timeoutSeconds: 60 },
  consentSoundCloudSandboxAuthorizationHandler
);
