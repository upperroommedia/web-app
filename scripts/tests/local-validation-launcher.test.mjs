import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '../validate-application-local.sh');
const realPython = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
const realTee = spawnSync('which', ['tee'], { encoding: 'utf8' }).stdout.trim();

// Only the Docker boundary is simulated: these receipts test the host wrapper,
// and are deliberately never evidence that the application validation passed.
async function fixture(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'urm-launcher-contract-'));
  const repo = join(dir, 'source'), bin = join(dir, 'bin'), state = join(dir, 'docker-state.json');
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await mkdir(bin);
  await copyFile(launcher, join(repo, 'scripts/validate-application-local.sh'));
  await writeFile(join(repo, '.gitignore'), 'output/\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Launcher Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  // Disk capacity belongs to the Docker environment, not this temporary host test.
  // Execute real Python and all real Git/summary checks, overriding only capacity.
  await writeFile(join(bin, 'python3'), `#!/bin/sh\nexec ${JSON.stringify(realPython)} -c 'import sys,shutil; shutil.disk_usage=lambda _: shutil._ntuple_diskusage(100*1024**3,0,100*1024**3); sys.argv.pop(1); exec(compile(sys.stdin.read(), "<launcher-fixture>", "exec"))' "$@"\n`);
  await writeFile(join(bin, 'tee'), `#!/bin/sh\n${JSON.stringify(realTee)} "$@"\nr=$?\ncase "$*" in *application.log*) if [ "$URM_FIXTURE_MODE" = tee-failure ]; then exit 9; fi;; esac\nexit "$r"\n`);
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = process.env.URM_FIXTURE_STATE, mode = process.env.URM_FIXTURE_MODE;
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { calls: [] };
const save = (s) => { const pending=file+'.'+process.pid; fs.writeFileSync(pending, JSON.stringify(s)); fs.renameSync(pending,file); };
const s = load(); s.calls.push(args); save(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
 switch (args[0]) {
 case 'info': case 'build': case 'cp': return;
 case 'image': console.log('sha256:fixture-image'); return;
 case 'volume': return;
 case 'create': {
  s.name = args[args.indexOf('--name')+1];
  s.artifacts = args.find(a => a.startsWith('type=bind,') && a.endsWith('dst=/artifacts')).split('src=')[1].split(',')[0];
  s.head = args.find(a => a.startsWith('URM_EXPECTED_COMMIT=')).split('=')[1]; save(s); console.log('fixture-container'); return;
 }
 case 'start': {
  const count = mode === 'missing-stage' ? 18 : 19;
  const summary = { passed: true, source: { commit: mode === 'wrong-source' ? 'wrong' : s.head }, stages: Array.from({length:count}, (_,i)=>({id:'fixture-'+i,status:'passed',commands:[{code:mode==='failed-command' && i===0 ? 1 : 0}]})) };
  fs.writeFileSync(s.artifacts+'/application-summary.json', JSON.stringify(summary));
  s.started = true; save(s); return;
 }
 case 'logs': if (mode === 'cancel') { while (!load().stopped) await sleep(20); } console.log('fixture Docker output'); if(mode==='logs-failure') process.exitCode=7; return;
 case 'wait': if(mode==='cancel') { while(!load().stopped) await sleep(20); } console.log(mode==='cancel' ? '143' : '0'); return;
 case 'stop': s.stopped=true; save(s); return;
 case 'rm': return;
 default: throw new Error('Unexpected fake Docker operation '+JSON.stringify(args));
 }
})().catch(e=>{ console.error(e); process.exitCode=1; });
`);
  for (const name of ['docker', 'tee', 'python3']) await chmod(join(bin, name), 0o755);
  const child = spawn('bash', [join(repo, 'scripts/validate-application-local.sh')], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, URM_FIXTURE_MODE: mode, URM_FIXTURE_STATE: state, URM_VALIDATION_SUMMARY_PATH: join(dir, 'isolated-summary.json'), GITHUB_OUTPUT: join(dir, 'isolated-github-output') },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = new Promise((resolveResult, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveResult({code, signal})); });
  return { child, done, head, state, get output() { return output; }, async cleanup() { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await done; await rm(dir,{recursive:true,force:true}); } };
}

async function run(mode, assertion) {
  const f = await fixture(mode);
  try { await assertion(f, await f.done); } finally { await f.cleanup(); }
}

function assertRetained(state) {
  assert.ok(!state.calls.some(args => args[0] === 'rm'), 'failed container must remain');
  assert.ok(!state.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), 'failed workspace must remain');
}

test('wrapper accepts only a complete successful fixture receipt and cleans its owned workspace', { timeout: 15000 }, async () => {
  await run('success', async (f, result) => {
    assert.equal(result.code, 0, f.output);
    assert.match(f.output, /Full local validation passed/);
    const state = JSON.parse(await readFile(f.state));
    assert.equal(state.head, f.head);
    assert.ok(state.calls.some(args => args[0] === 'rm' && args[1] === state.name));
    assert.ok(state.calls.some(args => args[0] === 'volume' && args[1] === 'rm'));
  });
});

test('missing stage, wrong source, and nonzero command cannot pass or delete failed state', { timeout: 30000 }, async () => {
  for (const mode of ['missing-stage', 'wrong-source', 'failed-command']) await run(mode, async (f, result) => {
    assert.notEqual(result.code, 0, f.output);
    assert.doesNotMatch(f.output, /Full local validation passed/);
    const state = JSON.parse(await readFile(f.state));
    assert.equal(state.started, true, f.output);
    assertRetained(state);
  });
});

test('Docker log-client and tee failures cannot become successful validation', { timeout: 20000 }, async () => {
  for (const mode of ['logs-failure', 'tee-failure']) await run(mode, async (f, result) => {
    assert.notEqual(result.code, 0, f.output);
    assert.doesNotMatch(f.output, /Full local validation passed/);
    const state = JSON.parse(await readFile(f.state));
    assert.equal(state.started, true, f.output);
    assertRetained(state);
  });
});

test('TERM sent only to wrapper PID stops the exact owned Docker container and retains failure state', { timeout: 15000 }, async () => {
  const f = await fixture('cancel');
  try {
    let state;
    for (let attempt=0; attempt<300; attempt++) {
      try { state=JSON.parse(await readFile(f.state)); } catch {}
      if(state?.started && state.calls.some(args=>args[0]==='wait')) break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.ok(state?.started, f.output);
    f.child.kill('SIGTERM');
    const result = await f.done;
    assert.notEqual(result.code, 0, f.output);
    state = JSON.parse(await readFile(f.state));
    assert.equal(state.stopped, true);
    assert.ok(state.calls.some(args=>args[0]==='stop' && args.at(-1)===state.name));
    assertRetained(state);
    assert.doesNotMatch(f.output, /Full local validation passed/);
  } finally { await f.cleanup(); }
});
