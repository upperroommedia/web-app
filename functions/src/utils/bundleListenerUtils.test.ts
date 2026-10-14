jest.mock('firebase-functions/v2', () => ({
  firestore: { onDocumentWritten: jest.fn((_options, handler) => handler) },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: jest.fn(), database: jest.fn() },
}));
jest.mock('./bundleCreationUtils', () => ({ generateAndStoreBundle: jest.fn() }));
jest.mock('../temporal/legacyAdmissionLease', () => ({ withLegacyAdmissionLease: jest.fn() }));
jest.mock('../temporal/bundles/admission', () => ({ admitBundleRegeneration: jest.fn() }));
jest.mock('../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { TOPIC_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';
import { withLegacyAdmissionLease } from '../temporal/legacyAdmissionLease';
import { admitBundleRegeneration } from '../temporal/bundles/admission';
import { generateAndStoreBundle } from './bundleCreationUtils';

const transaction = jest.fn();
const update = jest.fn().mockResolvedValue(undefined);
const once = jest.fn();
(firebaseAdmin.database as unknown as jest.Mock).mockReturnValue({ ref: () => ({ transaction, update, once }) });
const { createBundleDocumentListener } = require('./bundleListenerUtils') as typeof import('./bundleListenerUtils');
const event = { id: 'bundle-event', data: { before: { data: () => undefined }, after: { data: () => ({}) } } };
const invoke = () => {
  const handler = createBundleDocumentListener({ ...TOPIC_BUNDLE_CONFIG, shouldTrigger: () => true });
  return (handler as unknown as (event: unknown) => Promise<void>)(event);
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TASK_ORCHESTRATOR_BUNDLES;
});
afterEach(() => jest.useRealTimers());

describe('bundle listener admission lifetime', () => {
  it('does not mutate RTDB or generate when lease admission rejects a fresh event', async () => {
    (withLegacyAdmissionLease as jest.Mock).mockRejectedValueOnce(new Error('paused'));
    await expect(invoke()).rejects.toThrow('paused');
    expect(withLegacyAdmissionLease).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ domain: 'bundles', operation: 'bundle.listener:topics' }),
      expect.any(Function)
    );
    expect((withLegacyAdmissionLease as jest.Mock).mock.calls[0][1].continuation).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    expect(generateAndStoreBundle).not.toHaveBeenCalled();
  });

  it('keeps claim, generation, metadata and release inside the admitted lease', async () => {
    jest.useFakeTimers();
    let insideLease = false;
    let state: Record<string, unknown> | null = null;
    const mark = jest.fn(async () => undefined);
    (withLegacyAdmissionLease as jest.Mock).mockImplementationOnce(async (_db, _options, run) => {
      insideLease = true;
      try {
        return await run({ markEffectsStarted: mark });
      } finally {
        insideLease = false;
      }
    });
    transaction.mockImplementation(async (apply) => {
      expect(insideLease).toBe(true);
      expect(mark).toHaveBeenCalledTimes(1);
      state = apply(state);
      return { snapshot: { val: () => state, exists: () => state !== null } };
    });
    once.mockImplementation(async () => ({ val: () => state }));
    (generateAndStoreBundle as jest.Mock).mockImplementation(async () => {
      expect(insideLease).toBe(true);
      return 2;
    });
    update.mockImplementation(async () => {
      expect(insideLease).toBe(true);
    });
    const invocation = invoke();
    await jest.advanceTimersByTimeAsync(2500);
    await invocation;
    expect(generateAndStoreBundle).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(3); // claim, settle cycle, final owner release
    expect(state).toBeNull();
    expect(insideLease).toBe(false);
  });

  it('retains the durable event bridge when Temporal is configured', async () => {
    process.env.TASK_ORCHESTRATOR_BUNDLES = 'temporal';
    await invoke();
    expect(admitBundleRegeneration).toHaveBeenCalledWith('topics', 'bundle-event', { continuation: true });
    expect(withLegacyAdmissionLease).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
