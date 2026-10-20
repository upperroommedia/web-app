import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const service = require('ts-node').register({ project: new URL('../apps/temporal-worker/tsconfig.json', import.meta.url).pathname,
  transpileOnly: true, compilerOptions: { module: 'CommonJS' } });
let install;
try { install = require('../apps/temporal-worker/src/runtime/dispatch-caller.ts').installDispatchCertificateTransport; }
finally { service.enabled(false); }
const { OAuth2Client } = require('google-auth-library');
for (const mode of ['redirect', 'chunked-size', 'timeout']) test(`real Gaxios/default native fetch enforces certificate ${mode}`, async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (mode === 'redirect' && req.url !== '/final') { res.writeHead(302, { location: '/final' }).end(); return; }
    if (mode === 'timeout') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'chunked-size') { res.write('{"key":"'); res.end('x'.repeat(150000) + '"}'); }
    else res.end('{"controlled":"public-certificate-fixture"}');
  });
  const controller = new AbortController(), client = new OAuth2Client();
  let fallback;
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address();
    assert(address && typeof address !== 'string');
    // Only the test adapter redirects the fixed Google cert request to this owned
    // fixture. Real Gaxios preparation/interceptors/default node-fetch stay in use.
    client.transporter.defaults.adapter = (config, adapter) => adapter({ ...config, url: new URL(`http://127.0.0.1:${address.port}/`) });
    install(client, () => controller.signal, mode === 'timeout' ? 20 : 8000);
    fallback = setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await assert.rejects(client.getFederatedSignonCertsAsync());
    if (mode === 'timeout') assert(Date.now() - started < 200, 'prepared timeout must abort before fallback');
    if (mode === 'redirect') assert.equal(requests, 1);
    if (mode === 'chunked-size') assert.equal(requests, 1);
  } finally {
    clearTimeout(fallback); controller.abort(); server.closeAllConnections();
    if (server.listening) await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  }
});
