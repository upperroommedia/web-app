/** Operator policy is committed independently of the application being released. */
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Agent as HttpsAgent } from 'node:https';
import { join, dirname } from 'node:path';
import { validateConfig, firebaseResourceEnvironment } from './temporal-platform.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => {
  if (value === undefined) return null;
  if (value && typeof value.toDate === 'function' && Number.isInteger(value.seconds))
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
};
export const proofDigest = (value) => hash(JSON.stringify(canonical(value)));
const fail = (code) => Object.assign(new Error(code), { code });
export class BoundedReleaseHttpsAgent extends HttpsAgent {
  constructor(timeoutMs = 60_000) {
    super({ keepAlive: true });
    this.requestTimeoutMs = timeoutMs;
  }
  addRequest(request, options) {
    let response;
    const timer = setTimeout(() => {
      const error = fail('RELEASE_ADC_HTTP_TIMEOUT');
      response?.destroy(error);
      request.destroy(error);
    }, this.requestTimeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    request.once('response', (value) => {
      response = value;
      value.once('end', clear);
      value.once('error', clear);
      value.once('close', clear);
    });
    request.once('error', clear);
    request.once('close', () => {
      if (!response || response.complete || response.destroyed) clear();
    });
    try {
      super.addRequest(request, options);
    } catch (error) {
      clear();
      throw error;
    }
  }
}
/** No Compute/external-account fallback: the official SDK consumes this exact local ADC file. */
export function prepareLocalReleaseADC(
  sdkRoot,
  projectId,
  {
    env = process.env,
    platform = process.platform,
    read = readFileSync,
    realpath = realpathSync,
    sdkRequire = createRequire(resolve(sdkRoot, 'functions/package.json')),
    agent = new BoundedReleaseHttpsAgent(),
  } = {}
) {
  let credential;
  try {
    const directory =
      env.CLOUDSDK_CONFIG ||
      (platform === 'win32'
        ? env.APPDATA && join(env.APPDATA, 'gcloud')
        : env.HOME && join(env.HOME, '.config', 'gcloud'));
    const file =
      env.GOOGLE_APPLICATION_CREDENTIALS || (directory && join(directory, 'application_default_credentials.json'));
    if (!file) throw fail('RELEASE_LOCAL_ADC_REQUIRED');
    const path = realpath(file),
      json = JSON.parse(read(path));
    if (!['authorized_user', 'service_account'].includes(json.type)) throw fail('RELEASE_LOCAL_ADC_TYPE_UNSUPPORTED');
    // Use the documented SDK file selector so missing files cannot fall back to Compute metadata.
    env.GOOGLE_APPLICATION_CREDENTIALS = path;
    env.GOOGLE_CLOUD_PROJECT = projectId;
    const sdk = sdkRequire('firebase-admin/app');
    credential = sdk.applicationDefault(agent);
    // Read-only capability check against the pinned installed SDK. Never mutate its credential/cache.
    if (credential.googleAuth?.clientOptions?.transporterOptions?.agent !== agent)
      throw fail('RELEASE_ADC_AGENT_NOT_BOUND');
    return {
      credential,
      adcType: json.type,
      sdkCredentialImplementationSHA256: hash(
        read(resolve(dirname(sdkRequire.resolve('firebase-admin/app')), 'credential-internal.js'))
      ),
      close: () => agent.destroy(),
    };
  } catch (error) {
    agent.destroy();
    throw fail(/^RELEASE_LOCAL_ADC_|^RELEASE_ADC_/.test(error.code ?? '') ? error.code : 'RELEASE_LOCAL_ADC_REQUIRED');
  }
}
const operatorInput = (p) =>
  p &&
  (/^(scripts|ops|packages\/contracts)\//.test(p) ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'function-kits/firestore-send-email/src/temporal/public-address-ranges.json',
    ].includes(p));
