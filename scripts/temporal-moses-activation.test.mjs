import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMosesActivationReceipt,
  confirmLiveMosesActivation,
  mosesActivationPath,
  verifyMosesActivation,
} from './temporal-moses-activation.mjs';

const release = {
  projectId: 'urm-app-staging',
  environment: 'staging',
  releaseId: '11111111-1111-4111-8111-111111111111',
  compatibilityCommit: 'a'.repeat(40),
};
const expected = { imageId: 'sha256:' + 'b'.repeat(64), candidateId: 'c'.repeat(64), claimSHA256: 'd'.repeat(64) };
const data = {
  ...expected,
  schemaVersion: 1,
  projectId: release.projectId,
  releaseId: release.releaseId,
  target: 'moses',
  mode: 'enabled',
  guestOnly: true,
  commit: release.compatibilityCommit,
  controlRevision: 88,
  operationId: '22222222-2222-4222-8222-222222222222',
  runtimeId: '33333333-3333-4333-8333-333333333333',
  nativeReceiptSHA256: 'e'.repeat(64),
  containerId: 'f'.repeat(64),
};
const stamp = (nanoseconds = 2) => ({ seconds: 1_700_000_000, nanoseconds, toDate: () => new Date(1_700_000_000_000) });
const firestore = { projectId: release.projectId, databaseId: '(default)' };
const snap = (overrides = {}, nanos = 2) => ({
  exists: true,
  ref: { firestore, path: mosesActivationPath(release.releaseId) },
  data: () => ({ ...data, ...overrides }),
  createTime: stamp(nanos),
  updateTime: stamp(nanos),
});
const checked = () => assertMosesActivationReceipt(snap(), release, expected);

test('immutable native receipt needs the independently pinned staging project, manifest, guard and image', () => {
  assert.deepEqual(checked(), data);
  assert.ok(Object.isFrozen(checked()));
  for (const field of ['imageId', 'candidateId']) {
    const removed = { ...expected };
    delete removed[field];
    assert.throws(() => assertMosesActivationReceipt(snap(), release, removed));
    assert.throws(() => assertMosesActivationReceipt(snap(), release, { ...expected, [field]: '1'.repeat(64) }));
  }
  for (const override of [
    { target: 'hetzner' },
    { mode: 'verify' },
    { guestOnly: false },
    { commit: 'b'.repeat(40) },
    { releaseId: data.runtimeId },
    { projectId: 'urm-app' },
    { controlRevision: 0 },
    { nativeReceiptSHA256: null },
    { containerId: [data.containerId] },
    { imageId: 'candidate:latest' },
    { operationId: data.runtimeId },
    { runtimeId: 'bad' },
    { audience: 'https://different.test' },
  ])
    assert.throws(() => assertMosesActivationReceipt(snap(override), release, expected));
  for (const snapshot of [
    { ...snap(), exists: false },
    { ...snap(), updateTime: stamp(3) },
    { ...snap(), createTime: {} },
    { ...snap(), ref: { ...snap().ref, path: 'other/doc' } },
    { ...snap(), ref: { ...snap().ref, firestore: { ...firestore, projectId: 'urm-app' } } },
    { ...snap(), ref: { ...snap().ref, firestore: { ...firestore, databaseId: 'other' } } },
  ])
    assert.throws(() => assertMosesActivationReceipt(snapshot, release, expected));
  assert.throws(() => assertMosesActivationReceipt(snap(), { ...release, environment: 'production' }, expected));
  assert.throws(() =>
    assertMosesActivationReceipt(snap(), release, { ...expected, controlRevision: data.controlRevision + 1 })
  );
  assert.throws(() => mosesActivationPath(release.releaseId + '/other'));
});

