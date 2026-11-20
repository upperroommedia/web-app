// The local runner owns the canonical command catalog and process cleanup. Hosted
// groups repeat the short locked install/backend build on their own clean checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  applicationStages,
  preflight,
  recoveryRuntimeCommand,
  recoveryRuntimeParts,
  runStages,
} from './validate-application.mjs';

const groups = {
  integration: ['integration'],
  functions: ['functions-startup', 'kits-native', 'functions', 'email-capture'],
  browser: ['media-contracts', 'build-web', 'media-browser', 'cold-navigation'],
  worker: ['worker', 'media', 'frontend', 'audio-deployment', 'contracts', 'native-audio', 'kits'],
  'recovery-controls': ['recovery-before', 'controls', 'recovery-after'],
  'recovery-checkpoint': ['checkpoint'],
  'recovery-drain': ['drain'],
  'recovery-media': ['media-runtime'],
};
export const groupNames = Object.keys(groups);
const setupIds = ['install', 'build-backend'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const out = join(ROOT, 'output/validation');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const nativeId = (key) => (key === 'media' ? 'media-runtime' : key);

export function groupStages(group, catalog = applicationStages()) {
  assert(Object.hasOwn(groups, group), 'Unknown validation group');
  const recovery = catalog.find((stage) => stage.id === 'recovery-sdk');
  const runtime = recoveryRuntimeCommand();
  const index = recovery.commands.findIndex((cmd) => JSON.stringify(cmd) === JSON.stringify(runtime));
  assert(index > 0 && index < recovery.commands.length - 1, 'Missing native recovery command');
  const part = (id, commands) => ({ ...recovery, id, name: recovery.name + ' / ' + id, commands });
  const stages = [
    ...catalog.filter((stage) => stage !== recovery),
    part('recovery-before', recovery.commands.slice(0, index)),
    ...Object.entries(recoveryRuntimeParts).map(([key, suites]) =>
      part(nativeId(key), [recoveryRuntimeCommand(suites)])
    ),
    part('recovery-after', recovery.commands.slice(index + 1)),
  ];
  const ids = [...setupIds, ...Object.values(groups).flat()].sort();
  assert.deepEqual(ids, stages.map((stage) => stage.id).sort(), 'Every validation stage needs exactly one owner');
  assert.equal(new Set(ids).size, ids.length);
  return [...setupIds, ...groups[group]].map((id) => stages.find((stage) => stage.id === id));
}

function currentRun() {
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: commit } = process.env;
  assert.match(run ?? '', /^[1-9][0-9]*$/);
  assert.match(attempt ?? '', /^[1-9][0-9]*$/);
  assert.match(commit ?? '', /^[a-f0-9]{40}$/);
  const [head, tree] = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.equal(head, commit, 'Expected the exact workflow checkout');
  return { run, attempt, source: { commit, tree, trackedDiffSha256: sha('') } };
}

function checkWorker(worker) {
  assert.equal(worker?.schemaVersion, 1);
  assert.equal(worker.passed, true);
  assert.deepEqual(worker.filters, []);
  assert.deepEqual(worker.discovery.argv, ['--listTests', '--json', '--runInBand']);
  const paths = worker.suites.map((suite) => suite.path);
  assert(paths.length >= 48 && new Set(paths).size === paths.length, 'Incomplete or duplicate worker suites');
  assert.equal(worker.discovery.listSha256, sha(JSON.stringify(paths)), 'Worker discovery and results disagree');
  for (const suite of worker.suites) {
    assert.equal(suite.status, 'passed');
    assert.equal(suite.exitCode, 0);
    assert.deepEqual(suite.argv, ['--runInBand', '--runTestsByPath', suite.path]);
  }
}

async function runGroup(group, expected) {
  const stages = groupStages(group);
  const identity = preflight();
  assert.deepEqual(identity.source, expected.source, 'Expected a clean exact checkout');
  const dir = join(out, 'group');
  await mkdir(out, { recursive: true });
  // A fresh directory prevents a stale worker or receipt from surviving a failure.
  await mkdir(dir);
  const summaryPath = join(dir, 'stage-report.json');
  const report = await runStages(stages, {
    ...identity,
    summaryPath,
    env: { ...process.env, URM_VALIDATION_SUMMARY_PATH: summaryPath },
  });
  let workerSha256;
  if (group === 'worker') {
    const bytes = await readFile(join(dir, 'temporal-worker-summary.json'));
    checkWorker(JSON.parse(bytes));
    workerSha256 = sha(bytes);
  }
  await writeFile(
    join(dir, 'receipt.json'),
    json({
      ...expected,
      group,
      reportSha256: sha(json(report)),
      workerSha256,
    })
  );
}

