/* Regression tests for the migrated sender. All network and SMTP calls are mocked. */
const mockSend = jest.fn();
const mockInitialize = jest.fn();
let mockProjectId = 'urm-app';
const originalSandboxMode = process.env.STAGING_PROVIDER_MODE;
const originalEmailOrchestrator = process.env.TASK_ORCHESTRATOR_EMAILS;
let mockPayload: any;
let mockExists = true;
let mockControl: any;
let mockRelease: any;
let mockReadTime: any;
let mockCreatedTime: any;
let mockDuringPrepare: (() => void) | undefined;
let mockSerial = Promise.resolve();
const mockRef: any = {
  path: 'mail/test', id: 'test',
  get: jest.fn(async () => {
    const payload = {...mockPayload, delivery: mockPayload.delivery && {...mockPayload.delivery}};
    return {exists: mockExists, data: () => payload, ref: mockRef, createTime: mockCreatedTime,
      get: (key: string) => key.split('.').reduce((value: any, part: string) => value?.[part], payload)};
  }),
};
function apply(update: any) {
  for (const [key, value] of Object.entries(update)) {
    if (!key.includes('.')) mockPayload[key] = value;
    else {
      const field = key.split('.')[1];
      mockPayload.delivery[field] = (value as any)?.increment ? (mockPayload.delivery[field] ?? 0) + 1 : value;
    }
  }
}
const mockDb = {
  doc: (path: string) => ({path}),
  runTransaction: jest.fn(callback => {
    const work = mockSerial.then(() => callback({get: (ref: any) => ref.path === "_control/temporalRelease" ? {exists: !!mockControl, data: () => mockControl, readTime: mockReadTime} : ref.path === "_control/temporalReleaseState" ? {exists: !!mockRelease, data: () => mockRelease} : mockRef.get(), update: (_ref: any, update: any) => apply(update)}));
    mockSerial = work.catch(() => {});
    return work;
  }),
};
jest.mock('firebase-admin/app', () => ({ getApps: () => [{options: {projectId: mockProjectId}}], initializeApp: () => mockInitialize() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
  FieldValue: {increment: () => ({increment: true}), serverTimestamp: () => ({})},
  Timestamp: {fromDate: (date: Date) => ({toDate: () => date, toMillis: () => date.getTime()}), fromMillis: (time: number) => ({toMillis: () => time})},
}));
jest.mock('firebase-functions', () => ({requiresRole: jest.fn(), requiresAPI: jest.fn()}));
jest.mock('firebase-functions/v2/options', () => ({setGlobalOptions: jest.fn()}));
jest.mock('firebase-functions/v2/firestore', () => ({onDocumentWritten: (_options: any, handler: any) => handler}));
jest.mock('nodemailer', () => ({createTransport: () => ({sendMail: mockSend})}));
jest.mock('../src/config', () => ({
  __esModule: true,
  default: {database: '(default)', mailCollection: 'mail', testing: true, TTLExpireType: 'never', defaultFrom: 'sender@example.com'},
  triggerConfig: {mailCollection: 'mail', database: '(default)', location: 'us-central1'},
  smtpPassword: {}, oauthSecrets: [],
}));
jest.mock('../src/events', () => ({setupEventChannel: jest.fn(), recordStartEvent: jest.fn(), recordCompleteEvent: jest.fn(), recordErrorEvent: jest.fn(), recordSuccessEvent: jest.fn(), recordProcessingEvent: jest.fn(), recordRetryEvent: jest.fn(), recordPendingEvent: jest.fn()}));
jest.mock('../src/prepare-payload', () => ({setDependencies: jest.fn(), preparePayload: async (payload: any) => { mockDuringPrepare?.(); return {...payload, to: ['recipient@example.com'], cc: [], bcc: []}; }}));
jest.mock('../src/logs', () => ({start: jest.fn(), info: jest.fn(), attemptingDelivery: jest.fn(), delivered: jest.fn(), deliveryError: jest.fn(), error: jest.fn(), complete: jest.fn()}));
import {processQueue} from '../src/index';
const execute: any = processQueue;
function event() {const snapshot = {...mockPayload, delivery: mockPayload.delivery && {...mockPayload.delivery}}; return {data: {before: {exists: true}, after: {exists: mockExists, ref: mockRef, data: () => snapshot}}};}
afterEach(() => {
  if (originalSandboxMode === undefined) delete process.env.STAGING_PROVIDER_MODE; else process.env.STAGING_PROVIDER_MODE = originalSandboxMode;
  if (originalEmailOrchestrator === undefined) delete process.env.TASK_ORCHESTRATOR_EMAILS; else process.env.TASK_ORCHESTRATOR_EMAILS = originalEmailOrchestrator;
});
beforeEach(() => {
  mockProjectId = 'urm-app';
  delete process.env.STAGING_PROVIDER_MODE;
  mockPayload = {message: {subject: 'test', text: 'body'}};
  mockExists = true;
  mockControl = undefined; mockRelease = undefined; mockReadTime = undefined; mockCreatedTime = undefined; mockDuringPrepare = undefined;
  mockSerial = Promise.resolve();
  mockSend.mockReset().mockResolvedValue({messageId: 'test', accepted: ['recipient@example.com']});
});
test('initial write initializes PENDING then concurrent events send once and record success', async () => {
  await execute(event());
  expect(mockPayload.delivery.state).toBe('PENDING');
  expect(mockSend).not.toHaveBeenCalled();
  const pendingEvent = event();
  await Promise.all([execute(pendingEvent), execute(pendingEvent)]);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.state).toBe('SUCCESS');
  expect(mockPayload.delivery.attempts).toBe(1);
  await execute(pendingEvent); // replay of an old PENDING event still reads current state
  expect(mockSend).toHaveBeenCalledTimes(1);
});
test('lost SMTP acknowledgement remains unknown and a raw RETRY cannot resend', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockSend.mockRejectedValueOnce(new Error('SMTP unavailable'));
  await execute(event());
  expect(mockPayload.delivery.state).toBe('ERROR');
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(1);
  mockPayload.delivery.state = 'RETRY';
  await expect(execute(event())).rejects.toThrow('EMAIL_SMTP_OUTCOME_REQUIRES_REVIEW');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.smtpSubmissionState).toBe('unknown');
  expect(mockPayload.delivery.attempts).toBe(1);
});
test('expired processing lease becomes ERROR without sending again', async () => {
  mockPayload.delivery = {state: 'PROCESSING', leaseExpireTime: {toMillis: () => 0}};
  // Avoid structuredClone of the timestamp method in this fake event.
  await execute({data: {before: {exists: true}, after: {exists: true, ref: mockRef, data: () => mockPayload}}});
  expect(mockPayload.delivery.state).toBe('ERROR');
  expect(mockSend).not.toHaveBeenCalled();
});
test('deleted documents are ignored', async () => {
  mockExists = false;
  await execute(event());
  expect(mockSend).not.toHaveBeenCalled();
});
test('legacy flag rollback cannot resend a Temporal-owned mail document', async () => {
  mockPayload.delivery = {state: 'RETRY', orchestrator: 'temporal', attempts: 1};
  await execute(event());
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockPayload.delivery.state).toBe('RETRY');
});
test('stale legacy event cannot claim a document admitted to Temporal meanwhile', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  const stale = event();
  mockPayload.delivery.orchestrator = 'temporal';
  await execute(stale);
  expect(mockSend).not.toHaveBeenCalled();
});

