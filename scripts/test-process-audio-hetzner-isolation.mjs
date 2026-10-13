import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./deploy-process-audio-hetzner.sh', import.meta.url), 'utf8');
const program = marker => {
  const start = source.indexOf(`<<'${marker}'`);
  assert.ok(start >= 0);
  const bodyStart = source.indexOf('\n', start) + 1;
  return source.slice(bodyStart, source.indexOf(`\n${marker}\n`, bodyStart));
};
const shared = ['compose.yaml', '.env', 'Caddyfile', 'media-runtime-versions.env'];
const id = '0123456789ab-20260824T010203Z-123';
function fixture(target = 'staging') {
  const root = mkdtempSync(join(tmpdir(), 'hetzner-isolation-'));
  const remote = join(root, 'remote'), bin = join(root, 'bin');
  const rollback = join(remote, 'state/deploy-rollback', id);
  const incoming = join(remote, 'state/deploy-incoming', id);
  for (const dir of [bin, join(remote, '.deploy-lock'), join(remote, 'env'), join(remote, 'context'), join(rollback, 'config-before/env'), join(rollback, 'runtime-services/caddy'), join(incoming, 'context'), join(incoming, 'env')]) mkdirSync(dir, { recursive: true });
  const put = (file, text) => writeFileSync(file, text);
  put(join(remote, '.deploy-lock/deployment-id'), id);
  put(join(rollback, 'target-env'), target);
  put(join(rollback, 'config-snapshot-complete'), '');
  put(join(rollback, 'runtime-services/caddy/was-present'), 'true');
  for (const file of [...shared, 'README.md']) {
    put(join(remote, file), `old-${file}`);
    put(join(incoming, file), file === 'README.md' ? 'new-readme' : `old-${file}`);
    put(join(rollback, 'config-before', file), `old-${file}`);
  }
  for (const env of ['staging', 'production']) {
    put(join(remote, `env/process-audio-${env}.env`), `old-${env}`);
    put(join(rollback, `config-before/env/process-audio-${env}.env`), `old-${env}`);
    if (target === env || target === 'all') put(join(incoming, `env/process-audio-${env}.env`), `new-${env}`);
  }
  put(join(remote, 'context/version'), 'old-context');
  put(join(incoming, 'context/version'), 'new-context');
  const log = join(root, 'commands');
  put(join(bin, 'chown'), '#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$COMMAND_LOG"\n');
  put(join(bin, 'docker'), '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$COMMAND_LOG"\nexit 0\n');
  spawnSync('chmod', ['+x', join(bin, 'chown'), join(bin, 'docker')]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log };
  const run = marker => spawnSync('bash', ['-s', '--', remote, ...(marker === 'REMOTE_ROLLBACK_EOF' ? [target] : []), id], { input: program(marker), env, encoding: 'utf8' });
  return { root, remote, rollback, incoming, log, run, put };
}
function cleanup(f, run) { try { run(); } finally { rmSync(f.root, { recursive: true, force: true }); } }

test('isolated activation changes only staging config/state; rollback leaves production/shared inodes intact', () => {
  const f = fixture();
  cleanup(f, () => {
    const untouched = [...shared, 'env/process-audio-production.env'];
    const before = untouched.map(p => ({ p, ino: statSync(join(f.remote, p)).ino, mode: statSync(join(f.remote, p)).mode }));
    const activated = f.run('REMOTE_ACTIVATE_EOF');
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(readFileSync(join(f.remote, 'env/process-audio-staging.env'), 'utf8'), 'new-staging');
    assert.equal(readFileSync(join(f.remote, 'context/version'), 'utf8'), 'new-context');
    assert.deepEqual(readFileSync(join(f.rollback, 'config-mutation-paths'), 'utf8').trim().split('\n'), ['README.md', 'env/process-audio-staging.env']);
    assert.equal(existsSync(join(f.remote, 'state/production')), false);
    assert.equal(existsSync(join(f.remote, 'state/shared-browser-profile')), false);
    assert.equal(existsSync(join(f.rollback, 'runtime-services/caddy/mutation-attempted')), false);
    const rolledBack = f.run('REMOTE_ROLLBACK_EOF');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(readFileSync(join(f.remote, 'env/process-audio-staging.env'), 'utf8'), 'old-staging');
    assert.equal(readFileSync(join(f.remote, 'context/version'), 'utf8'), 'old-context');
    for (const { p, ino, mode } of before) { assert.equal(statSync(join(f.remote, p)).ino, ino, p); assert.equal(statSync(join(f.remote, p)).mode, mode, p); }
    const log = readFileSync(f.log, 'utf8');
    assert.doesNotMatch(log, /state\/production|shared-browser|browser-refresh|docker compose up.*(?:production|caddy)/);
  });
});

test('shared drift fails before activation and rollback performs no config restores', () => {
  const f = fixture();
  cleanup(f, () => {
    f.put(join(f.incoming, 'Caddyfile'), 'new-shared-proxy');
    const paths = [...shared, 'README.md', 'env/process-audio-staging.env', 'env/process-audio-production.env'];
    const inodes = paths.map(p => statSync(join(f.remote, p)).ino);
    const result = f.run('REMOTE_ACTIVATE_EOF');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated staging deployment refused.*'all' target/);
    assert.equal(existsSync(join(f.rollback, 'config-activation-started')), false);
    const rolledBack = f.run('REMOTE_ROLLBACK_EOF');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.deepEqual(paths.map(p => statSync(join(f.remote, p)).ino), inodes);
    assert.equal(readFileSync(join(f.remote, 'context/version'), 'utf8'), 'old-context');
  });
});

