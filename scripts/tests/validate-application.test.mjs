import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { applicationStages, runStages } from '../validate-application.mjs';

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'urm-validation-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const command = (program, ...args) => [process.execPath, '-e', program, ...args];

test('executes real argv without a shell and scopes per-stage environment to the intended command', async () =>
  temporary(async (root) => {
    const target = join(root, 'arguments.json'),
      value = 'literal $(touch never) `false` "quotes" spaces';
    const stages = [
      {
        id: 'first',
        name: 'first',
        env: { ONLY_STAGE: 'bound' },
        commands: [
          command(
            "require('fs').writeFileSync(process.argv[1],JSON.stringify({value:process.argv[2],env:process.env.ONLY_STAGE}))",
            target,
            value
          ),
        ],
      },
      {
        id: 'second',
        name: 'second',
        commands: [command("if(process.env.ONLY_STAGE!==undefined)throw Error('leaked env')")],
      },
    ];
    const summary = await runStages(stages, {
      root,
      env: { PATH: process.env.PATH },
      source: { commit: 'source' },
      tools: { node: process.version },
    });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { value, env: 'bound' });
    assert.equal(summary.passed, true);
    assert(summary.stages.every((row) => row.status === 'passed'));
    assert.equal(summary.source.commit, 'source');
    assert.equal(
      JSON.parse(await readFile(join(root, 'output/validation/application-summary.json'), 'utf8')).passed,
      true
    );
  }));

test('failure stops subsequent stages, marks not-run honestly, and exports only actual media failure', async () =>
  temporary(async (root) => {
    const marker = join(root, 'must-not-exist'),
      output = join(root, 'github-output'),
      summaryPath = join(root, 'artifacts/summary.json');
    await assert.rejects(
      runStages(
        [
          { id: 'media-browser', name: 'media', commands: [command('process.exitCode=23')] },
          {
            id: 'later',
            name: 'later',
            commands: [command("require('fs').writeFileSync(process.argv[1],'bad')", marker)],
          },
        ],
        { root, env: { GITHUB_OUTPUT: output, URM_VALIDATION_SUMMARY_PATH: summaryPath } }
      ),
      /23/
    );
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.passed, false);
    assert.deepEqual(
      summary.stages.map((row) => row.status),
      ['failed', 'not-run']
    );
    assert.equal(summary.stages[0].commands[0].code, 23);
    await assert.rejects(readFile(marker), /ENOENT/);
    assert.equal(await readFile(output, 'utf8'), 'media_failed=true\n');
    const other = join(root, 'other-output');
    await assert.rejects(
      runStages([{ id: 'backend', name: 'backend', commands: [command('process.exitCode=2')] }], {
        root,
        env: { GITHUB_OUTPUT: other },
      }),
      /2/
    );
    assert.equal(await readFile(other, 'utf8'), 'media_failed=false\n');
  }));

