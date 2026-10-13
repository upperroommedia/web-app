import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synchronize, crc32c, decodeTemporalKey } from './temporal-vm-secrets.mjs';
const bytes = Buffer.from('synthetic-scoped-key');
function transport(overrides = {}) {
  return async (url) => {
    if (url.startsWith('http:')) {
      const map = {
        'project/project-id': 'urm-app-staging',
        'project/numeric-project-id': '1234',
        'instance/id': '5678',
        'instance/service-accounts/default/email': 'temporal-worker@urm-app-staging.iam.gserviceaccount.com',
        'instance/network-interfaces/0/ip': '10.241.0.10',
        'instance/service-accounts/default/token': JSON.stringify({ access_token: 'synthetic-token' }),
      };
      const key = url.split('/computeMetadata/v1/')[1];
      return new Response(overrides[key] ?? map[key], { headers: { 'Metadata-Flavor': 'Google' } });
    }
    const secret = url.includes('WORKER_API_KEY') ? 'TEMPORAL_WORKER_API_KEY' : 'TEMPORAL_OPERATOR_API_KEY';
    return Response.json({
      name: `projects/1234/secrets/${secret}/versions/1`,
      payload: { data: bytes.toString('base64'), dataCrc32c: String(crc32c(bytes)) },
    });
  };
}
test('VM key sync verifies attached identity and CRC, passing secret data only through process stdin', async () => {
  const calls = [];
  await synchronize({
    projectId: 'urm-app-staging',
    namespace: 'temporal-staging',
    instanceId: '5678',
    request: transport(),
    run: (file, args, options) => calls.push({ file, args, options }),
  });
  assert.equal(calls.length, 3);
  for (const { file, args, options } of calls) {
    assert.equal(file, '/usr/local/bin/k3s');
    assert.ok(args.includes('--server=https://10.241.0.10:6443'));
    assert.equal(JSON.stringify(args).includes('synthetic'), false);
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
    const secret = JSON.parse(options.input);
    assert.equal(secret.metadata.namespace, 'temporal-staging');
    if (secret.type === 'Opaque') assert.equal(secret.data['api-key'], bytes.toString('base64'));
    else {
      assert.equal(secret.metadata.name, 'temporal-artifact-registry');
      const registry = JSON.parse(Buffer.from(secret.data['.dockerconfigjson'], 'base64'));
      assert.deepEqual(Object.keys(registry.auths), ['us-central1-docker.pkg.dev']);
      assert.equal(registry.auths['us-central1-docker.pkg.dev'].username, 'oauth2accesstoken');
      assert.equal(registry.auths['us-central1-docker.pkg.dev'].password, 'synthetic-token');
    }
  }
});
test('VM key sync fails before any key request or Kubernetes update for another project, instance or attached identity', async () => {
  for (const overrides of [
    { 'project/project-id': 'urm-app' },
    { 'instance/id': 'foreign' },
    { 'instance/service-accounts/default/email': 'default' },
  ])
    await assert.rejects(
      synchronize({
        projectId: 'urm-app-staging',
        namespace: 'temporal-staging',
        instanceId: '5678',
        request: transport(overrides),
        run: () => assert.fail('must not mutate'),
      })
    );
  assert.throws(() => decodeTemporalKey({ data: bytes.toString('base64'), dataCrc32c: '0' }));
  assert.throws(() =>
    decodeTemporalKey({
      data: Buffer.from('bad key').toString('base64'),
      dataCrc32c: String(crc32c(Buffer.from('bad key'))),
    })
  );
});
