// Server-side release evidence for the fixed staging Moses renderer.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { assertNativeSnapshot, hash, nativeSnapshotProof } from './temporal-release-runtime.mjs';

const projectId = 'urm-app-staging';
const healthUrl = 'https://yt-moses-staging.upperroommedia.org/healthz';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const commit = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const fields = [
  'schemaVersion',
  'projectId',
  'target',
  'guestOnly',
  'mode',
  'releaseId',
  'commit',
  'operationId',
  'candidateId',
  'claimSHA256',
  'nativeReceiptSHA256',
  'containerId',
  'imageId',
  'runtimeId',
  'controlRevision',
];
const pins = ['candidateId', 'imageId'];
const optionalPins = [
  'claimSHA256',
  'operationId',
  'controlRevision',
  'runtimeId',
  'nativeReceiptSHA256',
  'containerId',
];
const checked = new WeakSet();
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

const invalid = () => new Error('Exact immutable staging Moses activation receipt required');
const unavailable = () => new Error('Live staging Moses runtime does not match its activation receipt');

export function mosesActivationPath(releaseId) {
  if (typeof releaseId !== 'string' || !uuid.test(releaseId)) throw invalid();
  return '_control/temporalMosesYouTubeActivation-' + releaseId;
}

function staging(db) {
  if (db?.projectId !== projectId || db.databaseId !== '(default)') throw invalid();
}

function validateReceipt(receipt, release, expected) {
  if (
    release?.projectId !== projectId ||
    release.environment !== 'staging' ||
    !matches(commit, release.compatibilityCommit) ||
    !receipt ||
    Object.keys(receipt).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(receipt, key)) ||
    receipt.schemaVersion !== 1 ||
    receipt.projectId !== projectId ||
    receipt.target !== 'moses' ||
    receipt.guestOnly !== true ||
    receipt.mode !== 'enabled' ||
    receipt.releaseId !== release.releaseId ||
    receipt.commit !== release.compatibilityCommit ||
    !matches(uuid, receipt.operationId) ||
    !matches(uuid, receipt.runtimeId) ||
    receipt.operationId === receipt.runtimeId ||
    !matches(image, receipt.imageId) ||
    ['candidateId', 'claimSHA256', 'nativeReceiptSHA256', 'containerId'].some(
      (key) => !matches(digest, receipt[key])
    ) ||
    !Number.isSafeInteger(receipt.controlRevision) ||
    receipt.controlRevision < 1 ||
    !expected ||
    pins.some((key) => !Object.hasOwn(expected, key)) ||
    Object.keys(expected).some((key) => ![...pins, ...optionalPins].includes(key) || receipt[key] !== expected[key])
  )
    throw invalid();
}

/** expected comes from the independently authorized deployment, never the document being checked. */
export function assertMosesActivationReceipt(snapshot, release, expected) {
  if (!snapshot?.exists || snapshot.ref?.path !== mosesActivationPath(release.releaseId)) throw invalid();
  staging(snapshot.ref.firestore);
  const receipt = snapshot.data();
  validateReceipt(receipt, release, expected);
  const stamp = nativeSnapshotProof(snapshot);
  if (
    stamp.createTime.seconds !== stamp.updateTime.seconds ||
    stamp.createTime.nanoseconds !== stamp.updateTime.nanoseconds
  )
    throw invalid();
  const result = Object.freeze({ ...receipt });
  checked.add(result);
  return result;
}

function signedNativeRecord(record, expectedKey) {
  if (
    !record ||
    typeof record.payload !== 'string' ||
    record.payload.length > 4096 ||
    typeof record.publicKey !== 'string' ||
    record.publicKey.length > 256 ||
    !matches(/^[a-f0-9]{128}$/, record.signature)
  )
    throw invalid();
  const key = createPublicKey(record.publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    hash(key.export({ type: 'spki', format: 'der' })) !== expectedKey ||
    !verify(null, Buffer.from(record.payload), key, Buffer.from(record.signature, 'hex'))
  )
    throw invalid();
  return { value: JSON.parse(record.payload), sha256: hash(record.payload) };
}