test('cancellation settles a real owned child and cannot report a successful full run', async () =>
  temporary(async (root) => {
    const moduleURL = new URL('../validate-application.mjs', import.meta.url).href;
    const program = `import {runStages} from ${JSON.stringify(moduleURL)};
 try{await runStages([{id:'waiting',name:'waiting',commands:[[process.execPath,'-e',"console.log('OWNED_READY '+process.pid);setInterval(()=>{},1000)"]]},{id:'never',name:'never',commands:[]}],{root:${JSON.stringify(
   root
 )}})}catch{process.exitCode=1}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        URM_VALIDATION_SUMMARY_PATH: join(root, 'output/validation/application-summary.json'),
        GITHUB_OUTPUT: join(root, 'nested-github-output'),
      },
    });
    let text = '',
      pid;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      child.stdout.on('data', (bytes) => {
        text += bytes;
        const match = text.match(/OWNED_READY (\d+)/);
        if (match && !pid) {
          pid = Number(match[1]);
          child.kill('SIGTERM');
        }
      });
      const status = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(status, { code: 1, signal: null });
      assert(Number.isInteger(pid));
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === 'ESRCH'
      );
      const summary = JSON.parse(await readFile(join(root, 'output/validation/application-summary.json'), 'utf8'));
      assert.equal(summary.passed, false);
      assert.deepEqual(
        summary.stages.map((row) => row.status),
        ['failed', 'not-run']
      );
      assert.match(summary.error, /interrupted/);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }));

test('shared complete stage contract preserves mandatory suites, one build, distinct cold navigation and dedicated serial emulators', () => {
  const root = '/actual checkout with spaces',
    stages = applicationStages(root);
  assert.equal(stages.length, 19);
  assert.equal(new Set(stages.map((s) => s.id)).size, 19);
  const commands = stages.flatMap((s) => s.commands);
  assert.deepEqual(commands[0], ['pnpm', 'install', '--frozen-lockfile']);
  assert.equal(commands.filter((a) => a.includes('--build-production')).length, 1);
  assert.equal(commands.filter((a) => a.includes('--cold-navigation')).length, 1);
  assert(stages.findIndex((s) => s.id === 'build-web') < stages.findIndex((s) => s.id === 'media-browser'));
  assert(stages.findIndex((s) => s.id === 'media-browser') < stages.findIndex((s) => s.id === 'functions'));
  assert.deepEqual(stages.find((s) => s.id === 'functions').commands, [['pnpm', '--dir', 'functions', 'test']]);
  const sdk = stages.find((s) => s.id === 'recovery-sdk');
  assert.equal(sdk.env.RELEASE_RUNTIME_TEST_ROOT, root);
  assert.equal(sdk.env.BUNDLE_RECOVERY_TEST_RUNTIME_ROOT, root);
  for (const args of commands.filter((a) => a.includes('emulators:exec'))) {
    assert(args.includes('../firebase.test.json'));
    assert(args.includes('auth,firestore,database,storage'));
  }
  assert.equal(
    stages.find((s) => s.id === 'email-capture').env.URM_EMAIL_CAPTURE_TEST_CONFIG,
    join(root, 'firebase.test.json')
  );
  assert.equal(stages.find((s) => s.id === 'kits-native').env.KIT_STARTUP_REQUIRE_LINUX_X64, 'true');
});

test('invalid invocation replaces a stale pass before any tool or validation command can run', async () =>
  temporary(async (root) => {
    const { spawnSync } = await import('node:child_process');
    const summaryPath = join(root, 'previous.json');
    await writeFile(summaryPath, JSON.stringify({ passed: true }));
    const result = spawnSync(
      process.execPath,
      [new URL('../validate-application.mjs', import.meta.url).pathname, '--not-a-validation-mode'],
      { encoding: 'utf8', env: { ...process.env, URM_VALIDATION_SUMMARY_PATH: summaryPath }, timeout: 10000 }
    );
    assert.equal(result.status, 1);
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.passed, false);
    assert.equal(summary.phase, 'preflight');
    assert.equal(summary.stages.length, 19);
    assert(summary.stages.every((s) => s.status === 'not-run'));
  }));

test('cancellation permits nested detached cleanup beyond the previous ten-second outer grace', async () =>
  temporary(async (root) => {
    const moduleURL = new URL('../validate-application.mjs', import.meta.url).href;
    const marker = join(root, 'nested-cleanup-complete');
    const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const nested=spawn(process.execPath,['-e',"console.log('OWNED_NESTED '+process.pid);setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'});
    const hold=setInterval(()=>{},1000);
    process.once('SIGTERM',()=>setTimeout(()=>{nested.once('close',()=>{fs.writeFileSync(process.argv[1],'complete');clearInterval(hold);});process.kill(-nested.pid,'SIGTERM');},11000));`;
    const program = `import {runStages} from ${JSON.stringify(moduleURL)};
    try{await runStages([{id:'nested',name:'nested',commands:[[process.execPath,'-e',${JSON.stringify(
      parentCode
    )},${JSON.stringify(marker)}]]}],{root:${JSON.stringify(root)}})}catch{process.exitCode=1}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        URM_VALIDATION_SUMMARY_PATH: join(root, 'summary.json'),
        GITHUB_OUTPUT: join(root, 'github-output'),
      },
    });
    let text = '',
      nestedPid;
    const stopNested = () => {
      if (nestedPid) {
        try {
          process.kill(-nestedPid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    // An orphan can hold inherited stdout open after the runner exits. Close only
    // this fixture's known group before awaiting close, including failure paths.
    child.once('exit', stopNested);
    const watchdog = setTimeout(() => {
      stopNested();
      child.kill('SIGKILL');
    }, 30000);
    try {
      child.stdout.on('data', (bytes) => {
        text += bytes;
        const m = text.match(/OWNED_NESTED (\d+)/);
        if (m && !nestedPid) {
          nestedPid = Number(m[1]);
          child.kill('SIGTERM');
        }
      });
      const status = await new Promise((r, j) => {
        child.once('error', j);
        child.once('close', (code, signal) => r({ code, signal }));
      });
      assert.deepEqual(status, { code: 1, signal: null });
      assert(Number.isInteger(nestedPid));
      assert.equal(await readFile(marker, 'utf8'), 'complete');
      assert.throws(
        () => process.kill(nestedPid, 0),
        (error) => error.code === 'ESRCH'
      );
      const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
      assert.equal(summary.passed, false);
      assert.match(summary.error, /interrupted/);
      assert.doesNotMatch(summary.error, /forced cleanup/);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (nestedPid) {
        try {
          process.kill(-nestedPid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  }));
