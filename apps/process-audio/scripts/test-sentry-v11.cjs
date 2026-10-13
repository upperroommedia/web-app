/** Exercise the real SDK bootstrap without sending synthetic events to Sentry. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

if (!process.env.SENTRY_VERIFY_CHILD) {
  for (const enabled of ['true', 'false']) {
    const child = spawnSync(process.execPath, [__filename], {
      env: {
        ...process.env,
        SENTRY_VERIFY_CHILD: '1',
        SENTRY_ENABLE_LOGS: enabled,
        SENTRY_DSN: 'https://public@example.invalid/1',
        SENTRY_ENVIRONMENT: 'verification',
        SENTRY_RELEASE: 'local-verification',
        SENTRY_TRACES_SAMPLE_RATE: '0',
      },
      stdio: 'inherit',
    });
    assert.equal(child.status, 0, `Sentry verification failed with logs=${enabled}`);
  }
} else {
  const ts = require('typescript');
  const envelopes = [];
  globalThis.__sentryVerificationTransport = () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  });
  const filename = path.resolve(__dirname, '../src/instrument.ts');
  const source = fs
    .readFileSync(filename, 'utf8')
    .replace('Sentry.init({', 'Sentry.init({ transport: globalThis.__sentryVerificationTransport,');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const bootstrap = new Module(filename, module);
  bootstrap.filename = filename;
  bootstrap.paths = Module._nodeModulePaths(path.dirname(filename));
  bootstrap._compile(compiled, filename);
  const { Sentry, sentryEnabled, sentryLogsEnabled, sentryEnvironment, sentryRelease, sentryTracesSampleRate } =
    bootstrap.exports;
  const logsEnabled = process.env.SENTRY_ENABLE_LOGS === 'true';
  assert.equal(sentryEnabled, true);
  assert.equal(sentryLogsEnabled, logsEnabled);
  assert.equal(sentryEnvironment, 'verification');
  assert.equal(sentryRelease, 'local-verification');
  assert.equal(sentryTracesSampleRate, 0);
  const collection = Sentry.getClient().getOptions().dataCollection;
  for (const category of [
    'userInfo',
    'cookies',
    'urlQueryParams',
    'databaseQueryData',
    'queues',
    'stackFrameVariables',
  ])
    assert.equal(collection[category], false, category);
  assert.deepEqual(collection.httpHeaders, { request: false, response: false });
  assert.deepEqual(collection.httpBodies, []);
  assert.deepEqual(collection.genAI, { inputs: false, outputs: false });
  assert.deepEqual(collection.graphQL, { document: false, variables: false });
  assert.equal(Sentry.getClient().getOptions().includeLocalVariables, false);
  Sentry.captureException(new Error('intercepted local verification'));
  Sentry.logger.warn('intercepted local verification');
  (async () => {
    await Sentry.flush(2000);
    const items = envelopes.flatMap((envelope) => envelope[1]);
    assert.ok(
      items.some((item) => item[0].type === 'event'),
      'Error capture must remain enabled'
    );
    assert.equal(
      items.some((item) => item[0].type === 'log'),
      logsEnabled,
      'Direct SDK log calls must respect SENTRY_ENABLE_LOGS'
    );
    await Sentry.close(2000);
    process.stdout.write(`Sentry v11 privacy, error capture and logs=${logsEnabled} verified locally.\n`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