export function mosesActivationGrantPath(releaseId) {
  if (!matches(uuid, releaseId)) throw invalid();
  return '_control/temporalMosesYouTubeActivationGrant-' + releaseId;
}

export function signMosesActivationGrant({ verification, release, controlRevision, privateKey, now }) {
  if (
    !Buffer.isBuffer(verification) ||
    !verification.length ||
    verification.length > 32768 ||
    !Number.isSafeInteger(controlRevision) ||
    controlRevision < 1 ||
    !Number.isSafeInteger(now)
  )
    throw invalid();
  const policy = release.mosesActivation;
  const proof = JSON.parse(verification.toString('utf8'));
  const original = signedNativeRecord(proof.signedRelease, policy.operatorKeySHA256);
  const checked = original.value;
  const key = createPrivateKey(privateKey);
  const keyPin = hash(createPublicKey(key).export({ type: 'spki', format: 'der' }));
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    keyPin !== policy.guardKeySHA256 ||
    keyPin === policy.operatorKeySHA256 ||
    checked.kind !== 'urm.moses.staging.renderer.v1' ||
    checked.mode !== 'verify' ||
    checked.role !== 'staging-renderer' ||
    checked.target !== 'moses' ||
    checked.releaseId !== release.releaseId ||
    checked.commit !== release.compatibilityCommit ||
    !matches(uuid, checked.operationId) ||
    checked.operationId === policy.operationId ||
    checked.imageId !== policy.imageId ||
    proof.manifestSHA256 !== original.sha256 ||
    proof.operatorKeySHA256 !== policy.operatorKeySHA256 ||
    proof.guardKeyPinSHA256 !== policy.guardKeySHA256 ||
    proof.hostAuthority !== 'moses-user-service' ||
    proof.credentialType !== 'external_account' ||
    proof.native?.runtimeId !== null ||
    proof.native?.cloudRead?.stagingObjectLookup !== 'absent' ||
    !matches(digest, proof.native?.containerId) ||
    !Number.isSafeInteger(proof.observedAt) ||
    proof.observedAt > now
  )
    throw invalid();
  const grant = {
    kind: 'urm.moses.staging.activation.v1',
    manifestSHA256: policy.candidateId,
    releaseId: release.releaseId,
    operationId: policy.operationId,
    verifiedOperationId: checked.operationId,
    verificationSHA256: hash(verification),
    controlRevision,
    issuedAt: now,
    expiresAt: now + 300,
  };
  const payload = JSON.stringify(grant) + '\n';
  return { grant, payload, signature: sign(null, Buffer.from(payload), key), sha256: hash(payload) };
}

/** Consumes an authenticated SSH export of the original host journal. Both signed
 * authorizations are pinned independently, and the caller must challenge the live process
 * before it records the immutable receipt under its current native release lock. */
