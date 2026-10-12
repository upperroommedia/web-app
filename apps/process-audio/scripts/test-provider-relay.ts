import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createProviderRelayRouter } from '../src/providerRelay';

const main = async (): Promise<void> => {
  const forwarded: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const chunks: Buffer[] = [];
    if (init?.body && Symbol.asyncIterator in Object(init.body)) {
      for await (const chunk of init.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    } else if (init?.body) {
      chunks.push(Buffer.from(init.body as Uint8Array));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    forwarded.push({
      url: String(input),
      method: init?.method || '',
      headers: new Headers(init?.headers),
      body,
    });
    const url = String(input);
    if (url === 'https://secure.soundcloud.com/oauth/token' && body.includes('large_response')) {
      return new Response(Buffer.alloc(3 * 1024 * 1024, 0x61), { status: 200 });
    }
    if (url.includes('/builder/v1/list-rows')) {
      const responseBytes = url.includes('oversized') ? 17 * 1024 * 1024 : 3 * 1024 * 1024;
      return new Response(Buffer.alloc(responseBytes, 0x61), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
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

    const audioBody = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const upload = await fetch(`${base}/soundcloud/tracks`, {
      method: 'POST',
      headers: {
        'x-provider-relay-token': 'shared-test-token',
        authorization: 'OAuth access-token',
        'content-type': 'multipart/form-data; boundary=test',
      },
      body: audioBody,
    });
    assert.equal(upload.status, 200);
    assert.equal(forwarded[2].url, 'https://api.soundcloud.com/tracks');
    assert.equal(forwarded[2].body.length, audioBody.length);
    assert.equal(forwarded[2].headers.get('content-length'), String(audioBody.length));
    assert.equal(forwarded[2].headers.get('authorization'), 'OAuth access-token');
    assert.equal(forwarded[2].headers.get('x-provider-relay-token'), null);

    const trackUpdate = await fetch(`${base}/soundcloud/tracks/soundcloud%3Atracks%3A42`, {
      method: 'PUT',
      headers: { 'x-provider-relay-token': 'shared-test-token', 'content-type': 'application/json' },
      body: '{"track":{"title":"Updated"}}',
    });
    assert.equal(trackUpdate.status, 200);
    assert.equal(forwarded[3].url, 'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A42');

    const trackDelete = await fetch(`${base}/soundcloud/tracks/soundcloud%3Atracks%3A42`, {
      method: 'DELETE',
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(trackDelete.status, 200);
    assert.equal(forwarded[4].url, 'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A42');
    assert.equal(forwarded[4].method, 'DELETE');

    const forbiddenTrackSubpath = await fetch(`${base}/soundcloud/tracks/42/comments`, {
      method: 'POST',
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(forbiddenTrackSubpath.status, 404);
    assert.equal(forwarded.length, 5);

    const oversizedDefaultResponse = await fetch(`${base}/soundcloud-token`, {
      method: 'POST',
      headers: { 'x-provider-relay-token': 'shared-test-token' },
      body: 'large_response=true',
    });
    assert.equal(oversizedDefaultResponse.status, 502);

    const fullSubsplashList = await fetch(`${base}/subsplash/builder/v1/list-rows?filter[source_list]=full`, {
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(fullSubsplashList.status, 200);
    assert.equal((await fullSubsplashList.arrayBuffer()).byteLength, 3 * 1024 * 1024);

    const oversizedSubsplashList = await fetch(`${base}/subsplash/builder/v1/list-rows?filter[source_list]=oversized`, {
      headers: { 'x-provider-relay-token': 'shared-test-token' },
    });
    assert.equal(oversizedSubsplashList.status, 502);
    assert.deepEqual(await oversizedSubsplashList.json(), { error: 'Provider response exceeded the relay limit.' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
