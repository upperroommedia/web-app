import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderSingleVmBootstrap } from './temporal-single-vm-config.mjs';
const config = {
  projectId: 'urm-app-staging',
  instanceName: 'urm-temporal-staging',
  instanceId: '1234',
  privateIp: '10.180.0.2',
  mediaFilesystemUuid: '12345678-1234-1234-1234-123456789abc',
};
test('Simple bootstrap preserves real private node identity and encrypted keys without HA/DB/VIP requirements', () => {
  const files = renderSingleVmBootstrap(config),
    k3s = files['k3s-config.json'];
  assert.equal(k3s['node-name'], config.instanceName);
  assert.equal(k3s['bind-address'], config.privateIp);
  assert.equal(k3s['secrets-encryption'], true);
  assert.ok(files['wait-node.sh'].includes(`kubectl --server=https://${config.privateIp}:6443 wait`));
  assert.ok(
    files['temporal-storage-setup.service'].includes(
      'media-storage reconcile --config /etc/urm-temporal/media-storage.json'
    )
  );
  assert.equal(files['media-storage.json'].privateIp, config.privateIp);
  assert.equal(files['media-storage.json'].mediaFilesystemUuid, config.mediaFilesystemUuid);
  assert.equal(k3s['cluster-init'], undefined);
  assert.equal(k3s['server'], undefined);
  assert.equal(k3s['etcd-snapshot-schedule-cron'], undefined);
  assert.deepEqual(k3s.disable, ['traefik', 'servicelb']);
  assert.equal(files['namespace.json'].metadata.name, 'temporal-staging');
  assert.equal(files['media-storage-class.json'].parameters.nodePath, '/var/lib/urm-temporal/media');
  assert.ok(files['identity.env'].includes('GCE_INSTANCE_ID=1234'));
  assert.equal(JSON.stringify(files).includes('api-key-value'), false);
});
test('Bootstrap rejects cross-project names, missing actual VM IDs, public addresses and overlapping service/pod subnets', () => {
  for (const overrides of [
    { projectId: 'foreign' },
    { instanceName: 'urm-temporal-production' },
    { instanceId: 'REQUIRED' },
    { privateIp: '8.8.8.8' },
    { privateIp: '10.42.0.3' },
    { privateIp: '10.43.0.3' },
    { mediaFilesystemUuid: undefined },
    { mediaFilesystemUuid: 'REQUIRED' },
    { mediaFilesystemUuid: config.mediaFilesystemUuid.toUpperCase() },
    { mediaFilesystemUuid: config.mediaFilesystemUuid + '\n' },
  ])
    assert.throws(() => renderSingleVmBootstrap({ ...config, ...overrides }));
});

