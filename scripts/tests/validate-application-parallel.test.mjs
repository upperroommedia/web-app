import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { groupNames, groupStages, joinGroups } from '../validate-application-parallel.mjs';
import { proseOnlyDiff, validationMode } from '../application-validation-impact.mjs';
import { applicationStages, recoveryRuntimeCommand } from '../validate-application.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const expected = {
  run: '123',
  attempt: '2',
  source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), trackedDiffSha256: sha('') },
};
function fixture(change = () => {}) {
  const entries = groupNames.map((group) => {
    const stages = groupStages(group).map(({ id, name, commands }) => ({
      id,
      name,
      status: 'passed',
      commands: commands.map((cmd) => ({ argvSha256: sha(JSON.stringify(cmd)), code: 0, signal: null, elapsedMs: 1 })),
    }));
    const report = {
      source: expected.source,
      schemaVersion: 1,
      passed: true,
      stages,
      tools: {},
      startedAt: '2026-11-20T12:00:00Z',
      finishedAt: '2026-11-20T12:10:00Z',
    };
    const paths = Array.from({ length: 48 }, (_, i) => '/worker/test' + i);
    const worker = {
      schemaVersion: 1,
      passed: true,
      filters: [],
      discovery: { argv: ['--listTests', '--json', '--runInBand'], listSha256: sha(JSON.stringify(paths)) },
      suites: paths.map((path) => ({
        path,
        status: 'passed',
        exitCode: 0,
        argv: ['--runInBand', '--runTestsByPath', path],
      })),
    };
    change(group, report, worker);
    const reportBytes = Buffer.from(JSON.stringify(report));
    const receipt = { ...expected, group, reportSha256: sha(reportBytes) };
    const workerBytes = group === 'worker' ? Buffer.from(JSON.stringify(worker)) : undefined;
    if (workerBytes) receipt.workerSha256 = sha(workerBytes);
    return [group, { receipt, reportBytes, workerBytes }];
  });
  return Object.fromEntries(entries.reverse());
}

test('out-of-order groups reproduce all 19 canonical stages and command records in order and retain the complete worker bytes', () => {
  const inputs = fixture();
  const { application, workerBytes } = joinGroups(inputs, expected);
  assert.deepEqual(application.source, expected.source);
  assert.equal(application.stages.length, 19);
  assert.deepEqual(
    application.stages.map((row) => [row.id, row.commands.map((cmd) => cmd.argvSha256)]),
    applicationStages().map((stage) => [stage.id, stage.commands.map((cmd) => sha(JSON.stringify(cmd)))])
  );
  const native = application.stages.find((stage) => stage.id === 'recovery-sdk').commands.find((cmd) => cmd.parts);
  const partCommands = ['recovery-controls', 'recovery-checkpoint', 'recovery-drain', 'recovery-media']
    .flatMap((group) => groupStages(group).flatMap((stage) => stage.commands))
    .filter((cmd) => cmd.includes('demo-release-runtime'));
  assert.equal(partCommands.map((cmd) => cmd.at(-1)).join(' && '), recoveryRuntimeCommand().at(-1));
  assert.equal(native.parts.length, partCommands.length);
  assert.deepEqual(workerBytes, inputs.worker.workerBytes);
});

test('join rejects incomplete, duplicate, stale and unsuccessful receipts and worker discovery', () => {
  for (const alter of [
    (f) => delete f['recovery-drain'],
    (f) => (f.foreign = f.worker),
    (f) => (f.worker.receipt.attempt = '1'),
    (f) => (f.worker.receipt.group = 'browser'),
    (f) => (f.worker.receipt.run = '100'),
    (f) => (f.worker.workerBytes = Buffer.from('{}')),
    (f) => (f.worker.reportBytes = Buffer.from('{}')),
    (f) => (f.functions.receipt.source = { ...expected.source, tree: 'c'.repeat(40) }),
  ]) {
    const inputs = fixture();
    alter(inputs);
    assert.throws(() => joinGroups(inputs, expected));
  }
  for (const corrupt of [
    (report) => (report.passed = false),
    (report) => report.stages.pop(),
    (report) => report.stages.push(report.stages[0]),
    (report) => (report.stages[2].status = 'not-run'),
    (report) => (report.stages[0].commands[0].code = 1),
    (report) => (report.stages[0].commands[0].signal = 'SIGTERM'),
    (report) => (report.stages[0].commands = []),
    (report) => (report.stages[0].commands[0].argvSha256 = 'stale'),
    (report, worker) => worker.filters.push('subset'),
    (report, worker) => worker.suites.pop(),
    (report, worker) => (worker.suites[2] = worker.suites[3]),
  ]) {
    assert.throws(() =>
      joinGroups(
        fixture((group, report, worker) => {
          if (group === 'worker') corrupt(report, worker);
        }),
        expected
      )
    );
  }
});

test('only ordinary modifications of audited prose are fast', () => {
  const entry = ':100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' M\0';
  const name = 'docs/adr/2026-08-24-youtube-audio-acquisition.md';
  assert.equal(proseOnlyDiff(entry + name + '\0'), true);
  for (const bad of [
    '',
    entry + name,
    entry + name + '\0' + entry + 'package.json\0',
    entry + '.github/workflows/a.yml\0',
    entry + 'docs/temporal/release.md\0',
    entry.replace('100644 ', '120000 ') + name + '\0',
    entry.replace(' M\0', ' D\0') + name + '\0',
    entry + name + '\n' + '\0',
  ])
    assert.equal(proseOnlyDiff(bad), false);
});

test('impact uses the actual complete git PR graph and fails closed for mismatched commits, release events, or mixed changes', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'application-impact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'feature-base');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const path = 'docs/WEB_FIRST_LOAD_2026-10-01.md';
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, path), 'before');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'prose');
  writeFileSync(join(cwd, path), 'after');
  git('commit', '-am', 'edit');
  const head = git('rev-parse', 'HEAD');
  git('checkout', 'feature-base');
  git('merge', '--no-ff', 'prose', '-m', 'merge');
  const commit = git('rev-parse', 'HEAD'),
    pr = { base: { sha: base, ref: 'feature-base' }, head: { sha: head } };
  assert.equal(validationMode('pull_request', pr, commit, cwd), 'prose');
  for (const event of ['push', 'workflow_dispatch']) assert.equal(validationMode(event, pr, commit, cwd), 'full');
  for (const ref of ['staging', 'main'])
    assert.equal(validationMode('pull_request', { ...pr, base: { sha: base, ref } }, commit, cwd), 'full');
  assert.equal(validationMode('pull_request', pr, head, cwd), 'full');
  assert.equal(validationMode('pull_request', { ...pr, head: { sha: base } }, commit, cwd), 'full');
  // A merge-only edit has no counterpart in the PR head diff.
  writeFileSync(join(cwd, 'runtime.mjs'), 'export {}');
  git('add', '.');
  git('commit', '--amend', '--no-edit');
  assert.equal(validationMode('pull_request', pr, git('rev-parse', 'HEAD'), cwd), 'full');
});
