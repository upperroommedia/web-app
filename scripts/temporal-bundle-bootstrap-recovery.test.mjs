import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createRecoveryStore,
  makeRecoveryPlan,
  assertRecoveryAuthority,
  assertPlan,
  originalSpecs,
  replacementRequest,
  decideRecovery,
  recoverBundleBootstrap,
  digest,
  RECOVERY_ACTION,
} from './temporal-bundle-bootstrap-recovery.mjs';
import { parseRecoveryArgs, verifiedGoogleOperator, safeRecoveryError } from './temporal-recover-bundle-bootstrap.mjs';
const config = {
  projectId: 'urm-app-staging',
  releaseId: '12345678-1234-4123-8123-123456789abc',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'a'.repeat(40),
  mode: 'initial-cutover',
  controlRevision: 11,
  domains: ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles'],
};
const operator = { email: 'operator@example.test', verified: true, authority: 'google-adc-and-target-firestore-iam' };
const stamp = { seconds: 100, nanoseconds: 123 };
const authority = () => ({
  control: {
    schemaVersion: 1,
    releaseId: config.releaseId,
    revision: 11,
    admission: 'paused',
    domains: Object.fromEntries(
      [...config.domains, 'search'].map((d) => [
        d,
        { owner: d === 'search' ? 'legacy' : 'temporal', admission: 'paused' },
      ])
    ),
    legacyAdmissionCutoff: stamp,
  },
  state: {
    releaseId: config.releaseId,
    controlRevision: 11,
    phase: 'backend-ready',
    mode: config.mode,
    domains: config.domains,
    compatibilityCommit: config.compatibilityCommit,
    uiCommit: config.uiCommit,
    compatibilityVerifiedAt: stamp,
    legacySettlingCutoff: stamp,
  },
  controlCreateTime: stamp,
  stateCreateTime: stamp,
  controlUpdateTime: stamp,
  stateUpdateTime: stamp,
  serverReadTime: stamp,
});
function row(spec) {
  const job = {
    projectId: config.projectId,
    jobId: spec.jobId,
    kind: 'bundle.regenerate',
    entity: { type: 'bundle', id: spec.bundleType },
    generation: 1,
    revision: 20,
    state: 'failed',
    workflowId: `bundle:${config.projectId}:${spec.bundleType}`,
    requestedBy: 'system:firebase-event',
    requestId: spec.requestId,
    createdAt: 1,
    steps: [],
    actions: [],
  };
  const intent = {
    projectId: job.projectId,
    jobId: job.jobId,
    kind: job.kind,
    entity: job.entity,
    actorUid: job.requestedBy,
    payload: { bundleType: spec.bundleType },
    generation: 1,
    createdAt: 1,
  };
  const receipt = {
    projectId: job.projectId,
    actorUid: job.requestedBy,
    inputHash: digest({ kind: job.kind, entity: job.entity, requestId: job.requestId, payload: intent.payload }),
    receipt: { projectId: job.projectId, jobId: job.jobId, requestId: job.requestId, generation: 1 },
    createdAt: 1,
  };
  const outbox = {
    projectId: job.projectId,
    jobId: job.jobId,
    state: 'dispatched',
    attempt: 1,
    dispatch: {
      ref: { jobId: job.jobId, projectId: job.projectId },
      workflowId: job.workflowId,
      workflowType: 'bundlesWorkflow',
      taskQueue: 'urm-orchestration',
      signal: { name: 'requestBundleRegeneration', args: { projectId: job.projectId, jobId: job.jobId } },
    },
  };
  return {
    bundleType: spec.bundleType,
    job,
    intent,
    receipt,
    outbox,
    current: {
      entity: { projectId: job.projectId, entity: job.entity, generation: 1, activeJobId: job.jobId },
      job,
      intent,
      receipt,
    },
  };
}
function fixture() {
  const observation = { authority: authority(), originals: originalSpecs(config).map(row) };
  const plan = makeRecoveryPlan(
    config,
    observation,
    operator,
    'Repair verified worker OAuth configuration',
    'case:test',
    { runtimeCommit: config.compatibilityCommit, operatorCommit: 'b'.repeat(40) }
  );
  return { observation, plan };
}
function admit(row, request) {
  const job = {
    ...structuredClone(row.job),
    jobId: request.jobId,
    requestId: request.requestId,
    generation: 2,
    revision: 1,
    state: 'queued',
    createdAt: 2,
  };
  const intent = { ...structuredClone(row.intent), jobId: job.jobId, generation: 2, createdAt: 2 };
  const receipt = {
    actorUid: 'system:firebase-event',
    projectId: job.projectId,
    inputHash: request.inputHash,
    receipt: { jobId: job.jobId, projectId: job.projectId, requestId: job.requestId, generation: 2 },
  };
  row.replacement = { job, intent, receipt };
  row.current = {
    entity: { projectId: job.projectId, entity: job.entity, generation: 2, activeJobId: job.jobId },
    job,
    intent,
    receipt,
  };
}
test('exact six failed bootstrap plan and replacement IDs are deterministic, separate from originals', () => {
  const { observation, plan } = fixture();
  assertPlan(config, plan);
  const second = makeRecoveryPlan(config, observation, operator, 'Other documented repair reason', 'case:other', {});
  assert.equal(plan.recoveryId, second.recoveryId);
  assert.deepEqual(plan.requests, second.requests);
  assert(
    plan.requests.every(
      (r, i) =>
        r.jobId !== plan.originals[i].jobId &&
        r.args.expectedGeneration === 1 &&
        r.args.continuation &&
        r.args.expectedReleaseControl.revision === 11
    )
  );
});
for (const [name, change] of [
  ['wrong phase', (a) => (a.state.phase = 'bundles-ready')],
  ['open', (a) => (a.control.admission = 'open')],
  ['revision', (a) => a.control.revision++],
  ['source', (a) => (a.state.compatibilityCommit = 'f'.repeat(40))],
  ['cutoff', (a) => (a.state.compatibilityVerifiedAt = { seconds: 101, nanoseconds: 123 })],
  ['foreign release', (a) => (a.control.releaseId = 'other')],
  ['missing domain', (a) => delete a.control.domains.media],
  ['unknown domain', (a) => (a.control.domains.other = { owner: 'temporal', admission: 'paused' })],
])
  test(`authority rejects ${name}`, () => {
    const a = structuredClone(authority());
    change(a);
    assert.throws(() => assertRecoveryAuthority(config, a));
  });
