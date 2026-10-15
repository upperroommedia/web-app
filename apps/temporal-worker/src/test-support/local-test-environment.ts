import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';

type Options = Pick<NonNullable<Parameters<typeof TestWorkflowEnvironment.createLocal>[0]>, 'server'>;
const STARTUP_MS = 60_000;
const CLEANUP_MS = 20_000;

function bounded<T>(operation: Promise<T>, milliseconds: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Local test server ${stage} did not complete`)), milliseconds);
  });
  return Promise.race([operation, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

function forceOwnedGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForOwnedGroupExit(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error('Local test server owner left a descendant process');
    await new Promise((yes) => setTimeout(yes, 20));
  }
}

async function closeEnvironmentClients(environment: TestWorkflowEnvironment): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => environment.connection.close()),
    Promise.resolve().then(() => environment.nativeConnection.close()),
  ]);
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Local test client cleanup failed');
}

function ownerError(record: Record<string, unknown>): Error {
  const details = record.error as Record<string, unknown> | undefined;
  const message = typeof details?.message === 'string' ? details.message : 'Local test server owner failed';
  const causes = Array.isArray(record.causes) ? record.causes.slice(0, 4).map((cause) => ownerError({ error: cause })) : [];
  const error = causes.length ? new AggregateError(causes, message, { cause: causes[0] }) : new Error(message);
  if (typeof details?.name === 'string') error.name = details.name;
  if (typeof details?.stack === 'string') error.stack = details.stack;
  return error;
}

/**
 * Node subprocess management and Tokio's ephemeral-server reaper must not share
 * signal ownership. The child owns only the real SDK server; this process uses
 * the public existing-server API and retains real clients/workers/assertions.
 */
export async function createLocalTestEnvironment(options: Options = {}): Promise<TestWorkflowEnvironment> {
  const owner = fork(resolve(__dirname, 'local-test-server.cjs'), [], {
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ownerFailures: Error[] = [];
  owner.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as Record<string, unknown>).type === 'error') {
      ownerFailures.push(ownerError(message as Record<string, unknown>));
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    owner.once('error', no);
    owner.once('exit', (code, signal) => yes({ code, signal }));
  });
  // Register immediately so a startup failure cannot become an unhandled rejection.
  void exited.catch(() => undefined);
  const ready = new Promise<{ address: string; namespace: string }>((yes, no) => {
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const record = message as Record<string, unknown>;
      if (record.type === 'error') return no(ownerError(record));
      if (record.type !== 'ready') return;
      owner.off('message', onMessage);
      if (typeof record.address !== 'string' || typeof record.namespace !== 'string') {
        return no(new Error('Invalid local test server identity'));
      }
      let target: URL;
      try {
        target = new URL(`http://${record.address}`);
      } catch {
        return no(new Error('Invalid local test server address'));
      }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.port) {
        return no(new Error('Refusing non-loopback local test server'));
      }
      if (record.namespace !== (options.server?.namespace ?? 'default')) {
        return no(new Error('Local test server namespace differs from requested namespace'));
      }
      yes({ address: record.address, namespace: record.namespace });
    };
    owner.on('message', onMessage);
    void exited.then(() => no(new Error('Local test server owner exited before readiness')), no);
  });
  void ready.catch(() => undefined);
  let stopping: Promise<void> | undefined;
  const stopOwner = (): Promise<void> => {
    stopping ??= (async () => {
      if (owner.connected) {
        await new Promise<void>((yes, no) => owner.send({ type: 'stop' }, (error) => (error ? no(error) : yes())));
      }
      const result = await exited;
      if (result.code !== 0 || result.signal || ownerFailures.length) {
        throw new AggregateError(ownerFailures, 'Local test server owner did not exit naturally and cleanly');
      }
      await waitForOwnedGroupExit(owner);
    })();
    return bounded(stopping, CLEANUP_MS, 'owner cleanup').catch(async (error) => {
      forceOwnedGroup(owner);
      const cleanup = await Promise.allSettled([
        bounded(exited.catch(() => undefined), 2_000, 'forced failure cleanup'),
        waitForOwnedGroupExit(owner),
      ]);
      const failed = cleanup.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw new AggregateError([error, failed.reason], 'Owned local server group did not settle');
      throw error;
    });
  };
  let environment: TestWorkflowEnvironment | undefined;
  try {
    await new Promise<void>((yes, no) => owner.send({ type: 'start', options }, (error) => (error ? no(error) : yes())));
    const identity = await bounded(ready, STARTUP_MS, 'startup');
    let abandoned = false;
    const connecting = TestWorkflowEnvironment.createFromExistingServer(identity);
    void connecting.then(async (lateEnvironment) => {
      if (abandoned) await closeEnvironmentClients(lateEnvironment);
    }).catch((error) => { console.error('Late local test client cleanup failed', error); });
    try {
      environment = await bounded(connecting, CLEANUP_MS, 'client connection');
    } catch (error) {
      abandoned = true;
      throw error;
    }
    const closeClient = () => closeEnvironmentClients(environment!);
    let closing: Promise<void> | undefined;
    environment.teardown = () => {
      closing ??= (async () => {
        const failures: unknown[] = [];
        try {
          await bounded(closeClient(), CLEANUP_MS, 'client cleanup');
        } catch (error) {
          failures.push(error);
        }
        try {
          await stopOwner();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, 'Local test environment cleanup failed');
      })();
      return closing;
    };
    return environment;
  } catch (error) {
    try {
      await stopOwner();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Local test environment startup and cleanup failed');
    }
    throw error;
  }
}
