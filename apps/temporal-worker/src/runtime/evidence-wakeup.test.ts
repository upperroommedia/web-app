import { createPublishingEvidenceWakeup } from './evidence-wakeup';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import { providerMutationFingerprint } from '../../../../functions/src/temporal/publishing/providerMutationGuard';
function setup() {
  const projectId = 'urm-app',
    jobId = 'job',
    entity = { type: 'sermon' as const, id: 'sermon' },
    kind = 'sermon.publish' as const;
  const scope = { projectId, jobId, operation: 'metadata' },
    id = providerMutationFingerprint(scope);
  const records: Record<string, any> = {
    [`durableJobs/${jobId}`]: {
      projectId,
      jobId,
      entity,
      kind,
      generation: 3,
      state: 'needs_attention',
      workflowId: 'publishing:urm-app:job',
    },
    [`durableJobIntents/${jobId}`]: { projectId, jobId, entity, kind, generation: 3, actorUid: 'revoked-user' },
    [`durableJobEntities/${durableEntityKey(projectId, entity, kind)}`]: {
      projectId,
      generation: 3,
      activeJobId: jobId,
    },
  };
  const db: any = {
    doc: (path: string) => ({ path }),
    collection: (path: string) => ({ doc: (key: string) => ({ path: `${path}/${key}` }) }),
  };
  const writes: string[] = [],
    tx: any = {
      get: async (ref: any) => ({
        exists: !!records[ref.path],
        data: () => records[ref.path],
        get: (field: string) => records[ref.path]?.[field],
      }),
      set: (ref: any, value: any) => {
        writes.push(ref.path);
        records[ref.path] = value;
      },
    };
  const session: any = { db, id, scope, resources: [] },
    fact = {
      factId: providerMutationFingerprint([id, 'patch', 'claim']),
      step: 'patch',
      claim: 'claim',
      executionId: 'original-execution',
      completion: 'acknowledged' as const,
    };
  const path = `durableJobCommands/${providerMutationFingerprint(['provider-evidence', projectId, jobId, id])}`;
  return {
    projectId,
    jobId,
    records,
    writes,
    tx,
    session,
    fact,
    path,
    prepare: createPublishingEvidenceWakeup(db, projectId),
  };
}
test('original response admits only a deferred metadata signal even after actor revocation', async () => {
  const f = setup(),
    commit = await f.prepare(f.tx, f.session, f.fact);
  expect(f.writes).toEqual([]);
  expect(commit).toBeDefined();
  commit!();
  expect(f.records[f.path]).toMatchObject({
    action: 'evidence_available',
    generation: 3,
    evidenceVersion: 1,
    state: 'pending',
    signal: {
      name: 'publishingEvidenceAvailable',
      args: [{ projectId: 'urm-app', jobId: 'job', sessionId: f.session.id, factId: f.fact.factId, generation: 3 }],
    },
  });
});
test.each(['terminal', 'generation', 'entity', 'foreign'])(
  'stale %s routing leaves the original response fact untouched',
  async (mode) => {
    const f = setup();
    if (mode === 'terminal') f.records['durableJobs/job'].state = 'cancelled';
    if (mode === 'generation') f.records['durableJobs/job'].generation = 4;
    if (mode === 'entity') Object.values(f.records).find((record: any) => record.activeJobId)!.activeJobId = 'new-job';
    if (mode === 'foreign') f.session.scope.projectId = 'other';
    expect(await f.prepare(f.tx, f.session, f.fact)).toBeUndefined();
    expect(f.writes).toEqual([]);
  }
);
test('new facts coalesce under a live dispatch lease without erasing the newer evidence version', async () => {
  const f = setup();
  (await f.prepare(f.tx, f.session, f.fact))!();
  Object.assign(f.records[f.path], {
    state: 'dispatching',
    leaseToken: 'current-lease',
    leaseExpiresAt: Date.now() + 60000,
  });
  const next = {
    ...f.fact,
    claim: 'new-claim',
    factId: providerMutationFingerprint([f.session.id, 'patch', 'new-claim']),
  };
  (await f.prepare(f.tx, f.session, next))!();
  expect(f.records[f.path]).toMatchObject({
    state: 'dispatching',
    leaseToken: 'current-lease',
    evidenceVersion: 2,
    signal: { args: [{ factId: next.factId }] },
  });
});
