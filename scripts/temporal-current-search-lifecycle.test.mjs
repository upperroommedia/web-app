import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from './temporal-release-runtime.mjs';
import {
  verifyCurrentDeploymentLog,
  parseCurrentLifecycleArgs,
  parseCurrentLifecycleReceipt,
} from './temporal-retire-current-search-lifecycle.mjs';
import { CURRENT_LIFECYCLE_CONTRACT as contract } from './temporal-current-search-lifecycle.mjs';
function fixture(change = () => {}) {
  const parent = 'projects/urm-app-staging/locations/us-central1',
    functionName = parent + '/functions/kit-users-index-executeFullIndexOperation',
    queue = parent + '/queues/kit-users-index-executeFullIndexOperation',
    url = 'https://kit-users-index-executefullindexoperation-fixture.a.run.app';
  const httpRequest = {
      url,
      httpMethod: 'POST',
      body: 'eyJkYXRhIjp7fX0=',
      oidcToken: { serviceAccountEmail: 'firebase-fn-123@urm-app-staging.iam.gserviceaccount.com', audience: url },
    },
    source = {
      bucket: 'gcf-v2-sources-251680231116-us-central1',
      object: 'kit-users-index-executeFullIndexOperation/function-source.zip',
      generation: '123456',
    };
  const environmentVariables = {
    TEMPORAL_RELEASE_COMMIT: contract.applicationCommit,
    STAGING_PROVIDER_MODE: 'sandbox',
    ...Object.fromEntries(
      ['MEDIA', 'PUBLISHING', 'IMAGES', 'EMAILS', 'ACCOUNTS', 'BUNDLES', 'SEARCH'].map((d) => [
        'TASK_ORCHESTRATOR_' + d,
        'temporal',
      ])
    ),
  };
  const fn = {
    name: functionName,
    state: 'ACTIVE',
    serviceConfig: {
      environmentVariables,
      uri: url,
      serviceAccountEmail: httpRequest.oidcToken.serviceAccountEmail,
      revision: 'synthetic-revision',
    },
    buildConfig: {
      source: { storageSource: source },
      sourceProvenance: { resolvedStorageSource: source },
      build: 'projects/251680231116/locations/us-central1/builds/aabbcc',
    },
  };
  const request = {
    name: functionName,
    serviceConfig: { environmentVariables: structuredClone(environmentVariables) },
    buildConfig: { source: { storageSource: structuredClone(source) } },
  };
  const row = {
    name: queue + '/tasks/1234567',
    requestLine: 5,
    responseLine: 7,
    request: { task: { httpRequest } },
    response: { name: queue + '/tasks/1234567', view: 'BASIC', httpRequest },
    actualTask: { httpRequest },
  };
  const operationName = parent + '/operations/operation-fixture';
  const input = {
    fn,
    request,
    row,
    done: true,
    complete: true,
    operationName,
    acknowledgedOperation: operationName,
    returnedOperation: operationName,
    metadataRequest: structuredClone(fn),
    patchStatus: 200,
  };
  change(input);
  const lines = [
    `[actual] >>> [apiv2][body] PATCH https://cloudfunctions.googleapis.com/v2/${functionName} ${JSON.stringify(
      request
    )}`,
    `[actual] <<< [apiv2][status] PATCH https://cloudfunctions.googleapis.com/v2/${functionName} ${input.patchStatus}`,
    `[actual] <<< [apiv2][body] PATCH https://cloudfunctions.googleapis.com/v2/${functionName} ${JSON.stringify({
      name: input.acknowledgedOperation,
    })}`,
    `[actual] <<< [apiv2][body] GET https://cloudfunctions.googleapis.com/v2/${parent}/operations/operation-fixture ${JSON.stringify(
      {
        name: input.returnedOperation,
        done: input.done,
        metadata: { requestResource: input.metadataRequest },
        response: fn,
      }
    )}`,
    `[actual] >>> [apiv2][body] POST https://cloudtasks.googleapis.com/v2/${queue}/tasks ${JSON.stringify(
      row.request
    )}`,
    `[actual] <<< [apiv2][status] POST https://cloudtasks.googleapis.com/v2/${queue}/tasks 200`,
    `[actual] <<< [apiv2][body] POST https://cloudtasks.googleapis.com/v2/${queue}/tasks ${JSON.stringify(
      row.response
    )}`,
    input.complete ? '✔ Deploy complete!' : 'Deploy failed',
  ];
  const bytes = Buffer.from(lines.join('\n'));
  row.sourceSha256 = hash(bytes);
  return { row, bytes };
}
test('same actual log joins source PATCH, successful9094 operation and task CreateTask triple', () => {
  const f = fixture(),
    r = verifyCurrentDeploymentLog(f.row, f.bytes);
  assert.equal(r.deployment.applicationCommit, contract.applicationCommit);
  assert.equal(r.deployment.patchLine, 1);
  assert.equal(r.deployment.completionLine, 4);
});
for (const [label, change] of Object.entries({
  oldSource: (x) => {
    x.fn.serviceConfig.environmentVariables.TEMPORAL_RELEASE_COMMIT = '99c76a6eee820d347c06752573e45224665687ed';
  },
  requestSource: (x) => {
    x.request.serviceConfig.environmentVariables.TEMPORAL_RELEASE_COMMIT = '0'.repeat(40);
  },
  generation: (x) => {
    x.request.buildConfig.source.storageSource.generation = '999';
  },
  wrongUploadBucket: (x) => {
    x.request.buildConfig.source.storageSource = {
      bucket: 'foreign-bucket',
      object: 'aaee4070-0103-4ed1-b49a-12697d66e028.zip',
    };
  },
  wrongOperation: (x) => {
    x.acknowledgedOperation = x.operationName + '-other';
  },
  wrongReturnedOperation: (x) => {
    x.returnedOperation = x.operationName + '-other';
  },
  wrongNormalizedSource: (x) => {
    x.metadataRequest.buildConfig.source.storageSource.generation = '999';
  },
  wrongNormalizedRuntime: (x) => {
    x.metadataRequest.serviceConfig.environmentVariables.TEMPORAL_RELEASE_COMMIT = '0'.repeat(40);
  },
  patchFailed: (x) => {
    x.patchStatus = 500;
  },
  notDone: (x) => {
    x.done = false;
  },
  failure: (x) => {
    x.complete = false;
  },
  wrongTarget: (x) => {
    x.fn.serviceConfig.uri = 'https://another.a.run.app';
  },
  wrongPrincipal: (x) => {
    x.fn.serviceConfig.serviceAccountEmail = 'another@urm-app-staging.iam.gserviceaccount.com';
  },
  flags: (x) => {
    x.fn.serviceConfig.environmentVariables.TASK_ORCHESTRATOR_SEARCH = 'legacy';
  },
}))
  test(`deployment provenance rejects ${label} despite matching candidate source label`, () => {
    const f = fixture(change);
    assert.throws(() => verifyCurrentDeploymentLog(f.row, f.bytes), /DEPLOY/);
  });
test('apply arguments require exact original receipt identity and reject partial receipt', () => {
  assert.throws(
    () =>
      parseCurrentLifecycleReceipt(
        JSON.stringify({ mode: 'inspect', noMutations: true, manifest: {}, cleanupCompleted: false })
      ),
    /CLEAN_INSPECT/
  );
  assert.throws(() => parseCurrentLifecycleArgs(['--apply']), /ARGUMENTS/);
});

test('managed upload source joins through the exact acknowledged update operation', () => {
  const f = fixture((x) => {
    x.request.buildConfig.source.storageSource = {
      bucket: 'gcf-v2-uploads-251680231116.us-central1.cloudfunctions.appspot.com',
      object: 'aaee4070-0103-4ed1-b49a-12697d66e028.zip',
    };
  });
  const r = verifyCurrentDeploymentLog(f.row, f.bytes);
  assert.equal(r.deployment.requestSourceKind, 'managed-upload');
  assert.equal(
    r.deployment.operationName,
    'projects/urm-app-staging/locations/us-central1/operations/operation-fixture'
  );
});
