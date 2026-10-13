'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, cpSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, resolve } = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { createServer } = require('node:http');
const { patchInstalledTokenTransports, patchTokenModule } = require('./patch-google-oauth-transport.cjs');

test('Google Auth 11 exchanges a signed assertion through uncompressed OAuth and preserves caching', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'urm-oauth-'));
  const authRoot = dirname(require.resolve('google-auth-library/package.json'));
  const packageRoot = join(directory, 'node_modules', 'google-auth-library');
  mkdirSync(dirname(packageRoot), { recursive: true });
  cpSync(authRoot, packageRoot, {
    recursive: true,
    filter: (path) =>
      !path.includes('/node_modules/', path.indexOf('google-auth-library') + 'google-auth-library'.length),
  });
  const result = patchInstalledTokenTransports(join(directory, 'node_modules'));
  assert.equal(result.modules, 1);
  assert.equal(patchInstalledTokenTransports(join(directory, 'node_modules')).changed, 0);
  // Resolve actual dependencies only after patching the isolated copy; do not
  // let the patch scanner traverse a symlink into the developer installation.
  rmSync(join(packageRoot, 'node_modules'), { recursive: true, force: true });
  symlinkSync(resolve(__dirname, '../../..', 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  const { JWT } = require(packageRoot);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    assert.equal(request.headers['accept-encoding'], 'identity');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = body.get('assertion');
    assert.equal(assertion.split('.').length, 3);
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
    assert.equal(payload.iss, 'synthetic@example.test');
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/cloud-platform');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600, token_type: 'Bearer' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new JWT({
      email: 'synthetic@example.test',
      key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      transporterOptions: {
        fetchImplementation: async (url, options) => {
          assert.equal(String(url), 'https://oauth2.googleapis.com/token');
          return fetch(`http://127.0.0.1:${server.address().port}/token`, options);
        },
      },
    });
    const token = await client.getAccessToken();
    assert.equal(token.token, 'synthetic-token');
    assert.equal((await client.getAccessToken()).token, 'synthetic-token');
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy transports remain idempotent and incompatible source fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urm-oauth-legacy-'));
  try {
    const file = join(directory, 'index.js');
    writeFileSync(file, "headers: { 'Content-Type': 'application/x-www-form-urlencoded' },");
    assert.equal(patchTokenModule(file, 'legacy'), true);
    assert.equal(patchTokenModule(file, 'legacy'), false);
    assert.match(readFileSync(file, 'utf8'), /Accept-Encoding/);
    writeFileSync(file, 'changed implementation');
    assert.throws(() => patchTokenModule(file, 'current'), /Unsupported Google OAuth/);
    assert.throws(() => patchInstalledTokenTransports(directory), /No supported Google OAuth/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('discovers nested pnpm and hoisted transports without processing a symlink twice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urm-oauth-layout-'));
  try {
    const modules = join(directory, 'node_modules');
    const modern = join(modules, '.pnpm', 'google-auth-library@11.2.0', 'node_modules', 'google-auth-library');
    mkdirSync(join(modern, 'build/src/gtoken'), { recursive: true });
    writeFileSync(join(modern, 'build/src/gtoken/getToken.js'), "const opts = { responseType: 'json', };\n");
    symlinkSync(modern, join(modules, 'google-auth-library'), 'dir');
    const legacy = join(modules, 'other-sdk', 'node_modules', 'gtoken', 'build/src');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, 'index.js'),
      "const opts = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, };\n"
    );
    assert.deepEqual(patchInstalledTokenTransports(modules), { modules: 2, changed: 2 });
    assert.deepEqual(patchInstalledTokenTransports(modules), { modules: 2, changed: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
