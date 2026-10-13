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
};
test('Simple bootstrap preserves real private node identity and encrypted keys without HA/DB/VIP requirements', () => {
  const files = renderSingleVmBootstrap(config),
    k3s = files['k3s-config.json'];
  assert.equal(k3s['node-name'], config.instanceName);
  assert.equal(k3s['bind-address'], config.privateIp);
  assert.equal(k3s['secrets-encryption'], true);
  assert.ok(files['wait-node.sh'].includes(`kubectl --server=https://${config.privateIp}:6443 wait`));
  assert.ok(files['temporal-storage-setup.service'].includes(`--server=https://${config.privateIp}:6443`));
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
    assert.ok(files['bootstrap.sh'].includes('Existing K3s configuration differs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