const fixed = 'https://yt-moses-staging.upperroommedia.org/healthz';
function healthResponse(
  href,
  {
    override = {},
    status = 200,
    redirected = false,
    finalUrl = href,
    cache = 'no-store',
    type = 'application/json',
    raw,
  } = {}
) {
  const challenge = new URL(href).searchParams.get('releaseChallenge');
  const health = {
    ok: true,
    service: 'process-audio',
    releaseChallenge: challenge,
    temporalYouTubeRenderMode: 'enabled',
    temporalYouTubeRenderTarget: 'moses',
    temporalYouTubeGuestOnly: true,
    temporalYouTubeRenderPinProtocol: 1,
    temporalYouTubeRuntimeId: data.runtimeId,
    sentryEnabled: true,
    sentryEnvironment: 'staging',
    sentryRelease: 'process-audio-hetzner@staging-' + data.commit,
    ...override,
  };
  const response = new Response(raw ?? JSON.stringify(health), {
    status,
    headers: { 'cache-control': cache, 'content-type': type },
  });
  Object.defineProperties(response, { url: { value: finalUrl }, redirected: { value: redirected } });
  return response;
}

test('fresh fixed-origin challenges join the receipt to the running guest-only process', async () => {
  const challenges = [];
  const receipt = checked();
  const request = async (href, options) => {
    const url = new URL(href);
    assert.equal(url.origin + url.pathname, fixed);
    assert.deepEqual([...url.searchParams.keys()], ['releaseChallenge']);
    const challenge = url.searchParams.get('releaseChallenge');
    assert.match(challenge, /^[0-9a-f]{64}$/);
    challenges.push(challenge);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.signal.aborted, false);
    return healthResponse(href);
  };
  await confirmLiveMosesActivation(receipt, request);
  await confirmLiveMosesActivation(receipt, request);
  assert.notEqual(challenges[0], challenges[1]);
  for (const override of [
    { temporalYouTubeRenderTarget: 'hetzner' },
    { temporalYouTubeGuestOnly: false },
    { releaseChallenge: challenges[0] },
    { temporalYouTubeRuntimeId: data.operationId },
    { sentryRelease: 'other' },
    { temporalYouTubeRenderMode: 'verify' },
    { sentryEnabled: false },
    { sentryEnvironment: 'production' },
  ])
    await assert.rejects(
      confirmLiveMosesActivation(receipt, async (href) => healthResponse(href, { override })),
      /Live staging/
    );
  for (const opts of [
    { redirected: true },
    { status: 401 },
    { finalUrl: 'https://other.test' },
    { type: 'text/html' },
    { cache: 'public' },
    { raw: 'invalid' },
    { raw: ' '.repeat(8200) },
  ])
    await assert.rejects(
      confirmLiveMosesActivation(receipt, async (href) => healthResponse(href, opts)),
      /Live staging/
    );
  await assert.rejects(confirmLiveMosesActivation({ ...receipt }, request), /immutable staging/);
});

test('deployment proof pins the document across the live read and detects delete/recreate and data substitution', async () => {
  const read = (second) => {
    const snapshots = [snap(), second];
    return {
      ...firestore,
      doc(path) {
        assert.equal(path, mosesActivationPath(release.releaseId));
        return { get: async () => snapshots.shift() };
      },
    };
  };
  const options = { release, expected, request: async (href) => healthResponse(href) };
  const result = await verifyMosesActivation({ ...options, firestore: read(snap()) });
  assert.deepEqual(result.receipt, data);
  assert.deepEqual(result.proof.createTime, { seconds: stamp().seconds, nanoseconds: 2 });
  for (const after of [
    snap({}, 3),
    snap({ runtimeId: '44444444-4444-4444-8444-444444444444' }),
    snap({ nativeReceiptSHA256: 'a'.repeat(64) }),
  ])
    await assert.rejects(verifyMosesActivation({ ...options, firestore: read(after) }), /AUTHORITY_CHANGED/);
});

