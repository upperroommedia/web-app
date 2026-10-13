import { resolveDurableEmail, validateEmailResolution } from '../../src/temporal/resolution';
import { emailAdmissionJobId, buildEmailAdmission } from '../../src/temporal/ingress';
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
const input = {
  ref: { jobId: 'j1', projectId: 'p1' },
  actorUid: 'administrator',
  commandId: 'c1',
  expectedJobRevision: 2,
  expectedGeneration: 1,
  decision: 'confirm_accepted' as const,
  expectedReceiptToken: 'token',
  evidenceReference: 'provider ticket 123',
  reason: 'Reviewed provider accepted-delivery logs',
};
function harness(state = 'unknown') {
  const admission = buildEmailAdmission('p1', 'j1', 'mail/m1', 1, {}, 0);
  const records: Record<string, any> = {
    'mail/m1': { delivery: { state: 'ERROR' } },
    'durableJobIntents/j1': admission.intent,
    'durableJobs/j1': { ...admission.job, revision: 2 },
    [`durableJobEntities/${admission.entityKey}`]: admission.entity,
    'durableEmailReceipts/j1': {
      state,
      token: 'token',
      startedAt: Timestamp.fromMillis(0),
      options: { from: 'private@x.org', to: ['private@x.org'], text: 'private body', messageId: '<old@x.org>' },
    },
  };
  const doc = (path: string): any => ({ path });
  const db: any = {
    doc,
    collection: (collection: string) => ({ doc: (id: string) => doc(`${collection}/${id}`) }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => ({ exists: !!records[ref.path], get: (key: string) => records[ref.path]?.[key] }),
        create: (ref: any, value: any) => {
          records[ref.path] = value;
        },
        set: (ref: any, value: any) => {
          records[ref.path] = value;
        },
        update: (ref: any, value: any) => {
          records[ref.path] = { ...records[ref.path], ...value };
        },
      }),
  };
  return { records, db };
}
test('operator confirmation records evidence privately, fences stale attempt, is idempotent', async () => {
  const h = harness();
  expect(await resolveDurableEmail(h.db, input)).toEqual({ state: 'confirmed' });
  const receipt = h.records['durableEmailReceipts/j1'];
  expect(receipt.state).toBe('accepted');
  expect(receipt.token).toBe('review:c1');
  expect(receipt.review.evidenceReference).toBe('provider ticket 123');
  expect(await resolveDurableEmail(h.db, input)).toEqual({ state: 'confirmed' });
});
test('reviewed failure closes uncertainty without fabricating provider acceptance', async () => {
  const h = harness();
  expect(await resolveDurableEmail(h.db, { ...input, decision: 'mark_failed_after_review' })).toEqual({
    state: 'failed',
  });
  expect(h.records['durableEmailReceipts/j1'].state).toBe('rejected');
  expect(h.records['mail/m1']['delivery.state']).toBe('ERROR');
});
test('reviewed resend admits distinct frozen private envelope, job and outbox atomically', async () => {
  const h = harness();
  const result = await resolveDurableEmail(h.db, {
    ...input,
    decision: 'resend_after_review',
    duplicateRiskAcknowledged: true,
  });
  expect(result.state).toBe('resent');
  expect(result.replacementJobId).not.toBe(input.ref.jobId);
  const mailPath = h.records[`durableJobIntents/${result.replacementJobId}`].payload.mailPath;
  expect(emailAdmissionJobId('p1', mailPath)).toBe(result.replacementJobId);
  expect(h.records[mailPath].message.text).toBe('private body');
  expect(h.records[mailPath].to).toEqual(['private@x.org']);
  expect(h.records[`durableJobOutbox/${result.replacementJobId}`].state).toBe('pending');
  expect(JSON.stringify(h.records[`durableJobs/${result.replacementJobId}`])).not.toContain('private body');
  expect(h.records['durableEmailReceipts/j1'].state).toBe('rejected');
  expect(
    await resolveDurableEmail(h.db, { ...input, decision: 'resend_after_review', duplicateRiskAcknowledged: true })
  ).toEqual(result);
});
test('resend requires explicit risk acknowledgment', () => {
  expect(() => validateEmailResolution({ ...input, decision: 'resend_after_review' })).toThrow(
    'EMAIL_REVIEW_DUPLICATE_RISK_ACK_REQUIRED'
  );
});
test('cannot overwrite a different attempt receipt', async () => {
  const h = harness();
  await expect(resolveDurableEmail(h.db, { ...input, expectedReceiptToken: 'different' })).rejects.toThrow(
    'EMAIL_REVIEW_STALE'
  );
  expect(h.records['durableEmailReceipts/j1'].state).toBe('unknown');
});
test('cannot review a provider attempt still inside its execution deadline', async () => {
  const h = harness('sending');
  h.records['durableEmailReceipts/j1'].startedAt = Timestamp.now();
  await expect(resolveDurableEmail(h.db, input)).rejects.toThrow('EMAIL_REVIEW_ATTEMPT_STILL_ACTIVE');
});
test('TTL-deleted mail does not prevent private receipt resolution', async () => {
  const h = harness();
  delete h.records['mail/m1'];
  expect(await resolveDurableEmail(h.db, input)).toEqual({ state: 'confirmed' });
  expect(h.records['mail/m1']).toBeUndefined();
});
test.each(['', ' ', undefined])('review requires bounded evidence (%s)', (evidenceReference) => {
  expect(() => validateEmailResolution({ ...input, evidenceReference })).toThrow('EMAIL_REVIEW_INVALID');
});
test('review fences the actual job revision and entity generation', async () => {
  const h = harness();
  await expect(resolveDurableEmail(h.db, { ...input, expectedJobRevision: 1 })).rejects.toThrow('EMAIL_REVIEW_STALE');
  h.records['durableJobs/j1'].revision = 2;
  const admission = buildEmailAdmission('p1', 'j1', 'mail/m1', 1, {}, 0);
  h.records[`durableJobEntities/${admission.entityKey}`].activeJobId = 'another-job';
  await expect(resolveDurableEmail(h.db, input)).rejects.toThrow('EMAIL_REVIEW_STALE');
});
test('command outbox hook commits in the same receipt transaction without reads after writes', async () => {
  const h = harness();
  const originalTransaction = h.db.runTransaction;
  h.db.runTransaction = async (operation: any) =>
    originalTransaction(async (tx: any) => {
      let written = false;
      const guarded = {
        get: async (reference: any) => {
          if (written) throw new Error('read after write');
          return tx.get(reference);
        },
        create: (reference: any, value: any) => {
          written = true;
          tx.create(reference, value);
        },
        update: (reference: any, value: any) => {
          written = true;
          tx.update(reference, value);
        },
        set: (reference: any, value: any) => {
          written = true;
          tx.set(reference, value);
        },
      };
      return operation(guarded);
    });
  const result = await resolveDurableEmail(h.db, {
    ...input,
    onResolutionCommit: async (tx, resolved) => {
      const command: DocumentReference = h.db.doc('durableJobCommands/c1');
      expect((await tx.get(command)).exists).toBe(false);
      tx.create(command, { state: 'pending', result: resolved });
    },
  });
  expect(result).toEqual({ state: 'confirmed' });
  expect(h.records['durableJobCommands/c1'].state).toBe('pending');
  expect(h.records['durableEmailReceipts/j1'].state).toBe('accepted');
});
