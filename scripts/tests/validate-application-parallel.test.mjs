import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { applicationStages } from '../validate-application.mjs';
import { validationGroups, verifyGroupSummaries } from '../validate-application-parallel.mjs';

const identity = { run: '19', attempt: '2', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const groups = validationGroups();

function summaries() {
  return Object.fromEntries(
    Object.entries(groups).map(([group, stages]) => [
      group,
      {
        schemaVersion: 1,
        passed: true,
        parallel: { run: identity.run, attempt: identity.attempt, group },
        source: {
          commit: identity.commit,
          tree: identity.tree,
          trackedDiffSha256: createHash('sha256').digest('hex'),
        },
        stages: stages.map(({ id, commands }) => ({
          id,
          status: 'passed',
          commands: commands.map(() => ({ code: 0, signal: null })),
        })),
      },
    ])
  );
}

test('parallel groups reuse the complete serial stage definitions and preserve prerequisite order', () => {
  const catalog = applicationStages();
  const testStages = [];
  for (const stages of Object.values(groups)) {
    assert.deepEqual(stages.slice(0, 2), catalog.slice(0, 2));
    for (const stage of stages.slice(2)) {
      assert.deepEqual(
        stage,
        catalog.find(({ id }) => id === stage.id)
      );
      testStages.push(stage.id);
    }
  }
  assert.deepEqual(
    testStages.sort(),
    catalog
      .slice(2)
      .map(({ id }) => id)
      .sort()
  );
  assert.deepEqual(groups.browser.map(({ id }) => id).slice(2), [
    'media-contracts',
    'build-web',
    'media-browser',
    'cold-navigation',
  ]);
  assert.throws(() => validationGroups([...catalog, { id: 'new-test' }]), /cover every stage/);
});

test('accepts all stages from successful jobs for the same source and attempt', () => {
  assert.doesNotThrow(() => verifyGroupSummaries(summaries(), identity));
});

test('rejects a missing group or a previous attempt even on the same commit', () => {
  const missing = summaries();
  delete missing.worker;
  assert.throws(() => verifyGroupSummaries(missing, identity), /All parallel groups are required/);
  const old = summaries();
  old.worker.parallel.attempt = '1';
  assert.throws(() => verifyGroupSummaries(old, identity), /Wrong run/);
});

test('rejects a different commit, tree or tracked diff', () => {
  for (const key of ['commit', 'tree', 'trackedDiffSha256']) {
    const results = summaries();
    results.integration.source[key] = 'f'.repeat(results.integration.source[key].length);
    assert.throws(() => verifyGroupSummaries(results, identity), /Wrong source/);
  }
});

test('rejects a skipped stage or a failed or incomplete command even if a job claims success', () => {
  const skipped = summaries();
  skipped.browser.stages.pop();
  assert.throws(() => verifyGroupSummaries(skipped, identity), /Wrong stage coverage/);
  const failed = summaries();
  failed.functions.stages.at(-1).commands[0].code = 2;
  assert.throws(() => verifyGroupSummaries(failed, identity), /Unsuccessful commands/);
  const incomplete = summaries();
  incomplete.worker.stages.at(-1).commands.pop();
  assert.throws(() => verifyGroupSummaries(incomplete, identity), /Incomplete commands/);
});
