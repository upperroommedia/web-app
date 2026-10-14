#!/usr/bin/env node
// Operator release recovery only: never resurrect terminal jobs or change release state.
import { readFileSync, writeFileSync, openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validateReleaseConfig } from './temporal-release-lib.mjs';
import {
  assertRecoveryAuthority,
  assertPlan,
  createRecoveryStore,
  makeRecoveryPlan,
  recoverBundleBootstrap,
  digest,
} from './temporal-bundle-bootstrap-recovery.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fail = (code) => Object.assign(new Error(code), { code });
export function parseRecoveryArgs(args) {
  const [mode, ...pairs] = args;
  if (!['inspect', 'apply', 'resume'].includes(mode) || pairs.length % 2) throw fail('BUNDLE_RECOVERY_OPTIONS_INVALID');
  const values = {};
  for (let i = 0; i < pairs.length; i += 2) {
    if (
      ![
        '--release',
        '--runtime-root',
        '--control-revision',
        '--reason',
        '--evidence-reference',
        '--output',
        '--recovery-id',
        '--operation-id',
      ].includes(pairs[i]) ||
      !pairs[i + 1] ||
      values[pairs[i]] !== undefined
    )
      throw fail('BUNDLE_RECOVERY_OPTIONS_INVALID');
    values[pairs[i]] = pairs[i + 1];
  }
  if (!values['--release'] || !values['--output'] || !/^\d+$/.test(values['--control-revision'] ?? ''))
    throw fail('BUNDLE_RECOVERY_OPTIONS_INVALID');
  const revision = Number(values['--control-revision']);
  if (!Number.isSafeInteger(revision) || revision < 1) throw fail('BUNDLE_RECOVERY_OPTIONS_INVALID');
  if (
    mode === 'resume' &&
    (!/^[a-f0-9]{64}$/.test(values['--recovery-id'] ?? '') || !/^[a-f0-9-]{36}$/.test(values['--operation-id'] ?? ''))
  )
    throw fail('BUNDLE_RECOVERY_EXPLICIT_RESUME_REQUIRED');
  if (mode !== 'resume' && (values['--operation-id'] || values['--recovery-id']))
    throw fail('BUNDLE_RECOVERY_OPTIONS_INVALID');
  if (mode !== 'inspect' && (!values['--reason']?.trim() || !values['--evidence-reference']?.trim()))
    throw fail('BUNDLE_RECOVERY_OPERATOR_REVIEW_REQUIRED');
  return {
    mode,
    releasePath: resolve(values['--release']),
    runtimeRoot: resolve(values['--runtime-root'] ?? root),
    controlRevision: revision,
    reason: values['--reason'],
    evidenceReference: values['--evidence-reference'],
    output: resolve(values['--output']),
    recoveryId: values['--recovery-id'],
    operationId: values['--operation-id'],
  };
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function pinRecoveryRuntime(
  runtimeRoot,
  config,
  {
    git = (args) =>
      execFileSync('git', args, { cwd: runtimeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  } = {}
) {
  if (git(['rev-parse', 'HEAD']).trim() !== config.compatibilityCommit)
    throw fail('BUNDLE_RECOVERY_RUNTIME_COMMIT_CHANGED');
  const files = [
    'scripts/temporal-bootstrap-bundles.mjs',
    'scripts/temporal-deploy-source.mjs',
    'functions/src/temporal/bridge.ts',
    'functions/src/temporal/ownership.ts',
    'functions/src/temporal/releaseControl.ts',
    'functions/src/temporal/bundles/admission.ts',
    'packages/orchestration/src/job-store.ts',
    'packages/shared/firebase/firebaseAdmin.ts',
    'packages/shared/shared/firebaseProjectConfig.ts',
    'pnpm-lock.yaml',
  ];
  const hashes = {};
  for (const file of files) {
    const path = resolve(runtimeRoot, file);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw fail('BUNDLE_RECOVERY_RUNTIME_SOURCE_CHANGED');
    const bytes = readFileSync(path);
    if (!bytes.equals(Buffer.from(git(['show', `${config.compatibilityCommit}:${file}`]))))
      throw fail('BUNDLE_RECOVERY_RUNTIME_SOURCE_CHANGED');
    hashes[file] = sha(bytes);
  }
  return { runtimeRoot: realpathSync(runtimeRoot), runtimeCommit: config.compatibilityCommit, sourceHashes: hashes };
}
export async function verifiedGoogleOperator(credential, OAuth2Client, activeAccount) {
  try {
    const token = await credential.getAccessToken();
    // Official SDK POSTs tokeninfo with an Authorization Bearer header, never a query token.
    const info = await new OAuth2Client().getTokenInfo(token.access_token);
    if (!info.email || ![true, 'true'].includes(info.email_verified))
      throw fail('BUNDLE_RECOVERY_OPERATOR_IDENTITY_UNVERIFIED');
    let gcloudActiveAccount = null;
    try {
      gcloudActiveAccount = activeAccount?.() || null;
    } catch {}
    return {
      email: info.email,
      subject: typeof info.sub === 'string' ? info.sub : null,
      verified: true,
      authority: 'google-adc-and-target-firestore-iam',
      gcloudActiveAccount,
      adcAndGcloudAccountMatch: gcloudActiveAccount ? gcloudActiveAccount === info.email : null,
      firebaseAuthUid: null,
    };
  } catch {
    throw fail('BUNDLE_RECOVERY_OPERATOR_IDENTITY_UNVERIFIED');
  }
}
export async function main(args) {
  const options = parseRecoveryArgs(args);
  if (Object.keys(process.env).some((k) => /EMULATOR/.test(k) && process.env[k]))
    throw fail('BUNDLE_RECOVERY_EMULATOR_FORBIDDEN');
  const descriptorBytes = readFileSync(options.releasePath),
    config = { ...validateReleaseConfig(JSON.parse(descriptorBytes)), controlRevision: options.controlRevision };
  const runtime = pinRecoveryRuntime(options.runtimeRoot, config);
  // The operator itself must also be a committed artifact; it is never labelled as the old runtime.
  const operatorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const file of [
    'scripts/temporal-recover-bundle-bootstrap.mjs',
    'scripts/temporal-bundle-bootstrap-recovery.mjs',
  ]) {
    const pinned = execFileSync('git', ['show', `${operatorCommit}:${file}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!readFileSync(resolve(root, file)).equals(pinned)) throw fail('BUNDLE_RECOVERY_OPERATOR_SOURCE_NOT_COMMITTED');
  }
  const { assertCheckoutSource } = await import(
    pathToFileURL(resolve(options.runtimeRoot, 'scripts/temporal-deploy-source.mjs')).href
  );
  const expected = {
    schemaVersion: 1,
    revision: config.controlRevision,
    releaseId: config.releaseId,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { owner: config.domains.includes(d) ? 'temporal' : 'legacy', admission: 'paused' },
      ])
    ),
  };
  assertCheckoutSource(options.runtimeRoot, config.compatibilityCommit, {
    project: config.projectId,
    control: expected,
  });
  const { isolateFirebaseEnvironment } = await import(
    pathToFileURL(resolve(options.runtimeRoot, 'scripts/temporal-bootstrap-bundles.mjs')).href
  );
  isolateFirebaseEnvironment(config.projectId);
  const require = createRequire(resolve(options.runtimeRoot, 'functions/package.json'));
  require('ts-node').register({
    project: resolve(options.runtimeRoot, 'functions/tsconfig.json'),
    transpileOnly: true,
  });
  require('tsconfig-paths').register({
    baseUrl: resolve(options.runtimeRoot, 'functions'),
    paths: {
      '@upperroom/contracts/*': ['../packages/contracts/*'],
      '@upperroom/shared/*': ['../packages/shared/*'],
      '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
    },
  });
  const selectors = require(resolve(options.runtimeRoot, 'packages/shared/shared/firebaseProjectConfig.ts'));
  if (
    selectors.getFirebaseProjectId() !== config.projectId ||
    selectors.getFirebaseDatabaseUrl().replace(/\/+$/, '') !== config.databaseUrl?.replace(/\/+$/, '')
  )
    throw fail('BUNDLE_RECOVERY_RUNTIME_SELECTORS_CHANGED');
  const { getApps, initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore'),
    { getDatabase } = require('firebase-admin/database');
  if (getApps().length) throw fail('BUNDLE_RECOVERY_STANDALONE_SDK_REQUIRED');
  const fd = openSync(options.output, 'wx', 0o600);
  closeSync(fd);
  const credential = applicationDefault();
  let app,
    db,
    database,
    primaryError,
    result,
    operator,
    phase = 'sdk-initialization',
    cleanupFailed = false;
  try {
    app = initializeApp({
      projectId: config.projectId,
      databaseURL: config.databaseUrl,
      storageBucket: selectors.getFirebaseStorageBucket(),
      credential,
    });
    db = getFirestore(app);
    database = getDatabase(app);
    phase = 'identity';
    const { OAuth2Client } = createRequire(require.resolve('firebase-admin/app'))('google-auth-library');
    operator = await verifiedGoogleOperator(credential, OAuth2Client, () =>
      execFileSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    );
    if (options.mode !== 'inspect')
      operator = {
        ...operator,
        review: { mode: options.mode, reason: options.reason, evidenceReference: options.evidenceReference },
      };
    const runtimeEvidence = { ...runtime, operatorCommit, descriptorSha256: sha(descriptorBytes) };
    const store = createRecoveryStore({ db, config, serverTimestamp: () => FieldValue.serverTimestamp() });
    phase = 'observation';
    const observation = await store.observe();
    assertRecoveryAuthority(config, observation.authority);
    if (observation.authority.control.revision !== config.controlRevision)
      throw fail('BUNDLE_RECOVERY_EXPECTED_REVISION_CHANGED');
    assertCheckoutSource(options.runtimeRoot, config.compatibilityCommit, {
      project: config.projectId,
      control: observation.authority.control,
    });
    if (options.mode === 'inspect') {
      result = {
        schemaVersion: 1,
        result: 'read-only-recovery-inspection',
        operator,
        runtime: runtimeEvidence,
        config: { projectId: config.projectId, releaseId: config.releaseId, controlRevision: config.controlRevision },
        observation,
        remoteMutations: 0,
      };
    } else {
      let plan;
      if (options.mode === 'resume') {
        const existing = await store.readPlan(options.recoveryId);
        if (!existing.plan || existing.result) throw fail('BUNDLE_RECOVERY_RESUME_NOT_PENDING');
        plan = existing.plan.plan;
        assertPlan(config, plan);
        if (digest(plan.runtime) !== digest(runtimeEvidence)) throw fail('BUNDLE_RECOVERY_RUNTIME_EVIDENCE_CHANGED');
      } else {
        if (observation.operation) throw fail('BUNDLE_RECOVERY_EXPLICIT_RESUME_REQUIRED');
        plan = makeRecoveryPlan(
          config,
          observation,
          operator,
          options.reason,
          options.evidenceReference,
          runtimeEvidence
        );
      }
      phase = 'runtime-loading';
      const bridge = require(resolve(options.runtimeRoot, 'functions/src/temporal/bridge.ts'));
      if (typeof bridge.submitServerDurableJob !== 'function' || bridge.temporalProjectId() !== config.projectId)
        throw fail('BUNDLE_RECOVERY_RUNTIME_API_MISMATCH');
      phase = 'recovery-operation';
      result = await recoverBundleBootstrap(
        { config, plan, operationId: options.operationId, resume: options.mode === 'resume', operator },
        { ...store, submit: (args) => bridge.submitServerDurableJob(args) }
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const cleanup of [
      () => database?.goOffline(),
      () => db?.terminate(),
      () => (app ? deleteApp(app) : undefined),
    ])
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
  }
  if (primaryError || cleanupFailed) {
    const code = safeRecoveryError(primaryError ?? fail('BUNDLE_RECOVERY_SDK_CLEANUP_FAILED'));
    writeFileSync(
      options.output,
      JSON.stringify(
        {
          result: 'failed',
          code,
          phase,
          sdkCleanupFailed: cleanupFailed,
          operationMayRequireInspection: phase === 'recovery-operation',
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
    throw fail(code);
  }
  writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output: options.output, result: result.result, recoveryId: result.recoveryId ?? null }));
  return result;
}
export function safeRecoveryError(error) {
  return /^BUNDLE_RECOVERY_[A-Z_]{1,100}$/.test(error?.code ?? '')
    ? error.code
    : 'BUNDLE_RECOVERY_FAILED_INSPECT_ACTUAL_STATE';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help')
    console.log(
      'Usage: temporal-recover-bundle-bootstrap.mjs inspect|apply|resume --release FILE --control-revision N --output NEW_FILE [--runtime-root REVIEWED_CHECKOUT] [--reason TEXT --evidence-reference REF] [--recovery-id SHA --operation-id UUID]\nOperator release recovery via the unchanged trusted bundle server API; never generic terminal retry or manual state reset.'
    );
  else
    main(process.argv.slice(2)).catch((error) => {
      console.error(safeRecoveryError(error));
      process.exitCode = 1;
    });
}