test('isolated activation refuses an incoming production environment file', () => {
  const f = fixture();
  cleanup(f, () => {
    f.put(join(f.incoming, 'env/process-audio-production.env'), 'unscoped');
    const result = f.run('REMOTE_ACTIVATE_EOF');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds deployment scope/);
    assert.equal(existsSync(join(f.rollback, 'config-activation-started')), false);
  });
});

test('intentional all target permits shared config and both environment state changes', () => {
  const f = fixture('all');
  cleanup(f, () => {
    f.put(join(f.incoming, 'Caddyfile'), 'new-shared-proxy');
    chmodSync(f.remote, 0o700);
    chmodSync(join(f.remote, 'state'), 0o700);
    const result = f.run('REMOTE_ACTIVATE_EOF');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.remote, 'Caddyfile'), 'utf8'), 'new-shared-proxy');
    assert.equal(statSync(f.remote).mode & 0o777, 0o755);
    assert.equal(statSync(join(f.remote, 'state')).mode & 0o777, 0o755);
    for (const env of ['staging', 'production']) {
      assert.equal(readFileSync(join(f.remote, `env/process-audio-${env}.env`), 'utf8'), `new-${env}`);
      assert.equal(existsSync(join(f.remote, `state/${env}/tmp`)), true);
    }
    assert.equal(existsSync(join(f.remote, 'state/shared-browser-profile')), true);
  });
});

test('browser preflight is read-only for isolated targets; all may start shared auth infrastructure', () => {
  const f = fixture();
  cleanup(f, () => {
    mkdirSync(join(f.remote, 'state/shared-browser-profile/.config/google-chrome/Default'), { recursive: true });
    f.put(join(f.remote, 'state/shared-browser-profile/.config/google-chrome/Default/Cookies'), 'synthetic-cookies');
    const bin = join(f.root, 'bin');
    f.put(join(bin, 'systemctl'), '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$COMMAND_LOG"\n');
    f.put(join(bin, 'stat'), '#!/bin/sh\necho synthetic-timestamp\n');
    spawnSync('chmod', ['+x', join(bin, 'systemctl'), join(bin, 'stat')]);
    for (const [target, mode] of [['staging', 'check'], ['production', 'check'], ['all', 'check'], ['all', 'start']]) {
      f.put(f.log, '');
      const result = spawnSync('bash', ['-s', '--', f.remote, target, mode], { input: program('EOF'), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: f.log }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const log = readFileSync(f.log, 'utf8');
      assert.match(log, /is-active --quiet process-audio-browser-desktop-bridge.service/);
      if (target === 'all' && mode === 'start') assert.match(log, /start process-audio-browser-auth.target/);
      else assert.doesNotMatch(log, /systemctl (?:start|restart|enable|daemon-reload)/);
    }
  });
});

test('staging transaction snapshot never reads or modifies production env or shared runtime', () => {
  const f = fixture();
  cleanup(f, () => {
    rmSync(join(f.remote, '.deploy-lock'), { recursive: true });
    rmSync(f.rollback, { recursive: true });
    const bin = join(f.root, 'bin');
    f.put(join(bin, 'docker'), `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == compose && "$2" == ps ]]; then printf 'container-%s\\n' "\${!#}"; fi
if [[ "$1" == inspect ]]; then
  case "$3" in
    *State.Running*) echo true ;;
    *Config.Image*) echo worker:old ;;
    *Image*) echo sha256:old ;;
  esac
fi
`);
    const production = join(f.remote, 'env/process-audio-production.env');
    const before = statSync(production);
    const result = spawnSync('bash', ['-s', '--', f.remote, 'staging', id, 'a'.repeat(40)], { input: program('REMOTE_BEGIN_EOF'), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: f.log }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(production).ino, before.ino);
    assert.equal(statSync(production).mode, before.mode);
    assert.equal(existsSync(join(f.rollback, 'config-before/env/process-audio-production.env')), false);
    assert.equal(existsSync(join(f.rollback, 'runtime-services/caddy')), false);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /production|caddy/);
    assert.equal(readFileSync(join(f.rollback, 'config-before/env/process-audio-staging.env'), 'utf8'), 'old-staging');
  });
});

test('rollback rejects an out-of-scope mutation ledger before touching active config/context', () => {
  const f = fixture();
  cleanup(f, () => {
    f.put(join(f.rollback, 'config-activation-started'), '');
    f.put(join(f.rollback, 'config-mutation-paths'), 'env/process-audio-production.env\n');
    const result = f.run('REMOTE_ROLLBACK_EOF');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds environment scope/);
    assert.equal(readFileSync(join(f.remote, 'context/version'), 'utf8'), 'old-context');
    assert.equal(readFileSync(join(f.remote, 'env/process-audio-production.env'), 'utf8'), 'old-production');
  });
});
