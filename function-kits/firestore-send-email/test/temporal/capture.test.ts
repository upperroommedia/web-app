import {
  createMailCapture,
  emailCaptureProfile,
  assertLegacyEmailTransportAllowed,
  EMAIL_CAPTURE_PROFILE,
  assertEmailCaptureReceiptProfile,
} from '../../src/temporal/capture';
import { createEmailRuntime } from '../../src/temporal/runtime';
import { createEmailProviderRuntime } from '../../src/temporal/provider';

jest.mock('../../src/temporal/provider', () => ({
  createEmailProviderRuntime: jest.fn(() => {
    throw new Error('LIVE_TRANSPORT_MUST_NOT_INITIALIZE');
  }),
}));
let mockDatabase: any;
const mockApp = { options: { projectId: 'urm-app-staging' } };
jest.mock('firebase-admin/app', () => ({ getApp: () => mockApp }));
jest.mock('firebase-admin/firestore', () => ({
  ...jest.requireActual('firebase-admin/firestore'),
  getFirestore: () => mockDatabase,
}));
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  mockApp.options.projectId = 'urm-app-staging';
  jest.clearAllMocks();
});
function harness() {
  const records = new Map<string, any>();
  let creates = 0;
  let chain = Promise.resolve();
  const db: any = {
    projectId: 'urm-app-staging',
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
    runTransaction: (fn: any) => {
      const result = chain.then(() =>
        fn({
          get: async (r: any) => ({ exists: records.has(r.path), get: (k: string) => records.get(r.path)?.[k] }),
          create: (r: any, data: any) => {
            if (records.has(r.path)) throw new Error('Already exists');
            records.set(r.path, data);
            creates++;
          },
        })
      );
      chain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
  mockDatabase = db;
  return { db, records, creates: () => creates };
}
const messageId = '<' + 'a'.repeat(64) + '@durable.upperroommedia.org>';
const options = {
  messageId,
  to: ['real@example.org'],
  cc: ['other@example.org'],
  bcc: ['hidden@example.org'],
  text: 'Private body',
  subject: 'Fixture',
};
test('actual authoritative project plus sandbox is required; flags never enable production capture or staging live delivery', () => {
  expect(emailCaptureProfile('urm-app-staging', { STAGING_PROVIDER_MODE: 'sandbox' })).toEqual(EMAIL_CAPTURE_PROFILE);
  expect(emailCaptureProfile('urm-app', {})).toBeUndefined();
  expect(() => emailCaptureProfile('urm-app', { STAGING_PROVIDER_MODE: '' })).toThrow('PROJECT_MISMATCH');
  for (const project of ['other', '', undefined])
    expect(() => emailCaptureProfile(project as string, {})).toThrow('PROJECT_MISMATCH');
  for (const project of ['urm-app', 'other'])
    expect(() => emailCaptureProfile(project, { STAGING_PROVIDER_MODE: 'sandbox' })).toThrow('PROJECT_MISMATCH');
  for (const mode of [undefined, 'live', 'capture'])
    expect(() => emailCaptureProfile('urm-app-staging', { STAGING_PROVIDER_MODE: mode })).toThrow(
      'STAGING_CAPTURE_REQUIRED'
    );
  expect(() => assertLegacyEmailTransportAllowed('urm-app-staging', { STAGING_PROVIDER_MODE: 'sandbox' })).toThrow(
    'REQUIRES_TEMPORAL_CAPTURE'
  );
  expect(() => assertLegacyEmailTransportAllowed('urm-app', {})).not.toThrow();
});
test('actual runtime retains preparation and security while never constructing live provider or reading SMTP credentials', async () => {
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  const h = harness(),
    runtime = createEmailRuntime(h.db);
  const prepared = await runtime.prepare(
    { to: options.to, cc: options.cc, bcc: options.bcc, message: { subject: options.subject, text: options.text } },
    messageId
  );
  expect(prepared).toMatchObject({
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    disableUrlAccess: true,
    disableFileAccess: true,
    messageId,
  });
  await runtime.verify();
  const result = await runtime.send(prepared);
  runtime.close();
  expect(createEmailProviderRuntime).not.toHaveBeenCalled();
  expect(result.accepted).toEqual(['real@example.org', 'other@example.org', 'hidden@example.org']);
  expect(result.deliveryTransport).toMatchObject({
    mode: 'capture',
    profileId: EMAIL_CAPTURE_PROFILE.profileId,
    version: 1,
  });
  expect(result.response).toContain('no external email was sent');
  expect([...h.records.values()][0]).toMatchObject({ externalDelivery: false, options: prepared });
});
test('concurrent retries create one immutable capture; changed content cannot reuse the message id', async () => {
  const h = harness(),
    capture = createMailCapture(h.db, { ...EMAIL_CAPTURE_PROFILE });
  const fence = jest.fn(async () => undefined);
  const [a, b] = await Promise.all([capture.send(options, fence), capture.send({ ...options }, fence)]);
  expect(a).toEqual(b);
  expect(fence).toHaveBeenCalledTimes(2);
  expect(h.creates()).toBe(1);
  await expect(capture.send({ ...options, text: 'changed' }, fence)).rejects.toThrow('CONTENT_CONFLICT');
  expect(h.creates()).toBe(1);
});
test('a stale beforeSend fence prevents capture and capture rejects unsafe envelopes', async () => {
  const h = harness(),
    capture = createMailCapture(h.db, { ...EMAIL_CAPTURE_PROFILE });
  await expect(
    capture.send(options, async () => {
      throw new Error('STALE_JOB');
    })
  ).rejects.toThrow('STALE_JOB');
  expect(h.creates()).toBe(0);
  await expect(capture.send({ ...options, attachments: [{ path: 'https://outside.invalid/file' }] })).rejects.toThrow(
    'EXTERNAL_ATTACHMENT'
  );
  await expect(capture.send({ ...options, messageId: 'caller-controlled' })).rejects.toThrow('MESSAGE_ID_REQUIRED');
  expect(() => createMailCapture({ ...h.db, projectId: 'urm-app' }, { ...EMAIL_CAPTURE_PROFILE })).toThrow(
    'PROJECT_UNVERIFIED'
  );
});
test.each(['prepared', 'sending', 'unknown', 'partial', 'accepted'])(
  'historical unprofiled %s and profile mismatches never become simulated acceptance',
  (state) => {
    const existing = (profile?: unknown) => ({
      exists: true,
      get: (k: string) => (k === 'deliveryProfile' ? profile : state),
    });
    expect(() => assertEmailCaptureReceiptProfile(existing(), { ...EMAIL_CAPTURE_PROFILE })).toThrow(
      'PROFILE_MISMATCH'
    );
    expect(() =>
      assertEmailCaptureReceiptProfile(existing({ ...EMAIL_CAPTURE_PROFILE, version: 2 }), { ...EMAIL_CAPTURE_PROFILE })
    ).toThrow('PROFILE_MISMATCH');
    expect(() => assertEmailCaptureReceiptProfile(existing({ ...EMAIL_CAPTURE_PROFILE }), undefined)).toThrow(
      'PROFILE_MISMATCH'
    );
    expect(() =>
      assertEmailCaptureReceiptProfile(existing({ ...EMAIL_CAPTURE_PROFILE }), { ...EMAIL_CAPTURE_PROFILE })
    ).not.toThrow();
  }
);

test.each([
  ['urm-app-staging', undefined, 'EMAIL_STAGING_CAPTURE_REQUIRED'],
  ['urm-app', 'sandbox', 'EMAIL_CAPTURE_PROJECT_MISMATCH'],
  ['urm-app', '', 'EMAIL_CAPTURE_PROJECT_MISMATCH'],
  ['unknown', undefined, 'EMAIL_CAPTURE_PROJECT_MISMATCH'],
  ['', 'sandbox', 'EMAIL_PROJECT_UNVERIFIED'],
])('actual runtime %s/%s refuses the live factory on invalid authority', (projectId, mode, error) => {
  mockApp.options.projectId = projectId;
  if (mode === undefined) delete process.env.STAGING_PROVIDER_MODE;
  else process.env.STAGING_PROVIDER_MODE = mode;
  const h = harness();
  expect(() => createEmailRuntime(h.db)).toThrow(error);
  expect(createEmailProviderRuntime).not.toHaveBeenCalled();
});
