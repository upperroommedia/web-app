import assert from 'node:assert/strict';
import express from 'express';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { installYouTubeAdminDesktop } from '../src/youtubeAdminAuth';

async function run() {
  const directory = mkdtempSync('/tmp/urm-vnc-');
  const socketPath = `${directory}/novnc.sock`;
  let role = 'admin';
  let disabled = false;
  let revoked = false;
  let tokensValidAfterTime: string | undefined;
  let requests = 0;
  let recoveries = 0;
  const audit: string[] = [];
  const backend = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader('Content-Type', 'text/html');
    res.end('<html>remote browser</html>');
  });
  backend.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/websockify');
    assert.equal(req.headers.cookie, undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', (data) => socket.write(data));
  });
  await new Promise<void>((resolve) => backend.listen(socketPath, resolve));
  const app = express();
  const attach = installYouTubeAdminDesktop(
    app,
    {
      verifyIdToken: async (token, checkRevoked) => {
        assert.equal(checkRevoked, true);
        if (token !== 'admin-token' || revoked) throw new Error('invalid token');
        return { uid: 'admin' };
      },
      getUser: async () => ({ disabled, customClaims: { role }, tokensValidAfterTime }),
    },
    {
      adminOrigin: 'https://admin.example',
      desktopOrigin: 'https://worker.example',
      socketPath,
      recover: () => {
        recoveries++;
      },
      audit: (event, uid) => audit.push(`${event}:${uid}`),
    }
  );
  const server = createServer(app);
  attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = (origin = 'https://admin.example', token = 'admin-token') =>
    fetch(`${base}/youtube-auth/session`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ idToken: token }),
    });
  const ws = (cookie: string, origin: string, expected: boolean) =>
    new Promise<void>((resolve, reject) => {
      const req = request(`${base}/youtube-auth/websockify`, {
        headers: {
          Cookie: cookie,
          Origin: origin,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'test',
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (_res, socket) => {
        if (!expected) {
          socket.destroy();
          reject(new Error('Unauthorized websocket accepted'));
          return;
        }
        socket.on('error', reject);
        socket.once('data', (data) => {
          assert.equal(data.toString(), 'hello');
          socket.destroy();
          resolve();
        });
        socket.write('hello');
      });
      req.on('response', (res) => {
        res.resume();
        expected ? reject(new Error('Websocket rejected')) : resolve();
      });
      req.on('error', (err) => (expected ? reject(err) : resolve()));
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('Websocket timed out'));
      });
      req.end();
    });
  try {
    assert.equal((await fetch(`${base}/youtube-auth/vnc.html`)).status, 401);
    assert.equal(requests, 0);
    assert.equal((await login('https://evil.example')).status, 403);
    assert.equal((await login('https://admin.example', 'invalid')).status, 401);
    role = 'publisher';
    assert.equal((await login()).status, 403);
    role = 'admin';
    disabled = true;
    assert.equal((await login()).status, 403);
    disabled = false;
    revoked = true;
    assert.equal((await login()).status, 401);
    revoked = false;
    const opened = await login();
    assert.equal(opened.status, 303);
    const setCookie = opened.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Max-Age=900'])
      assert(setCookie.includes(flag));
    assert(!opened.headers.get('location')?.includes('admin-token'));
    const cookie = setCookie.split(';')[0];
    const page = await fetch(`${base}/youtube-auth/vnc.html`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<html>remote browser</html>');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self' https://admin.example");
    assert.deepEqual(audit, ['YouTube desktop session opened:admin']);
    await ws(cookie, 'https://worker.example', true);
    await ws(cookie, 'https://evil.example', false);
    await ws('__Secure-urm-youtube-desktop=invalid', 'https://worker.example', false);
    role = 'user';
    assert.equal((await fetch(`${base}/youtube-auth/core/rfb.js`, { headers: { Cookie: cookie } })).status, 401);
    await ws(cookie, 'https://worker.example', false);
    role = 'admin';
    const nextCookie = (await login()).headers.get('set-cookie')!.split(';')[0];
    tokensValidAfterTime = new Date(Date.now() + 1000).toISOString();
    assert.equal((await fetch(`${base}/youtube-auth/vnc.html`, { headers: { Cookie: nextCookie } })).status, 401);
    tokensValidAfterTime = undefined;
    const expiryCookie = (await login()).headers.get('set-cookie')!.split(';')[0];
    const originalNow = Date.now;
    const now = Date.now();
    Date.now = () => now + 16 * 60_000;
    try {
      assert.equal((await fetch(`${base}/youtube-auth/vnc.html`, { headers: { Cookie: expiryCookie } })).status, 401);
    } finally {
      Date.now = originalNow;
    }
    const recover = (token?: string) =>
      fetch(`${base}/youtube-auth/recover`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    assert.equal((await recover()).status, 401);
    assert.equal((await recover('bad-token')).status, 401);
    role = 'user';
    assert.equal((await recover('admin-token')).status, 403);
    role = 'admin';
    disabled = true;
    assert.equal((await recover('admin-token')).status, 403);
    disabled = false;
    revoked = true;
    assert.equal((await recover('admin-token')).status, 401);
    revoked = false;
    assert.equal(recoveries, 0);
    const recoveryResponse = await recover('admin-token');
    assert.equal(recoveryResponse.status, 202);
    assert.deepEqual(await recoveryResponse.json(), { checking: true });
    assert.equal(recoveries, 1);
    console.log('YouTube admin desktop: HTTP/WS proxy, access control, CSRF, revocation and expiry passed');
  } finally {
    server.closeAllConnections();
    backend.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
