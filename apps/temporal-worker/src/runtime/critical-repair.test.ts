import { createHash } from 'node:crypto';
import { createCriticalRepairAuthority } from './critical-repair';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const setup = (authorizeDerivedOperation?: jest.Mock, authorizeCertifiedDeletionInTransaction?: jest.Mock) => {
  const ref = { projectId: 'test', jobId: 'job' };
  const execution: any = { activityType: 'repairPublishingCritical', workflowId: 'owned' };
  const intent = { ...ref, generation: 2, actorUid: 'revoked-original' };
  const critical = { ...ref, generation: 2, workflowId: 'owned', enteredAt: 10 };
  const operation = { kind: 'provider_read', provider: 'subsplash', resourceId: 'fixed-media', method: 'GET' };
  const certificate = {
    schemaVersion: 1 as const,
    ...ref,
    generation: 2,
    workflowId: 'owned',
    intentFingerprint: digest(intent),
    criticalFingerprint: digest(critical),
    operations: [operation],
    sourceEvidenceDigests: ['source'],
  };
  const certificateId = 'a'.repeat(64);
  const grant: any = {
    schemaVersion: 1,
    ...ref,
    generation: 2,
    workflowId: 'owned',
    actorUid: 'reviewer',
    commandId: 'command',
    certificateId,
    certificateDigest: digest(certificate),
    intentFingerprint: certificate.intentFingerprint,
    criticalFingerprint: certificate.criticalFingerprint,
    operations: certificate.operations,
    sourceEvidenceDigests: certificate.sourceEvidenceDigests,
    reason: 'Repair the known deletion',
    evidenceReference: 'audit:review',
    createdAtMillis: 100,
  };
  const records: any = {
    durableJobs: { ...ref, generation: 2, workflowId: 'owned', state: 'reconciling' },
    durableJobIntents: intent,
    durableJobCriticalSections: critical,
    durableJobCriticalRepairGrants: grant,
  };
  const firestore: any = {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: Boolean(records[collection]),
          data: () => records[collection],
          get: (field: string) => records[collection]?.[field],
        }),
      }),
    }),
  };
  const reviewer: any = { disabled: false, customClaims: { role: 'admin' } };
  const getUser = jest.fn(async () => reviewer);
  const loadValidatedCertificate = jest.fn(async () => certificate);
  const assertExecution = jest.fn(async () => {});
  const sourceDeletedProof = jest.fn(async () => {});
  const authority = createCriticalRepairAuthority({
    firestore,
    auth: { getUser } as any,
    projectId: 'test',
    getExecution: () => execution,
    digest,
    loadValidatedCertificate,
    assertExecution,
    authorizeDeletedCanonicalCleanup: sourceDeletedProof,
    authorizeDerivedOperation,
    authorizeCertifiedDeletionInTransaction,
  });
  return {
    ref,
    execution,
    intent,
    critical,
    operation,
    certificate,
    certificateId,
    grant,
    records,
    reviewer,
    loadValidatedCertificate,
    getUser,
    authority,
    assertExecution,
    sourceDeletedProof,
  };
};
test('each exact certified effect freshly revalidates the current reviewer', async () => {
  const f = setup();
  await f.authority.authorizeOperation(f.ref, f.certificateId, f.operation);
  f.reviewer.customClaims.role = 'user';
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, f.operation)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  expect(f.getUser).toHaveBeenCalledTimes(2);
});
test('repair grant cannot replay ordinary activities, change resources or allocate new providers', async () => {
  const f = setup();
  await expect(
    f.authority.authorizeOperation(f.ref, f.certificateId, { ...f.operation, resourceId: 'other' })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  f.operation.method = 'POST';
  f.grant.certificateDigest = digest(f.certificate);
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, f.operation)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  f.execution.activityType = 'ensurePublishingMedia';
  await expect(f.authority.loadCertificate(f.ref, f.certificateId)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});
test('immutable intent, critical phase, certificate and approved operation set are all pinned', async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) => {
      f.intent.generation = 3;
    },
    (f: ReturnType<typeof setup>) => {
      f.critical.enteredAt = 11;
    },
    (f: ReturnType<typeof setup>) => {
      f.grant.operations = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.grant.certificateDigest = 'b'.repeat(64);
    },
    (f: ReturnType<typeof setup>) => {
      f.records.durableJobCancellationIntents = { ...f.ref };
    },
  ]) {
    const f = setup();
    mutate(f);
    await expect(f.authority.loadCertificate(f.ref, f.certificateId)).rejects.toMatchObject({
      code: 'PERMISSION_CHANGED',
    });
  }
});
test('source evidence validation failure prevents repair before any effects', async () => {
  const f = setup();
  f.loadValidatedCertificate.mockRejectedValue(new Error('Journal changed'));
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, f.operation)).rejects.toThrow('Journal changed');
  expect(f.getUser).not.toHaveBeenCalled();
});
test('a stale SDK execution loses repair authority before any provider call', async () => {
  const f = setup();
  f.assertExecution.mockRejectedValue(Object.assign(new Error('Stale execution'), { code: 'STALE_EXECUTION' }));
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, f.operation)).rejects.toMatchObject({
    code: 'STALE_EXECUTION',
  });
  expect(f.loadValidatedCertificate).not.toHaveBeenCalled();
});
test('only the exact audited repair cleanup marker permits journal-certified DELETE', async () => {
  const f = setup();
  const deletion = { ...f.operation, kind: 'provider_delete', method: 'DELETE' };
  f.certificate.operations.push(deletion);
  f.grant.certificateDigest = digest(f.certificate);
  f.records.durableJobs.state = 'cancel_requested';
  f.records.durableJobs.result = { resolutionPurpose: 'cleanup' };
  const marker = {
    schemaVersion: 1,
    ...f.ref,
    generation: 2,
    workflowId: 'owned',
    purpose: 'critical_repair_cleanup',
    certificateId: f.certificateId,
    actorUid: 'reviewer',
    authorizedAt: 200,
  };
  f.records.durableJobCancellationIntents = marker;
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, deletion)).resolves.toBeUndefined();
  marker.purpose = 'ordinary_cancel';
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, deletion)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});

