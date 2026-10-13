import { webcrypto } from 'node:crypto';
import { getInviteClaimRequestId } from './inviteClaimIntent';

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

test('reopening a claim reuses one admission identity without storing its secret token', async () => {
  const token = 'private-invitation-bearer-secret';
  const first = await getInviteClaimRequestId('claimant-a', token);
  expect(await getInviteClaimRequestId('claimant-a', token)).toBe(first);
  expect(storage.size).toBe(1);
  expect(JSON.stringify([...storage.entries()])).not.toContain(token);
  expect(await getInviteClaimRequestId('claimant-a', 'replacement-token')).not.toBe(first);
});

test('disabled browser storage does not create a new claim intent on retry', async () => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw new Error('storage blocked');
    },
  });
  expect(await getInviteClaimRequestId('claimant', 'same-token')).toBe(
    await getInviteClaimRequestId('claimant', 'same-token')
  );
});

test('storage references are scoped to each signed-in account', async () => {
  await getInviteClaimRequestId('account-a', 'token');
  await getInviteClaimRequestId('account-b', 'token');
  expect([...storage.keys()].some((key) => key.includes(':account-a:'))).toBe(true);
  expect([...storage.keys()].some((key) => key.includes(':account-b:'))).toBe(true);
});
