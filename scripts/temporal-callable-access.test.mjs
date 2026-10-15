import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicCallableTransport,
  verifyBrowserCallableAccess,
  verifyTemporalCallableTransport,
  TEMPORAL_BROWSER_CALLABLES,
} from './temporal-callable-access.mjs';

function fixture() {
  const binding = { projectId: 'urm-app-staging', projectNumber: '251680231116', runtimeCommit: '1'.repeat(40) };
  const prefix = `projects/${binding.projectId}/locations/us-central1/`;
  const expected = {
    functionId: 'submitDurableJob',
    region: 'us-central1',
    codebase: 'core',
    sourceCommit: binding.runtimeCommit,
    endpoint: { platform: 'gcfv2', entryPoint: 'submitDurableJob', callableTrigger: {} },
    service: `${prefix}services/submitdurablejob`,
    revision: 'submitdurablejob-00005-quk',
    build: `projects/${binding.projectNumber}/locations/us-central1/builds/fixture-build`,
    source: {
      bucket: 'gcf-v2-sources-251680231116-us-central1',
      object: 'submitDurableJob/function-source.zip',
      generation: '1791961973517813',
    },
  };
  const deployed = {
    name: `${prefix}functions/submitDurableJob`,
    environment: 'GEN_2',
    state: 'ACTIVE',
    labels: { 'deployment-callable': 'true', 'firebase-functions-codebase': 'core' },
    buildConfig: {
      entryPoint: 'submitDurableJob',
      build: expected.build,
      source: { storageSource: structuredClone(expected.source) },
      sourceProvenance: { resolvedStorageSource: structuredClone(expected.source) },
    },
    serviceConfig: { service: expected.service, revision: expected.revision },
  };
  const calls = [];
  let policy = { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] };
  const api = async (url, method) => {
    calls.push({ url, method });
    assert.equal(method, 'GET');
    if (url === `https://cloudfunctions.googleapis.com/v2/${deployed.name}`) return structuredClone(deployed);
    assert.equal(url, `https://run.googleapis.com/v2/${expected.service}:getIamPolicy`);
    return structuredClone(policy);
  };
  return {
    binding,
    expected,
    deployed,
    calls,
    api,
    setPolicy: (value) => {
      policy = value;
    },
  };
}
const run = (f, api = f.api) => verifyBrowserCallableAccess({ binding: f.binding, callables: [f.expected], api });

test('actual missing service policy shape blocks despite healthy source deployment', async () => {
  const f = fixture();
  f.setPolicy({ etag: 'ACAB' });
  await assert.rejects(run(f), /no public invoker/);
  assert.equal(f.calls.length, 2);
});
test('restored unconditional allUsers binding passes exact GET-only source/service join', async () => {
  const f = fixture(),
    result = await run(f);
  assert.equal(result.result, 'passed');
  assert.equal(result.checked, 1);
  assert.equal(result.remoteMutations, 0);
  assert.equal(result.handlerAuthorizationVerified, false);
  assert.equal(f.calls.length, 3);
  assert(f.calls.every(({ method }) => method === 'GET'));
  assert.equal(result.callables[0].service, f.expected.service);
});
for (const policy of [
  {},
  { bindings: [] },
  { bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }] },
  { bindings: [{ role: 'roles/run.admin', members: ['allUsers'] }] },
  { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'], condition: { expression: 'true' } }] },
  { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'], condition: null }] },
  { bindings: [{ role: 'roles/run.invoker', members: 'allUsers' }] },
])
  test(`rejects absent, conditional, wrong-role or malformed public transport ${JSON.stringify(policy)}`, () => {
    assert.throws(() => assertPublicCallableTransport(policy));
  });

for (const [name, mutate] of [
  [
    'foreign source commit',
    (f) => {
      f.expected.sourceCommit = '2'.repeat(40);
    },
  ],
  [
    'foreign service project',
    (f) => {
      f.expected.service = f.expected.service.replace('urm-app-staging', 'urm-app');
    },
  ],
  [
    'foreign service region',
    (f) => {
      f.expected.service = f.expected.service.replace('us-central1', 'us-east1');
    },
  ],
  [
    'foreign source bucket',
    (f) => {
      f.expected.source.bucket = 'gcf-v2-sources-999999999-us-central1';
    },
  ],
  [
    'foreign build project',
    (f) => {
      f.expected.build = f.expected.build.replace('251680231116', '999999999');
    },
  ],
  [
    'export mismatch',
    (f) => {
      f.expected.endpoint.entryPoint = 'getDurableJobReceipt';
    },
  ],
  [
    'private HTTP',
    (f) => {
      delete f.expected.endpoint.callableTrigger;
      f.expected.endpoint.httpsTrigger = {};
    },
  ],
  [
    'task queue',
    (f) => {
      delete f.expected.endpoint.callableTrigger;
      f.expected.endpoint.taskQueueTrigger = {};
    },
  ],
  [
    'event',
    (f) => {
      delete f.expected.endpoint.callableTrigger;
      f.expected.endpoint.eventTrigger = {};
    },
  ],
  [
    'mixed declaration',
    (f) => {
      f.expected.endpoint.taskQueueTrigger = {};
    },
  ],
])
  test(`rejects ${name} before API access`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(run(f));
    assert.equal(f.calls.length, 0);
  });

