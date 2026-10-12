/* Regression tests for the migrated sender. All network and SMTP calls are mocked. */
const mockSend = jest.fn();
const mockInitialize = jest.fn();
let mockPayload: any;
let mockExists = true;
let mockSerial = Promise.resolve();
const mockRef: any = {
  path: 'mail/test', id: 'test',
  get: jest.fn(async () => ({exists: mockExists, data: () => mockPayload})),
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
  runTransaction: jest.fn(callback => {
    const work = mockSerial.then(() => callback({get: () => mockRef.get(), update: (_ref: any, update: any) => apply(update)}));
    mockSerial = work.catch(() => {});
    return work;
  }),
};
jest.mock('firebase-admin/app', () => ({ getApps: () => [{}], initializeApp: () => mockInitialize() }));
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
  default: {database: '(default)', testing: true, TTLExpireType: 'never', defaultFrom: 'sender@example.com'},
  triggerConfig: {mailCollection: 'mail', database: '(default)', location: 'us-central1'},
  smtpPassword: {}, oauthSecrets: [],
}));
jest.mock('../src/events', () => ({setupEventChannel: jest.fn(), recordStartEvent: jest.fn(), recordCompleteEvent: jest.fn(), recordErrorEvent: jest.fn(), recordSuccessEvent: jest.fn(), recordProcessingEvent: jest.fn(), recordRetryEvent: jest.fn(), recordPendingEvent: jest.fn()}));
jest.mock('../src/prepare-payload', () => ({setDependencies: jest.fn(), preparePayload: async (payload: any) => ({...payload, to: ['recipient@example.com'], cc: [], bcc: []})}));
jest.mock('../src/logs', () => ({start: jest.fn(), info: jest.fn(), attemptingDelivery: jest.fn(), delivered: jest.fn(), deliveryError: jest.fn(), error: jest.fn(), complete: jest.fn()}));
import {processQueue} from '../src/index';
const execute: any = processQueue;
function event() {const snapshot = {...mockPayload, delivery: mockPayload.delivery && {...mockPayload.delivery}}; return {data: {before: {exists: true}, after: {exists: mockExists, ref: mockRef, data: () => snapshot}}};}
beforeEach(() => {
  mockPayload = {message: {subject: 'test', text: 'body'}};
  mockExists = true;
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
test('SMTP failure records ERROR and only explicit RETRY attempts delivery again', async () => {
  mockPayload.delivery = {state: 'PENDING', attempts: 0};
  mockSend.mockRejectedValueOnce(new Error('SMTP unavailable'));
  await execute(event());
  expect(mockPayload.delivery.state).toBe('ERROR');
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(1);
  mockPayload.delivery.state = 'RETRY';
  await execute(event());
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockPayload.delivery.state).toBe('SUCCESS');
  expect(mockPayload.delivery.attempts).toBe(2);
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
