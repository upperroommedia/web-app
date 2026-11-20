import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseApi } from './temporal-release-api.mjs';
test('source authorization executes after delayed credential acquisition and before the sole HTTP request', async () => {
  const order = [];
  const api = createReleaseApi({
    getAccessToken: async () => {
      order.push('credential-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('credential-settled');
      return 'controlled-fixture';
    },
    request: async (_url, options) => {
      order.push('HTTP');
      assert.equal(options.method, 'PATCH');
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  });
  await api('https://controlled.invalid', 'PATCH', { name: 'owned' }, async () => {
    order.push('authority');
  });
  assert.deepEqual(order, ['credential-start', 'credential-settled', 'authority', 'HTTP']);
});
test('authority changed during credential acquisition denies before HTTP, with no automatic retry', async () => {
  let authority = true,
    calls = 0;
  const api = createReleaseApi({
    getAccessToken: async () => {
      authority = false;
      return 'controlled-fixture';
    },
    request: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  await assert.rejects(
    api('https://controlled.invalid', 'PATCH', { name: 'owned' }, async () => {
      if (!authority) throw new Error('AUTHORITY_CHANGED');
    }),
    /AUTHORITY_CHANGED/
  );
  assert.equal(calls, 0);
});
test('existing read-only callers retain response and fixed HTTP error semantics', async () => {
  const api = createReleaseApi({
    getAccessToken: () => 'controlled-fixture',
    request: async (_url, o) => ({ ok: o.method === 'GET', status: 409, json: async () => ({ native: 'metadata' }) }),
  });
  assert.deepEqual(await api('https://controlled.invalid'), { native: 'metadata' });
  await assert.rejects(api('https://controlled.invalid', 'PATCH', {}), (e) => e.status === 409);
});