test('the journal must join exact signed verification, one guard and the enabled process', async () => {
  const { createHash, generateKeyPairSync, sign } = await import('node:crypto');
  const { readMosesNativeReceipt, signMosesActivationGrant } = await import('./temporal-moses-activation.mjs');
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const keys = () => generateKeyPairSync('ed25519');
  const operator = keys();
  const guard = keys();
  const pin = ({ publicKey }) => hash(publicKey.export({ type: 'spki', format: 'der' }));
  const record = (payload, pair) => ({
    payload,
    signature: sign(null, Buffer.from(payload), pair.privateKey).toString('hex'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  const enabled = {
    kind: 'urm.moses.staging.renderer.v1',
    role: 'staging-renderer',
    target: 'moses',
    mode: 'enabled',
    releaseId: release.releaseId,
    operationId: data.operationId,
    commit: data.commit,
    imageId: data.imageId,
  };
  const manifest = record(JSON.stringify(enabled), operator);
  const descriptor = {
    ...release,
    mosesActivation: {
      operatorKeySHA256: pin(operator),
      guardKeySHA256: pin(guard),
      candidateId: hash(manifest.payload),
      imageId: data.imageId,
      operationId: data.operationId,
    },
  };
  const verificationManifest = record(
    JSON.stringify({ ...enabled, mode: 'verify', operationId: '99999999-9999-4999-8999-999999999999' }),
    operator
  );
  const now = 1700000000;
  const host = {
    hostAuthority: 'moses-user-service',
    credentialType: 'external_account',
    credentialPrincipal: 'process-audio-moses@urm-app-staging.iam.gserviceaccount.com',
    operatorKeySHA256: pin(operator),
    guardKeyPinSHA256: pin(guard),
  };
  const verifier = Buffer.from(
    JSON.stringify({
      ...host,
      signedRelease: verificationManifest,
      manifestSHA256: hash(verificationManifest.payload),
      observedAt: now - 30,
      native: { runtimeId: null, containerId: data.containerId, cloudRead: { stagingObjectLookup: 'absent' } },
    })
  );
  const inputs = {
    verification: verifier,
    release: descriptor,
    controlRevision: data.controlRevision,
    privateKey: guard.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    now,
  };
  const minted = signMosesActivationGrant(inputs);
  assert.equal(minted.grant.verificationSHA256, hash(verifier));
  assert.equal(minted.grant.expiresAt - minted.grant.issuedAt, 300);
  assert.throws(() =>
    signMosesActivationGrant({ ...inputs, privateKey: operator.privateKey.export({ format: 'pem', type: 'pkcs8' }) })
  );
  const journal = {
    ...host,
    signedRelease: manifest,
    manifestSHA256: descriptor.mosesActivation.candidateId,
    guard: { signed: record(minted.payload, guard), guardSHA256: minted.sha256, guardKeySHA256: pin(guard) },
    native: {
      startedAt: new Date((now + 15) * 1000).toISOString(),
      uid: 1000,
      gid: 1000,
      cloudRead: { stagingObjectLookup: 'absent', firestoreRevision: String(data.controlRevision) },
      sentryRelease: 'process-audio-hetzner@staging-' + data.commit,
      containerId: data.containerId,
      runtimeId: data.runtimeId,
    },
    observedAt: now + 17,
  };
  const payload = (value) => Buffer.from(JSON.stringify(value));
  const result = readMosesNativeReceipt(payload(journal), descriptor, data.controlRevision);
  assert.equal(result.claimSHA256, minted.sha256);
  assert.equal(result.runtimeId, data.runtimeId);
  assert.throws(() => readMosesNativeReceipt(payload(journal), descriptor, data.controlRevision + 1));
  assert.throws(() =>
    readMosesNativeReceipt(
      payload({
        ...journal,
        native: { ...journal.native, startedAt: new Date((now + 300) * 1000).toISOString() },
      }),
      descriptor,
      data.controlRevision
    )
  );
  assert.throws(() =>
    readMosesNativeReceipt(
      payload({
        ...journal,
        guard: { ...journal.guard, signed: record(minted.payload, operator) },
      }),
      descriptor,
      data.controlRevision
    )
  );
});