test('native CAS rejects control/state mutation even at same revision', () => {
  const original = authority(),
    changed = structuredClone(original);
  changed.state.changed = true;
  assert.throws(() => assertRecoveryAuthority(config, changed, original));
});
for (const [name, mutate] of [
  ['not failed', (r) => (r.job.state = 'running')],
  ['other actor', (r) => (r.intent.actorUid = 'admin')],
  ['changed payload', (r) => (r.intent.payload.other = 'new')],
  ['receipt hash', (r) => (r.receipt.inputHash = 'bad')],
  ['workflow', (r) => (r.outbox.dispatch.workflowId = 'foreign')],
])
  test(`original proof rejects ${name}`, () => {
    const { observation } = fixture();
    mutate(observation.originals[0]);
    assert.throws(() => makeRecoveryPlan(config, observation, operator, 'Verified repair reason', 'case', {}));
  });
test('receipt first resumes replacement even if mutable revision/attempt/job status advances', () => {
  const { observation, plan } = fixture();
  admit(observation.originals[0], plan.requests[0]);
  const r = observation.originals[0];
  r.replacement.job.state = 'succeeded';
  r.replacement.job.revision = 20;
  assert.equal(decideRecovery(config, plan, 0, r).decision, 'replacement-receipt-verified');
  assert.equal(r.job.state, 'failed');
});
test('newer legitimate generation is respected, not overwritten', () => {
  const { observation, plan } = fixture();
  admit(observation.originals[0], plan.requests[0]);
  const r = observation.originals[0];
  r.current.job = {
    ...r.current.job,
    jobId: 'job-' + 'c'.repeat(48),
    generation: 3,
    requestId: 'legitimate-event',
    state: 'succeeded',
  };
  r.current.entity = { ...r.current.entity, activeJobId: r.current.job.jobId, generation: 3 };
  r.current.intent = { ...r.current.intent, jobId: r.current.job.jobId, generation: 3 };
  r.current.receipt = {
    ...r.current.receipt,
    receipt: { jobId: r.current.job.jobId, projectId: config.projectId, requestId: 'legitimate-event', generation: 3 },
  };
  assert.equal(decideRecovery(config, plan, 0, r).decision, 'newer-legitimate-generation');
});
for (const [name, mutate] of [
  ['failed replacement', (r) => (r.current.job.state = 'failed')],
  ['wrong input', (r) => (r.replacement.receipt.inputHash = 'wrong')],
  ['unbound newer job', (r) => (r.current.intent.jobId = 'other')],
  ['missing receipt', (r) => (r.replacement.receipt = undefined)],
])
  test(`replacement rejects ${name}`, () => {
    const { observation, plan } = fixture();
    admit(observation.originals[0], plan.requests[0]);
    mutate(observation.originals[0]);
    assert.throws(() => decideRecovery(config, plan, 0, observation.originals[0]));
  });
