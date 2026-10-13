#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_TYPES = Object.freeze([
  'topics',
  'subtitles',
  'bible-chapters',
  'sunday-homilies',
  'holy-week',
  'latest-list',
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code) => Object.assign(new Error(code), { code });
export function validateBootstrapOptions(options) {
  if (
    !['urm-app', 'urm-app-staging'].includes(options.projectId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.releaseId ?? '') ||
    !Number.isSafeInteger(options.controlRevision) ||
    options.controlRevision < 1
  )
    throw fail('INVALID_BOOTSTRAP_ARGUMENTS');
}
export function assertBootstrapControl(control, options) {
  if (
    control?.schemaVersion !== 1 ||
    control.releaseId !== options.releaseId ||
    control.revision !== options.controlRevision ||
    control.admission !== 'paused' ||
    control.domains?.bundles?.owner !== 'temporal'
  )
    throw fail('BOOTSTRAP_CONTROL_MISMATCH');
}
export function bootstrapRequestId(releaseId, bundleType) {
  return `bundle-bootstrap-${createHash('sha256')
    .update(JSON.stringify([releaseId, bundleType]))
    .digest('hex')}`;
}
/** Latest desired generation may replace our bootstrap intent while the release is paused. */
export function validateBundleProof(proof, projectId, bundleType) {
  const { entity, job, pointer } = proof;
  if (!entity || !job || !pointer || job.state !== 'succeeded') return false;
  if (
    entity.projectId !== projectId ||
    entity.entity?.type !== 'bundle' ||
    entity.entity?.id !== bundleType ||
    !Number.isSafeInteger(entity.generation) ||
    entity.generation < 1 ||
    job.projectId !== projectId ||
    job.kind !== 'bundle.regenerate' ||
    job.entity?.type !== 'bundle' ||
    job.entity?.id !== bundleType ||
    job.generation !== entity.generation ||
    job.jobId !== entity.activeJobId ||
    pointer.projectId !== projectId ||
    pointer.jobId !== entity.activeJobId ||
    pointer.generation !== entity.generation ||
    !Number.isSafeInteger(pointer.count) ||
    pointer.count < 0 ||
    typeof pointer.storagePath !== 'string' ||
    !pointer.storagePath.startsWith(`bundles/durable/${bundleType}/${entity.activeJobId}/`) ||
    !/^bundles\/durable\/[a-z-]+\/job-[a-f0-9]+\/[a-f0-9-]+\.bin$/.test(pointer.storagePath)
  )
    throw fail('BOOTSTRAP_PROOF_INVALID');
  return true;
}
/** Dependencies make all race/timeout checks testable without Firebase or provider writes. */
export async function runBundleBootstrap(options, deps) {
  validateBootstrapOptions(options);
  const now = deps.now ?? Date.now,
    sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (options.timeoutMs ?? 20 * 60 * 1000);
  const bootstrapJobIds = [],
    bootstrapGenerations = [];
  assertBootstrapControl(await deps.readControl(), options);
  for (const bundleType of BUNDLE_TYPES) {
    assertBootstrapControl(await deps.readControl(), options);
    const receipt = await deps.submit({
      kind: 'bundle.regenerate',
      entity: { type: 'bundle', id: bundleType },
      actorUid: 'system:firebase-event',
      requestId: bootstrapRequestId(options.releaseId, bundleType),
      payload: { bundleType },
      continuation: true,
      expectedReleaseControl: { releaseId: options.releaseId, revision: options.controlRevision },
    });
    if (
      receipt.projectId !== options.projectId ||
      typeof receipt.jobId !== 'string' ||
      !Number.isSafeInteger(receipt.generation) ||
      receipt.generation < 1
    )
      throw fail('BOOTSTRAP_RECEIPT_INVALID');
    bootstrapJobIds.push(receipt.jobId);
    bootstrapGenerations.push(receipt.generation);
  }
  while (now() < deadline) {
    assertBootstrapControl(await deps.readControl(), options);
    const proofs = await deps.readProofs(BUNDLE_TYPES);
    let converged = true;
    for (let i = 0; i < BUNDLE_TYPES.length; i++) {
      const proof = proofs[i];
      if (!validateBundleProof(proof, options.projectId, BUNDLE_TYPES[i])) {
        converged = false;
        break;
      }
      if (proof.entity.generation < bootstrapGenerations[i]) throw fail('BOOTSTRAP_PROOF_INVALID');
      const artifact = await deps.readArtifact(proof.pointer.storagePath);
      if (
        !artifact ||
        !artifact.exists ||
        artifact.contentType !== 'application/octet-stream' ||
        Number(artifact.metadata?.[`${BUNDLE_TYPES[i]}-count`]) !== proof.pointer.count ||
        !/^[0-9]+$/.test(String(artifact.metadata?.[`${BUNDLE_TYPES[i]}-count`] ?? '')) ||
        !(Number(artifact.size) > 0)
      )
        throw fail('BOOTSTRAP_ARTIFACT_INVALID');
    }
    if (converged && (await deps.confirmProofs(proofs, options))) {
      assertBootstrapControl(await deps.readControl(), options);
      return {
        projectId: options.projectId,
        releaseId: options.releaseId,
        controlRevision: options.controlRevision,
        result: 'passed',
        bundleTypes: [...BUNDLE_TYPES],
        jobIds: proofs.map((p) => p.entity.activeJobId),
        bootstrapJobIds,
      };
    }
    await sleep(options.pollMs ?? 2000);
  }
  throw fail('BOOTSTRAP_TIMEOUT');
}