export function readMosesNativeReceipt(bytes, release, controlRevision) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32768) throw invalid();
  const data = JSON.parse(bytes.toString('utf8'));
  const { operatorKeySHA256, guardKeySHA256, candidateId, imageId, operationId } = release.mosesActivation;
  const manifest = signedNativeRecord(data.signedRelease, operatorKeySHA256);
  const guard = signedNativeRecord(data.guard?.signed, guardKeySHA256);
  const signed = manifest.value;
  const grant = guard.value;
  const native = data.native;
  const started = Date.parse(native?.startedAt) / 1000;
  if (
    operatorKeySHA256 === guardKeySHA256 ||
    signed?.kind !== 'urm.moses.staging.renderer.v1' ||
    signed.role !== 'staging-renderer' ||
    signed.target !== 'moses' ||
    signed.mode !== 'enabled' ||
    signed.releaseId !== release.releaseId ||
    signed.operationId !== operationId ||
    signed.imageId !== imageId ||
    signed.commit !== release.compatibilityCommit ||
    manifest.sha256 !== candidateId ||
    data.manifestSHA256 !== candidateId ||
    data.operatorKeySHA256 !== operatorKeySHA256 ||
    data.guardKeyPinSHA256 !== guardKeySHA256 ||
    data.hostAuthority !== 'moses-user-service' ||
    data.credentialType !== 'external_account' ||
    data.credentialPrincipal !== 'process-audio-moses@urm-app-staging.iam.gserviceaccount.com' ||
    grant?.kind !== 'urm.moses.staging.activation.v1' ||
    grant.manifestSHA256 !== candidateId ||
    grant.releaseId !== signed.releaseId ||
    grant.operationId !== signed.operationId ||
    !matches(uuid, grant.verifiedOperationId) ||
    grant.verifiedOperationId === signed.operationId ||
    !matches(digest, grant.verificationSHA256) ||
    grant.controlRevision !== controlRevision ||
    data.guard.guardSHA256 !== guard.sha256 ||
    data.guard.guardKeySHA256 !== guardKeySHA256 ||
    !Number.isSafeInteger(grant.issuedAt) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    !(grant.issuedAt <= started && started < grant.expiresAt && grant.expiresAt <= grant.issuedAt + 300) ||
    !Number.isSafeInteger(data.observedAt) ||
    data.observedAt < Math.floor(started) ||
    native.uid !== 1000 ||
    native.gid !== 1000 ||
    native.cloudRead?.firestoreRevision !== String(controlRevision) ||
    native.cloudRead.stagingObjectLookup !== 'absent' ||
    native.sentryRelease !== 'process-audio-hetzner@staging-' + signed.commit
  )
    throw invalid();
  const receipt = Object.freeze({
    schemaVersion: 1,
    projectId,
    target: 'moses',
    guestOnly: true,
    mode: 'enabled',
    releaseId: signed.releaseId,
    commit: signed.commit,
    operationId,
    candidateId,
    claimSHA256: guard.sha256,
    nativeReceiptSHA256: hash(bytes),
    containerId: native.containerId,
    imageId,
    runtimeId: native.runtimeId,
    controlRevision,
  });
  validateReceipt(receipt, release, { candidateId, imageId, operationId, controlRevision });
  checked.add(receipt);
  return receipt;
}

async function readHealth(response, href) {
  if (
    response.status !== 200 ||
    response.redirected ||
    response.url !== href ||
    !response.headers
      .get('cache-control')
      ?.toLowerCase()
      .split(',')
      .some((value) => value.trim() === 'no-store') ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  ) {
    await response.body?.cancel();
    throw unavailable();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8192) throw unavailable();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** This proves that the process from the native receipt answers now. Image/guard identities come from the receipt. */
export async function confirmLiveMosesActivation(receipt, request = fetch) {
  if (!checked.has(receipt)) throw invalid();
  const challenge = randomBytes(32).toString('hex');
  const url = new URL(healthUrl);
  url.searchParams.set('releaseChallenge', challenge);
  const signal = AbortSignal.timeout(5000);
  try {
    const response = await request(url.href, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    const health = await readHealth(response, url.href);
    signal.throwIfAborted();
    if (
      health?.ok !== true ||
      health.service !== 'process-audio' ||
      health.releaseChallenge !== challenge ||
      health.temporalYouTubeRenderMode !== 'enabled' ||
      health.temporalYouTubeRenderTarget !== 'moses' ||
      health.temporalYouTubeGuestOnly !== true ||
      health.temporalYouTubeRenderPinProtocol !== 1 ||
      health.temporalYouTubeRuntimeId !== receipt.runtimeId ||
      health.sentryEnabled !== true ||
      health.sentryEnvironment !== 'staging' ||
      health.sentryRelease !== 'process-audio-hetzner@staging-' + receipt.commit
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
}

/** Retain proof and recheck it in the transaction which authorizes deployment or admission. */
export async function verifyMosesActivation({ firestore, release, expected, request = fetch }) {
  staging(firestore);
  const ref = firestore.doc(mosesActivationPath(release.releaseId));
  const before = await ref.get();
  const receipt = assertMosesActivationReceipt(before, release, expected);
  const proof = nativeSnapshotProof(before);
  await confirmLiveMosesActivation(receipt, request);
  const after = await ref.get();
  assertMosesActivationReceipt(after, release, expected);
  assertNativeSnapshot(proof, after);
  return { receipt, proof };
}
