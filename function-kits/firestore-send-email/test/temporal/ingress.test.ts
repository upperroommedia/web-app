import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as ts from 'typescript';
import { buildEmailAdmission, emailAdmissionJobId, enqueueTemporalEmail } from '../../src/temporal/ingress';

function loadModule(
  file: string,
  dependencies: Record<string, unknown> = {},
  cache = new Map<string, { exports: unknown }>()
): any {
  const cached = cache.get(file);
  if (cached) return cached.exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const requireModule = (name: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
    if (name.startsWith('.')) return loadModule(resolve(dirname(file), `${name}.ts`), dependencies, cache);
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(requireModule, module, module.exports);
  return module.exports;
}
test('standalone admission protocol matches the actual shared server store', () => {
  const contracts = loadModule(resolve(__dirname, '../../../../packages/contracts/temporal.ts'));
  const shared = loadModule(resolve(__dirname, '../../../../packages/orchestration/src/job-store.ts'), {
    '@upperroom/contracts/temporal': contracts,
  });
  const writes: Record<string, unknown> = {};
  const firestore: any = {
    collection: (collection: string) => ({ doc: (id: string) => ({ path: `${collection}/${id}` }) }),
  };
  const tx: any = {
    create: (ref: any, value: any) => {
      writes[ref.path] = value;
    },
    set: (ref: any, value: any) => {
      writes[ref.path] = value;
    },
  };
  const jobId = emailAdmissionJobId('p1', 'mail/m1');
  const envelope = buildEmailAdmission('p1', jobId, 'mail/m1', 2, { message: { text: 'private' } }, 1000);
  shared.createDurableJobStore({ firestore, projectId: 'p1' }).createInTransaction(tx, {
    ref: { projectId: 'p1', jobId },
    kind: 'email.deliver',
    entity: { type: 'mail', id: 'mail/m1' },
    actorUid: 'system:email',
    payload: envelope.intent.payload,
    requestId: `mail:${jobId}`,
    generation: 2,
    dispatch: envelope.outbox.dispatch,
    createdAt: 1000,
  });
  expect(writes[`durableJobs/${jobId}`]).toEqual(envelope.job);
  expect(writes[`durableJobIntents/${jobId}`]).toEqual(envelope.intent);
  expect(writes[`durableJobOutbox/${jobId}`]).toEqual(envelope.outbox);
  expect(writes[`durableJobEntities/${envelope.entityKey}`]).toEqual(envelope.entity);
  expect(JSON.stringify(envelope.job)).not.toContain('private');
});
function harness(payload: any) {
  const records: Record<string, any> = {
    'mail/m1': payload,
    '_control/temporalRelease': {
      schemaVersion: 1,
      revision: 1,
      admission: 'open',
      domains: { emails: { owner: 'temporal', admission: 'open' } },
      releaseId: 'test-release',
      updatedAt: 1,
    },
  };
  const doc = (path: string): any => ({ path });
  const writes: string[] = [];
  const db: any = {
    doc,
    collection: (collection: string) => ({ doc: (id: string) => doc(`${collection}/${id}`) }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => ({
          exists: !!records[ref.path],
          data: () => records[ref.path],
          get: (key: string) => records[ref.path]?.[key],
        }),
        create: (ref: any, data: any) => {
          writes.push(ref.path);
          records[ref.path] = data;
        },
        set: (ref: any, data: any) => {
          writes.push(ref.path);
          records[ref.path] = data;
        },
        update: (ref: any, data: any) => {
          writes.push(ref.path);
          records[ref.path] = { ...records[ref.path], ...data };
        },
      }),
  };
  return { db, records, writes };
}
test('atomic outbox admission retains private content and is idempotent', async () => {
  const h = harness({ message: { text: 'private mail content' }, to: ['private@example.org'] });
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1');
  const jobId = emailAdmissionJobId('p1', 'mail/m1');
  expect(h.records[`durableJobOutbox/${jobId}`].state).toBe('pending');
  expect(h.records['mail/m1'].delivery.orchestrator).toBe('temporal');
  expect(h.records[`durableJobIntents/${jobId}`].payload.payload.to).toEqual(['private@example.org']);
  expect(JSON.stringify(h.records[`durableJobs/${jobId}`])).not.toContain('private');
  expect(h.writes).toHaveLength(5);
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1');
  expect(h.writes).toHaveLength(5);
});
test.each(['PROCESSING', 'SUCCESS', 'ERROR'])('does not adopt legacy %s delivery', async (state) => {
  const h = harness({ message: { text: 'mail' }, delivery: { state } });
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1');
  expect(h.writes).toHaveLength(0);
});
test('invalid mail is not admitted', async () => {
  const h = harness({ to: ['a@x.org'] });
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1');
  expect(h.writes).toHaveLength(0);
});
test('existing delivery expiry survives adoption', async () => {
  const h = harness({ message: { text: 'mail' }, delivery: { state: 'PENDING', expireAt: 'old-expiry' } });
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1', () => {
    throw new Error('must retain existing expiry');
  });
  expect(h.records['mail/m1'].delivery.expireAt).toBe('old-expiry');
});
test('previous legacy attempts are not imported or automatically retried', async () => {
  const h = harness({ message: { text: 'mail' }, delivery: { state: 'RETRY', attempts: 1 } });
  await enqueueTemporalEmail(h.db, 'mail/m1', 'p1', undefined, undefined, { revision: 1, releaseId: 'test-release' });
  expect(h.writes).toHaveLength(0);
});
