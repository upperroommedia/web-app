// Temporal's native runtime and Node child-process signal handling share process
// state. Keep every Jest suite in a fresh OS process; the parent imports no SDK.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { constants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('../apps/temporal-worker/', import.meta.url));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export function filterArguments(args) {
  const discovery = [],
    suite = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    assert.equal(typeof arg, 'string', 'Jest filter must be a string');
    if (arg === '--') continue;
    if (arg === '-t' || arg === '--testNamePattern') {
      const value = args[++index];
      assert(value && !value.startsWith('-'), 'A test name filter requires a value');
      discovery.push('--testNamePattern', value);
      suite.push('--testNamePattern', value);
    } else if (arg.startsWith('--testNamePattern=')) {
      assert(arg.slice('--testNamePattern='.length), 'A test name filter requires a value');
      discovery.push(arg);
      suite.push(arg);
    } else {
      assert(arg && !arg.startsWith('-'), `Unsupported Jest option: ${arg}`);
      discovery.push(arg);
    }
  }
  return { discovery, suite };
}
export async function validateDiscoveredTests(output, workerRoot) {
  let paths;
  try {
    paths = JSON.parse(output);
  } catch {
    throw new Error('Jest discovery did not return JSON');
  }
  assert(Array.isArray(paths) && paths.length > 0, 'Jest discovery must return at least one suite');
  assert(paths.length <= 10000, 'Jest discovery returned too many suites');
  const root = await realpath(workerRoot),
    seen = new Set();
  for (const path of paths) {
    assert(
      typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
      'Jest returned an invalid suite path'
    );
    const actual = await realpath(path),
      within = relative(root, actual);
    assert(
      within && within !== '..' && !within.startsWith('../') && !isAbsolute(within),
      'Jest suite is outside the worker'
    );
    assert((await stat(actual)).isFile(), 'Jest suite must be a file');
    assert(!seen.has(actual), 'Jest discovery returned a duplicate suite');
    seen.add(actual);
  }
  return paths;
}
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function settleGroup(pid, graceMs, forcedMs) {
  if (!pid || !groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await pause(25);
  if (!groupAlive(pid)) return;
  signalGroup(pid, 'SIGKILL');
  const forcedDeadline = Date.now() + forcedMs;
  while (groupAlive(pid) && Date.now() < forcedDeadline) await pause(25);
  assert(!groupAlive(pid), 'Owned Jest process group did not terminate');
}
export function workerSummaryPath(workerRoot, env) {
  return (
    env.URM_WORKER_TEST_SUMMARY_PATH ||
    (env.URM_VALIDATION_SUMMARY_PATH
      ? resolve(dirname(env.URM_VALIDATION_SUMMARY_PATH), 'temporal-worker-summary.json')
      : resolve(workerRoot, '../../output/validation/temporal-worker-summary.json'))
  );
}
export async function runWorkerTests({
  workerRoot = WORKER_ROOT,
  jestPath,
  args = [],
  env = process.env,
  suiteStdio = 'inherit',
  cleanupGraceMs = 10000,
  forcedGraceMs = 2000,
  summaryPath = workerSummaryPath(workerRoot, env),
} = {}) {
  assert(process.platform !== 'win32', 'Worker process isolation requires POSIX process groups');
  if (summaryPath && env.URM_VALIDATION_SUMMARY_PATH)
    assert.notEqual(
      resolve(summaryPath),
      resolve(env.URM_VALIDATION_SUMMARY_PATH),
      'Worker summary must not replace application summary'
    );
  const summary = {
    schemaVersion: 1,
    passed: false,
    startedAt: new Date().toISOString(),
    workerRoot: resolve(workerRoot),
    nodeVersion: process.version,
    parentPid: process.pid,
    filters: args,
    suites: [],
  };
  const save = async () => {
    if (!summaryPath) return;
    await mkdir(dirname(resolve(summaryPath)), { recursive: true });
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  };
  let active, cancelled, cleanup, failure;
  const cancel = (signal) => {
    cancelled ??= signal;
    if (active?.pid) cleanup ??= settleGroup(active.pid, cleanupGraceMs, forcedGraceMs);
    // The awaited child records this rejection; do not leave an unhandled promise.
    cleanup?.catch(() => {});
  };
  const onTerm = () => cancel('SIGTERM'),
    onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const command = async (commandArgs, collect = false, row) => {
    assert(!cancelled, `Worker tests interrupted by ${cancelled}`);
    const chunks = [];
    let outputBytes = 0,
      overflow = false;
    active = spawn(process.execPath, [jestPath, ...commandArgs], {
      cwd: workerRoot,
      env,
      detached: true,
      stdio: collect ? ['ignore', 'pipe', 'inherit'] : suiteStdio,
    });
    const child = active;
    if (row) row.pid = child.pid;
    if (collect)
      child.stdout.on('data', (chunk) => {
        if (outputBytes + chunk.length > 4 * 1024 * 1024) {
          overflow = true;
          cleanup ??= settleGroup(child.pid, cleanupGraceMs, forcedGraceMs);
          cleanup.catch(() => {});
        } else {
          chunks.push(chunk);
          outputBytes += chunk.length;
        }
      });
    const result = await new Promise((done) => {
      child.once('error', (error) => done({ error: error.message }));
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    const leftover = child.pid && groupAlive(child.pid);
    if (leftover) cleanup ??= settleGroup(child.pid, cleanupGraceMs, forcedGraceMs);
    await cleanup;
    cleanup = undefined;
    // Discovery stdout can finish draining after exit; descendants have settled.
    if (collect && child.stdout && !child.stdout.readableEnded && !child.stdout.destroyed)
      await new Promise((done) => child.stdout.once('close', done));
    active = undefined;
    assert(!cancelled, `Worker tests interrupted by ${cancelled}`);
    assert(!overflow, 'Jest discovery exceeded its output bound');
    assert(!leftover, 'Jest left an owned descendant running');
    if (result.error || result.code !== 0) {
      const error = new Error(`Jest process failed (${result.error ?? result.signal ?? result.code})`);
      error.exitCode = result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
      error.signal = result.signal;
      error.pid = child.pid;
      throw error;
    }
    return { ...result, stdout: Buffer.concat(chunks).toString('utf8'), pid: child.pid };
  };
  try {
    await save(); // An earlier pass is invalidated even if discovery fails.
    const filters = filterArguments(args);
    jestPath ??= createRequire(resolve(workerRoot, 'package.json')).resolve('jest/bin/jest');
    const discovered = await command(['--listTests', '--json', '--runInBand', ...filters.discovery], true);
    const paths = await validateDiscoveredTests(discovered.stdout, workerRoot);
    summary.jestPath = jestPath;
    summary.discovery = {
      pid: discovered.pid,
      argv: ['--listTests', '--json', '--runInBand', ...filters.discovery],
      outputSha256: createHash('sha256').update(discovered.stdout).digest('hex'),
      listSha256: createHash('sha256').update(JSON.stringify(paths)).digest('hex'),
    };
    summary.suites = paths.map((path) => ({ path, status: 'not-run' }));
    await save();
    for (const [index, row] of summary.suites.entries()) {
      row.status = 'running';
      row.argv = ['--runInBand', '--runTestsByPath', row.path, ...filters.suite];
      row.startedAt = new Date().toISOString();
      const started = Date.now();
      console.log(`\nWorker suite ${index + 1}/${paths.length}: ${relative(workerRoot, row.path)}`);
      try {
        const result = await command(row.argv, false, row);
        row.pid = result.pid;
        row.exitCode = result.code;
        row.status = 'passed';
      } catch (error) {
        row.status = 'failed';
        row.error = error.message;
        if (error.pid) row.pid = error.pid;
        if (error.exitCode !== undefined) row.exitCode = error.exitCode;
        if (error.signal) row.signal = error.signal;
        throw error;
      } finally {
        row.elapsedMs = Date.now() - started;
        row.finishedAt = new Date().toISOString();
        await save();
      }
    }
    summary.passed = true;
  } catch (error) {
    failure = error;
    summary.error = error.message;
  } finally {
    try {
      await (cleanup ?? settleGroup(active?.pid, cleanupGraceMs, forcedGraceMs));
    } catch (error) {
      failure ??= error;
      summary.error = error.message;
      summary.passed = false;
    }
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (cancelled) {
      summary.passed = false;
      summary.signal = cancelled;
    }
    summary.finishedAt = new Date().toISOString();
    await save();
  }
  if (failure || cancelled) {
    const error = failure ?? new Error(`Worker tests interrupted by ${cancelled}`);
    error.exitCode = cancelled ? 128 + constants.signals[cancelled] : error.exitCode ?? 1;
    error.summary = summary;
    throw error;
  }
  console.log(`Worker suites passed: ${summary.suites.length}/${summary.suites.length} (fresh process per suite)`);
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runWorkerTests({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