for (const [name, mutate] of [
  [
    'source generation',
    (f) => {
      f.deployed.buildConfig.source.storageSource.generation = '9';
    },
  ],
  [
    'resolved generation',
    (f) => {
      f.deployed.buildConfig.sourceProvenance.resolvedStorageSource.generation = '9';
    },
  ],
  [
    'build',
    (f) => {
      f.deployed.buildConfig.build += '-other';
    },
  ],
  [
    'lookalike service',
    (f) => {
      f.deployed.serviceConfig.service += '-other';
    },
  ],
  [
    'revision',
    (f) => {
      f.deployed.serviceConfig.revision += '-other';
    },
  ],
  [
    'not callable',
    (f) => {
      delete f.deployed.labels['deployment-callable'];
    },
  ],
  [
    'deployed event',
    (f) => {
      f.deployed.eventTrigger = {};
    },
  ],
  [
    'failed deployment',
    (f) => {
      f.deployed.state = 'FAILED';
    },
  ],
])
  test(`rejects deployed ${name} mismatch before reading IAM`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(run(f));
    assert.equal(f.calls.length, 1);
  });
test('a redeployment during IAM read cannot borrow the policy proof', async () => {
  const f = fixture();
  await assert.rejects(
    run(f, async (url, method) => {
      const response = await f.api(url, method);
      if (url.includes(':getIamPolicy')) f.deployed.serviceConfig.revision += '-new';
      return response;
    }),
    /revision changed/
  );
});
test('empty and duplicate selections cannot claim complete callable coverage', async () => {
  const f = fixture();
  await assert.rejects(verifyBrowserCallableAccess({ binding: f.binding, callables: [], api: f.api }));
  await assert.rejects(
    verifyBrowserCallableAccess({ binding: f.binding, callables: [f.expected, f.expected], api: f.api })
  );
  assert.equal(f.calls.length, 0);
});

function temporalFixture() {
  const f = fixture();
  const flags = { TASK_ORCHESTRATOR_UPLOADS: 'temporal' };
  const functions = TEMPORAL_BROWSER_CALLABLES.map((id) => ({
    ...structuredClone(f.deployed),
    name: f.deployed.name.replace('submitDurableJob', id),
    buildConfig: { ...structuredClone(f.deployed.buildConfig), entryPoint: id },
    serviceConfig: {
      service: f.expected.service.replace('submitdurablejob', id.toLowerCase()),
      revision: id.toLowerCase() + '-00001-abc',
      environmentVariables: { ...flags, TEMPORAL_RELEASE_COMMIT: f.binding.runtimeCommit },
    },
  }));
  const calls = [];
  return {
    functions,
    projectId: f.binding.projectId,
    projectNumber: f.binding.projectNumber,
    region: 'us-central1',
    runtimeCommit: f.binding.runtimeCommit,
    flags,
    calls,
    api: async (url, method) => {
      calls.push({ url, method });
      assert.equal(method, 'GET');
      if (url.includes('run.googleapis.com'))
        return { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] };
      return structuredClone(functions.find((fn) => url.endsWith(fn.name)));
    },
  };
}
test('mandatory Temporal callable transport accepts verified project number alias and reads only exact three services', async () => {
  const f = temporalFixture();
  for (const fn of f.functions)
    fn.serviceConfig.service = fn.serviceConfig.service.replace(f.projectId, f.projectNumber);
  const result = await verifyTemporalCallableTransport(f);
  assert.equal(result.checked, 3);
  assert.equal(result.handlerAuthorizationVerified, false);
  assert.equal(f.calls.length, 6);
});
for (const id of TEMPORAL_BROWSER_CALLABLES)
  test(`mandatory callable cannot be omitted: ${id}`, async () => {
    const f = temporalFixture();
    f.functions = f.functions.filter((fn) => !fn.name.endsWith('/' + id));
    await assert.rejects(verifyTemporalCallableTransport(f), /missing or duplicated/);
    assert.equal(f.calls.length, 0);
  });
for (const field of ['service', 'revision', 'build'])
  test(`callable ${field} race fails closed`, async () => {
    const f = temporalFixture(),
      api = f.api;
    f.api = async (...args) => {
      const value = await api(...args);
      if (args[0].includes('cloudfunctions')) {
        if (field === 'build') value.buildConfig.build += '-changed';
        else value.serviceConfig[field] += '-changed';
      }
      return value;
    };
    await assert.rejects(verifyTemporalCallableTransport(f), /changed/);
  });