test('a missing sermon root requires its immutable deletion proof even for a fresh repair administrator', async () => {
  const f = setup();
  Object.assign(f.intent, { kind: 'sermon.delete', entity: { type: 'sermon', id: 'sermon' } });
  f.certificate.intentFingerprint = digest(f.intent);
  f.grant.intentFingerprint = f.certificate.intentFingerprint;
  f.grant.certificateDigest = digest(f.certificate);
  f.sourceDeletedProof.mockRejectedValueOnce(
    Object.assign(new Error('Root removal checkpoint missing'), { code: 'PERMISSION_CHANGED' })
  );
  await expect(f.authority.loadCertificate(f.ref, f.certificateId)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  await expect(f.authority.loadCertificate(f.ref, f.certificateId)).resolves.toBe(f.certificate);
  expect(f.sourceDeletedProof).toHaveBeenCalledWith(f.intent, f.execution, undefined);
  const deletion = { ...f.operation, kind: 'provider_delete', method: 'DELETE' };
  f.certificate.operations.push(deletion);
  f.grant.certificateDigest = digest(f.certificate);
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, deletion)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});

test('legacy retention authorizes only an exact source-generated certificate without an HTTP operation', async () => {
  const f = setup(),
    retention = { kind: 'legacy_soundcloud_retain', certificateId: 'b'.repeat(64) };
  (f.certificate.operations as unknown[]).push(retention);
  f.grant.certificateDigest = digest(f.certificate);
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, retention)).resolves.toBeUndefined();
  for (const changed of [
    { ...retention, method: 'DELETE' },
    { ...retention, resourceId: 'arbitrary-track' },
    { ...retention, certificateId: 'private-response' },
  ])
    await expect(f.authority.authorizeOperation(f.ref, f.certificateId, changed)).rejects.toMatchObject({
      code: 'PERMISSION_CHANGED',
    });
  f.reviewer.customClaims.role = 'user';
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, retention)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});

