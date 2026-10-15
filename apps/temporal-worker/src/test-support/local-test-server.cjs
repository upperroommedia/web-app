'use strict';

// This process must never use node:child_process. Only the real Temporal SDK
// owns server children here, avoiding competing libuv/Tokio SIGCHLD handlers.
const { TestWorkflowEnvironment } = require('@temporalio/testing');
let starting;
let stopping;
let started = false;
const CLEANUP_MS = 20_000;

function notify(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return resolve();
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    stack: error instanceof Error ? error.stack?.slice(0, 8_000) : undefined,
  };
}
function stop(failed = false) {
  if (failed) process.exitCode = 1;
  stopping ??= (async () => {
    // This watchdog is failure cleanup only. A forced process-group death can
    // never satisfy the parent's required natural, zero-status owner exit.
    const watchdog = setTimeout(() => {
      process.stderr.write('Local test server owner cleanup did not complete\n');
      process.kill(-process.pid, 'SIGKILL');
    }, CLEANUP_MS);
    try {
      const environment = await starting;
      if (environment) {
        // SDK teardown currently reports some failures through console.error
        // instead of rejection. They must not become a successful owner exit.
        const reportError = console.error;
        const reportedErrors = [];
        console.error = (...args) => { reportedErrors.push(...args); reportError(...args.map(errorDetails)); };
        try {
          await environment.teardown();
          if (reportedErrors.length) throw new AggregateError(reportedErrors, 'SDK reported a cleanup failure', { cause: reportedErrors[0] });
        } finally {
          console.error = reportError;
        }
      }
    } catch (error) {
      process.exitCode = 1;
      console.error('Local test server cleanup failed', errorDetails(error));
      await notify({ type: 'error', code: 'LOCAL_TEST_SERVER_CLEANUP_FAILED', error: errorDetails(error), causes: error instanceof AggregateError ? error.errors.slice(0, 4).map(errorDetails) : [] }).catch(() => undefined);
    } finally {
      clearTimeout(watchdog);
      process.off('message', onMessage);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onTerm);
      if (process.connected) process.disconnect();
    }
  })();
  return stopping;
}
const onTerm = () => { void stop(true); };
function onMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'stop') { void stop(); return; }
  if (message.type !== 'start' || started || stopping) { void stop(true); return; }
  started = true;
  starting = TestWorkflowEnvironment.createLocal(message.options);
  void starting.then(
    (environment) => notify({ type: 'ready', address: environment.address, namespace: environment.namespace ?? 'default' }),
    (error) => {
      console.error('Local test server startup failed', errorDetails(error));
      return notify({ type: 'error', code: 'LOCAL_TEST_SERVER_STARTUP_FAILED', error: errorDetails(error) }).finally(() => stop(true));
    }
  ).catch(() => stop(true));
}
process.on('message', onMessage);
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', onTerm);
process.on('SIGINT', onTerm);
