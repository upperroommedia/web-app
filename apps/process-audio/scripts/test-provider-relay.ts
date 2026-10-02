import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createProviderRelayRouter } from '../src/providerRelay';

const main = async (): Promise<void> => {
  const forwarded: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = init?.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : '';
    forwarded.push({
      url: String(input),
      method: init?.method || '',
      headers: new Headers(init?.headers),
      body,
    });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = express();
  app.use('/internal/provider-relay', createProviderRelayRouter('shared-test-token', fakeFetch));
  app.use(express.json());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local test port.');
    const base = `http://127.0.0.1:${address.port}/internal/provider-relay`;

    const unauthorized = await fetch(`${base}/soundcloud-token`, {
      method: 'POST',
      body: 'grant_type=refresh_token',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(forwarded.length, 0);

    const forbiddenTarget = await fetch(`${base}/subsplash/other/v1/resource`, {
      method: 'POST',
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(forbiddenTarget.status, 404);
    assert.equal(forwarded.length, 0);

    const forbiddenTokenSubpath = await fetch(`${base}/subsplash/accounts/v1/oauth/token/extra`, {
      method: 'POST',
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(forbiddenTokenSubpath.status, 404);
    assert.equal(forwarded.length, 0);

    const soundcloud = await fetch(`${base}/soundcloud-token`, {
      method: 'POST',
      headers: {
        'x-provider-relay-token': 'shared-test-token',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token',
    });
    assert.equal(soundcloud.status, 200);
    assert.equal(forwarded[0].url, 'https://secure.soundcloud.com/oauth/token');
    assert.equal(forwarded[0].body, 'grant_type=refresh_token');
    assert.equal(forwarded[0].headers.get('x-provider-relay-token'), null);

    const subsplash = await fetch(`${base}/subsplash/media/v1/media-items/item-1?include=images`, {
      method: 'PATCH',
      headers: {
        'x-provider-relay-token': 'shared-test-token',
        authorization: 'Bearer provider-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Updated' }),
    });
    assert.equal(subsplash.status, 200);
    assert.equal(forwarded[1].url, 'https://core.subsplash.com/media/v1/media-items/item-1?include=images');
    assert.equal(forwarded[1].method, 'PATCH');
    assert.equal(forwarded[1].headers.get('authorization'), 'Bearer provider-token');
    assert.equal(forwarded[1].headers.get('x-provider-relay-token'), null);
    assert.deepEqual(JSON.parse(forwarded[1].body), { title: 'Updated' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