test('one lost acknowledgement retains operation; explicit same-plan resume submits only remaining types', async () => {
  const { observation, plan } = fixture();
  let acquired = false,
    calls = 0,
    finished = false,
    crash = true;
  const deps = {
    acquire: async (_p, id, resume) => {
      if (acquired && !resume) throw Error('held');
      acquired = true;
      return { operationId: id };
    },
    observe: async () => structuredClone(observation),
    submit: async (args) => {
      const index = plan.requests.findIndex((r) => r.requestId === args.requestId);
      calls++;
      admit(observation.originals[index], plan.requests[index]);
      if (crash) {
        crash = false;
        throw Error('lost acknowledgement');
      }
    },
    finish: async () => {
      finished = true;
      acquired = false;
      return { result: 'recovery-admissions-verified' };
    },
  };
  await assert.rejects(
    recoverBundleBootstrap({ config, plan, operationId: 'same', operator }, deps),
    /lost acknowledgement/
  );
  assert.equal(acquired, true);
  assert.equal(finished, false);
  assert.equal(calls, 1);
  await recoverBundleBootstrap({ config, plan, operationId: 'same', resume: true, operator }, deps);
  assert.equal(calls, 6);
  assert.equal(finished, true);
  assert(observation.originals.every((r) => r.job.state === 'failed'));
});
test('phase change before submit aborts without API call', async () => {
  const { observation, plan } = fixture();
  observation.authority.state.phase = 'ui-ready';
  let called = false;
  await assert.rejects(
    recoverBundleBootstrap(
      { config, plan, operator },
      {
        acquire: async () => ({}),
        observe: async () => observation,
        submit: () => {
          called = true;
        },
      }
    )
  );
  assert.equal(called, false);
});
test('Google operator uses official SDK method and does not infer Firebase UID or gcloud equality', async () => {
  let got;
  class OAuth {
    async getTokenInfo(token) {
      got = token;
      return { email: 'adc@example.test', email_verified: 'true', sub: 'google-subject' };
    }
  }
  const result = await verifiedGoogleOperator(
    { getAccessToken: async () => ({ access_token: 'never-log' }) },
    OAuth,
    () => 'different@example.test'
  );
  assert.equal(got, 'never-log');
  assert.equal(result.adcAndGcloudAccountMatch, false);
  assert.equal(result.firebaseAuthUid, null);
  assert(!JSON.stringify(result).includes('never-log'));
});
test('raw credential/HTTP failures are replaced by allowlisted diagnostics without request configs', async () => {
  class OAuth {
    async getTokenInfo() {
      throw { config: { headers: { Authorization: 'Bearer sensitive' } }, message: 'sensitive' };
    }
  }
  await assert.rejects(
    verifiedGoogleOperator({ getAccessToken: async () => ({ access_token: 'sensitive' }) }, OAuth),
    (e) => e.code === 'BUNDLE_RECOVERY_OPERATOR_IDENTITY_UNVERIFIED' && !JSON.stringify(e).includes('sensitive')
  );
  assert.equal(
    safeRecoveryError({ message: 'Bearer sensitive', config: { url: 'private' } }),
    'BUNDLE_RECOVERY_FAILED_INSPECT_ACTUAL_STATE'
  );
});
test('CLI only explicit modes and exact resume IDs; help is offline', () => {
  assert.throws(() => parseRecoveryArgs(['apply', '--release', 'r', '--output', 'o', '--control-revision', '11']));
  assert.throws(() =>
    parseRecoveryArgs([
      'resume',
      '--release',
      'r',
      '--output',
      'o',
      '--control-revision',
      '11',
      '--reason',
      'reviewed',
      '--evidence-reference',
      'case',
    ])
  );
  const child = spawnSync(process.execPath, ['scripts/temporal-recover-bundle-bootstrap.mjs', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: 'forbidden' },
  });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /Operator release recovery/);
});
export { config, operator, authority, fixture, admit };

test('actual installed Google OAuth2Client tokeninfo uses POST/Bearer with no credential URL or raw transport errors', async () => {
  const runtimeRequire = createRequire(new URL('../functions/package.json', import.meta.url));
  const { OAuth2Client } = createRequire(runtimeRequire.resolve('firebase-admin/app'))('google-auth-library');
  let requests = 0;
  class ObservedOfficialClient extends OAuth2Client {
    constructor() {
      super();
      this.transporter.request = async (options) => {
        requests++;
        assert.equal(options.method, 'POST');
        assert.equal(String(options.url), 'https://oauth2.googleapis.com/tokeninfo');
        assert.equal(new URL(options.url).search, '');
        assert.equal(options.headers.authorization, 'Bearer synthetic-offline-test-token');
        assert.equal(options.params, undefined);
        return {
          data: {
            email: 'sdk-operator@example.test',
            email_verified: true,
            sub: 'sdk-subject',
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            expires_in: 3600,
          },
        };
      };
    }
  }
  const actual = await verifiedGoogleOperator(
    { getAccessToken: async () => ({ access_token: 'synthetic-offline-test-token' }) },
    ObservedOfficialClient
  );
  assert.equal(requests, 1);
  assert.equal(actual.email, 'sdk-operator@example.test');
  assert.equal(actual.firebaseAuthUid, null);
  assert(!JSON.stringify(actual).includes('synthetic-offline-test-token'));
});