test('Initial node registration can be missing before Ready without aborting idempotent bootstrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-node-registration-'));
  try {
    const fake = join(dir, 'k3s'),
      counter = join(dir, 'counter'),
      calls = join(dir, 'calls');
    await writeFile(counter, '0');
    await writeFile(
      fake,
      `#!/bin/sh\nset -eu\necho "$*" >> '${calls}'\ncase "$*" in *"get node/"*) n=$(cat '${counter}');n=$((n+1));echo "$n" > '${counter}';[ "$n" -ge 3 ];; *"wait --for=condition=Ready"*) [ "$(cat '${counter}')" -ge 3 ];; *) exit 99;; esac\n`
    );
    await chmod(fake, 0o700);
    const sleep = join(dir, 'sleep');
    await writeFile(sleep, '#!/bin/sh\nexit 0\n');
    await chmod(sleep, 0o700);
    const files = renderSingleVmBootstrap(config),
      wait = join(dir, 'wait.sh');
    await writeFile(wait, files['wait-node.sh'].replaceAll('/usr/local/bin/k3s', fake));
    execFileSync('sh', [wait], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: 'pipe' });
    const log = (await readFile(calls, 'utf8')).trim().split('\n');
    assert.equal(log.length, 4);
    assert.ok(log[3].includes('wait --for=condition=Ready'));
    assert.ok(files['bootstrap.sh'].includes('cmp -s "$task_tmp/k3s" /usr/local/bin/k3s'));
    assert.ok(files['bootstrap.sh'].includes('Existing K3s binary differs'));
    assert.ok(
      files['bootstrap.sh'].includes('install_same "$task_dir/k3s-config.json" /etc/rancher/k3s/config.yaml 0600')
    );
    assert.ok(files['bootstrap.sh'].includes('require explicit reviewed maintenance'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('K3s itself fails closed on its mount and guarded enrollment; operator uses only the same reviewed helper', () => {
  const files = renderSingleVmBootstrap(config);
  for (const name of ['k3s.service', 'temporal-storage-setup.service']) {
    assert.match(files[name], /^RequiresMountsFor=\/var\/lib\/urm-temporal\/media$/m);
    assert.match(
      files[name],
      /^ExecStartPre=\/usr\/local\/libexec\/urm-temporal-media-storage guard --config \/etc\/urm-temporal\/media-storage.json$/m
    );
    assert.equal(files[name].includes('\\n'), false, 'unit contains actual newlines');
    assert.ok(files[name].indexOf('ExecStartPre=') < files[name].indexOf('\nExecStart='));
  }
  assert.match(
    files['k3s.service'],
    /^ExecStart=\/usr\/local\/bin\/k3s server --config \/etc\/rancher\/k3s\/config.yaml$/m
  );
  assert.equal(files['bootstrap.sh'].includes('systemctl restart'), false);
  assert.equal(files['bootstrap.sh'].includes('--disable=local-storage'), false);
  assert.equal(files['local-path-config-patch.json'], undefined);
  assert.match(files['media-storage.py'], /google-' \+ config\['instanceName'\] \+ '-media'/);
  assert.equal(
    files['media-storage.py'].includes(config.mediaFilesystemUuid),
    false,
    'helper has no hardcoded actual filesystem UUID'
  );
  assert.ok(files['identity.env'].split('\n').includes('GCE_INSTANCE_ID=1234'));
});
test('fresh bootstrap waits packaged resources before skip, enrollment and reconciliation, with exact ADC policy', () => {
  const files = renderSingleVmBootstrap(config),
    script = files['bootstrap.sh'];
  const firstStart = script.indexOf('systemctl start k3s.service');
  const packagedReady = script.indexOf('get configmap local-path-config');
  const skip = script.indexOf(
    "install -m0600 /dev/null '/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip'"
  );
  const enroll = script.indexOf("media-storage' enroll");
  const permitRemoval = script.indexOf("rm '/etc/urm-temporal/media-storage.initializing'");
  const reconcile = script.indexOf('systemctl enable --now temporal-storage-setup.service');
  assert(
    firstStart >= 0 &&
      firstStart < packagedReady &&
      packagedReady < skip &&
      skip < enroll &&
      enroll < permitRemoval &&
      permitRemoval < reconcile
  );
  assert(script.indexOf('systemctl is-active --quiet k3s.service') < firstStart);
  assert(script.includes('Existing active K3s requires explicit reviewed maintenance'));
  assert(script.includes('never recreate it on startup'));
  assert(
    script.includes(
      'https://www.googleapis.com/auth/cloud-platform\nhttps://www.googleapis.com/auth/firebase.database\nhttps://www.googleapis.com/auth/userinfo.email'
    )
  );
  assert.equal(script.includes('\\n'), false, 'bootstrap has real line breaks');
  execFileSync('sh', ['-n'], { input: script, stdio: 'pipe' });
});
test('CLI requires actual filesystem UUID and emits renderable files, with Python guard/CAS behavioral suite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-media-bootstrap-'));
  try {
    const cli = new URL('./temporal-single-vm-config.mjs', import.meta.url).pathname;
    const args = [
      cli,
      '--project',
      config.projectId,
      '--instance-name',
      config.instanceName,
      '--instance-id',
      config.instanceId,
      '--private-ip',
      config.privateIp,
      '--output',
      dir,
    ];
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
    execFileSync(process.execPath, [...args, '--media-filesystem-uuid', config.mediaFilesystemUuid], { stdio: 'pipe' });
    const rendered = await readFile(join(dir, 'k3s.service'), 'utf8');
    assert.match(rendered, /\nExecStartPre=/);
    const configJson = JSON.parse(await readFile(join(dir, 'media-storage.json'), 'utf8'));
    const permit = JSON.parse(await readFile(join(dir, 'media-storage-initial-permit.json'), 'utf8'));
    const hash = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.stdin.read()),sort_keys=True,separators=(',',':')).encode()).hexdigest())",
      ],
      { input: JSON.stringify(configJson), encoding: 'utf8' }
    ).trim();
    assert.equal(permit.configSha256, hash, 'JS bootstrap and Python guard bind the same canonical config');
    execFileSync(
      'python3',
      ['-B', new URL('../ops/temporal/single-vm/test_media_storage.py', import.meta.url).pathname],
      { stdio: 'pipe' }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('actual fresh-install admission refuses retained cluster state or effective vendor units even when local unit is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-fresh-install-admission-'));
  const files = renderSingleVmBootstrap(config);
  try {
    const systemctl = join(dir, 'systemctl');
    await writeFile(
      systemctl,
      `#!/bin/sh
set -eu
case "$*" in
  *LoadState*) printf '%s\\n' "$FIXTURE_LOAD_STATE" ;;
  *DropInPaths*) printf '%s\\n' "$FIXTURE_DROP_IN_PATHS" ;;
  *FragmentPath*) printf '%s\\n' "$FIXTURE_FRAGMENT_PATH" ;;
  *) exit 99 ;;
esac
`
    );
    await chmod(systemctl, 0o700);
    const systemRoot = join(dir, 'root');
    const script = join(dir, 'classify.sh');
    const admission = files['classify-installation.sh'].replace(
      /\/(?:usr\/lib|lib|etc|var|run)\//g,
      (prefix) => systemRoot + prefix
    );
    await writeFile(script, admission);
    const execute = (load = 'not-found', fragment = '', dropIns = '') =>
      execFileSync('sh', [script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: dir + ':' + process.env.PATH,
          FIXTURE_LOAD_STATE: load,
          FIXTURE_FRAGMENT_PATH: fragment,
          FIXTURE_DROP_IN_PATHS: dropIns,
        },
      }).trim();
    assert.equal(execute(), 'fresh');
    for (const retained of [
      'var/lib/rancher/k3s/server/db/state.db',
      'var/lib/rancher/k3s/server/manifests/local-storage.yaml',
      'etc/rancher/k3s/k3s.yaml',
      'etc/rancher/k3s/config.yaml',
      'etc/rancher/node/password',
      'run/k3s/state',
      'etc/urm-temporal/media-storage.initializing',
    ]) {
      const destination = join(systemRoot, retained);
      await import('node:fs/promises').then((fs) => fs.mkdir(join(destination, '..'), { recursive: true }));
      await writeFile(destination, 'retained native state');
      assert.throws(() => execute(), /explicit audited maintenance/, 'retained ' + retained + ' cannot enroll');
      await rm(systemRoot, { recursive: true, force: true });
    }
    assert.throws(
      () => execute('loaded', '/usr/lib/systemd/system/k3s.service'),
      /explicit audited maintenance/,
      'vendor unit is existing installation'
    );
    assert.throws(() => execute('masked', ''), /explicit audited maintenance/);
    assert.throws(() => execute('not-found', '/retained/unit'), /explicit audited maintenance/);
    assert.equal(execute(), 'fresh');
    const fs = await import('node:fs/promises');
    for (const enrolled of [false, true]) {
      if (enrolled) {
        for (const path of ['etc/systemd/system/k3s.service', 'etc/urm-temporal/media-storage-enrollment.json']) {
          const destination = join(systemRoot, path);
          await fs.mkdir(join(destination, '..'), { recursive: true });
          await writeFile(destination, 'already enrolled');
        }
      }
      const load = enrolled ? 'loaded' : 'not-found';
      const fragment = enrolled ? join(systemRoot, 'etc/systemd/system/k3s.service') : '';
      assert.equal(execute(load, fragment), enrolled ? 'enrolled' : 'fresh');
      assert.throws(
        () => execute(load, fragment, '/etc/systemd/system/k3s.service.d/override.conf'),
        /explicit audited maintenance/,
        'effective drop-in cannot override guard'
      );
      for (const base of ['etc', 'run', 'usr/lib', 'lib']) {
        const directory = join(systemRoot, base, 'systemd/system/k3s.service.d');
        await fs.mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'override.conf'), '[Service]\nExecStartPre=\nExecStart=/unreviewed/command\n');
        assert.throws(
          () => execute(load, fragment),
          /explicit audited maintenance/,
          (enrolled ? 'enrolled' : 'orphaned') + ' ' + base + ' override rejected'
        );
        await rm(directory, { recursive: true, force: true });
      }
      await rm(systemRoot, { recursive: true, force: true });
    }
    const bootstrap = files['bootstrap.sh'];
    assert(bootstrap.indexOf('classify-installation.sh') < bootstrap.indexOf('install_same()'));
    assert(bootstrap.indexOf('classify-installation.sh') < bootstrap.indexOf('media-storage-initial-permit.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