export function isolateFirebaseEnvironment(projectId, env = process.env) {
  if (Object.keys(env).some((k) => /EMULATOR/.test(k) && env[k])) throw fail('BOOTSTRAP_EMULATOR_FORBIDDEN');
  for (const key of [
    'FIREBASE_CONFIG',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_DATABASE_URL',
    'FIREBASE_DATABASE_URL',
    'NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET',
    'FIREBASE_IMAGES_BUCKET',
  ])
    delete env[key];
  for (const key of [
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'FIREBASE_PROJECT_ID',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT',
  ])
    env[key] = projectId;
  env.NODE_ENV = 'production';
  env.TASK_ORCHESTRATOR_BUNDLES = 'temporal';
}
async function firebaseDependencies(options) {
  isolateFirebaseEnvironment(options.projectId);
  const require = createRequire(resolve(root, 'package.json'));
  require('ts-node').register({ project: resolve(root, 'functions/tsconfig.json'), transpileOnly: true });
  require('tsconfig-paths').register({
    baseUrl: resolve(root, 'functions'),
    paths: {
      '@upperroom/contracts/*': ['../packages/contracts/*'],
      '@upperroom/shared/*': ['../packages/shared/*'],
      '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
    },
  });
  const admin = require(resolve(root, 'packages/shared/firebase/firebaseAdmin.ts')).default;
  if (admin.app().options.projectId !== options.projectId) throw fail('BOOTSTRAP_PROJECT_MISMATCH');
  const { submitServerDurableJob } = require(resolve(root, 'functions/src/temporal/bridge.ts'));
  const { durableEntityKey } = require(resolve(root, 'packages/orchestration/src/job-store.ts'));
  const db = admin.firestore();
  const controlRef = db.doc('_control/temporalRelease');
  async function readProofs(types, tx) {
    const get = (ref) => (tx ? tx.get(ref) : ref.get());
    const proofs = [];
    for (const type of types) {
      const entity = (
        await get(
          db
            .collection('durableJobEntities')
            .doc(durableEntityKey(options.projectId, { type: 'bundle', id: type }, 'bundle.regenerate'))
        )
      ).data();
      const job = entity?.activeJobId
        ? (await get(db.collection('durableJobs').doc(entity.activeJobId))).data()
        : undefined;
      const pointer = (await get(db.collection('_durableBundlePointers').doc(type))).data();
      proofs.push({ entity, job, pointer });
    }
    return proofs;
  }
  return {
    readControl: async () => (await controlRef.get()).data(),
    submit: submitServerDurableJob,
    readProofs,
    async readArtifact(path) {
      const file = admin.storage().bucket().file(path);
      try {
        const [m] = await file.getMetadata();
        return { exists: true, contentType: m.contentType, metadata: m.metadata, size: m.size };
      } catch (error) {
        if (error.code === 404) return { exists: false };
        throw error;
      }
    },
    confirmProofs: (expected, opts) =>
      db.runTransaction(async (tx) => {
        assertBootstrapControl((await tx.get(controlRef)).data(), opts);
        const latest = await readProofs(BUNDLE_TYPES, tx);
        return latest.every(
          (p, i) =>
            validateBundleProof(p, opts.projectId, BUNDLE_TYPES[i]) &&
            p.entity.activeJobId === expected[i].entity.activeJobId &&
            p.entity.generation === expected[i].entity.generation &&
            p.pointer.storagePath === expected[i].pointer.storagePath &&
            p.pointer.count === expected[i].pointer.count
        );
      }),
  };
}
export function parseBootstrapArgs(args) {
  if (!args.includes('--apply') || args.filter((v) => v === '--apply').length !== 1)
    throw fail('BOOTSTRAP_APPLY_REQUIRED');
  args = args.filter((v) => v !== '--apply');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--project', '--release-id', '--control-revision', '--timeout-ms'].includes(args[i]) ||
      !args[i + 1] ||
      values[args[i]]
    )
      throw fail('INVALID_BOOTSTRAP_ARGUMENTS');
    values[args[i]] = args[i + 1];
  }
  const options = {
    projectId: values['--project'],
    releaseId: values['--release-id'],
    controlRevision: Number(values['--control-revision']),
  };
  if (values['--timeout-ms'] !== undefined) {
    options.timeoutMs = Number(values['--timeout-ms']);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60 * 60 * 1000)
      throw fail('INVALID_BOOTSTRAP_ARGUMENTS');
  }
  validateBootstrapOptions(options);
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help')
    console.log(
      'Usage: node scripts/temporal-bootstrap-bundles.mjs --project PROJECT --release-id UUID --control-revision N --apply [--timeout-ms N]\nRelease controller --apply only; requires matching paused private control. Waits up to 20 minutes for six immutable bundle artifacts.'
    );
  else {
    try {
      const options = parseBootstrapArgs(process.argv.slice(2));
      const result = await runBundleBootstrap(options, await firebaseDependencies(options));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(/^BOOTSTRAP_|^INVALID_BOOTSTRAP_/.test(error.code ?? '') ? error.code : 'BOOTSTRAP_FAILED');
      process.exitCode = 1;
    }
  }
}
