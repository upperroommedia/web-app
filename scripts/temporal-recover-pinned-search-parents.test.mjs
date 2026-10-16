// Pure bounded-parent command/policy fixtures; no SDK or native calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParentOverrideArgs } from './temporal-recover-pinned-search-parents.mjs';
import {
  ORIGINAL_PARENT_RUNS,
  ORIGINAL_PARENT_PLAN_SHA256,
  assertPinnedParentRequest,
  recover,
  createPinnedSearchRecoveryDependencies,
} from './temporal-recover-pinned-search.mjs';
import {
  validateRecoveryOperatorBindings,
  ORIGINAL_OPERATOR_COMMIT,
} from './temporal-pinned-search-operator-binding.mjs';
function args(row = ORIGINAL_PARENT_RUNS[0]) {
  return [
    'override',
    '--origin-operator-root',
    '/original/operator',
    '--old-release',
    '/old.json',
    '--target-release',
    '/target.json',
    '--target-runtime-root',
    '/original/runtime',
    '--plan',
    '/original/plan.json',
    '--plan-sha',
    ORIGINAL_PARENT_PLAN_SHA256,
    '--workflow-id',
    row.workflowId,
    '--run-id',
    row.runId,
    '--output',
    '/fresh/output.json',
    '--apply',
  ];
}
for (const row of ORIGINAL_PARENT_RUNS)
  test('only reviewed original parent ' + row.jobId + ' is selectable', () => {
    const p = parseParentOverrideArgs(args(row));
    assert.equal(p.originOperatorRoot, '/original/operator');
    assert.equal(p.options['--workflow-id'], row.workflowId);
    assert.equal(p.options['--run-id'], row.runId);
    assert.equal(p.options['--plan-sha'], ORIGINAL_PARENT_PLAN_SHA256);
  });
for (const [name, change] of Object.entries({
  inspect: (a) => (a[0] = 'inspect'),
  report: (a) => (a[0] = 'report'),
  missingApply: (a) => a.pop(),
  foreignPlan: (a) => (a[a.indexOf('--plan-sha') + 1] = 'a'.repeat(64)),
  foreignRun: (a) => (a[a.indexOf('--run-id') + 1] = '11111111-2222-4333-8444-555555555555'),
  foreignWorkflow: (a) => (a[a.indexOf('--workflow-id') + 1] = 'search:urm-app-staging:document'),
  mismatchedPair: (a) => (a[a.indexOf('--run-id') + 1] = ORIGINAL_PARENT_RUNS[1].runId),
  duplicateOrigin: (a) => a.push('--origin-operator-root', '/other'),
  duplicateApply: (a) => a.push('--apply'),
  extraAudit: (a) => a.push('--audit-id', '11111111-2222-4333-8444-555555555555'),
  unknown: (a) => a.push('--reset', 'true'),
}))
  test('parent CLI refuses ' + name + ' before any dependency/native access', () => {
    const a = args();
    change(a);
    assert.throws(() => parseParentOverrideArgs(a));
  });
test('native override operator is separately recorded from immutable original plan/runtime binding', () => {
  const origin = {
    operatorCommit: ORIGINAL_OPERATOR_COMMIT,
    runtimeCommit: ORIGINAL_OPERATOR_COMMIT,
    runtimeRoot: '/original/runtime',
    operatorClosureDigest: 'a'.repeat(64),
  };
  const current = { ...origin, operatorCommit: 'b'.repeat(40), operatorClosureDigest: 'c'.repeat(64) };
  const binding = validateRecoveryOperatorBindings(
    current,
    origin,
    { compatibilityCommit: ORIGINAL_OPERATOR_COMMIT },
    true
  );
  assert.equal(binding.operatorCommit, current.operatorCommit);
  assert.equal(binding.originalOperatorCommit, ORIGINAL_OPERATOR_COMMIT);
  assert.equal(binding.runtimeCommit, ORIGINAL_OPERATOR_COMMIT);
  for (const [a, b, c, d] of [
    [current, origin, { compatibilityCommit: 'd'.repeat(40) }, true],
    [current, origin, { compatibilityCommit: ORIGINAL_OPERATOR_COMMIT }, false],
    [{ ...current, runtimeRoot: '/foreign' }, origin, { compatibilityCommit: ORIGINAL_OPERATOR_COMMIT }, true],
  ])
    assert.throws(() => validateRecoveryOperatorBindings(a, b, c, d));
});
test('parent native extension cannot reach inspect/report or hide unknown options', async () => {
  for (const action of ['inspect', 'report'])
    await assert.rejects(
      recover({ action }, {}, {}, { nativeOperatorBinding: {} }),
      /OVERRIDE_OPTIONS_REQUIRE_OVERRIDE_ACTION/
    );
  await assert.rejects(
    recover({ action: 'override' }, {}, {}, { auditBuilder: () => ({}) }),
    /UNKNOWN_OVERRIDE_OPTION/
  );
  const p = parseParentOverrideArgs(args()).options;
  assert.throws(
    () => assertPinnedParentRequest({ ...p, '--plan-sha': 'f'.repeat(64) }),
    /EXACT_FOUR_ORIGINAL_PARENT_OVERRIDE_REQUIRED/
  );
  await assert.rejects(
    createPinnedSearchRecoveryDependencies({ ...p, action: 'report' }, { parentOverrideOnly: true }),
    /EXACT_FOUR_ORIGINAL_PARENT_OVERRIDE_REQUIRED/
  );
  await assert.rejects(
    createPinnedSearchRecoveryDependencies(p, { parentOverrideOnly: true, reportOnly: true }),
    /CONFLICTING_RECOVERY_CAPABILITIES/
  );
});
