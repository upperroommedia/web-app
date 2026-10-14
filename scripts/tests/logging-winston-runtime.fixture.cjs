// Child-only real production logger verification. All network exits are blocked.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const attempts = [];
const block = (name) => () => {
  attempts.push(name);
  throw new Error(`Forbidden logging contract network exit: ${name}`);
};
for (const [name, methods] of Object.entries({
  'node:net': ['connect', 'createConnection'],
  'node:tls': ['connect'],
  'node:http': ['get', 'request'],
  'node:https': ['get', 'request'],
  'node:dns': ['lookup', 'resolve', 'resolve4', 'resolve6'],
})) {
  const module = require(name);
  for (const method of methods) module[method] = block(`${name}.${method}`);
}
require('node:net').Socket.prototype.connect = block('Socket.connect');
for (const method of Object.keys(require('node:dns').promises)) {
  if (/^(lookup|resolve|reverse)/.test(method)) require('node:dns').promises[method] = block(`dns.promises.${method}`);
}
require('node:http2').connect = block('http2.connect');
require('node:dgram').createSocket = block('dgram.createSocket');
globalThis.fetch = block('fetch');
process.env.NODE_ENV = 'production';
process.env.ENABLE_CLOUD_LOGGING = 'true';
process.env.K_SERVICE = 'dependency-fixture';
process.env.K_SERVICE_VERSION = 'offline-contract';
process.env.SENTRY_DSN = '';
process.env.SENTRY_ENABLE_LOGS = 'false';

const loggingLoader = createRequire(rootRequire.resolve('@google-cloud/logging-winston'));
const { Log } = loggingLoader('@google-cloud/logging');
const writes = [];
let failure;
let failedWrites = 0;
// Preserve the actual transport, entry construction, severity methods and
// callbackification. Intercept only the remote write boundary before ADC/RPC.
Log.prototype.write = async function (entries) {
  if (failure) {
    failedWrites++;
    throw failure;
  }
  writes.push(...(Array.isArray(entries) ? entries : [entries]));
  return [{}];
};
const winston = rootRequire('winston');
let configuredLogger;
const originalCreateLogger = winston.createLogger;
winston.createLogger = function (options) {
  configuredLogger = originalCreateLogger(options);
  return configuredLogger;
};

(async () => {
  const { createLoggerWithContext } = require(resolve(root, 'apps/process-audio/dist/WinstonLogger.js'));
  const { LoggingWinston } = rootRequire('@google-cloud/logging-winston');
  const transport = configuredLogger.transports.find((value) => value instanceof LoggingWinston);
  assert.ok(transport, 'Production application logger must actually construct its Cloud Logging transport');
  assert.equal(transport.common.redirectToStdout, false);
  const logger = createLoggerWithContext({
    requestId: 'local-request',
    sermonId: 'local-sermon',
    operation: 'local-operation',
  });
  if (process.argv.includes('--failure')) {
    failure = Object.assign(new Error('SYNTHETIC_SECRET_MUST_NOT_LEAK'), {
      code: 'PRIVATE_CODE',
      requestId: 'PRIVATE_REQUEST',
    });
    // Do not attach a test error listener: the unmodified application would
    // terminate on the asynchronous transport error, which is the regression.
    logger.error('fixture-business-error', { category: 'verification' });
    await new Promise((done) => setTimeout(done, 50));
    assert.ok(failedWrites > 0);
    const businessResult = await Promise.resolve('business-operation-completed');
    logger.info('fixture-business-continued');
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(attempts, []);
    configuredLogger.close();
    process.stdout.write(
      `LOGGING_FAILURE_CONTRACT:${JSON.stringify({ businessResult, networkAttempts: 0, asyncFailureObserved: true })}\n`
    );
    return;
  }

  logger.info('fixture-info', { labels: { actor: 'fixture' }, measured: 1 });
  logger.warn('fixture-warning', { retryable: true });
  logger.error('fixture-error', { stack: 'Error: fixture failure\n    at local-contract', category: 'verification' });
  const finished = once(configuredLogger, 'finish');
  configuredLogger.end();
  await finished;
  const entry = (message) => writes.find((value) => value.data?.message?.startsWith(message));
  for (const [message, severity] of [
    ['fixture-info', 'INFO'],
    ['fixture-warning', 'WARNING'],
    ['fixture-error', 'ERROR'],
  ]) {
    const value = entry(message);
    assert.ok(value, `${message} must flush through the actual transport`);
    assert.equal(value.metadata.severity, severity);
    assert.equal(value.metadata.labels.service, 'process-audio-cloud-run');
    assert.equal(value.data.metadata.requestId, 'local-request');
    assert.equal(value.data.metadata.sermonId, 'local-sermon');
    assert.equal(value.data.metadata.operation, 'local-operation');
  }
  assert.equal(entry('fixture-info').data.metadata.measured, 1);
  assert.equal(entry('fixture-info').data.metadata.labels_actor, 'fixture');
  assert.match(entry('fixture-error').data.message, /Error: fixture failure/);
  assert.deepEqual(entry('fixture-error').data.serviceContext, {
    service: 'process-audio-cloud-run',
    version: 'offline-contract',
  });
  const failedTransport = new LoggingWinston({ labels: { service: 'process-audio-cloud-run' } });
  failure = new Error('LOCAL_WRITE_FAILURE');
  await new Promise((done, reject) =>
    failedTransport.log(
      { level: 'error', [Symbol.for('level')]: 'error', message: 'fixture-write-failure' },
      (error) => {
        try {
          assert.equal(error, failure);
          done();
        } catch (caught) {
          reject(caught);
        }
      }
    )
  );
  assert.deepEqual(attempts, []);
  process.stdout.write(
    `LOGGING_CONTRACT:${JSON.stringify({
      applicationTransport: true,
      emitted: 3,
      severityLabelsContextStack: true,
      flushed: true,
      failurePropagated: true,
      networkAttempts: 0,
    })}\n`
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
