import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationStages, preflight, ROOT, runStages } from './validate-application.mjs';

const sharedStages = ['install', 'build-backend'];
const groupStages = {
  functions: ['functions', 'recovery-sdk', 'email-capture'],
  integration: ['integration'],
  browser: ['media-contracts', 'build-web', 'media-browser', 'cold-navigation'],
  worker: [
    'functions-startup',
    'kits-native',
    'worker',
    'media',
    'frontend',
    'audio-deployment',
    'contracts',
    'native-audio',
    'kits',
  ],
};
const cleanDiffSha256 = createHash('sha256').digest('hex');

export function validationGroups(catalog = applicationStages()) {
  const ids = [...sharedStages, ...Object.values(groupStages).flat()];
  assert.deepEqual([...ids].sort(), catalog.map(({ id }) => id).sort(), 'Parallel groups must cover every stage');
  assert.equal(new Set(ids).size, ids.length, 'Parallel groups must assign each stage once');
  return Object.fromEntries(
    Object.entries(groupStages).map(([group, stages]) => [
      group,
      catalog.filter(({ id }) => sharedStages.includes(id) || stages.includes(id)),
    ])
  );
}

export function verifyGroupSummaries(summaries, expected, groups = validationGroups()) {
  assert.deepEqual(Object.keys(summaries).sort(), Object.keys(groups).sort(), 'All parallel groups are required');
  for (const [group, stages] of Object.entries(groups)) {
    const result = summaries[group];
    assert.equal(result.schemaVersion, 1, `Unknown summary schema for ${group}`);
    assert.equal(result.passed, true, `Validation failed for ${group}`);
    assert.deepEqual(
      result.parallel,
      { run: expected.run, attempt: expected.attempt, group },
      `Wrong run for ${group}`
    );
    assert.deepEqual(
      result.source,
      { commit: expected.commit, tree: expected.tree, trackedDiffSha256: cleanDiffSha256 },
      `Wrong source for ${group}`
    );
    assert.deepEqual(
      result.stages.map(({ id }) => id),
      stages.map(({ id }) => id),
      `Wrong stage coverage for ${group}`
    );
    for (const [index, row] of result.stages.entries()) {
      assert.equal(row.status, 'passed', `Stage ${row.id} did not pass in ${group}`);
      assert.equal(row.commands.length, stages[index].commands.length, `Incomplete commands for ${row.id} in ${group}`);
      assert(
        row.commands.every(({ code, signal, error }) => code === 0 && signal === null && error === undefined),
        `Unsuccessful commands for ${row.id} in ${group}`
      );
    }
  }
}

function currentRun() {
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: commit } = process.env;
  assert.match(run ?? '', /^[1-9][0-9]*$/);
  assert.match(attempt ?? '', /^[1-9][0-9]*$/);
  assert.match(commit ?? '', /^[a-f0-9]{40}$/);
  const [head, tree] = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.equal(head, commit, 'Expected the current workflow checkout');
  assert.match(tree, /^[a-f0-9]{40}$/);
  return { run, attempt, commit, tree };
}

async function main([mode, input, ...extra]) {
  assert(input && extra.length === 0, 'Use run <group> or verify <download-directory>');
  const expected = currentRun();
  const { run, attempt, commit, tree } = expected;
  const groups = validationGroups();
  if (mode === 'run') {
    assert(Object.hasOwn(groups, input), 'Unknown application group');
    const identity = preflight();
    assert.deepEqual(identity.source, { commit, tree, trackedDiffSha256: cleanDiffSha256 }, 'Unexpected checkout');
    const summaryPath = join(ROOT, 'output/validation/application-summary.json');
    const summary = await runStages(groups[input], { ...identity, summaryPath });
    await writeFile(
      summaryPath,
      JSON.stringify({ ...summary, parallel: { run, attempt, group: input } }, null, 2) + '\n'
    );
    return;
  }

  assert.equal(mode, 'verify', 'Unknown parallel application validation mode');
  const groupsByArtifact = Object.fromEntries(
    Object.keys(groups).map((group) => [`parallel-application-${run}-${attempt}-${group}`, group])
  );
  const artifacts = await readdir(input);
  assert.deepEqual(artifacts.sort(), Object.keys(groupsByArtifact).sort(), 'Missing or unexpected parallel artifacts');
  const entries = await Promise.all(
    artifacts.map(async (artifact) => [
      groupsByArtifact[artifact],
      JSON.parse(await readFile(join(input, artifact, 'application-summary.json'), 'utf8')),
    ])
  );
  verifyGroupSummaries(Object.fromEntries(entries), expected, groups);
  console.log(`All ${artifacts.length} application groups passed for ${commit} (tree ${tree}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
