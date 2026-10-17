/** Source-pinned leaf loader. No application bootstrap, Firebase default app or provider transport. */
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('OWNED_SMOKE_' + code), { code: 'OWNED_SMOKE_' + code });
};
const publishing = 'functions/src/temporal/publishing/';
const allowed = new Set([
  ...[
    'criticalRepair',
    'criticalRepairCatalog',
    'criticalAcknowledgedRepair',
    'acknowledgedProjectionDigest',
    'providerMutationGuard',
    'providerReceipts',
    'allocationBarrier',
  ].map((n) => publishing + n + '.ts'),
  'packages/contracts/temporal.ts',
  'packages/orchestration/src/job-store.ts',
  'packages/orchestration/src/provider-usage.ts',
  'packages/orchestration/src/provider-transaction.ts',
  'functions/src/providerSandbox/profile.ts',
  'functions/src/providerSandbox/store.ts',
  'function-kits/firestore-send-email/src/temporal/delivery.ts',
  'function-kits/firestore-send-email/src/temporal/secure-options.ts',
]);
export function loadOwnedSmokeRuntime(binding) {
  need(binding.runtimeCommit === incident.runtimeCommit, 'RUNTIME_COMMIT_CHANGED');
  const root = resolve(binding.runtimeRoot),
    require = createRequire(root + '/functions/package.json'),
    ts = require('typescript'),
    cache = new Map();
  // Missing leaf dependencies are unavailable, never successful guard substitutes. The selected
  // readonly functions and store factory have an actual-source integration test for their closure.
  const readPinned = (file) => {
    const path = resolve(root, file);
    need(path.startsWith(root + '/'), 'RUNTIME_IMPORT_OUTSIDE_ROOT');
    const stat = lstatSync(path),
      bytes = readFileSync(path);
    need(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        bytes.equals(
          execFileSync('git', ['show', `${binding.runtimeCommit}:${file}`], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        ),
      'RUNTIME_SOURCE_CHANGED'
    );
    return bytes;
  };
  const unavailable = (name, target) => {
    // Read literal exported routing constants from their actual pinned source without evaluating
    // application bootstrap or mutation code. Nonliteral values and every callable stay unavailable.
    const values = {};
    if (target && target.endsWith('.ts')) {
      let source;
      try {
        source = readPinned(target).toString('utf8');
      } catch {
        throw Object.assign(new Error('OWNED_SMOKE_RUNTIME_DEPENDENCY_UNVERIFIED'), {
          code: 'OWNED_SMOKE_RUNTIME_DEPENDENCY_UNVERIFIED',
        });
      }
      const ast = ts.createSourceFile(target, source, ts.ScriptTarget.ES2022, true);
      for (const statement of ast.statements)
        if (
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        )
          for (const d of statement.declarationList.declarations) {
            let value = d.initializer;
            while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
            if (ts.isIdentifier(d.name) && value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value)))
              values[d.name.text] = ts.isStringLiteral(value) ? value.text : Number(value.text);
          }
    }
    return new Proxy(Object.freeze(values), {
      get(target, key) {
        if (key === '__esModule') return false;
        if (Object.hasOwn(target, key)) return target[key];
        throw Object.assign(new Error('OWNED_SMOKE_UNAVAILABLE_RUNTIME_DEPENDENCY'), {
          code: 'OWNED_SMOKE_UNAVAILABLE_RUNTIME_DEPENDENCY',
        });
      },
    });
  };
  function load(file) {
    need(allowed.has(file), 'RUNTIME_MODULE_NOT_ALLOWED');
    if (cache.has(file)) return cache.get(file);
    const path = resolve(root, file),
      bytes = readPinned(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(bytes.toString('utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText;
    vm.runInThisContext('(function(exports,require){' + code + '\n})', { filename: 'owned-runtime:' + file })(
      exports,
      (name) => {
        if (name === 'node:crypto') return crypto;
        if (name === 'firebase-admin/firestore') return require(name);
        if (name === 'firebase-functions/v2/https') return require(name);
        let target;
        if (name.startsWith('@upperroom/contracts/'))
          target = 'packages/contracts/' + name.slice('@upperroom/contracts/'.length) + '.ts';
        else if (name.startsWith('@upperroom/orchestration/'))
          target = 'packages/orchestration/src/' + name.slice('@upperroom/orchestration/'.length) + '.ts';
        else if (name.startsWith('.')) target = resolve(dirname(path), name + '.ts').slice(root.length + 1);
        if (target && allowed.has(target)) return load(target);
        return unavailable(name, target);
      }
    );
    return exports;
  }
  const all = Object.assign(
    {},
    load('packages/orchestration/src/job-store.ts'),
    load('packages/orchestration/src/provider-usage.ts'),
    ...[
      'criticalRepairCatalog',
      'criticalAcknowledgedRepair',
      'criticalRepair',
      'providerMutationGuard',
      'providerReceipts',
      'allocationBarrier',
    ].map((n) => load(publishing + n + '.ts')),
    load('functions/src/providerSandbox/profile.ts'),
    load('functions/src/providerSandbox/store.ts'),
    load('function-kits/firestore-send-email/src/temporal/delivery.ts'),
    load('function-kits/firestore-send-email/src/temporal/secure-options.ts')
  );
  const names = [
    'createDurableJobStore',
    'durableEntityKey',
    'extractProviderResources',
    'providerResourceKey',
    'providerEdgeKey',
    'loadValidatedPublishingCriticalRepairCertificate',
    'publishingCriticalRepairDigest',
    'readCertifiedCriticalRepairOperations',
    'validateCertifiedCriticalRepairOperation',
    'validateAcknowledgedProjectionEvidence',
    'readAcknowledgedProjectionFragments',
    'acknowledgedProjectionDigest',
    'listProviderReceiptsForJob',
    'listProviderAcknowledgementsForJob',
    'sameResourceAcknowledgementProvesReceipt',
    'providerReceiptId',
    'providerPayloadFingerprint',
    'sandboxResourceKey',
    'assertSandboxCatalogReady',
    'STAGING_SANDBOX_PROFILE',
    'readOriginalProviderMutationAcknowledgement',
    'capturePublishingAllocationSource',
    'emailMessageId',
    'secureMailOptions',
  ];
  need(
    names.every((k) => (k === 'STAGING_SANDBOX_PROFILE' ? all[k] : typeof all[k] === 'function')),
    'RUNTIME_EXPORT_REQUIRED'
  );
  return Object.freeze(Object.fromEntries(names.map((k) => [k, all[k]])));
}