export function joinGroups(fragments, expected, catalog = applicationStages()) {
  assert.deepEqual(Object.keys(fragments).sort(), [...groupNames].sort(), 'Missing or unexpected groups');
  const rows = new Map();
  const reports = {};
  for (const group of groupNames) {
    const { receipt, reportBytes, workerBytes } = fragments[group];
    const report = JSON.parse(reportBytes);
    assert.deepEqual(
      receipt,
      {
        ...expected,
        group,
        reportSha256: sha(reportBytes),
        ...(group === 'worker' ? { workerSha256: sha(workerBytes) } : {}),
      },
      'Wrong run, group, source or artifact digest: ' + group
    );
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.passed, true);
    assert.deepEqual(report.source, expected.source);
    const stages = groupStages(group, catalog);
    assert.deepEqual(
      report.stages.map((s) => s.id),
      stages.map((s) => s.id),
      'Incorrect stage ownership: ' + group
    );
    for (const [i, row] of report.stages.entries()) {
      assert.equal(row.status, 'passed');
      assert.deepEqual(
        row.commands.map((cmd) => cmd.argvSha256),
        stages[i].commands.map((argv) => sha(JSON.stringify(argv))),
        'Missing, duplicate or unexpected command in ' + row.id
      );
      assert(
        row.commands.every(
          (cmd) =>
            cmd.code === 0 &&
            cmd.signal === null &&
            cmd.error === undefined &&
            Number.isSafeInteger(cmd.elapsedMs) &&
            cmd.elapsedMs >= 0
        ),
        'Unsuccessful command in ' + row.id
      );
      if (!setupIds.includes(row.id) || group === 'integration') rows.set(row.id, { ...row, group });
    }
    reports[group] = report;
  }
  const workerBytes = fragments.worker.workerBytes;
  checkWorker(JSON.parse(workerBytes));
  const recovery = catalog.find((stage) => stage.id === 'recovery-sdk');
  const parts = Object.keys(recoveryRuntimeParts).map((key) => {
    const id = nativeId(key);
    return { id, group: rows.get(id).group, ...rows.get(id).commands[0] };
  });
  // Preserve the canonical single local emulator command and its ordered command
  // count. The joined exit status is valid only after every hosted part passed.
  const runtime = {
    code: 0,
    signal: null,
    argvSha256: sha(JSON.stringify(recoveryRuntimeCommand())),
    elapsedMs: parts.reduce((sum, part) => sum + part.elapsedMs, 0),
    parts,
  };
  const commands = [...rows.get('recovery-before').commands, runtime, ...rows.get('recovery-after').commands];
  rows.set(recovery.id, {
    id: recovery.id,
    name: recovery.name,
    status: 'passed',
    elapsedMs: commands.reduce((sum, cmd) => sum + cmd.elapsedMs, 0),
    commands,
  });
  const groupReports = Object.values(reports);
  return {
    workerBytes,
    application: {
      schemaVersion: 1,
      passed: true,
      source: expected.source,
      tools: reports.integration.tools,
      startedAt: groupReports.map((report) => report.startedAt).sort()[0],
      finishedAt: groupReports
        .map((report) => report.finishedAt)
        .sort()
        .at(-1),
      parallel: {
        run: expected.run,
        attempt: expected.attempt,
        groups: groupNames.map((group) => ({
          group,
          startedAt: reports[group].startedAt,
          finishedAt: reports[group].finishedAt,
          receipt: fragments[group].receipt,
        })),
      },
      stages: catalog.map((stage) => rows.get(stage.id)),
    },
  };
}

async function joinArtifacts(input, expected) {
  const prefix = 'application-group-' + expected.run + '-' + expected.attempt + '-';
  assert.deepEqual(
    (await readdir(input)).sort(),
    groupNames.map((group) => prefix + group).sort(),
    'Missing or unexpected group artifacts'
  );
  const fragments = {};
  for (const group of groupNames) {
    const dir = join(input, prefix + group);
    const files = ['receipt.json', 'stage-report.json'];
    if (group === 'worker') files.push('temporal-worker-summary.json');
    assert.deepEqual((await readdir(dir)).sort(), files.sort(), 'Incorrect artifact files: ' + group);
    fragments[group] = {
      receipt: await readJson(join(dir, 'receipt.json')),
      reportBytes: await readFile(join(dir, 'stage-report.json')),
      workerBytes: group === 'worker' ? await readFile(join(dir, 'temporal-worker-summary.json')) : undefined,
    };
  }
  const { application, workerBytes } = joinGroups(fragments, expected);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'temporal-worker-summary.json'), workerBytes, { flag: 'wx' });
  await writeFile(join(out, 'application-summary.json'), json(application), { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, input, ...extra] = process.argv.slice(2);
  assert(input && extra.length === 0);
  const expected = currentRun();
  if (mode === 'run') await runGroup(input, expected);
  else {
    assert.equal(mode, 'join');
    await joinArtifacts(input, expected);
  }
}
