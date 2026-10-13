import { createHash } from 'node:crypto';
import { deliverDurableEmail, emailMessageId } from '../../src/temporal/delivery';
import { isDefinitelyUnsent, EmailRuntime } from '../../src/temporal/runtime';

function harness(initial: Record<string, any> = {}) {
  const headId = createHash('sha256')
    .update(JSON.stringify(['p1', 'mail', 'mail/m1', 'email']))
    .digest('hex');
  const records: Record<string, any> = {
    'mail/m1': {},
    'durableJobs/j1': { state: 'running', entity: { type: 'mail', id: 'mail/m1' }, generation: 1 },
    [`durableJobEntities/${headId}`]: { activeJobId: 'j1', generation: 1 },
    ...initial,
  };
  const ref = (path: string): any => ({
    path,
    get: async () => snapshot(path),
    update: async (value: any) => {
      records[path] = { ...records[path], ...value };
    },
  });
  const snapshot = (path: string): any => ({ exists: !!records[path], get: (key: string) => records[path]?.[key] });
  let chain = Promise.resolve();
  const db: any = {
    collection: (path: string) => ({ doc: (id: string) => ref(`${path}/${id}`) }),
    doc: ref,
    runTransaction: (work: any) => {
      const result = chain.then(() =>
        work({
          get: async (r: any) => snapshot(r.path),
          create: (r: any, v: any) => {
            records[r.path] = v;
          },
          update: (r: any, v: any) => {
            records[r.path] = { ...records[r.path], ...v };
          },
        })
      );
      chain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
  const runtime: EmailRuntime = {
    prepare: jest.fn(async (_payload, messageId) => ({ messageId, to: ['private@example.org'] })),
    verify: jest.fn(async () => undefined),
    send: jest.fn(async (options) => ({
      messageId: options.messageId as string,
      accepted: ['private@example.org'],
      rejected: [],
      pending: [],
      response: '250 OK',
      sendgridQueueId: null,
    })),
    close: jest.fn(),
  };
  return { db, runtime, records };
}
const ref = { jobId: 'j1', projectId: 'p1' };
const intent = { mailPath: 'mail/m1', payload: { message: { text: 'private body' } } };

test('deterministic project-scoped RFC message IDs', () => {
  expect(emailMessageId('p1', 'j1')).toBe(emailMessageId('p1', 'j1'));
  expect(emailMessageId('p2', 'j1')).not.toBe(emailMessageId('p1', 'j1'));
  expect(emailMessageId('p1', 'j1')).toMatch(/^<[a-f0-9]{64}@durable\.upperroommedia\.org>$/);
});
test('records sending fence before provider side effect and replay does not send twice', async () => {
  const h = harness();
  (h.runtime.send as jest.Mock).mockImplementation(async (options) => {
    expect(h.records['durableEmailReceipts/j1'].state).toBe('sending');
    return {
      messageId: options.messageId,
      accepted: ['private@example.org'],
      rejected: [],
      pending: [],
      response: null,
      sendgridQueueId: null,
    };
  });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('confirmed');
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('confirmed');
  expect(h.runtime.send).toHaveBeenCalledTimes(1);
  expect(h.records['mail/m1']['delivery.state']).toBe('SUCCESS');
});
test.each(['sending', 'unknown'])('crash-recovered %s receipt never resends', async (state) => {
  const h = harness({ 'durableEmailReceipts/j1': { state } });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('unknown');
  expect(h.runtime.send).not.toHaveBeenCalled();
});
test('failure before submission retries with frozen template/recipient options', async () => {
  const h = harness();
  (h.runtime.verify as jest.Mock).mockRejectedValueOnce(new Error('secret transport detail'));
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('safe_retry');
  expect(h.runtime.send).not.toHaveBeenCalled();
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('confirmed');
  expect(h.runtime.prepare).toHaveBeenCalledTimes(1);
});
test('known pre-envelope failure can retry', async () => {
  const h = harness();
  (h.runtime.send as jest.Mock).mockRejectedValueOnce({ command: 'CONN', code: 'ECONNECTION' });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('safe_retry');
  expect(h.records['durableEmailReceipts/j1'].state).toBe('prepared');
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('confirmed');
});
test('DATA timeout needs review, emits no raw error and cannot be retried', async () => {
  const h = harness();
  (h.runtime.send as jest.Mock).mockRejectedValue({ command: 'DATA', code: 'ETIMEDOUT', message: 'password=private' });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('unknown');
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('unknown');
  expect(h.runtime.send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.records)).not.toContain('password=private');
});
test('partial acceptance cannot resend accepted recipients automatically', async () => {
  const h = harness();
  (h.runtime.send as jest.Mock).mockResolvedValue({
    messageId: 'id',
    accepted: ['a@x.org'],
    rejected: ['b@x.org'],
    pending: [],
    response: null,
    sendgridQueueId: null,
  });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('partial');
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('partial');
  expect(h.runtime.send).toHaveBeenCalledTimes(1);
});
test('unknown errors are conservative', () => {
  expect(isDefinitelyUnsent({ command: 'DATA', code: 'ETIMEDOUT' })).toBe(false);
  expect(isDefinitelyUnsent({ code: 'ECONNRESET' })).toBe(false);
  expect(isDefinitelyUnsent({ command: 'AUTH PLAIN' })).toBe(true);
});
test('TTL-deleted unsubmitted mail is cancelled without sending', async () => {
  const h = harness();
  delete h.records['mail/m1'];
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('cancelled');
  expect(h.runtime.send).not.toHaveBeenCalled();
});
test('cancellation during preflight wins the durable fence before any send', async () => {
  const h = harness();
  (h.runtime.verify as jest.Mock).mockImplementation(async () => {
    h.records['durableJobs/j1'].state = 'cancel_requested';
  });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('cancelled');
  expect(h.runtime.send).not.toHaveBeenCalled();
  expect(h.records['durableEmailReceipts/j1'].state).toBe('cancelled');
});
test('superseded generation cannot send an older private envelope', async () => {
  const h = harness();
  const headId = createHash('sha256')
    .update(JSON.stringify(['p1', 'mail', 'mail/m1', 'email']))
    .digest('hex');
  (h.runtime.verify as jest.Mock).mockImplementation(async () => {
    h.records[`durableJobEntities/${headId}`].activeJobId = 'replacement';
  });
  expect(await deliverDurableEmail(h.db, h.runtime, ref, intent)).toBe('cancelled');
  expect(h.runtime.send).not.toHaveBeenCalled();
});
test('private execution epoch is fenced before reservations and immediately before provider send', async () => {
  const h = harness();
  let invalid = false;
  (h.runtime.verify as jest.Mock).mockImplementation(async () => {
    invalid = true;
  });
  const fence = {
    assertCurrent: async () => {
      if (invalid) throw new Error('LEASE_LOST');
    },
    assertInTransaction: async () => {
      if (invalid) throw new Error('LEASE_LOST');
    },
  };
  await expect(deliverDurableEmail(h.db, h.runtime, ref, intent, fence)).rejects.toThrow('LEASE_LOST');
  expect(h.runtime.send).not.toHaveBeenCalled();
});
