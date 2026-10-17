import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { validateOwnedIndexPlan, assertOwnedSmokeAuthority } from './temporal-owned-smoke-index-stage.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
import {
  OWNED_SMOKE_INCIDENT as incident,
  ownedMirrorPaths,
  planOwnedMirrorEdges,
  capturedEmailProjection,
} from './temporal-owned-smoke-plan.mjs';

// Synthetic, pure planner tests only: no SDK initialization, authentication or cloud effects.
const key = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const row = (path, data) => ({
  path,
  data,
  native: {
    dataDigest: proofDigest(data),
    createTime: { seconds: 100, nanoseconds: 1 },
    updateTime: { seconds: 101, nanoseconds: 2 },
  },
});
const repin = (document) => {
  document.native.dataDigest = proofDigest(document.data);
};
function fixture() {
  const marker = row('_control/temporalProviderUsage', {
    schemaVersion: 1,
    projectId: incident.projectId,
    status: 'ready',
    epoch: incident.originalEpoch,
  });
  const groups = incident.resources.map((resource) => {
    const path = `temporalProviderUsage/${key([
      resource.projectId,
      resource.provider,
      resource.account,
      resource.remoteId,
    ])}/epochs/${incident.originalEpoch}`;
    const canonicalPath = `sermons/${incident.sermonId}`;
    return {
      resource: structuredClone(resource),
      aggregate: row(path, { ...resource, epoch: incident.originalEpoch, state: 'active', referenceCount: 1 }),
      edges: {
        allPages: true,
        rows: [row(`${path}/edges/${key(canonicalPath)}`, { canonicalPath, projectId: incident.projectId })],
      },
      canonicals: [canonicalPath, ...ownedMirrorPaths()].map((p) => row(p, { resources: [resource] })),
    };
  });
  return { marker, groups, extractResources: (_project, _path, data) => data.resources };
}
test('plans exactly six edges and two count fields without mutating input or exposing canonical payload', () => {
  const f = fixture();
  const before = proofDigest({ marker: f.marker, groups: f.groups });
  const plan = planOwnedMirrorEdges(f);
  assert.equal(plan.edgeCreates, 6);
  assert.equal(plan.countUpdates, 2);
  assert.equal(plan.providerWrites, 0);
  assert.equal(plan.canonicalWrites, 0);
  assert.equal(proofDigest({ marker: f.marker, groups: f.groups }), before);
  for (const group of plan.aggregates) {
    assert.equal(group.beforeCount, 1);
    assert.equal(group.afterCount, 4);
    assert.equal(group.creates.length, 3);
    assert(group.creates.every((create) => Object.keys(create.data).sort().join(',') === 'canonicalPath,projectId'));
    assert(group.canonicals.every((d) => !Object.hasOwn(d, 'data')));
  }
});
const badIndex = [
  [
    'production marker',
    (f) => {
      f.marker.data.projectId = 'urm-app';
      repin(f.marker);
    },
  ],
  [
    'new epoch',
    (f) => {
      f.marker.data.epoch = 'new-epoch';
      repin(f.marker);
    },
  ],
  [
    'building marker',
    (f) => {
      f.marker.data.status = 'building';
      repin(f.marker);
    },
  ],
  [
    'foreign resource',
    (f) => {
      f.groups[0].resource.remoteId = 'foreign';
    },
  ],
  [
    'duplicate group',
    (f) => {
      f.groups[1] = structuredClone(f.groups[0]);
    },
  ],
  [
    'reserved aggregate',
    (f) => {
      f.groups[0].aggregate.data.state = 'reserved';
      repin(f.groups[0].aggregate);
    },
  ],
  [
    'active with cleanup proof',
    (f) => {
      f.groups[0].aggregate.data.cleanupProof = {};
      repin(f.groups[0].aggregate);
    },
  ],
  [
    'count differs from full edges',
    (f) => {
      f.groups[0].aggregate.data.referenceCount = 2;
      repin(f.groups[0].aggregate);
    },
  ],
  [
    'incomplete pages',
    (f) => {
      f.groups[0].edges.allPages = false;
    },
  ],
  [
    'stale native digest',
    (f) => {
      f.groups[0].aggregate.data.referenceCount = 0;
    },
  ],
  [
    'missing native timestamp',
    (f) => {
      delete f.groups[0].aggregate.native.updateTime;
    },
  ],
  [
    'forged edge key',
    (f) => {
      f.groups[0].edges.rows[0].path += 'x';
    },
  ],
  [
    'foreign edge project',
    (f) => {
      f.groups[0].edges.rows[0].data.projectId = 'urm-app';
      repin(f.groups[0].edges.rows[0]);
    },
  ],
  [
    'existing edge references absent canonical',
    (f) => {
      f.groups[0].canonicals.shift();
    },
  ],
  [
    'target missing reference',
    (f) => {
      f.groups[0].canonicals[1].data.resources = [];
      repin(f.groups[0].canonicals[1]);
    },
  ],
  [
    'extra canonical',
    (f) => {
      f.groups[0].canonicals.push(row('sermons/extra', { resources: [] }));
    },
  ],
  [
    'duplicate canonical',
    (f) => {
      f.groups[0].canonicals.push(f.groups[0].canonicals[0]);
    },
  ],
  [
    'target already present',
    (f) => {
      const g = f.groups[0],
        path = ownedMirrorPaths()[0];
      g.edges.rows.push(
        row(`${g.aggregate.path}/edges/${key(path)}`, { canonicalPath: path, projectId: incident.projectId })
      );
      g.aggregate.data.referenceCount++;
      repin(g.aggregate);
    },
  ],
];
for (const [label, change] of badIndex)
  test(`rejects ${label}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => planOwnedMirrorEdges(f), /OWNED_SMOKE_/);
  });
function emailFixture() {
  return {
    job: {
      projectId: incident.projectId,
      jobId: incident.emailJobId,
      kind: 'email.deliver',
      state: 'running',
      revision: 3,
      generation: incident.emailGeneration,
      workflowId: incident.emailWorkflowId,
      entity: { type: 'mail', id: `mail/${incident.mailId}` },
    },
    native: {
      workflowId: incident.emailWorkflowId,
      runId: incident.emailRunId,
      latestRunId: incident.emailRunId,
      status: 'FAILED',
      failureType: 'EMAIL_STALE_JOB',
      pendingActivities: 0,
      terminalEventType: 'WORKFLOW_EXECUTION_FAILED',
      historyDigest: 'a'.repeat(64),
    },
    acceptedCapture: {
      projectId: incident.projectId,
      mailId: incident.mailId,
      mailState: 'SUCCESS',
      receiptAccepted: true,
      captureId: incident.captureId,
      payloadSha256: incident.payloadSha256,
      payloadHashMatches: true,
      externalDelivery: false,
      profileId: 'urm-app-staging-mail-capture-v1',
      profileVersion: 1,
    },
  };
}
test('plans only real-store projection fields while preserving explicit native failure', () => {
  const f = emailFixture(),
    before = proofDigest(f),
    patch = capturedEmailProjection(f);
  assert.equal(patch.expectedRevision, 3);
  assert.equal(patch.state, 'succeeded');
  assert.deepEqual(patch.actions, []);
  assert.deepEqual(patch.destinations, [{ destination: 'email', state: 'confirmed' }]);
  assert.equal(patch.result.externalDelivery, false);
  assert.equal(patch.result.deliveryTransport.captureId, incident.captureId);
  assert.equal(proofDigest(f), before);
  assert.equal(f.native.status, 'FAILED');
});
test('uses the actual email admission producer full mail-path entity identity', () => {
  const require = createRequire(new URL('../functions/package.json', import.meta.url));
  const ts = require('typescript');
  const source = readFileSync(
    new URL('../function-kits/firestore-send-email/src/temporal/ingress.ts', import.meta.url),
    'utf8'
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (name) => {
      if (name === 'node:crypto' || name === 'crypto') return require(name);
      if (name === 'firebase-admin/firestore') return Object.freeze({});
      // Only the pure real admission producer is exercised. Any release/cloud path must stop.
      if (name === './release')
        return {
          assertTemporalEmailRelease: () => {
            throw Error('NO_CLOUD_TEST');
          },
        };
      throw Error('UNEXPECTED_PRODUCER_IMPORT');
    },
  });
  const input = emailFixture();
  const produced = module.exports.buildEmailAdmission(
    incident.projectId,
    incident.emailJobId,
    `mail/${incident.mailId}`,
    incident.emailGeneration,
    {},
    100
  );
  input.job = JSON.parse(JSON.stringify({ ...produced.job, state: 'running', revision: 3 }));
  const patch = capturedEmailProjection(input);
  assert.equal(patch.expectedRevision, 3);
  assert.equal(patch.state, 'succeeded');
  assert.equal(input.job.entity.id, `mail/${incident.mailId}`);
});
const badEmail = [
  [
    'wrong job',
    (f) => {
      f.job.jobId = 'foreign';
    },
  ],
  [
    'already terminal job',
    (f) => {
      f.job.state = 'succeeded';
    },
  ],
  [
    'wrong kind',
    (f) => {
      f.job.kind = 'sermon.publish';
    },
  ],
  [
    'production job',
    (f) => {
      f.job.projectId = 'urm-app';
    },
  ],
  [
    'wrong mail',
    (f) => {
      f.job.entity.id = 'foreign';
    },
  ],
  [
    'replacement generation',
    (f) => {
      f.job.generation++;
    },
  ],
  [
    'missing workflows',
    (f) => {
      delete f.job.workflowId;
      delete f.native.workflowId;
    },
  ],
  [
    'empty workflows',
    (f) => {
      f.job.workflowId = '';
      f.native.workflowId = '';
    },
  ],
  [
    'jointly changed workflows',
    (f) => {
      f.job.workflowId = 'other';
      f.native.workflowId = 'other';
    },
  ],
  [
    'replacement failed run',
    (f) => {
      f.native.runId = f.native.latestRunId = 'aaaaaaaa-2222-4333-8444-555555555555';
    },
  ],
  [
    'missing run ID',
    (f) => {
      delete f.native.runId;
    },
  ],
  [
    'new current run',
    (f) => {
      f.native.latestRunId = 'aaaaaaaa-2222-4333-8444-555555555555';
    },
  ],
  [
    'running native',
    (f) => {
      f.native.status = 'RUNNING';
    },
  ],
  [
    'pending activity',
    (f) => {
      f.native.pendingActivities = 1;
    },
  ],
  [
    'unrelated native error',
    (f) => {
      f.native.failureType = 'OTHER';
    },
  ],
  [
    'unproven history',
    (f) => {
      delete f.native.historyDigest;
    },
  ],
  [
    'mail not accepted',
    (f) => {
      f.acceptedCapture.receiptAccepted = false;
    },
  ],
  [
    'external delivery',
    (f) => {
      f.acceptedCapture.externalDelivery = true;
    },
  ],
  [
    'wrong capture',
    (f) => {
      f.acceptedCapture.captureId = 'b'.repeat(64);
    },
  ],
  [
    'wrong hash',
    (f) => {
      f.acceptedCapture.payloadSha256 = 'b'.repeat(64);
    },
  ],
  [
    'hash mismatch',
    (f) => {
      f.acceptedCapture.payloadHashMatches = false;
    },
  ],
  [
    'wrong capture profile',
    (f) => {
      f.acceptedCapture.profileId = 'other';
    },
  ],
];
for (const [label, change] of badEmail)
  test(`email rejects ${label}`, () => {
    const f = emailFixture();
    change(f);
    assert.throws(() => capturedEmailProjection(f), /OWNED_SMOKE_/);
  });
test('incident scope is recursively immutable', () => {
  assert.throws(() => {
    incident.resources[0].remoteId = 'other';
  }, TypeError);
  assert.throws(() => {
    incident.listIds.push('other');
  }, TypeError);
});
test('the index stage rejects a forged aggregate delta or creation path', () => {
  const original = planOwnedMirrorEdges(fixture());
  assert.equal(validateOwnedIndexPlan(original), original);
  for (const alter of [
    (p) => {
      p.aggregates[0].afterCount++;
    },
    (p) => {
      p.aggregates[0].creates[0].path = 'sermons/unrelated';
    },
    (p) => {
      p.aggregates[0].creates[0].data.projectId = 'urm-app';
    },
    (p) => {
      p.aggregates[0].creates.push(p.aggregates[0].creates[0]);
    },
    (p) => {
      p.aggregates[0].aggregatePath = 'temporalProviderUsage/unrelated/epochs/other';
    },
    (p) => {
      p.aggregates[0].aggregateAfterDataDigest = '';
    },
    (p) => {
      p.aggregates[0].existingEdges.push(p.aggregates[0].existingEdges[0]);
    },
    (p) => {
      p.aggregates[1] = p.aggregates[0];
    },
  ]) {
    const p = structuredClone(original);
    alter(p);
    assert.throws(() => validateOwnedIndexPlan(p), /OWNED_SMOKE_/);
  }
});
function authorityFixture() {
  const release = {
    environment: 'staging',
    projectId: incident.projectId,
    mode: 'durable-upgrade',
    compatibilityCommit: incident.runtimeCommit,
    uiCommit: incident.runtimeCommit,
    releaseId: '939dd424-7473-4cae-a7a8-ea8e2dcc9977',
    domains: ['publishing', 'emails', 'search'],
  };
  const control = {
    schemaVersion: 1,
    releaseId: release.releaseId,
    revision: 55,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
        domain,
        { owner: 'temporal', admission: release.domains.includes(domain) ? 'paused' : 'open' },
      ])
    ),
  };
  const state = { ...release, controlRevision: 55, phase: 'ownership-changed' };
  return { release, control, state };
}
test('apply authority requires a new fixed-source normal ownership-changed paused checkpoint', () => {
  const f = authorityFixture();
  assertOwnedSmokeAuthority(f.control, f.state, f.release, 55);
  for (const alter of [
    (f) => {
      f.control.admission = 'open';
    },
    (f) => {
      f.state.phase = 'complete';
    },
    (f) => {
      f.state.phase = 'ui-frozen';
    },
    (f) => {
      f.release.compatibilityCommit = '99c76a6eee820d347c06752573e45224665687ed';
    },
    (f) => {
      f.release.projectId = 'urm-app';
    },
    (f) => {
      f.release.releaseId = '09e0d630-f119-4da4-8f20-3db27ff08d17';
    },
    (f) => {
      f.release.domains = ['publishing', 'search'];
    },
    (f) => {
      f.control.domains.emails.admission = 'open';
    },
    (f) => {
      f.control.domains.media.owner = 'legacy';
    },
    (f) => {
      f.state.controlRevision = 54;
    },
  ]) {
    const changed = structuredClone(f);
    alter(changed);
    assert.throws(() => assertOwnedSmokeAuthority(changed.control, changed.state, changed.release, 55));
  }
});