test('catalog-derived operations require source membership and a fresh reviewer after the source read', async () => {
  const membership = jest.fn(async () => {}),
    f = setup(membership),
    read = { ...f.operation, resourceId: 'catalog-fixed-id' };
  await f.authority.authorizeOperation(f.ref, f.certificateId, read);
  expect(membership).toHaveBeenCalledWith(f.ref, f.certificate, read);
  expect(f.getUser).toHaveBeenCalledTimes(2);
  membership.mockImplementation(async () => {
    f.reviewer.customClaims.role = 'user';
  });
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, read)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});
test('source membership cannot authorize a desired allocation or any unknown operation', async () => {
  const membership = jest.fn(async () => {}),
    f = setup(membership);
  await expect(
    f.authority.authorizeOperation(f.ref, f.certificateId, { kind: 'provider_create', method: 'POST' })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(membership).not.toHaveBeenCalled();
});

test('certified delete transaction requires source phase authority and rechecks reviewer after source reads', async () => {
  const phaseCheck = jest.fn(async () => {}),
    f = setup(undefined, phaseCheck),
    tx: any = { get: (reference: any) => reference.get() };
  const operation = { ...f.operation, kind: 'provider_delete', method: 'DELETE' };
  (f.certificate.operations as unknown[]).push(operation);
  f.grant.certificateDigest = digest(f.certificate);
  await f.authority.authorizeCertifiedDeletionInTransaction(tx, f.ref, f.certificateId, operation, 'claim');
  expect(phaseCheck).toHaveBeenCalledWith(tx, f.ref, f.certificate, operation, 'claim');
  expect(f.assertExecution).toHaveBeenCalledWith(f.ref, tx);
  expect(f.getUser).toHaveBeenCalledTimes(2);
  phaseCheck.mockImplementation(async () => {
    f.reviewer.disabled = true;
  });
  await expect(
    f.authority.authorizeCertifiedDeletionInTransaction(tx, f.ref, f.certificateId, operation, 'replay')
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('missing certified phase validator and unrelated operations never authorize a delete transaction', async () => {
  const f = setup(),
    tx: any = { get: (reference: any) => reference.get() },
    operation = { ...f.operation, kind: 'provider_delete', method: 'DELETE' };
  await expect(
    f.authority.authorizeCertifiedDeletionInTransaction(tx, f.ref, f.certificateId, operation, 'claim')
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  const validator = jest.fn(),
    allowed = setup(undefined, validator);
  await expect(
    allowed.authority.authorizeCertifiedDeletionInTransaction(
      tx,
      allowed.ref,
      allowed.certificateId,
      allowed.operation,
      'claim'
    )
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(validator).not.toHaveBeenCalled();
});

test('a zero-effects stop certificate grants no catalog-derived destination operation', async () => {
  const derived = jest.fn(),
    phase = jest.fn(),
    f = setup(derived, phase),
    zero = { kind: 'publishing_zero_effects_stop', planId: 'b'.repeat(64), sessionId: 'c'.repeat(64) };
  f.certificate.operations.splice(0, f.certificate.operations.length, zero as any);
  f.grant.certificateDigest = digest(f.certificate);
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, zero)).resolves.toBeUndefined();
  await expect(f.authority.authorizeOperation(f.ref, f.certificateId, f.operation)).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  const tx: any = { get: (reference: any) => reference.get() };
  await expect(
    f.authority.authorizeCertifiedDeletionInTransaction(
      tx,
      f.ref,
      f.certificateId,
      { ...f.operation, kind: 'provider_delete', method: 'DELETE' },
      'claim'
    )
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(derived).not.toHaveBeenCalled();
  expect(phase).not.toHaveBeenCalled();
  await expect(
    f.authority.authorizeOperation(f.ref, f.certificateId, { ...zero, method: 'DELETE' })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});

test('partial stop grants only its exact factual operation and source-validated fixed reads', async () => {
  const membership = jest.fn(async () => {}),
    phase = jest.fn(),
    f = setup(membership, phase),
    partial = { kind: 'sermon_deletion_partial_stop', planId: 'b'.repeat(64), sessionId: 'c'.repeat(64) };
  f.certificate.operations.splice(0, f.certificate.operations.length, partial as any);
  f.grant.certificateDigest = digest(f.certificate);
  await f.authority.authorizeOperation(f.ref, f.certificateId, partial);
  await f.authority.authorizeOperation(f.ref, f.certificateId, f.operation);
  expect(membership).toHaveBeenCalledWith(f.ref, f.certificate, f.operation);
  const tx: any = { get: (reference: any) => reference.get() };
  await f.authority.authorizePartialStopInTransaction(tx, f.ref, f.certificateId, partial);
  await expect(
    f.authority.authorizePartialStopInTransaction(tx, f.ref, f.certificateId, { ...partial, planId: 'd'.repeat(64) })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  await expect(
    f.authority.authorizeOperation(f.ref, f.certificateId, {
      ...f.operation,
      kind: 'provider_delete',
      method: 'DELETE',
    })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  await expect(
    f.authority.authorizeCertifiedDeletionInTransaction(
      tx,
      f.ref,
      f.certificateId,
      { ...f.operation, kind: 'provider_delete', method: 'DELETE' },
      'claim'
    )
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(phase).not.toHaveBeenCalled();
  f.reviewer.disabled = true;
  await expect(
    f.authority.authorizePartialStopInTransaction(tx, f.ref, f.certificateId, partial)
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
