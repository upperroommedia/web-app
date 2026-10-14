import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSandboxImportArgs } from './temporal-import-provider-sandbox.mjs';
test('inspect requires exact reviewed release/revision/fixture and a fresh output selector', () => {
  const value = parseSandboxImportArgs([
    '--inspect',
    '--release',
    '/private/release.json',
    '--revision',
    '2',
    '--fixture',
    '/private/fixture.json',
    '--output',
    '/private/plan.json',
  ]);
  assert.equal(value.mode, 'inspect');
  assert.equal(value.revision, 2);
});
test('apply requires reviewed plan and explicit owned operation identity', () => {
  const value = parseSandboxImportArgs([
    '--apply',
    '--release',
    '/private/release.json',
    '--revision',
    '2',
    '--plan',
    '/private/plan.json',
    '--operation-id',
    'a801c079-a832-4bfa-a526-ec385e49d27f',
    '--output',
    '/private/result.json',
  ]);
  assert.equal(value.mode, 'apply');
  assert.equal(value.planPath, '/private/plan.json');
});
test('unknown/ambiguous modes, missing authority and duplicate selectors fail before SDK setup', () => {
  for (const args of [
    [],
    ['--apply', '--inspect'],
    ['--inspect', '--release', 'r', '--revision', '-1', '--fixture', 'f', '--output', 'o'],
    ['--inspect', '--release', 'r', '--revision', '1', '--fixture', 'f', '--output', 'o', '--output', 'other'],
    ['--apply', '--release', 'r', '--revision', '1', '--plan', 'p', '--output', 'o'],
  ])
    assert.throws(() => parseSandboxImportArgs(args));
});
