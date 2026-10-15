import assert from 'node:assert/strict';

const own = (value, key) => Object.hasOwn(value ?? {}, key);
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);

/** Only declarations from the verified immutable Firebase endpoint manifest qualify. */
export function assertBrowserCallableDeclaration(endpoint) {
  assert(endpoint?.platform === 'gcfv2' && own(endpoint, 'callableTrigger'), 'Expected an explicit v2 callable');
  assert(
    endpoint.callableTrigger &&
      typeof endpoint.callableTrigger === 'object' &&
      !Array.isArray(endpoint.callableTrigger),
    'Invalid callable declaration'
  );
  for (const trigger of ['httpsTrigger', 'eventTrigger', 'taskQueueTrigger', 'scheduleTrigger', 'blockingTrigger'])
    assert(!own(endpoint, trigger), 'Mixed or non-callable trigger is not browser transport authority');
}

/** Public transport is necessary for unauthenticated OPTIONS, not handler authorization. */
export function assertPublicCallableTransport(policy) {
  assert(Array.isArray(policy?.bindings), 'Callable service has no public invoker binding');
  for (const binding of policy.bindings)
    assert(
      typeof binding?.role === 'string' &&
        Array.isArray(binding.members) &&
        binding.members.every((member) => typeof member === 'string'),
      'Malformed service IAM policy'
    );
  assert(
    policy.bindings.some(
      (binding) =>
        binding.role === 'roles/run.invoker' && binding.members.includes('allUsers') && !own(binding, 'condition')
    ),
    'Callable service requires unconditional allUsers roles/run.invoker'
  );
}

function validateExpected(binding, expected) {
  const { projectId, projectNumber, runtimeCommit } = binding;
  assert(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? ''), 'Exact project ID required');
  assert(/^[1-9][0-9]+$/.test(projectNumber ?? ''), 'Verified project number required');
  assert(/^[a-f0-9]{40}$/.test(runtimeCommit ?? ''), 'Verified immutable runtime commit required');
  assertBrowserCallableDeclaration(expected.endpoint);
  assert(expected.sourceCommit === runtimeCommit, 'Callable source differs from verified runtime');
  assert(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(expected.functionId ?? ''), 'Invalid callable export ID');
  assert(/^[a-z]+-[a-z0-9]+[0-9]$/.test(expected.region ?? ''), 'Exact callable region required');
  assert(expected.endpoint.entryPoint === expected.functionId, 'Callable entry point differs from export');
  assert(/^[a-z][a-z0-9-]*$/.test(expected.codebase ?? ''), 'Exact codebase required');
  const prefix = `projects/${projectId}/locations/${expected.region}/`;
  assert(
    typeof expected.service === 'string' && expected.service.startsWith(`${prefix}services/`),
    'Callable service belongs to a different project or region'
  );
  const serviceId = expected.service.slice(`${prefix}services/`.length);
  assert(/^[a-z][a-z0-9-]{0,62}$/.test(serviceId), 'Invalid exact service identity');
  assert(
    typeof expected.revision === 'string' &&
      expected.revision.startsWith(`${serviceId}-`) &&
      /^[a-z][a-z0-9-]+$/.test(expected.revision),
    'Exact service-qualified revision required'
  );
  assert(
    typeof expected.build === 'string' &&
      expected.build.startsWith(`projects/${projectNumber}/locations/${expected.region}/builds/`) &&
      /^[A-Za-z0-9-]+$/.test(expected.build.split('/').at(-1)),
    'Build belongs to a different project or region'
  );
  assert(
    expected.source?.bucket === `gcf-v2-sources-${projectNumber}-${expected.region}` &&
      typeof expected.source.object === 'string' &&
      expected.source.object.length > 0 &&
      /^[1-9][0-9]*$/.test(expected.source.generation ?? ''),
    'Exact managed source generation required'
  );
  return `${prefix}functions/${expected.functionId}`;
}

function assertDeployedCallable(actual, expected, name) {
  assert(
    actual?.name === name && actual.environment === 'GEN_2' && actual.state === 'ACTIVE',
    'Exact active v2 callable deployment required'
  );
  assert(
    actual.labels?.['deployment-callable'] === 'true' &&
      actual.labels?.['firebase-functions-codebase'] === expected.codebase,
    'Deployment is not the reviewed callable'
  );
  for (const trigger of ['eventTrigger', 'taskQueueTrigger', 'scheduleTrigger', 'blockingTrigger'])
    assert(!own(actual, trigger), 'Non-callable deployment cannot pass this gate');
  same(actual.buildConfig?.entryPoint, expected.endpoint.entryPoint, 'Deployed entry point changed');
  same(actual.buildConfig?.build, expected.build, 'Deployed build changed');
  same(actual.buildConfig?.source?.storageSource, expected.source, 'Deployed source generation changed');
  same(
    actual.buildConfig?.sourceProvenance?.resolvedStorageSource,
    expected.source,
    'Resolved source generation changed'
  );
  same(actual.serviceConfig?.service, expected.service, 'Deployed service mapping changed');
  same(actual.serviceConfig?.revision, expected.revision, 'Deployed revision changed');
}

/**
 * GET-only join of already verified source/deployment pins and current service IAM.
 * The caller supplies the existing authenticated operator API, not credentials.
 * No endpoint discovery, policy mutation, token minting or handler invocation occurs.
 */