function legacyAuthority() {
  const cutoff = {seconds: 1000, nanoseconds: 123456789};
  mockControl = {schemaVersion: 1, revision: 2, releaseId: 'release', updatedAt: 1, admission: 'paused',
    domains: {emails: {owner: 'legacy', admission: 'paused'}}, legacyAdmissionCutoff: cutoff};
  mockRelease = {mode: 'initial-cutover', releaseId: 'release', legacySettlingCutoff: cutoff,
    compatibilityVerifiedAt: cutoff, legacySettlingGraceSeconds: 3600, maximumLegacyExecutionSeconds: 3570};
}
test('post-cutoff legacy retry cannot acquire PROCESSING or submit SMTP after server grace', async () => {
  legacyAuthority();
  mockReadTime = {seconds: 9000, nanoseconds: 0};
  mockCreatedTime = {seconds: 1000, nanoseconds: 123456790};
  mockPayload.delivery = {state: 'RETRY', attempts: 1, smtpSubmissionState: 'not_submitted'};
  await expect(execute(event())).rejects.toThrow('EMAIL_POST_CUTOFF_ADMISSION_REQUIRES_REVIEW');
  expect(mockPayload.delivery.state).toBe('RETRY');
  expect(mockSend).not.toHaveBeenCalled();
});
test('a known mail claim remains visible and may settle SMTP after the grace boundary', async () => {
  legacyAuthority();
  mockReadTime = {seconds: 2000, nanoseconds: 0};
  mockCreatedTime = {seconds: 900, nanoseconds: 0};
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockDuringPrepare = () => {
    expect(mockPayload.delivery.state).toBe('PROCESSING');
    mockReadTime = {seconds: 9000, nanoseconds: 0};
  };
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.state).toBe('SUCCESS');
});

// Synthetic native snapshots make the one-hour boundary explicit; no real
// Firestore creation timestamp is backdated and no real SMTP runs in this suite.
test('original pre-cutoff queued mail first executes after grace and settles once', async () => {
  legacyAuthority();
  mockReadTime = {seconds: 9000, nanoseconds: 0};
  mockCreatedTime = {seconds: 900, nanoseconds: 0};
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.state).toBe('SUCCESS');
});

