import { createEmailActivities } from './index';
import { createEmailControlActivities } from './controls';
import { createEmailRuntime } from '@upperroom/function-kit-firestore-send-email/lib/temporal/runtime';
import { deliverDurableEmail } from '@upperroom/function-kit-firestore-send-email/lib/temporal/delivery';
import {
  emailCaptureProfile,
  authoritativeEmailProject,
  assertEmailCaptureReceiptProfile,
} from '@upperroom/function-kit-firestore-send-email/lib/temporal/capture';

jest.mock(
  '@upperroom/contracts/temporal',
  () => ({
    isDurableJobTerminal: (state: string) => ['succeeded', 'cancelled', 'failed', 'superseded'].includes(state),
  }),
  { virtual: true }
);
jest.mock(
  '@upperroom/function-kit-firestore-send-email/lib/temporal/runtime',
  () => ({ createEmailRuntime: jest.fn() }),
  { virtual: true }
);
jest.mock(
  '@upperroom/function-kit-firestore-send-email/lib/temporal/delivery',
  () => ({ deliverDurableEmail: jest.fn() }),
  { virtual: true }
);
jest.mock(
  '@upperroom/function-kit-firestore-send-email/lib/temporal/capture',
  () => ({
    emailCaptureProfile: jest.fn(),
    authoritativeEmailProject: jest.fn(),
    assertEmailCaptureReceiptProfile: jest.fn(),
  }),
  { virtual: true }
);
const profile = {
  schemaVersion: 1 as const,
  mode: 'capture' as const,
  projectId: 'urm-app-staging' as const,
  profileId: 'urm-app-staging-mail-capture-v1' as const,
  version: 1 as const,
};
const provenance = { ...profile, captureId: 'a'.repeat(64), payloadSha256: 'b'.repeat(64) };
const ref = { projectId: 'urm-app-staging', jobId: 'email-fixture' };
function harness(state = 'accepted') {
  const receipt = {
    exists: true,
    get: (key: string): any => ({ state, attempts: 1, 'info.deliveryTransport': provenance })[key],
  };
  const db: any = { collection: () => ({ doc: () => ({ get: async () => receipt }) }) };
  const store: any = {
    loadJob: jest.fn(async () => ({ state: 'running' })),
    assertCurrent: jest.fn(),
    loadIntent: jest.fn(async () => ({ kind: 'email.deliver', payload: { mailPath: 'mail/fixture' } })),
    project: jest.fn(),
    recordStep: jest.fn(),
  };
  return { db, store, projectId: ref.projectId };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(createEmailRuntime)
    .mockReturnValue({ deliveryProfile: profile } as ReturnType<typeof createEmailRuntime>);
  jest.mocked(emailCaptureProfile).mockReturnValue(profile);
  jest.mocked(authoritativeEmailProject).mockReturnValue(ref.projectId);
  jest.mocked(deliverDurableEmail).mockResolvedValue('confirmed');
  jest.mocked(assertEmailCaptureReceiptProfile).mockImplementation(() => undefined);
});
test('completed capture projects safe simulation provenance and truthful label without recipients or body', async () => {
  const h = harness();
  await expect(createEmailActivities(h).deliverEmail(ref)).resolves.toBe('confirmed');
  expect(h.store.recordStep).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({ label: 'Capture staging email', state: 'succeeded' })
  );
  expect(h.store.project).toHaveBeenLastCalledWith(
    ref,
    expect.objectContaining({
      state: 'succeeded',
      result: { deliveryTransport: provenance, externalDelivery: false },
      destinations: [expect.objectContaining({ message: expect.stringContaining('no external email sent') })],
    })
  );
});
test('historical profile mismatch needs review, cannot automatically retry, and never clears receipts', async () => {
  const h = harness('unknown');
  jest.mocked(deliverDurableEmail).mockRejectedValue(new Error('EMAIL_DELIVERY_PROFILE_MISMATCH'));
  await expect(createEmailActivities(h).deliverEmail(ref)).rejects.toMatchObject({
    type: 'EMAIL_DELIVERY_PROFILE_MISMATCH',
    nonRetryable: true,
  });
  expect(h.store.project).toHaveBeenLastCalledWith(
    ref,
    expect.objectContaining({
      state: 'needs_attention',
      actions: [],
      error: expect.objectContaining({ retryable: false }),
    })
  );
  expect(h.store.recordStep).not.toHaveBeenCalled();
});
test('datastore review controls refuse mismatched historical receipts instead of declaring confirmed or prepared', async () => {
  const h = harness('unknown');
  jest.mocked(assertEmailCaptureReceiptProfile).mockImplementation(() => {
    throw new Error('EMAIL_DELIVERY_PROFILE_MISMATCH');
  });
  await expect(createEmailControlActivities(h).getEmailReceiptState(ref)).rejects.toMatchObject({
    type: 'EMAIL_DELIVERY_PROFILE_MISMATCH',
    nonRetryable: true,
  });
  expect(h.store.project).not.toHaveBeenCalled();
});
test('reviewed capture result retains simulation label/provenance', async () => {
  const h = harness();
  await expect(createEmailControlActivities(h).getEmailReceiptState(ref)).resolves.toBe('confirmed');
  expect(h.store.recordStep).toHaveBeenCalledWith(ref, expect.objectContaining({ label: 'Capture staging email' }));
  expect(h.store.project).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({
      result: expect.objectContaining({ deliveryTransport: provenance, externalDelivery: false }),
    })
  );
});

test.each(['safe_retry', 'unknown', 'invalid', 'cancelled'] as const)(
  'non-success capture outcome %s never claims that a message was captured',
  async (outcome) => {
    const h = harness('prepared');
    jest.mocked(deliverDurableEmail).mockResolvedValue(outcome);
    await createEmailActivities(h).deliverEmail(ref);
    expect(h.store.project).toHaveBeenLastCalledWith(
      ref,
      expect.objectContaining({
        destinations: [
          expect.objectContaining({ message: 'Staging simulation: external email delivery is disabled.' }),
        ],
      })
    );
  }
);

test('uncertain capture references private capture evidence, never an SMTP provider', async () => {
  const h = harness('unknown');
  jest.mocked(deliverDurableEmail).mockResolvedValue('unknown');
  await createEmailActivities(h).deliverEmail(ref);
  const projection = h.store.project.mock.calls.at(-1)[1];
  expect(projection.attention.provider).toBeUndefined();
  expect(projection.error.provider).toBeUndefined();
  expect(projection.attention.message).toContain('no external email was sent');
  expect(projection.error.message).toContain('capture');
});
