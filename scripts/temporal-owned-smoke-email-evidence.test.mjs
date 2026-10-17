import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { verifyCapturedEmailDocuments, collectOwnedEmailEvidence } from './temporal-owned-smoke-email-evidence.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const require = createRequire(import.meta.url),
  ts = require('typescript');
// Actual leaf source; Firebase imports are inert and no SDK, config or transport is initialized.
function sourceExports(path, inert = [], modules = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    Buffer,
    structuredClone,
    require: (name) => {
      if (name === 'node:crypto') return crypto;
      if (Object.hasOwn(modules, name)) return modules[name];
      if (inert.includes(name)) return {};
      throw Error('UNEXPECTED_TEST_IMPORT:' + name);
    },
  });
  return exports;
}
const delivery = sourceExports('function-kits/firestore-send-email/src/temporal/delivery.ts', [
  'firebase-admin/firestore',
  './runtime',
  './capture',
]);
const secure = sourceExports('function-kits/firestore-send-email/src/temporal/secure-options.ts');
const usage = sourceExports('packages/orchestration/src/provider-usage.ts', ['firebase-admin/firestore']);
const runtime = {
  emailMessageId: delivery.emailMessageId,
  secureMailOptions: secure.secureMailOptions,
  extractProviderResources: usage.extractProviderResources,
  durableEntityKey: () => 'a'.repeat(64),
};
const validation = sourceExports(
  'function-kits/firestore-send-email/src/validation.ts',
  ['firebase-functions/logger'],
  { 'zod/v3': require('zod/v3') }
);
const prepare = sourceExports(
  'function-kits/firestore-send-email/src/prepare-payload.ts',
  ['firebase-admin/firestore', './logs'],
  { './validation': validation, 'zod/v3': require('zod/v3'), './config': { default: {} } }
);
const prohibited = () => {
  throw Error('NO_TEST_EMAIL_TRANSPORT_OR_DATABASE');
};
const frozenDefaults = {
  defaultFrom: 'synthetic-frozen-default@example.test',
  defaultReplyTo: 'synthetic-frozen-reply@example.test',
};
const producerRuntime = sourceExports(
  'function-kits/firestore-send-email/src/temporal/runtime.ts',
  ['firebase-admin/firestore', '../templates'],
  {
    './provider': { createEmailProviderRuntime: prohibited },
    '../config': { default: frozenDefaults },
    '../prepare-payload': prepare,
    './secure-options': secure,
    './capture': {
      authoritativeEmailProject: () => 'urm-app-staging',
      emailCaptureProfile: () => ({
        schemaVersion: 1,
        mode: 'capture',
        projectId: 'urm-app-staging',
        profileId: 'urm-app-staging-mail-capture-v1',
        version: 1,
      }),
      createMailCapture: () => ({ send: prohibited, verify: prohibited, close: prohibited }),
    },
  }
);
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
function jsonCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(jsonCanonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + jsonCanonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function fixture() {
  const binding = {
    projectId: 'urm-app-staging',
    mailId: 'synthetic-private-mail',
    emailJobId: 'email-synthetic-job',
    emailGeneration: 1,
    emailWorkflowId: 'email:synthetic',
    mediaId: 'synthetic-owned-media',
    capturedAtIso: '1970-01-01T00:00:00.100Z',
  };
  const messageId = runtime.emailMessageId(binding.projectId, binding.emailJobId);
  const options = JSON.parse(
    JSON.stringify(
      runtime.secureMailOptions(
        {
          from: frozenDefaults.defaultFrom,
          replyTo: frozenDefaults.defaultReplyTo,
          to: ['private@example.test'],
          cc: [],
          bcc: [],
          subject: 'Synthetic private subject',
          text: 'Synthetic private body',
          html: '<p>Synthetic private body</p>',
        },
        messageId
      )
    )
  );
  binding.captureId = sha(messageId);
  binding.payloadSha256 = sha(jsonCanonical(options));
  const profile = {
    schemaVersion: 1,
    mode: 'capture',
    projectId: binding.projectId,
    profileId: 'urm-app-staging-mail-capture-v1',
    version: 1,
  };
  const transport = { ...profile, captureId: binding.captureId, payloadSha256: binding.payloadSha256 };
  const info = {
    messageId,
    accepted: ['private@example.test'],
    rejected: [],
    pending: [],
    deliveryTransport: transport,
  };
  const payload = {
    meta: { source: 'runtime-alert', metadata: { mediaItemId: binding.mediaId } },
    to: ['private@example.test'],
    message: {
      subject: 'Synthetic private subject',
      text: 'Synthetic private body',
      html: '<p>Synthetic private body</p>',
    },
  };
  const entity = { type: 'mail', id: 'mail/' + binding.mailId };
  const job = {
    projectId: binding.projectId,
    jobId: binding.emailJobId,
    kind: 'email.deliver',
    generation: 1,
    workflowId: binding.emailWorkflowId,
    entity,
    state: 'running',
  };
  const documents = {
    job,
    intent: {
      schemaVersion: 1,
      projectId: binding.projectId,
      jobId: binding.emailJobId,
      kind: job.kind,
      generation: 1,
      entity,
      actorUid: 'system:email',
      payload: { mailPath: entity.id, payload: structuredClone(payload) },
    },
    entity: {
      schemaVersion: 1,
      projectId: binding.projectId,
      scope: 'email',
      generation: 1,
      entity,
      activeJobId: binding.emailJobId,
    },
    critical: undefined,
    mail: {
      ...payload,
      delivery: {
        state: 'SUCCESS',
        jobId: binding.emailJobId,
        orchestrator: 'temporal',
        messageId,
        info: structuredClone(info),
        deliveryTransport: structuredClone(transport),
      },
    },
    receipt: { state: 'accepted', messageId, deliveryProfile: profile, options: structuredClone(options), info },
    capture: {
      schemaVersion: 1,
      messageId,
      externalDelivery: false,
      payloadSha256: binding.payloadSha256,
      deliveryProfile: structuredClone(profile),
      options,
      capturedAt: { toMillis: () => 100 },
    },
  };
  return { binding, documents, runtime };
}
test('actual producer message ID, secure-options and resource extractor join synthetic private RAM documents', () => {
  const f = fixture(),
    result = verifyCapturedEmailDocuments(f);
  assert.equal(result.payloadHashMatches, true);
  assert.equal(result.externalDelivery, false);
  assert.equal(result.captureId, f.binding.captureId);
  const out = JSON.stringify(result);
  for (const secret of [
    'private@example.test',
    'Synthetic private body',
    'Synthetic private subject',
    f.documents.receipt.messageId,
    'options',
    'info',
  ])
    assert(!out.includes(secret));
});
test('restricted direct alert mapping matches actual preparePayload+runtime.prepare with frozen defaults and no SDK/transport', async () => {
  const f = fixture();
  const producer = producerRuntime.createEmailRuntime(Object.freeze({ collection: prohibited }));
  const prepared = await producer.prepare(f.documents.intent.payload.payload, f.documents.receipt.messageId);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), f.documents.capture.options);
  assert.equal(verifyCapturedEmailDocuments(f).payloadHashMatches, true);
});
for (const [label, change] of [
  [
    'joint mail+intent recipient change',
    (f) => {
      f.documents.mail.to = ['other@example.test'];
      f.documents.intent.payload.payload.to = ['other@example.test'];
    },
  ],
  [
    'joint mail+intent body change',
    (f) => {
      f.documents.mail.message.text = 'changed';
      f.documents.intent.payload.payload.message.text = 'changed';
    },
  ],
  [
    'joint template addition',
    (f) => {
      f.documents.mail.template = { name: 'mutable' };
      f.documents.intent.payload.payload.template = { name: 'mutable' };
    },
  ],
  ['mail/intent payload diverged', (f) => (f.documents.intent.payload.payload.message.text = 'changed')],
  ['wrong owned alert', (f) => (f.documents.mail.meta.metadata.mediaItemId = 'other')],
  ['critical marker', (f) => (f.documents.critical = { generation: 1 })],
  ['replaced entity', (f) => (f.documents.entity.generation = 2)],
  ['wrong original intent', (f) => (f.documents.intent.payload.mailPath = 'mail/other')],
  [
    'provider-bearing intent',
    (f) => {
      f.documents.intent.payload.payload.subsplashId = 'resource';
      f.documents.mail.subsplashId = 'resource';
    },
  ],
  ['mail failed', (f) => (f.documents.mail.delivery.state = 'ERROR')],
  ['receipt pending', (f) => (f.documents.receipt.state = 'sending')],
  ['receipt extra capture profile key', (f) => (f.documents.receipt.deliveryProfile.smtp = true)],
  ['receipt options differ', (f) => (f.documents.receipt.options.text = 'changed')],
  [
    'joint options corruption',
    (f) => {
      f.documents.capture.options.text = 'changed';
      f.documents.receipt.options.text = 'changed';
    },
  ],
  [
    'unsafe options',
    (f) => {
      f.documents.capture.options.disableUrlAccess = false;
      f.documents.receipt.options.disableUrlAccess = false;
    },
  ],
  ['capture external', (f) => (f.documents.capture.externalDelivery = true)],
  ['capture hash', (f) => (f.documents.capture.payloadSha256 = 'a'.repeat(64))],
  ['capture identity', (f) => (f.documents.capture.messageId = 'other')],
  ['capture timestamp absent', (f) => delete f.documents.capture.capturedAt],
  ['capture timestamp invalid', (f) => (f.documents.capture.capturedAt = { toMillis: () => NaN })],
  ['capture timestamp replaced', (f) => (f.documents.capture.capturedAt = { toMillis: () => 200 })],
  ['mail/receipt info diverged', (f) => (f.documents.mail.delivery.info.response = 'changed')],
  [
    'accepted wrong recipient',
    (f) => {
      f.documents.receipt.info.accepted = ['other@example.test'];
      f.documents.mail.delivery.info.accepted = ['other@example.test'];
    },
  ],
  [
    'partial delivery',
    (f) => {
      f.documents.receipt.info.pending = ['private@example.test'];
      f.documents.mail.delivery.info.pending = ['private@example.test'];
    },
  ],
  [
    'forged transport',
    (f) => {
      f.documents.receipt.info.deliveryTransport.captureId = 'a'.repeat(64);
      f.documents.mail.delivery.info.deliveryTransport.captureId = 'a'.repeat(64);
    },
  ],
  ['production binding', (f) => (f.binding.projectId = 'urm-app')],
])
  test('rejects ' + label, () => {
    const f = fixture();
    change(f);
    assert.throws(() => verifyCapturedEmailDocuments(f));
  });
test('the exact incident reader cannot substitute synthetic case identities or export raw private documents', async () => {
  const f = fixture(),
    paths = [];
  const db = {
    doc: (path) => {
      paths.push(path);
      return { get: async () => ({ exists: false }) };
    },
  };
  await assert.rejects(collectOwnedEmailEvidence({ db, runtime, native: {} }), /EMAIL_PROVENANCE_DOCUMENT_MISSING/);
  assert.equal(paths[0], 'durableJobs/' + incident.emailJobId);
  assert(!paths.includes('durableJobs/' + f.binding.emailJobId));
});