export function scriptOrigin(name) {
  if (['deploy-temporal-platform.mjs', 'temporal-bootstrap-bundles.mjs'].includes(name)) return 'operator';
  if (['temporal-backfill-provider-usage.mjs', 'temporal-bootstrap-search.mjs'].includes(name)) return 'runtime';
  throw fail('RELEASE_TOOL_ORIGIN_UNREVIEWED');
}
export function releaseScript(binding, name) {
  return resolve(scriptOrigin(name) === 'operator' ? binding.operatorRoot : binding.runtimeRoot, 'scripts', name);
}
export function pinReleaseCheckouts(
  operatorRoot,
  runtimeRoot,
  config,
  {
    git = (root, args) =>
      execFileSync('git', args, {
        cwd: root,
        ...(args[0] === 'show' ? {} : { encoding: 'utf8' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    read = readFileSync,
    stat = lstatSync,
    realpath = realpathSync,
  } = {}
) {
  operatorRoot = realpath(operatorRoot);
  runtimeRoot = realpath(runtimeRoot);
  const operatorCommit = git(operatorRoot, ['rev-parse', 'HEAD']).trim();
  const runtimeCommit = git(runtimeRoot, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(operatorCommit) || runtimeCommit !== config.compatibilityCommit)
    throw fail('RELEASE_RUNTIME_COMMIT_CHANGED');
  // Pin the complete tracked operator dependency closure, including fixtures/locks.
  // Graph artifacts are generated observations, never executable operator inputs.
  const files = git(operatorRoot, ['ls-files', '-z']).split('\0').filter(operatorInput);
  const operatorHashes = {};
  for (const file of files) {
    const path = resolve(operatorRoot, file);
    if (relative(operatorRoot, path).startsWith('..') || !stat(path).isFile() || stat(path).isSymbolicLink())
      throw fail('RELEASE_OPERATOR_SOURCE_CHANGED');
    const bytes = read(path);
    if (!Buffer.from(bytes).equals(Buffer.from(git(operatorRoot, ['show', `${operatorCommit}:${file}`]))))
      throw fail('RELEASE_OPERATOR_SOURCE_CHANGED');
    operatorHashes[file] = hash(bytes);
  }
  // An uncommitted executable must not become a dependency through a new import.
  const unknown = git(operatorRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (
    unknown.some(
      (p) =>
        !p.startsWith('graphify-out/') &&
        !/^(apps\/web|functions|function-kits\/firestore-algolia-search)\/node_modules\/?$/.test(p)
    )
  )
    throw fail('RELEASE_OPERATOR_UNTRACKED_SOURCE');
  const runtimePins = {};
  const guardModules = new Set(['scripts/temporal-deploy-source.mjs']);
  const pending = [
    ...git(runtimeRoot, ['ls-files', '-z']).split('\0').filter(operatorInput),
    'pnpm-lock.yaml',
    'firebase.json',
    'scripts/temporal-deploy-source.mjs',
    'scripts/temporal-bootstrap-bundles.mjs',
    'functions/src/temporal/bridge.ts',
  ];
  while (pending.length) {
    const file = pending.pop();
    if (runtimePins[file]) continue;
    const path = resolve(runtimeRoot, file),
      bytes = read(path);
    if (
      !stat(path).isFile() ||
      stat(path).isSymbolicLink() ||
      !Buffer.from(bytes).equals(Buffer.from(git(runtimeRoot, ['show', `${runtimeCommit}:${file}`])))
    )
      throw fail('RELEASE_RUNTIME_SOURCE_CHANGED');
    runtimePins[file] = hash(bytes);
    // Pin every relative module import before any frozen guard code executes.
    // Application TS is validated by that full source guard before it is loaded.
    if (guardModules.has(file) && /\.[cm]?js$/.test(file)) {
      for (const match of Buffer.from(bytes)
        .toString('utf8')
        .matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = resolve(runtimeRoot, file, '..', match[1]);
        const name = relative(runtimeRoot, dependency);
        if (name.startsWith('..')) throw fail('RELEASE_RUNTIME_IMPORT_OUTSIDE_ROOT');
        guardModules.add(name);
        pending.push(name);
      }
    }
  }
  return {
    operatorRoot,
    runtimeRoot,
    operatorCommit,
    runtimeCommit,
    operatorClosureDigest: proofDigest(operatorHashes),
    operatorHashes,
    runtimePins,
  };
}
export async function assertReleaseRuntimeSource(binding, config, control) {
  const { assertCheckoutSource } = await import(
    pathToFileURL(resolve(binding.runtimeRoot, 'scripts/temporal-deploy-source.mjs')).href
  );
  assertCheckoutSource(binding.runtimeRoot, binding.runtimeCommit, {
    project: config.projectId,
    control,
    includeStagingSearch: config.domains.includes('search') && control?.releaseId === config.releaseId,
    release: config,
  });
}
export async function loadVerifiedRuntimeApplication(binding, config, db, load) {
  const control = (await db.doc('_control/temporalRelease').get()).data();
  await assertReleaseRuntimeSource(binding, config, control);
  return load();
}
export function loadReleaseResourceBinding(config, { read = readFileSync, validate = validateConfig } = {}) {
  const platformBytes = read(config.platformConfig),
    peerBytes = read(config.platformPeerConfig);
  const platform = JSON.parse(platformBytes),
    peer = JSON.parse(peerBytes);
  validate(platform, peer);
  firebaseResourceEnvironment(platform);
  if (
    platform.firebaseProjectId !== config.projectId ||
    platform.environment !== config.environment ||
    new URL(platform.firebaseResources.databaseUrl).href !== new URL(config.databaseUrl).href
  )
    throw fail('RELEASE_RESOURCE_PROJECT_CHANGED');
  return {
    resources: platform.firebaseResources,
    platformConfigSHA256: hash(platformBytes),
    peerConfigSHA256: hash(peerBytes),
    projectId: config.projectId,
    workerBuildId: platform.workerBuildId,
    workerImage: platform.workerImage,
    resourceDigest: proofDigest({ projectId: config.projectId, resources: platform.firebaseResources }),
  };
}
export function validateBucketProject(binding, project, bucket) {
  if (
    project.projectId !== binding.projectId ||
    !/^\d+$/.test(String(project.projectNumber)) ||
    project.lifecycleState !== 'ACTIVE' ||
    bucket.name !== binding.resources.storageBucket ||
    String(bucket.projectNumber) !== String(project.projectNumber) ||
    !/^\d+$/.test(String(bucket.metageneration))
  )
    throw fail('RELEASE_BUCKET_PROJECT_CHANGED');
  return {
    projectId: project.projectId,
    projectNumber: String(project.projectNumber),
    bucket: bucket.name,
    metageneration: String(bucket.metageneration),
    resourceDigest: binding.resourceDigest,
  };
}
export async function verifyReleaseResourceIdentity(binding, api) {
  const project = await api(`https://cloudresourcemanager.googleapis.com/v1/projects/${binding.projectId}`);
  const bucket = await api(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(binding.resources.storageBucket)}`
  );
  return validateBucketProject(binding, project, bucket);
}
export async function verifyReleaseOperator(binding, credential) {
  const { verifiedGoogleOperator } = await import('./temporal-recover-bundle-bootstrap.mjs');
  const require = createRequire(resolve(binding.runtimeRoot, 'functions/package.json'));
  const { OAuth2Client } = createRequire(require.resolve('firebase-admin/app'))('google-auth-library');
  class BoundedOAuth2Client extends OAuth2Client {
    constructor() {
      super({ transporterOptions: { timeout: 60_000, retry: false, signal: AbortSignal.timeout(60_000) } });
    }
  }
  return verifiedGoogleOperator(credential, BoundedOAuth2Client, () =>
    execFileSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  );
}
export function artifactProof(bundleType, pointer, metadata, bucket) {
  const count = metadata?.metadata?.[`${bundleType}-count`];
  if (
    !metadata ||
    metadata.bucket !== bucket ||
    metadata.name !== pointer.storagePath ||
    metadata.contentType !== 'application/octet-stream' ||
    Number(count) !== pointer.count ||
    !/^\d+$/.test(String(count ?? '')) ||
    !(Number(metadata.size) > 0) ||
    !/^\d+$/.test(String(metadata.generation)) ||
    !/^\d+$/.test(String(metadata.metageneration))
  )
    throw fail('BOOTSTRAP_ARTIFACT_INVALID');
  return {
    bundleType,
    bucket,
    path: metadata.name,
    generation: String(metadata.generation),
    metageneration: String(metadata.metageneration),
    contentType: metadata.contentType,
    count,
    size: String(metadata.size),
    metadataDigest: proofDigest(metadata.metadata),
    pointerDigest: proofDigest(pointer),
  };
}
export function assertSameArtifact(expected, actual) {
  if (proofDigest(expected) !== proofDigest(actual)) throw fail('BOOTSTRAP_ARTIFACT_CHANGED');
}
export function nativeSnapshotProof(snapshot) {
  for (const stamp of [snapshot.createTime, snapshot.updateTime])
    if (
      !stamp ||
      !Number.isSafeInteger(stamp.seconds) ||
      !Number.isInteger(stamp.nanoseconds) ||
      stamp.nanoseconds < 0 ||
      stamp.nanoseconds >= 1e9 ||
      typeof stamp.toDate !== 'function'
    )
      throw fail('RELEASE_NATIVE_AUTHORITY_REQUIRED');
  return {
    dataDigest: proofDigest(snapshot.data()),
    createTime: canonical(snapshot.createTime),
    updateTime: canonical(snapshot.updateTime),
  };
}
export function assertNativeSnapshot(expected, snapshot) {
  if (proofDigest(expected) !== proofDigest(nativeSnapshotProof(snapshot)))
    throw fail('RELEASE_NATIVE_AUTHORITY_CHANGED');
}
export async function confirmBundleProofInTransaction(tx, db, proof, projectId) {
  const types = ['topics', 'subtitles', 'bible-chapters', 'sunday-homilies', 'holy-week', 'latest-list'];
  if (
    !proof ||
    proof.bundleTypes?.join('|') !== types.join('|') ||
    proof.artifactProofs?.length !== 6 ||
    proof.jobIds?.length !== 6
  )
    throw fail('BOOTSTRAP_PROOF_INVALID');
  for (let i = 0; i < 6; i++) {
    const type = types[i],
      artifact = proof.artifactProofs[i];
    const key = createHash('sha256')
      .update(JSON.stringify([projectId, 'bundle', type, 'bundle']))
      .digest('hex');
    const [entity, job, pointer] = await Promise.all([
      tx.get(db.doc(`durableJobEntities/${key}`)),
      tx.get(db.doc(`durableJobs/${proof.jobIds[i]}`)),
      tx.get(db.doc(`_durableBundlePointers/${type}`)),
    ]);
    const e = entity.data(),
      j = job.data(),
      p = pointer.data();
    if (
      !/^job-[a-f0-9]{48}$/.test(proof.jobIds[i]) ||
      artifact.bundleType !== type ||
      e?.projectId !== projectId ||
      e?.entity?.type !== 'bundle' ||
      e?.entity?.id !== type ||
      !Number.isSafeInteger(e?.generation) ||
      e.generation < 1 ||
      !Number.isSafeInteger(p?.count) ||
      p.count < 0 ||
      e?.activeJobId !== proof.jobIds[i] ||
      j?.state !== 'succeeded' ||
      j?.projectId !== projectId ||
      j?.jobId !== e.activeJobId ||
      j?.kind !== 'bundle.regenerate' ||
      j?.entity?.type !== 'bundle' ||
      j?.entity?.id !== type ||
      j?.generation !== e.generation ||
      p?.generation !== e.generation ||
      p?.jobId !== e.activeJobId ||
      p?.projectId !== projectId ||
      proofDigest(p) !== artifact.pointerDigest ||
      p.storagePath !== artifact.path
    )
      throw fail('BOOTSTRAP_PROOF_CHANGED');
  }
}