export async function verifyBrowserCallableAccess({ binding, callables, api }) {
  assert(binding && typeof api === 'function', 'Verified resource binding and read API required');
  assert(
    Array.isArray(callables) && callables.length > 0 && callables.length <= 100,
    'Explicit reviewed browser callable selection required'
  );
  // Validate every input before the first remote read.
  const names = callables.map((expected) => validateExpected(binding, expected));
  assert(
    new Set(names).size === names.length && new Set(callables.map((item) => item.service)).size === names.length,
    'Duplicate callable or service selection'
  );
  const rows = [];
  const startedAt = new Date().toISOString();
  for (const [index, expected] of callables.entries()) {
    const name = names[index];
    const functionUrl = `https://cloudfunctions.googleapis.com/v2/${name}`;
    assertDeployedCallable(await api(functionUrl, 'GET'), expected, name);
    const policy = await api(`https://run.googleapis.com/v2/${expected.service}:getIamPolicy`, 'GET');
    assertPublicCallableTransport(policy);
    // A concurrent source/revision/service change cannot borrow the IAM read.
    assertDeployedCallable(await api(functionUrl, 'GET'), expected, name);
    rows.push({
      function: name,
      service: expected.service,
      revision: expected.revision,
      source: expected.source,
      build: expected.build,
      publicTransportVerified: true,
    });
  }
  return {
    schemaVersion: 1,
    result: 'passed',
    scope: 'exact-browser-callable-public-transport-only',
    projectId: binding.projectId,
    runtimeCommit: binding.runtimeCommit,
    startedAt,
    verifiedAt: new Date().toISOString(),
    checked: rows.length,
    callables: rows,
    handlerAuthorizationVerified: false,
    remoteMutations: 0,
  };
}

/** Mandatory Temporal browser entry points; service identity comes from current Functions metadata. */
export const TEMPORAL_BROWSER_CALLABLES = Object.freeze([
  'submitDurableJob',
  'getDurableJobReceipt',
  'commandDurableJob',
]);

export async function verifyTemporalCallableTransport({
  functions,
  projectId,
  projectNumber,
  region,
  runtimeCommit,
  flags,
  api,
}) {
  assert(Array.isArray(functions) && typeof api === 'function', 'Current managed Functions and reader required');
  assert(/^[a-f0-9]{40}$/.test(runtimeCommit ?? ''), 'Reviewed callable commit required');
  assert(
    /^[a-z][a-z0-9-]+$/.test(projectId ?? '') && /^[1-9][0-9]*$/.test(projectNumber ?? ''),
    'Verified callable project required'
  );
  assert(/^[a-z]+-[a-z0-9]+[0-9]$/.test(region ?? ''), 'Verified callable region required');
  assert(flags && typeof flags === 'object' && Object.keys(flags).length > 0, 'Callable ownership flags required');
  const selected = TEMPORAL_BROWSER_CALLABLES.map((id) => {
    const name = `projects/${projectId}/locations/${region}/functions/${id}`;
    const matches = functions.filter((fn) => fn.name === name);
    assert(matches.length === 1, `Required browser callable missing or duplicated: ${id}`);
    return matches[0];
  });
  function identity(fn, id) {
    assert(
      fn?.name === `projects/${projectId}/locations/${region}/functions/${id}` &&
        fn.state === 'ACTIVE' &&
        fn.environment === 'GEN_2',
      'Required active Gen2 browser callable changed'
    );
    assert(
      fn.labels?.['deployment-callable'] === 'true' &&
        fn.labels?.['firebase-functions-codebase'] === 'core' &&
        fn.buildConfig?.entryPoint === id,
      'Required core callable declaration changed'
    );
    const env = fn.serviceConfig?.environmentVariables;
    assert(env?.TEMPORAL_RELEASE_COMMIT === runtimeCommit, 'Callable runtime commit changed');
    for (const [key, value] of Object.entries(flags))
      assert(env[key] === value, `Callable ownership flag changed: ${key}`);
    const service = fn.serviceConfig?.service;
    assert(
      typeof service === 'string' &&
        [projectId, projectNumber].some((project) =>
          service.startsWith(`projects/${project}/locations/${region}/services/`)
        ),
      'Callable service project or region changed'
    );
    assert(
      service.split('/').length === 6 && /^[a-z][a-z0-9-]{0,62}$/.test(service.split('/').at(-1)),
      'Invalid callable service identity'
    );
    for (const trigger of ['eventTrigger', 'taskQueueTrigger', 'scheduleTrigger', 'blockingTrigger'])
      assert(!own(fn, trigger), 'Required browser callable has non-callable trigger');
    const revision = fn.serviceConfig?.revision,
      build = fn.buildConfig?.build;
    assert(
      typeof revision === 'string' && revision.length > 0 && typeof build === 'string' && build.length > 0,
      'Callable revision/build missing'
    );
    return { service, revision, build };
  }
  // Every mandatory selection passes local gates before any IAM read.
  const pins = selected.map((fn, index) => identity(fn, TEMPORAL_BROWSER_CALLABLES[index]));
  assert(new Set(pins.map((pin) => pin.service)).size === pins.length, 'Duplicate browser callable service');
  for (const [index, fn] of selected.entries()) {
    assertPublicCallableTransport(
      await api(`https://run.googleapis.com/v2/${pins[index].service}:getIamPolicy`, 'GET')
    );
    const fresh = await api(`https://cloudfunctions.googleapis.com/v2/${fn.name}`, 'GET');
    same(
      identity(fresh, TEMPORAL_BROWSER_CALLABLES[index]),
      pins[index],
      'Callable deployment changed during IAM verification'
    );
  }
  return {
    checked: selected.length,
    publicTransportVerified: true,
    handlerAuthorizationVerified: false,
    remoteMutations: 0,
  };
}
