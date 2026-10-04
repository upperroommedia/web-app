const assert = require('node:assert/strict');
const messages = [];
let pageCalls = 0;
const admin = {
  auth: () => ({
    listUsers: async (_limit, token) => {
      pageCalls++;
      if (!token)
        return {
          users: [
            { email: 'ADMIN@EXAMPLE.COM', customClaims: { role: 'admin' } },
            { email: 'publisher@example.com', customClaims: { role: 'publisher' } },
            { email: 'disabled@example.com', disabled: true, customClaims: { role: 'admin' } },
          ],
          pageToken: 'next',
        };
      assert.equal(token, 'next');
      return {
        users: [
          { email: 'other@example.com', customClaims: { role: 'admin' } },
          { email: 'admin@example.com', customClaims: { role: 'admin' } },
        ],
      };
    },
  }),
  firestore: () => ({
    collection: (name) => {
      assert.equal(name, 'mail');
      return { add: async (message) => messages.push(message) };
    },
  }),
};
const stub = (path, value) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } };
};
stub('../dist/firebaseAdmin', admin);
stub('../dist/WinstonLogger', { info() {}, error() {}, warn() {} });
const { emitOperationalAlertEmail } = require('../dist/operationalAlerts');
async function run() {
  process.env.ADMIN_BASE_URL = 'https://admin.example/';
  process.env.RUNTIME_ALERT_RECIPIENTS = 'operator@example.com';
  await emitOperationalAlertEmail({
    alertCode: 'cookie_session_stale',
    summary: 'Sign in again',
    error: new Error('Session expired'),
    youtubeAuthRecovery: true,
  });
  assert.equal(pageCalls, 2);
  assert.deepEqual(messages[0].to, ['admin@example.com', 'other@example.com']);
  assert(messages[0].message.text.includes('https://admin.example/admin/youtube-auth'));
  assert(messages[0].message.html.includes('href="https://admin.example/admin/youtube-auth"'));
  await emitOperationalAlertEmail({ alertCode: 'provider_unhealthy', summary: 'Provider issue', error: 'offline' });
  assert.deepEqual(messages[1].to, ['operator@example.com']);
  assert(!messages[1].message.text.includes('/admin/youtube-auth'));
  admin.auth = () => ({ listUsers: async () => ({ users: [] }) });
  await assert.rejects(
    emitOperationalAlertEmail({
      alertCode: 'cookie_session_stale',
      summary: 'Sign in',
      error: 'expired',
      youtubeAuthRecovery: true,
    }),
    /No active admin/
  );
  assert.equal(messages.length, 2);
  console.log(
    'YouTube auth alerts: paginated admin recipients, disabled filtering, recovery link and failure propagation passed'
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
