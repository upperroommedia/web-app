import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { proofDigest } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as original } from './temporal-owned-smoke-plan.mjs';
const require = createRequire(import.meta.url),
  ts = require('typescript');
const worker = createRequire(new URL('../apps/temporal-worker/package.json', import.meta.url));
const { historyToJSON } = worker('@temporalio/common/lib/proto-utils');
const { temporal } = worker('@temporalio/proto');
const History = temporal.api.history.v1.History;
const events = [
  ...Array.from({ length: 10 }, (_, i) => ({
    eventId: String(i + 1),
    eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
  })),
  {
    eventId: '11',
    eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED',
    workflowExecutionFailedEventAttributes: {
      failure: { message: 'Synthetic private error', cause: { applicationFailureInfo: { type: 'EMAIL_STALE_JOB' } } },
    },
  },
];
const histories = [History.fromObject({ events: events.slice(0, 5) }), History.fromObject({ events: events.slice(5) })];
const toJSON = (h) => {
  const value = historyToJSON(h);
  return typeof value === 'string' ? JSON.parse(value) : value;
};
const binding = {
  ...original,
  emailHistoryDigest: proofDigest(histories.flatMap((h) => toJSON(h).events)),
  emailEventCount: 11,
};
function reader() {
  const exports = {};
  vm.runInThisContext(
    '(function(exports,require){' +
      ts.transpileModule(readFileSync(new URL('./temporal-owned-smoke-native.mjs', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: 'native.ts',
      }).outputText +
      '\n})'
  )(exports, (name) => {
    if (name === './temporal-owned-smoke-plan.mjs') return { OWNED_SMOKE_INCIDENT: binding };
    if (name === './temporal-release-runtime.mjs') return { proofDigest };
    throw Error('UNEXPECTED_NATIVE_TEST_IMPORT');
  });
  return exports.readOriginalOwnedEmailNative;
}
function fixture(change = () => {}) {
  let descriptions = 0,
    historiesRead = 0;
  const calls = [];
  const request = async (method, args) => {
    calls.push({ method, args });
    assert.equal(args.namespace, binding.temporalNamespace);
    assert.equal(args.execution.workflowId, binding.emailWorkflowId);
    let response;
    if (method === 'describeWorkflowExecution') {
      descriptions++;
      response = {
        workflowExecutionInfo: {
          execution: { workflowId: binding.emailWorkflowId, runId: binding.emailRunId },
          status: 3,
        },
        pendingActivities: [],
      };
    } else {
      assert.equal(method, 'getWorkflowExecutionHistory');
      assert.equal(args.execution.runId, binding.emailRunId);
      response = {
        history: histories[Math.min(historiesRead, 1)],
        ...(historiesRead === 0 ? { nextPageToken: Uint8Array.of(1) } : {}),
      };
      historiesRead++;
    }
    change({ method, args, response, descriptions, historiesRead });
    return response;
  };
  return { request, calls };
}
test('actual SDK history JSON joins all pages and returns only pinned honest FAILED facts', async () => {
  const f = fixture();
  const proof = await reader()({ ...f, historyToJSON, namespace: binding.temporalNamespace });
  assert.equal(proof.status, 'FAILED');
  assert.equal(proof.historyDigest, binding.emailHistoryDigest);
  assert.equal(f.calls.length, 4);
  assert(!JSON.stringify(proof).includes('Synthetic private error'));
  assert.deepEqual(
    Object.keys(proof).sort(),
    [
      'workflowId',
      'runId',
      'latestRunId',
      'status',
      'failureType',
      'pendingActivities',
      'terminalEventType',
      'historyDigest',
    ].sort()
  );
});
for (const [name, change] of [
  [
    'new current run',
    (x) => {
      if (x.method === 'describeWorkflowExecution') x.response.workflowExecutionInfo.execution.runId = 'other';
    },
  ],
  [
    'run changes after history',
    (x) => {
      if (x.descriptions === 2) x.response.workflowExecutionInfo.execution.runId = 'other';
    },
  ],
  [
    'pending activity',
    (x) => {
      if (x.method === 'describeWorkflowExecution') x.response.pendingActivities = [{}];
    },
  ],
  [
    'malformed pending activities',
    (x) => {
      if (x.method === 'describeWorkflowExecution') x.response.pendingActivities = false;
    },
  ],
  [
    'malformed history token',
    (x) => {
      if (x.method === 'getWorkflowExecutionHistory') x.response.nextPageToken = false;
    },
  ],
  [
    'repeated history cursor',
    (x) => {
      if (x.method === 'getWorkflowExecutionHistory') x.response.nextPageToken = Uint8Array.of(1);
    },
  ],
  [
    'missing history',
    (x) => {
      if (x.method === 'getWorkflowExecutionHistory') delete x.response.history;
    },
  ],
  [
    'changed original history',
    (x) => {
      if (x.method === 'getWorkflowExecutionHistory') x.response.history = History.fromObject({ events: [] });
    },
  ],
])
  test('native reader rejects ' + name, async () => {
    const f = fixture(change);
    await assert.rejects(reader()({ ...f, historyToJSON, namespace: binding.temporalNamespace }), /OWNED_SMOKE_/);
  });
test('wrong namespace is rejected before any service call', async () => {
  let calls = 0;
  await assert.rejects(
    reader()({
      request: async () => {
        calls++;
      },
      historyToJSON,
      namespace: 'other',
    }),
    /NATIVE_READ_BINDING_REQUIRED/
  );
  assert.equal(calls, 0);
});
