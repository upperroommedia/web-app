import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  filterArguments,
  runWorkerTests,
  validateDiscoveredTests,
  workerSummaryPath,
} from '../test-temporal-worker.mjs';

const runnerUrl = new URL('../test-temporal-worker.mjs', import.meta.url).href;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(read, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await wait(20);
  }
  throw new Error('Fixture did not become ready');
}
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urm worker process ')));
  try {
    const first = join(root, 'first suite.test.ts'),
      second = join(root, 'second suite.test.ts');
    await writeFile(first, '{}');
    await writeFile(second, '{}');
    const jestPath = join(root, 'fake jest.mjs'),
      journal = join(root, 'journal.jsonl');
    await writeFile(
      jestPath,
      `
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const record=(event,extra={})=>appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({event,pid:process.pid,cwd:process.cwd(),args,...extra})+'\\n');
record('start');
if(args.includes('--listTests')) {
 process.stdout.write(process.env.FIXTURE_DISCOVERY);record('end');
 process.exitCode=Number(process.env.FIXTURE_DISCOVERY_EXIT||0);
} else {
 if(globalThis.fixtureSdkInitialized)throw Error('SDK state was reused');
 globalThis.fixtureSdkInitialized=true;
 const path=args[args.indexOf('--runTestsByPath')+1];
 const config=JSON.parse(readFileSync(path,'utf8'));
 if(config.hold){
  process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));
  const nested=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{require('fs').writeFileSync(process.argv[1],'stopped');process.exit(0)});require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},100)\",process.env.FIXTURE_NESTED_STOP,process.env.FIXTURE_NESTED_READY],{stdio:'inherit'});
  writeFileSync(process.env.FIXTURE_READY,JSON.stringify({pid:process.pid,nested:nested.pid}));
  setInterval(()=>{},100);
 } else if(config.orphan){
  const nested=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});
  writeFileSync(process.env.FIXTURE_READY,JSON.stringify({nested:nested.pid}));
  record('end');
 } else if(config.signal) process.kill(process.pid,config.signal);
 else {record('end',{proof:process.env.FIXTURE_PROOF});process.exitCode=config.code||0;}
}
`
    );
    const env = {
      ...process.env,
      FIXTURE_DISCOVERY: JSON.stringify([first, second]),
      FIXTURE_JOURNAL: journal,
      URM_WORKER_TEST_SUMMARY_PATH: join(root, 'worker-summary.json'),
    };
    await run({ root, first, second, jestPath, journal, env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const rows = async (path) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const options = (f, extra = {}) => ({
  workerRoot: f.root,
  jestPath: f.jestPath,
  env: f.env,
  suiteStdio: 'ignore',
  ...extra,
});

test('discovers every suite once and runs real fresh Node processes serially, preserving paths with spaces and environment', async () =>
  fixture(async (f) => {
    const summary = await runWorkerTests(options(f, { env: { ...f.env, FIXTURE_PROOF: 'inherited' } }));
    assert.equal(summary.passed, true);
    assert.equal(summary.discovery.listSha256.length, 64);
    assert.equal(summary.discovery.outputSha256.length, 64);
    assert.equal(new Set(summary.suites.map((s) => s.pid)).size, 2);
    assert.deepEqual(
      summary.suites.map((s) => [s.path, s.status]),
      [
        [f.first, 'passed'],
        [f.second, 'passed'],
      ]
    );
    const events = await rows(f.journal);
    assert.deepEqual(
      events.map((r) => r.event),
      ['start', 'end', 'start', 'end', 'start', 'end']
    );
    assert.equal(new Set(events.map((r) => r.pid)).size, 3);
    assert(events.every((r) => r.cwd === f.root));
    assert(events.filter((r) => r.event === 'end' && r.proof).every((r) => r.proof === 'inherited'));
    assert.deepEqual(events[0].args, ['--listTests', '--json', '--runInBand']);
    assert.deepEqual(events[2].args, ['--runInBand', '--runTestsByPath', f.first]);
    assert.deepEqual(events[4].args, ['--runInBand', '--runTestsByPath', f.second]);
  }));

test('path filters affect discovery while test-name filters also apply to each exact suite', async () =>
  fixture(async (f) => {
    await runWorkerTests(options(f, { args: ['search|images', '-t', 'real workflow'] }));
    const events = await rows(f.journal);
    assert.deepEqual(events[0].args.slice(3), ['search|images', '--testNamePattern', 'real workflow']);
    assert.deepEqual(events[2].args.slice(3), ['--testNamePattern', 'real workflow']);
  }));

for (const args of [
  ['--forceExit'],
  ['--testTimeout=999999'],
  ['--watch'],
  ['--config', 'other'],
  ['--passWithNoTests'],
  ['--runInBand'],
  ['--listTests'],
  ['--testNamePattern'],
  ['--testNamePattern='],
])
  test(`rejects unsupported or incomplete arguments ${JSON.stringify(args)}`, () =>
    assert.throws(() => filterArguments(args)));

test('accepts explicit testNamePattern equals form without changing it', () => {
  assert.deepEqual(filterArguments(['--', '--testNamePattern=foo bar']), {
    discovery: ['--testNamePattern=foo bar'],
    suite: ['--testNamePattern=foo bar'],
  });
});

for (const [name, value] of [
  ['malformed', 'not JSON'],
  ['empty', '[]'],
  ['object', '{}'],
  ['relative', '["relative.test.ts"]'],
  ['nonstring', '[3]'],
])
  test(`discovery fails closed on ${name} output`, async () =>
    fixture(async (f) => {
      const summaryPath = join(f.root, 'summary.json');
      await assert.rejects(runWorkerTests(options(f, { env: { ...f.env, FIXTURE_DISCOVERY: value }, summaryPath })));
      const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
      assert.equal(summary.passed, false);
      assert.deepEqual(summary.suites, []);
      assert.equal((await rows(f.journal)).length, 2);
    }));

test('rejects duplicate, outside-root, missing, and nonfile paths', async () =>
  fixture(async (f) => {
    await assert.rejects(validateDiscoveredTests(JSON.stringify([f.first, f.first]), f.root), /duplicate/);
    await assert.rejects(validateDiscoveredTests(JSON.stringify([resolve('package.json')]), f.root), /outside/);
    await assert.rejects(validateDiscoveredTests(JSON.stringify([join(f.root, 'missing')]), f.root));
    const directory = join(f.root, 'directory');
    await mkdir(directory);
    await assert.rejects(validateDiscoveredTests(JSON.stringify([directory]), f.root), /file/);
  }));

test('a failing suite preserves exit code and leaves subsequent suites honestly not-run', async () =>
  fixture(async (f) => {
    await writeFile(f.first, '{"code":17}');
    const summaryPath = join(f.root, 'summary.json');
    await assert.rejects(runWorkerTests(options(f, { summaryPath })), (error) => error.exitCode === 17);
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.passed, false);
    assert.deepEqual(
      summary.suites.map((r) => r.status),
      ['failed', 'not-run']
    );
    assert.equal(summary.suites[0].exitCode, 17);
    assert.equal((await rows(f.journal)).length, 4);
  }));

test('a signalled suite fails with signal identity and never runs the next suite', async () =>
  fixture(async (f) => {
    await writeFile(f.first, '{"signal":"SIGTERM"}');
    await assert.rejects(
      runWorkerTests(options(f)),
      (error) =>
        error.exitCode === 143 &&
        error.summary.suites[0].signal === 'SIGTERM' &&
        error.summary.suites[1].status === 'not-run'
    );
  }));

test('nonzero discovery exit never launches a suite', async () =>
  fixture(async (f) => {
    await assert.rejects(
      runWorkerTests(options(f, { env: { ...f.env, FIXTURE_DISCOVERY_EXIT: '23' } })),
      (error) => error.exitCode === 23
    );
    assert.equal((await rows(f.journal)).length, 2);
  }));

test('a spawn error is a failure rather than a successful empty run', async () =>
  fixture(async (f) => {
    await assert.rejects(runWorkerTests(options(f, { workerRoot: join(f.root, 'absent') })), /ENOENT/);
  }));

test('worker summary cannot overwrite the shared application summary', async () =>
  fixture(async (f) => {
    const summaryPath = join(f.root, 'application.json');
    await writeFile(summaryPath, 'unchanged');
    await assert.rejects(
      runWorkerTests(options(f, { summaryPath, env: { ...f.env, URM_VALIDATION_SUMMARY_PATH: summaryPath } })),
      /must not replace/
    );
    assert.equal(await readFile(summaryPath, 'utf8'), 'unchanged');
  }));

test('discovery failure invalidates a previous worker pass', async () =>
  fixture(async (f) => {
    const summaryPath = join(f.root, 'summary.json');
    await writeFile(summaryPath, '{"passed":true}');
    await assert.rejects(runWorkerTests(options(f, { summaryPath, env: { ...f.env, FIXTURE_DISCOVERY: '[]' } })));
    assert.equal(JSON.parse(await readFile(summaryPath, 'utf8')).passed, false);
  }));

test(
  'cancellation settles the owned suite and its grandchild and reports remaining suites not-run',
  { timeout: 15000 },
  async () =>
    fixture(async (f) => {
      await writeFile(f.first, '{"hold":true}');
      const ready = join(f.root, 'ready.json'),
        stopped = join(f.root, 'nested-stopped'),
        nestedReady = join(f.root, 'nested-ready'),
        summaryPath = join(f.root, 'summary.json');
      const driver = join(f.root, 'driver.mjs');
      await writeFile(
        driver,
        `import {runWorkerTests} from ${JSON.stringify(runnerUrl)};try{await runWorkerTests(${JSON.stringify(
          options(f, {
            summaryPath,
            cleanupGraceMs: 1000,
            forcedGraceMs: 1000,
            env: { ...f.env, FIXTURE_READY: ready, FIXTURE_NESTED_STOP: stopped, FIXTURE_NESTED_READY: nestedReady },
          })
        )})}catch(e){process.exitCode=e.exitCode??1}`
      );
      const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
      const result = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
      let pids;
      try {
        await eventually(async () => {
          try {
            pids = JSON.parse(await readFile(ready, 'utf8'));
            return true;
          } catch {
            return false;
          }
        });
        // The grandchild itself attests that its cleanup handler is installed.
        // A parent PID or a fixed delay cannot establish this under CPU contention.
        await eventually(async () => {
          try {
            return (await readFile(nestedReady, 'utf8')) === String(pids.nested);
          } catch {
            return false;
          }
        });
        child.kill('SIGTERM');
        assert.deepEqual(await result, { code: 143, signal: null });
        assert.equal(await readFile(stopped, 'utf8'), 'stopped');
        const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
        assert.equal(summary.passed, false);
        assert.equal(summary.signal, 'SIGTERM');
        assert.deepEqual(
          summary.suites.map((r) => r.status),
          ['failed', 'not-run']
        );
        for (const pid of [pids.pid, pids.nested]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        if (pids?.pid) {
          try {
            process.kill(-pids.pid, 'SIGKILL');
          } catch {}
        }
        await result;
      }
    })
);

test('default summary stays beside application artifacts or in root output, never replaces application summary', () => {
  assert.equal(
    workerSummaryPath('/checkout/apps/temporal-worker', {}),
    '/checkout/output/validation/temporal-worker-summary.json'
  );
  assert.equal(
    workerSummaryPath('/checkout/apps/temporal-worker', {
      URM_VALIDATION_SUMMARY_PATH: '/artifacts/application-summary.json',
    }),
    '/artifacts/temporal-worker-summary.json'
  );
});