test('known pre-submit failure stays terminal-safe and explicit retry may submit once', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockDuringPrepare = () => { throw new Error('Template lookup failed before SMTP'); };
  await execute(event());
  expect(mockPayload.delivery.state).toBe('ERROR');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('not_submitted');
  expect(mockSend).not.toHaveBeenCalled();
  mockDuringPrepare = undefined;
  mockPayload.delivery.state = 'RETRY';
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.smtpSubmissionState).toBe('accepted');
});
test('expired PROCESSING with a started submission stays unknown and cannot be resent', async () => {
  mockPayload.delivery = {state: 'PROCESSING', attempts: 0, smtpSubmissionState: 'started', smtpClaimId: 'old', leaseExpireTime: {toMillis: () => 0}};
  await execute(event());
  expect(mockPayload.delivery.state).toBe('ERROR');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('unknown');
  mockPayload.delivery.state = 'RETRY';
  await expect(execute(event())).rejects.toThrow('EMAIL_SMTP_OUTCOME_REQUIRES_REVIEW');
  expect(mockSend).not.toHaveBeenCalled();
});
test('expired PROCESSING proven never submitted remains terminal-safe', async () => {
  mockPayload.delivery = {state: 'PROCESSING', attempts: 0, smtpSubmissionState: 'not_submitted', leaseExpireTime: {toMillis: () => 0}};
  await execute(event());
  expect(mockPayload.delivery.state).toBe('ERROR');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('not_submitted');
  expect(mockSend).not.toHaveBeenCalled();
});
test('a started SMTP claim remains drain-visible while waiting for its acknowledgement', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockSend.mockImplementationOnce(async () => {
    expect(mockPayload.delivery.state).toBe('PROCESSING');
    expect(mockPayload.delivery.smtpSubmissionState).toBe('started');
    expect(mockPayload.delivery.smtpClaimId).toMatch(/^[a-f0-9-]+$/);
    return {messageId: 'acknowledged', accepted: ['recipient@example.com']};
  });
  await execute(event());
  expect(mockPayload.delivery.state).toBe('SUCCESS');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('accepted');
});

test('the same SMTP acknowledgement can settle a claim marked unknown by a concurrent expiry event', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  let entered: () => void = () => undefined, finish: () => void = () => undefined;
  const inFlight = new Promise<void>(resolve => { entered = resolve; });
  const mayFinish = new Promise<void>(resolve => { finish = resolve; });
  mockSend.mockImplementationOnce(async () => {
    entered(); await mayFinish;
    return {messageId: 'same-claim-ack', accepted: ['recipient@example.com']};
  });
  const sending = execute(event());
  await inFlight;
  const now = jest.spyOn(Date, 'now').mockReturnValue(mockPayload.delivery.leaseExpireTime.toMillis() + 1);
  try {
    await execute(event());
    expect(mockPayload.delivery.state).toBe('ERROR');
    expect(mockPayload.delivery.smtpSubmissionState).toBe('unknown');
  } finally { now.mockRestore(); finish(); }
  await sending;
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockPayload.delivery.state).toBe('SUCCESS');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('accepted');
});
test('an old SMTP acknowledgement cannot overwrite a different claim identity', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockSend.mockImplementationOnce(async () => {
    mockPayload.delivery.smtpClaimId = 'different-claim';
    mockPayload.delivery.state = 'ERROR';
    mockPayload.delivery.smtpSubmissionState = 'unknown';
    return {messageId: 'old-claim-ack', accepted: ['recipient@example.com']};
  });
  await execute(event());
  expect(mockPayload.delivery.smtpClaimId).toBe('different-claim');
  expect(mockPayload.delivery.smtpSubmissionState).toBe('unknown');
});

test('staging sandbox legacy flag refuses real delivery before preparation or SMTP submission', async () => {
  mockProjectId = 'urm-app-staging';
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  process.env.TASK_ORCHESTRATOR_EMAILS = 'legacy';
  mockPayload.delivery = { state: 'PENDING', attempts: 0 };
  await expect(execute(event())).rejects.toThrow('EMAIL_SANDBOX_REQUIRES_TEMPORAL_CAPTURE');
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockPayload.delivery).toEqual({ state: 'PENDING', attempts: 0 });
});
test.each(['other', ''])('unknown initialized project %s cannot fall back to SMTP', async (projectId) => {
  mockProjectId = projectId;
  process.env.TASK_ORCHESTRATOR_EMAILS = 'legacy';
  await expect(execute(event())).rejects.toThrow('EMAIL_CAPTURE_PROJECT_MISMATCH');
  expect(mockSend).not.toHaveBeenCalled();
});
