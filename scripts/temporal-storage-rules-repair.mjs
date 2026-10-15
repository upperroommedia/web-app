#!/usr/bin/env node
/** A rules-only compatibility repair; it never advances or rewrites the application release. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateReleaseConfig, validateControl, CONTROL_PATH } from './temporal-release-lib.mjs';
import { DEPLOY_LOCK_PATH, DEPLOY_STATE_PATH, runGuardedCommand } from './temporal-deploy-guard.mjs';
import {
  pinReleaseCheckouts,
  loadReleaseResourceBinding,
  assertReleaseRuntimeSource,
  prepareLocalReleaseADC,
  verifyReleaseOperator,
  verifyReleaseResourceIdentity,
  nativeSnapshotProof,
  assertNativeSnapshot,
  hash,
  proofDigest,
} from './temporal-release-runtime.mjs';
import { runWithCleanup } from './temporal-release-resources.mjs';
const fail = (code) => Object.assign(new Error(code), { code });
const oldKind = ".data.kind == 'upload.source.start'";
const newKind = ".data.kind == 'upload.create'";
const sha = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
export function buildStorageRulesRepairPlan({
  release,
  revision,
  runtimeCommit,
  operatorCommit,
  originalRules,
  desiredSHA256,
  bucket,
  expectedRuleset,
}) {
  if (release?.projectId !== 'urm-app-staging' || release.environment !== 'staging')
    throw fail('STORAGE_RULES_REPAIR_STAGING_ONLY');
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[a-f0-9]{40}$/.test(runtimeCommit ?? '') ||
    !/^[a-f0-9]{40}$/.test(operatorCommit ?? '') ||
    runtimeCommit !== release.compatibilityCommit
  )
    throw fail('STORAGE_RULES_REPAIR_SOURCE_MISMATCH');
  if (
    bucket !== 'urm-app-staging.firebasestorage.app' ||
    !/^projects\/urm-app-staging\/rulesets\/[A-Za-z0-9_-]+$/.test(expectedRuleset ?? '')
  )
    throw fail('STORAGE_RULES_REPAIR_RESOURCE_MISMATCH');
  if (typeof originalRules !== 'string' || originalRules.split(oldKind).length !== 2 || originalRules.includes(newKind))
    throw fail('STORAGE_RULES_REPAIR_BASELINE_MISMATCH');
  const repairedRules = originalRules.replace(oldKind, newKind);
  if (!sha(desiredSHA256) || hash(repairedRules) !== desiredSHA256)
    throw fail('STORAGE_RULES_REPAIR_ARTIFACT_MISMATCH');
  return {
    schemaVersion: 1,
    projectId: release.projectId,
    releaseId: release.releaseId,
    revision,
    runtimeCommit,
    operatorCommit,
    bucket,
    expectedRuleset,
    beforeSHA256: hash(originalRules),
    afterSHA256: desiredSHA256,
    originalRules,
    repairedRules,
  };
}
export function assertStorageRulesRepairAuthority(control, state, release, revision) {
  validateControl(control);
  if (
    control.releaseId !== release.releaseId ||
    control.revision !== revision ||
    control.admission !== 'paused' ||
    state?.releaseId !== release.releaseId ||
    state.controlRevision !== revision ||
    state.phase !== 'paused-for-recovery' ||
    !['open', 'complete'].includes(state.pausedFrom) ||
    state.mode !== release.mode ||
    state.compatibilityCommit !== release.compatibilityCommit ||
    state.uiCommit !== release.uiCommit ||
    JSON.stringify(state.domains) !== JSON.stringify(release.domains) ||
    release.domains.some(
      (domain) => control.domains[domain]?.admission !== 'paused' || control.domains[domain]?.owner !== 'temporal'
    )
  )
    throw fail('STORAGE_RULES_REPAIR_AUTHORITY_MISMATCH');
}
export function verifyStorageRulesObservation(observation, plan, content, expectedRuleset) {
  const releaseName = `projects/${plan.projectId}/releases/firebase.storage/${plan.bucket}`;
  const rule = observation?.release,
    set = observation?.ruleset,
    files = set?.source?.files;
  const prefix = `projects/${plan.projectId}/rulesets/`;
  const validRuleset =
    typeof rule?.rulesetName === 'string' &&
    rule.rulesetName.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/.test(rule.rulesetName.slice(prefix.length));
  if (
    rule?.name !== releaseName ||
    !validRuleset ||
    set?.name !== rule.rulesetName ||
    (expectedRuleset && rule.rulesetName !== expectedRuleset) ||
    !Array.isArray(files) ||
    files.length !== 1 ||
    files[0].name !== 'storage.rules' ||
    files[0].content !== content
  )
    throw fail('STORAGE_RULES_REPAIR_LIVE_RULES_MISMATCH');
  return {
    releaseName: rule.name,
    rulesetName: set.name,
    releaseUpdateTime: rule.updateTime ?? null,
    rulesetCreateTime: set.createTime ?? null,
    sourceSHA256: hash(files[0].content),
  };
}
/** All cloud seams are explicit; every Firestore write is confined to the owned lock and immutable audit. */
export async function repairStorageRules({
  db,
  release,
  plan,
  operationId,
  evidence,
  readRules,
  deploy,
  now = Date.now,
}) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId ?? ''))
    throw fail('STORAGE_RULES_REPAIR_OPERATION_REQUIRED');
  if (
    proofDigest(
      buildStorageRulesRepairPlan({
        release,
        revision: plan.revision,
        runtimeCommit: plan.runtimeCommit,
        operatorCommit: plan.operatorCommit,
        originalRules: plan.originalRules,
        desiredSHA256: plan.afterSHA256,
        bucket: plan.bucket,
        expectedRuleset: plan.expectedRuleset,
      })
    ) !== proofDigest(plan)
  )
    throw fail('STORAGE_RULES_REPAIR_PLAN_CHANGED');
  const controlRef = db.doc(CONTROL_PATH),
    stateRef = db.doc(DEPLOY_STATE_PATH),
    lockRef = db.doc(DEPLOY_LOCK_PATH),
    auditRef = db.doc(`_control/temporalStorageRulesRepair-${operationId}`);
  const before = verifyStorageRulesObservation(await readRules(), plan, plan.originalRules, plan.expectedRuleset);
  let authority, lockData;
  await db.runTransaction(async (tx) => {
    const [control, state, lock, audit] = await Promise.all([
      tx.get(controlRef),
      tx.get(stateRef),
      tx.get(lockRef),
      tx.get(auditRef),
    ]);
    assertStorageRulesRepairAuthority(control.data(), state.data(), release, plan.revision);
    if (lock.exists || audit.exists) throw fail('STORAGE_RULES_REPAIR_OPERATION_HELD');
    authority = { control: nativeSnapshotProof(control), state: nativeSnapshotProof(state) };
    lockData = {
      schemaVersion: 1,
      operationId,
      action: 'controlled-storage-rules-repair',
      releaseId: plan.releaseId,
      planDigest: proofDigest(plan),
      repair: {
        bucket: plan.bucket,
        beforeSHA256: plan.beforeSHA256,
        afterSHA256: plan.afterSHA256,
        expectedRuleset: plan.expectedRuleset,
      },
      authority,
      before,
      evidence,
      createdAtMillis: now(),
    };
    tx.create(lockRef, lockData);
  });
  // No finally-unlock: a failed CLI or unknown acknowledgement retains this exact operation for inspection.
  const lock = await lockRef.get();
  if (proofDigest(lock.data()) !== proofDigest(lockData)) throw fail('STORAGE_RULES_REPAIR_OPERATION_CHANGED');
  const nativeLock = nativeSnapshotProof(lock);
  const assertOwned = async (tx) => {
    const [control, state, current] = await Promise.all([tx.get(controlRef), tx.get(stateRef), tx.get(lockRef)]);
    assertStorageRulesRepairAuthority(control.data(), state.data(), release, plan.revision);
    assertNativeSnapshot(authority.control, control);
    assertNativeSnapshot(authority.state, state);
    assertNativeSnapshot(nativeLock, current);
  };
  verifyStorageRulesObservation(await readRules(), plan, plan.originalRules, plan.expectedRuleset);
  await db.runTransaction(assertOwned);
  await deploy();
  const observedAt = now(),
    after = verifyStorageRulesObservation(await readRules(), plan, plan.repairedRules);
  await db.runTransaction(async (tx) => {
    await assertOwned(tx);
    const audit = await tx.get(auditRef);
    if (audit.exists || now() - observedAt > 60000 || now() < observedAt)
      throw fail('STORAGE_RULES_REPAIR_FINAL_PROOF_CHANGED');
    tx.create(auditRef, {
      schemaVersion: 1,
      operationId,
      action: 'controlled-storage-rules-repair',
      releaseId: plan.releaseId,
      runtimeCommit: plan.runtimeCommit,
      operatorCommit: plan.operatorCommit,
      planDigest: proofDigest(plan),
      before,
      after,
      authority,
      nativeOperation: nativeLock,
      evidence,
      completedAtMillis: now(),
      releaseStateWrites: 0,
      jobWrites: 0,
    });
    tx.delete(lockRef);
  });
  return { operationId, releaseId: plan.releaseId, revision: plan.revision, before, after, auditPath: auditRef.path };
}
export function storageRulesRepairFirebaseConfig(bucket) {
  if (bucket !== 'urm-app-staging.firebasestorage.app') throw fail('STORAGE_RULES_REPAIR_RESOURCE_MISMATCH');
  return { storage: [{ bucket, rules: 'storage.rules' }] };
}
export function parseStorageRulesRepairArgs(args) {
  const allowed = new Set([
      '--project',
      '--release',
      '--runtime-root',
      '--repair-commit',
      '--rules-sha256',
      '--expected-ruleset',
      '--revision',
      '--operation-id',
      '--output',
    ]),
    values = {};
  const apply = args.includes('--apply'),
    inspect = args.includes('--inspect');
  for (let i = 0; i < args.length; i++) {
    if (['--storage-rules-repair', '--apply', '--inspect'].includes(args[i])) continue;
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || values[args[i]] !== undefined)
      throw fail('STORAGE_RULES_REPAIR_ARGUMENTS_INVALID');
    values[args[i]] = args[++i];
  }
  if (
    apply === inspect ||
    [...allowed].filter((flag) => flag !== '--operation-id').some((flag) => !values[flag]) ||
    (apply && !values['--operation-id']) ||
    values['--project'] !== 'urm-app-staging' ||
    !/^[a-f0-9]{40}$/.test(values['--repair-commit']) ||
    !sha(values['--rules-sha256']) ||
    !Number.isSafeInteger(Number(values['--revision'])) ||
    Number(values['--revision']) < 1
  )
    throw fail('STORAGE_RULES_REPAIR_ARGUMENTS_INVALID');
  return {
    apply,
    project: values['--project'],
    releasePath: resolve(values['--release']),
    runtimeRoot: resolve(values['--runtime-root']),
    repairCommit: values['--repair-commit'],
    desiredSHA256: values['--rules-sha256'],
    expectedRuleset: values['--expected-ruleset'],
    revision: Number(values['--revision']),
    operationId: values['--operation-id'],
    output: resolve(values['--output']),
  };
}
export async function main(args = process.argv.slice(2)) {
  const options = parseStorageRulesRepairArgs(args);
  if (Object.entries(process.env).some(([key, value]) => key.includes('EMULATOR') && value))
    throw fail('STORAGE_RULES_REPAIR_EMULATOR_FORBIDDEN');
  const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url))),
    descriptorBytes = readFileSync(options.releasePath),
    release = validateReleaseConfig(JSON.parse(descriptorBytes));
  if (release.projectId !== options.project || release.environment !== 'staging')
    throw fail('STORAGE_RULES_REPAIR_STAGING_ONLY');
  const binding = pinReleaseCheckouts(operatorRoot, options.runtimeRoot, release),
    resourceBinding = loadReleaseResourceBinding(release);
  if (binding.operatorCommit !== options.repairCommit) throw fail('STORAGE_RULES_REPAIR_SOURCE_MISMATCH');
  const originalRules = execFileSync('git', ['show', `${binding.runtimeCommit}:storage.rules`], {
    cwd: binding.runtimeRoot,
    encoding: 'utf8',
  });
  const plan = buildStorageRulesRepairPlan({
    release,
    revision: options.revision,
    runtimeCommit: binding.runtimeCommit,
    operatorCommit: binding.operatorCommit,
    originalRules,
    desiredSHA256: options.desiredSHA256,
    bucket: resourceBinding.resources.storageBucket,
    expectedRuleset: options.expectedRuleset,
  });
  const output = openSync(options.output, 'wx', 0o600);
  let adc, app, db, temp, sdk;
  const require = createRequire(resolve(operatorRoot, 'functions/package.json'));
  const assertBinding = () => {
    if (proofDigest(pinReleaseCheckouts(operatorRoot, options.runtimeRoot, release)) !== proofDigest(binding))
      throw fail('STORAGE_RULES_REPAIR_SOURCE_MISMATCH');
  };
  try {
    await runWithCleanup(
      async () => {
        sdk = require('firebase-admin/app');
        if (sdk.getApps().length) throw fail('STORAGE_RULES_REPAIR_STANDALONE_SDK_REQUIRED');
        adc = prepareLocalReleaseADC(operatorRoot, options.project);
        app = sdk.initializeApp({ projectId: options.project, credential: adc.credential });
        db = require('firebase-admin/firestore').getFirestore(app);
        const control = await db.doc(CONTROL_PATH).get();
        await assertReleaseRuntimeSource(binding, release, control.data());
        const principal = await verifyReleaseOperator(binding, adc.credential);
        const api = async (url) => {
          const token = await adc.credential.getAccessToken(),
            response = await fetch(url, {
              headers: { Authorization: `Bearer ${token.access_token}`, 'X-Goog-User-Project': options.project },
              signal: AbortSignal.timeout(60000),
            });
          if (!response.ok) throw fail(`STORAGE_RULES_REPAIR_API_${response.status}`);
          return response.json();
        };
        const resourceIdentity = await verifyReleaseResourceIdentity(resourceBinding, api);
        const readRules = async () => {
          const live = await api(
            `https://firebaserules.googleapis.com/v1/projects/${options.project}/releases/firebase.storage/${plan.bucket}`
          );
          if (!/^projects\/urm-app-staging\/rulesets\/[A-Za-z0-9_-]+$/.test(live.rulesetName ?? ''))
            throw fail('STORAGE_RULES_REPAIR_RESOURCE_MISMATCH');
          return { release: live, ruleset: await api(`https://firebaserules.googleapis.com/v1/${live.rulesetName}`) };
        };
        const evidence = {
          descriptorSHA256: hash(descriptorBytes),
          operatorCommit: binding.operatorCommit,
          operatorClosureDigest: binding.operatorClosureDigest,
          runtimeCommit: binding.runtimeCommit,
          resourceIdentity,
          principal,
        };
        let result;
        if (!options.apply) {
          const [current, state, lock] = await Promise.all([
            db.doc(CONTROL_PATH).get(),
            db.doc(DEPLOY_STATE_PATH).get(),
            db.doc(DEPLOY_LOCK_PATH).get(),
          ]);
          assertStorageRulesRepairAuthority(current.data(), state.data(), release, options.revision);
          const observation = await readRules();
          let classification;
          try {
            verifyStorageRulesObservation(observation, plan, plan.originalRules, plan.expectedRuleset);
            classification = 'original';
          } catch {
            verifyStorageRulesObservation(observation, plan, plan.repairedRules);
            classification = 'repaired';
          }
          const [finalControl, finalState, finalLock] = await Promise.all([
            db.doc(CONTROL_PATH).get(),
            db.doc(DEPLOY_STATE_PATH).get(),
            db.doc(DEPLOY_LOCK_PATH).get(),
          ]);
          assertNativeSnapshot(nativeSnapshotProof(current), finalControl);
          assertNativeSnapshot(nativeSnapshotProof(state), finalState);
          if (lock.exists !== finalLock.exists) throw fail('STORAGE_RULES_REPAIR_OPERATION_CHANGED');
          if (lock.exists) assertNativeSnapshot(nativeSnapshotProof(lock), finalLock);
          result = {
            mode: 'inspect',
            classification,
            plan: { ...plan, originalRules: undefined, repairedRules: undefined },
            evidence,
            liveRules: observation,
            authority: { control: nativeSnapshotProof(current), state: nativeSnapshotProof(state) },
            operation: lock.exists ? { data: lock.data(), native: nativeSnapshotProof(lock) } : null,
          };
        } else {
          temp = mkdtempSync(join(tmpdir(), 'urm-storage-rules-repair-'));
          const rulesPath = join(temp, 'storage.rules'),
            configPath = join(temp, 'firebase.json');
          writeFileSync(rulesPath, plan.repairedRules, { mode: 0o600 });
          writeFileSync(configPath, JSON.stringify(storageRulesRepairFirebaseConfig(plan.bucket)), {
            mode: 0o600,
          });
          const cli = createRequire(resolve(binding.runtimeRoot, 'package.json')).resolve(
            'firebase-tools/lib/bin/firebase.js'
          );
          evidence.firebaseCLI = { path: cli, sha256: hash(readFileSync(cli)) };
          result = await repairStorageRules({
            db,
            release,
            plan,
            operationId: options.operationId,
            evidence,
            readRules,
            deploy: async () => {
              assertBinding();
              await assertReleaseRuntimeSource(binding, release, (await db.doc(CONTROL_PATH).get()).data());
              await runGuardedCommand(process.execPath, [
                cli,
                'deploy',
                '--project',
                options.project,
                '--config',
                configPath,
                '--only',
                'storage',
                '--non-interactive',
              ]);
              assertBinding();
              await assertReleaseRuntimeSource(binding, release, (await db.doc(CONTROL_PATH).get()).data());
            },
          });
        }
        writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
      },
      async () => {
        let failures = 0;
        for (const cleanup of [
          () => db?.terminate(),
          () => app && sdk.deleteApp(app),
          () => adc?.close(),
          () => temp && rmSync(temp, { recursive: true, force: true }),
        ])
          try {
            await cleanup();
          } catch {
            failures++;
          }
        if (failures) throw fail('STORAGE_RULES_REPAIR_CLEANUP_FAILED');
      }
    );
  } catch (error) {
    writeFileSync(
      output,
      JSON.stringify({
        result: 'failed',
        operationId: options.operationId ?? null,
        requiresInspection: options.apply,
        code: /^(STORAGE_RULES_REPAIR_|RELEASE_)[A-Z0-9_]+$/.test(error.code ?? '')
          ? error.code
          : 'STORAGE_RULES_REPAIR_FAILED',
      }) + '\n'
    );
    throw error;
  } finally {
    closeSync(output);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      /^(STORAGE_RULES_REPAIR_|RELEASE_)[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'STORAGE_RULES_REPAIR_FAILED'
    );
    process.exitCode = 1;
  });
