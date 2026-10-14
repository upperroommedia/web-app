#!/usr/bin/env node
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  pinReleaseCheckouts,
  loadReleaseResourceBinding,
  loadVerifiedRuntimeApplication,
  prepareLocalReleaseADC,
  verifyReleaseOperator,
  verifyReleaseResourceIdentity,
} from './temporal-release-runtime.mjs';
import { validateReleaseConfig } from './temporal-release-lib.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseSandboxImportArgs(args) {
  const mode = args.includes('--apply') ? 'apply' : args.includes('--inspect') ? 'inspect' : undefined;
  const allowed = new Set(['--release', '--revision', '--fixture', '--plan', '--operation-id', '--output']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    if (['--apply', '--inspect'].includes(args[i])) continue;
    if (!allowed.has(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('SANDBOX_IMPORT_ARGUMENTS_INVALID');
    values[args[i]] = args[++i];
  }
  if (
    !mode ||
    (args.includes('--apply') && args.includes('--inspect')) ||
    !values['--release'] ||
    !values['--output'] ||
    !Number.isSafeInteger(Number(values['--revision'])) ||
    Number(values['--revision']) < 1 ||
    (mode === 'inspect' && !values['--fixture']) ||
    (mode === 'apply' && (!values['--plan'] || !/^[a-f0-9-]{36}$/.test(values['--operation-id'] ?? '')))
  )
    throw new Error('SANDBOX_IMPORT_ARGUMENTS_INVALID');
  return {
    mode,
    releasePath: resolve(values['--release']),
    revision: Number(values['--revision']),
    output: resolve(values['--output']),
    fixturePath: values['--fixture'] && resolve(values['--fixture']),
    planPath: values['--plan'] && resolve(values['--plan']),
    operationId: values['--operation-id'],
  };
}
export async function main(args) {
  const options = parseSandboxImportArgs(args);
  if (Object.entries(process.env).some(([key, value]) => /EMULATOR/.test(key) && value))
    throw new Error('SANDBOX_IMPORT_EMULATOR_FORBIDDEN');
  const config = validateReleaseConfig(JSON.parse(readFileSync(options.releasePath)));
  if (config.projectId !== 'urm-app-staging' || process.env.STAGING_PROVIDER_MODE !== 'sandbox')
    throw new Error('SANDBOX_IMPORT_STAGING_PROFILE_REQUIRED');
  const binding = pinReleaseCheckouts(root, root, config),
    resources = loadReleaseResourceBinding(config);
  const require = createRequire(resolve(root, 'functions/package.json')),
    sdk = require('firebase-admin/app');
  if (sdk.getApps().length) throw new Error('SANDBOX_IMPORT_STANDALONE_SDK_REQUIRED');
  const outputFd = openSync(options.output, 'wx', 0o600);
  let primaryError;
  let adc, app, db, database;
  try {
    adc = prepareLocalReleaseADC(root, config.projectId);
    app = sdk.initializeApp({
      projectId: config.projectId,
      databaseURL: resources.resources.databaseUrl,
      storageBucket: resources.resources.storageBucket,
      credential: adc.credential,
    });
    db = require('firebase-admin/firestore').getFirestore(app);
    database = require('firebase-admin/database').getDatabase(app);
    let module, profile;
    await loadVerifiedRuntimeApplication(binding, config, db, async () => {
      require('ts-node').register({ project: resolve(root, 'functions/tsconfig.json'), transpileOnly: true });
      require('tsconfig-paths').register({
        baseUrl: resolve(root, 'functions'),
        paths: {
          '@upperroom/contracts/*': ['../packages/contracts/*'],
          '@upperroom/shared/*': ['../packages/shared/*'],
          '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
        },
      });
      module = require(resolve(root, 'functions/src/providerSandbox/catalog.ts'));
      profile = require(resolve(root, 'functions/src/providerSandbox/profile.ts')).getProviderExecutionProfile(
        config.projectId
      );
    });
    const operatorPrincipal = await verifyReleaseOperator(binding, adc.credential);
    const resourceIdentity = await verifyReleaseResourceIdentity(resources, async (url) => {
      const token = await adc.credential.getAccessToken();
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('SANDBOX_IMPORT_RESOURCE_IDENTITY_FAILED');
      return response.json();
    });
    const [control, state, operation] = await Promise.all([
      db.doc('_control/temporalRelease').get(),
      db.doc('_control/temporalReleaseState').get(),
      db.doc('_control/temporalReleaseOperation').get(),
    ]);
    module.assertSandboxImportFrozen(control.data(), state.data(), config.releaseId, options.revision);
    const evidence = {
      operatorCommit: binding.operatorCommit,
      operatorClosureDigest: binding.operatorClosureDigest,
      resourceIdentity,
      operatorPrincipal,
    };
    let result;
    if (options.mode === 'inspect') {
      if (operation.exists) throw new Error('SANDBOX_IMPORT_RELEASE_OPERATION_HELD');
      const jobs = await db
        .collection('durableJobs')
        .where('state', 'in', [
          'awaiting_source',
          'queued',
          'running',
          'retrying',
          'waiting_for_auth',
          'cancel_requested',
          'reconciling',
          'needs_attention',
        ])
        .get();
      module.assertNoUnprofiledPublishingJobs(jobs.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
      const fixtureRef = JSON.parse(readFileSync(options.fixturePath));
      const fixture = await module.inspectSandboxCatalogFixture(profile, fixtureRef);
      const plan = module.buildSandboxCatalogPlan(
        profile,
        await module.readSandboxCatalogSources(db),
        fixture,
        Date.now()
      );
      result = {
        schemaVersion: 1,
        mode: 'inspect',
        plan,
        authority: { releaseId: config.releaseId, revision: options.revision },
        operatorEvidence: evidence,
        providerNetworkRequests: 0,
        canonicalWrites: 0,
      };
    } else {
      const reviewed = JSON.parse(readFileSync(options.planPath));
      if (
        reviewed.mode !== 'inspect' ||
        reviewed.authority?.releaseId !== config.releaseId ||
        reviewed.authority?.revision !== options.revision
      )
        throw new Error('SANDBOX_IMPORT_REVIEWED_AUTHORITY_CHANGED');
      result = {
        schemaVersion: 1,
        mode: 'apply',
        ...(await module.applySandboxCatalogPlan(db, reviewed.plan, {
          releaseId: config.releaseId,
          revision: options.revision,
          operationId: options.operationId,
          operator: operatorPrincipal.email,
          operatorEvidence: evidence,
        })),
        operatorEvidence: evidence,
      };
    }
    writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    primaryError = error;
    writeFileSync(
      outputFd,
      JSON.stringify({
        schemaVersion: 1,
        mode: options.mode,
        result: 'failed',
        operationId: options.operationId ?? null,
        code: /^SANDBOX_|^PROVIDER_|^RELEASE_/.test(error.code ?? error.message ?? '')
          ? error.code ?? error.message
          : 'SANDBOX_IMPORT_FAILED',
        requiresInspection: options.mode === 'apply',
      }) + '\n'
    );
    throw error;
  } finally {
    const failures = [];
    for (const close of [
      () => database?.goOffline(),
      () => db?.terminate(),
      () => app && sdk.deleteApp(app),
      () => adc?.close(),
    ])
      try {
        await close();
      } catch {
        failures.push(true);
      }
    closeSync(outputFd);
    if (failures.length) {
      if (primaryError) console.error('SANDBOX_IMPORT_SDK_CLEANUP_FAILED');
      else throw new Error('SANDBOX_IMPORT_SDK_CLEANUP_FAILED');
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      /^SANDBOX_|^PROVIDER_|^RELEASE_/.test(error.code ?? error.message ?? '')
        ? error.code ?? error.message
        : 'SANDBOX_IMPORT_FAILED'
    );
    process.exitCode = 1;
  });
