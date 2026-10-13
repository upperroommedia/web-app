jest.mock('../../helpers/sermonDeletionPartialStop', () => ({
  SERMON_DELETION_PARTIAL_STOPS: 'temporalSermonDeletionPartialStops',
  validateSermonDeletionPartialStopEvidence: jest.fn(async () => {}),
}));
jest.mock('./publishingZeroEffectsStop', () => ({
  PUBLISHING_ZERO_EFFECTS_STOPS: 'temporalPublishingZeroEffectsStops',
  validatePublishingZeroEffectsStopEvidence: jest.fn(async () => {}),
}));
import type { Firestore } from 'firebase-admin/firestore';
jest.mock('./criticalRepair', () => ({
  publishingCriticalRepairDigest: (value: unknown) =>
    jest.requireActual('./criticalRepairCatalog').criticalRepairCatalogDigest(value),
}));
jest.mock('./criticalRepairCatalog', () => ({
  ...jest.requireActual('./criticalRepairCatalog'),
  readCriticalRepairCatalogStepAuthority: async (tx: any, db: any, _ref: any, pinned: any) => {
    const root = (await tx.get(db.doc('catalog'))).data();
    if (
      root.ready !== true ||
      jest.requireActual('./criticalRepairCatalog').criticalRepairCatalogDigest(root) !==
        jest.requireActual('./criticalRepairCatalog').criticalRepairCatalogDigest(pinned)
    )
      throw Error('PUBLISHING_CRITICAL_STEP_AUTHORITY_REQUIRED');
    return root;
  },
}));
jest.mock('./localSermonDeletionRepair', () => ({
  ...jest.requireActual('./localSermonDeletionRepair'),
  validateLocalSermonDeletionRepairEvidence: jest.fn(async () => {}),
}));
import type { CriticalRepairCatalogRoot } from './criticalRepairCatalog';
jest.mock('./legacySoundCloudRetention', () => ({
  loadValidatedLegacySoundCloudRetentionCertificate: async (tx: any, db: any, _ref: any, id: string) =>
    (await tx.get(db.doc('legacy/' + id))).data(),
  readLegacySoundCloudRetentionStepAuthority: async (_tx: any, _db: any, _ref: any, cert: any) => cert.stepAuthority,
}));
import { sermonDeletionMirrorPlanId } from '../../helpers/sermonDeletionMirrors';
import { readAuthoritativeCriticalRepairStepIds } from './criticalRepairStepAuthority';
import { publishingCriticalRepairDigest, type CriticalRepairCertificate } from './criticalRepair';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import { localSermonDeletionHeaderProjection } from './localSermonDeletionRepair';
const ref = { projectId: 'project', jobId: 'job' };
type Data = Record<string, any>;
function fixture() {
  const data = new Map<string, Data>(),
    reads: string[] = [];
  const intent = { ...ref, generation: 1, kind: 'sermon.delete', entity: { type: 'sermon', id: 'sermon' } };
  data.set('durableJobIntents/job', intent);
  data.set('durableJobs/job', {
    ...intent,
    workflowId: 'workflow',
    steps: [{ id: 'provider-write' }, { id: 'canonical-projection' }, { id: 'delete-local' }],
  });
  const certificate: CriticalRepairCertificate = {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    acceptedUserCancellation: false,
    intentFingerprint: publishingCriticalRepairDigest(intent),
    criticalFingerprint: 'f'.repeat(64),
    operations: [],
    sourceEvidenceDigests: [],
  };
  const db: any = {
    doc: (path: string) => ({ path }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (target: any) => {
          reads.push(target.path);
          const row = data.get(target.path);
          return {
            exists: !!row,
            data: () => row,
            get: (name: string) => name.split('.').reduce((value, key) => value?.[key], row),
          };
        },
      }),
  };
  const pin = () => {
    const digest = publishingCriticalRepairDigest(certificate);
    data.set(`temporalPublishingCriticalRepairs/${digest}`, {
      schemaVersion: 1,
      certificateId: digest,
      digest,
      certificate: structuredClone(certificate),
    });
  };
  const catalog = (ids: string[], sourceCount = 10000, parent = ref) => {
    const root: any = {
      schemaVersion: 1,
      ...ref,
      generation: 1,
      workflowId: 'workflow',
      intentDigest: certificate.intentFingerprint,
      criticalDigest: certificate.criticalFingerprint,
      acceptedUserCancellation: false,
      sourceCatalogSealDigest: 'a'.repeat(64),
      sourceCount,
      sourceCursor: sourceCount,
      sourceCursorDigest: 'b'.repeat(64),
      operationCount: sourceCount,
      pageCount: Math.ceil(sourceCount / 32),
      chainDigest: 'c'.repeat(64),
      ready: true,
      catalogId: 'd'.repeat(64),
      sourceStepIds: ids,
      sourceParentRef: parent,
    };
    data.set('catalog', root);
    certificate.catalog = structuredClone(root);
  };
  const ack = (ids: string[], parent = ref) => {
    const sessionId = 'e'.repeat(64),
      manifest = {
        schemaVersion: 2,
        ...parent,
        sessionId,
        operation: 'original',
        intentFingerprint: acknowledgedProjectionDigest(intent),
        pageCount: 1,
        requestCount: 1,
        chainDigest: 'a'.repeat(64),
        completesActivity: false,
        uiStepIds: ids,
      };
    const projectionDigest = acknowledgedProjectionDigest(manifest);
    certificate.operations.push({ kind: 'acknowledged_projection', sessionId, projectionDigest });
    certificate.sourceEvidenceDigests.push(projectionDigest);
    data.set(`temporalPublishingAcknowledgedProjections/${sessionId}`, manifest);
    return { manifest, sessionId, projectionDigest };
  };
  return { data, reads, certificate, db: db as Firestore, pin, catalog, ack };
}
it('reads an immutable 10000-source READY step summary without scanning catalogue pages', async () => {
  const f = fixture();
  f.catalog(['provider-write']);
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['provider-write']);
  expect(f.reads).toHaveLength(4);
  expect(f.reads.some((path) => path.includes('/pages/'))).toBe(false);
});
it('uses exact parent ACK roots and deduplicates explicitly recorded IDs with the READY summary', async () => {
  const f = fixture();
  f.catalog(['provider-write']);
  f.ack(['canonical-projection', 'provider-write']);
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual([
    'canonical-projection',
    'provider-write',
  ]);
  expect(f.reads.length).toBeLessThan(8);
});
it.each(['missing source IDs', 'foreign parent', 'unknown public step', 'duplicate source IDs', 'not READY'])(
  'fails closed for %s',
  async (mode) => {
    const f = fixture();
    f.catalog(['provider-write']);
    const root = f.data.get('catalog')!;
    if (mode === 'missing source IDs') delete root.sourceStepIds;
    if (mode === 'foreign parent') root.sourceParentRef = { ...ref, jobId: 'child' };
    if (mode === 'unknown public step') root.sourceStepIds = ['not-recorded'];
    if (mode === 'duplicate source IDs') root.sourceStepIds = ['provider-write', 'provider-write'];
    if (mode === 'not READY') root.ready = false;
    f.certificate.catalog = structuredClone(root) as CriticalRepairCatalogRoot;
    f.pin();
    await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow(
      'PUBLISHING_CRITICAL_STEP_AUTHORITY_REQUIRED'
    );
  }
);
it('does not infer an ACK step or accept a child manifest even when other summary IDs exist', async () => {
  const f = fixture();
  f.catalog(['provider-write']);
  f.ack([]);
  f.pin();
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
  const child = fixture();
  child.ack(['provider-write'], { ...ref, jobId: 'child' });
  child.pin();
  await expect(readAuthoritativeCriticalRepairStepIds(ref, child.certificate, child.db)).rejects.toThrow();
});
it('pins the exact immutable private certificate and current generation', async () => {
  const f = fixture();
  f.catalog(['provider-write']);
  f.pin();
  f.certificate.workflowId = 'different';
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
  const stale = fixture();
  stale.catalog(['provider-write']);
  stale.pin();
  stale.data.get('durableJobs/job')!.generation = 2;
  await expect(readAuthoritativeCriticalRepairStepIds(ref, stale.certificate, stale.db)).rejects.toThrow();
});
it('allows only the genuine committed completesActivity seal restoration, with unchanged original ACK IDs', async () => {
  const f = fixture(),
    ack = f.ack(['provider-write']);
  f.pin();
  ack.manifest.completesActivity = true;
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
  f.data.set(`temporalProviderMutationSessions/${ack.sessionId}`, { state: 'committed', scope: ref });
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['provider-write']);
  ack.manifest.uiStepIds = ['canonical-projection'];
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});
it('local zero-provider repair requires original header step authority pinned inside local evidence', async () => {
  const f = fixture(),
    planId = 'a'.repeat(64),
    header = {
      schemaVersion: 1,
      ...ref,
      planId,
      sermonId: 'sermon',
      generation: 1,
      workflowId: 'workflow',
      sourceStepIds: ['delete-local'],
      sourceParentRef: ref,
      requests: [],
      verifications: [],
      originalRoot: { title: 'Local' },
      originalRootDigest: 'b'.repeat(64),
      pointerClearRootDigest: 'b'.repeat(64),
      intentFingerprint: 'c'.repeat(64),
    };
  const digest = acknowledgedProjectionDigest(localSermonDeletionHeaderProjection(header));
  f.certificate.operations.push({ kind: 'local_sermon_delete', planId });
  f.certificate.sourceEvidenceDigests.push(digest);
  f.data.set(`temporalSermonDeletionMirrorPlans/${planId}`, header);
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['delete-local']);
  delete (header as Partial<typeof header>).sourceStepIds;
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});
it('rejects oversized or duplicated current public steps instead of expanding the whitelist', async () => {
  const f = fixture();
  f.catalog(['provider-write']);
  f.pin();
  f.data.get('durableJobs/job')!.steps = Array.from({ length: 33 }, () => ({ id: 'provider-write' }));
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});

it('legacy SC-only NoSEND requires explicit original source authority with a zero-source catalogue', async () => {
  const f = fixture(),
    sourceId = 'b'.repeat(64);
  f.catalog([], 0);
  f.certificate.operations.push({ kind: 'legacy_soundcloud_retain', certificateId: sourceId });
  f.certificate.sourceEvidenceDigests.push(sourceId);
  f.data.set('legacy/' + sourceId, { stepAuthority: { sourceParentRef: ref, sourceStepIds: ['provider-write'] } });
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['provider-write']);
  f.data.get('legacy/' + sourceId)!.stepAuthority.sourceStepIds = [];
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});

it('zero-effects stop derives only original header IDs pinned by the stop evidence', async () => {
  const f = fixture(),
    planId = 'a'.repeat(64),
    sessionId = 'b'.repeat(64),
    header = {
      schemaVersion: 1,
      ...ref,
      planId,
      sermonId: 'sermon',
      generation: 1,
      workflowId: 'workflow',
      sourceStepIds: ['provider-write'],
      sourceParentRef: ref,
      originalRoot: { subsplashId: 'remote' },
      originalRootDigest: 'c'.repeat(64),
      frozenProgramDigest: 'd'.repeat(64),
      canonicalPageCount: 1,
      immutableCanonicalCatalogDigest: 'e'.repeat(64),
    };
  const projection = {
    ...localSermonDeletionHeaderProjection(header),
    frozenProgramDigest: header.frozenProgramDigest,
    canonicalPageCount: 1,
    immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
  };
  const identity = {
    schemaVersion: 1,
    ...ref,
    planId,
    sessionId,
    generation: 1,
    workflowId: 'workflow',
    intentFingerprint: f.certificate.intentFingerprint,
    headerDigest: acknowledgedProjectionDigest(projection),
  };
  f.data.set(`temporalSermonDeletionMirrorPlans/${planId}`, header);
  f.data.set(`temporalPublishingZeroEffectsStops/${planId}`, { ...identity, state: 'prepared' });
  f.certificate.operations.push({ kind: 'publishing_zero_effects_stop', planId, sessionId });
  f.certificate.sourceEvidenceDigests.push(acknowledgedProjectionDigest(identity));
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['provider-write']);
  header.sourceStepIds = ['delete-local'];
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});

it('partial stop uses immutable original header IDs and rejects foreign or modified provenance', async () => {
  const f = fixture(),
    planId = 'a'.repeat(64),
    sessionId = 'b'.repeat(64),
    header = {
      schemaVersion: 1,
      ...ref,
      planId,
      sermonId: 'sermon',
      generation: 1,
      workflowId: 'workflow',
      sourceStepIds: ['provider_write'],
      sourceParentRef: ref,
      originalRoot: { subsplashId: 'remote' },
      originalRootDigest: 'c'.repeat(64),
      frozenProgramDigest: 'd'.repeat(64),
      canonicalPageCount: 1,
      canonicalChainDigest: 'f'.repeat(64),
      immutableCanonicalCatalogDigest: 'e'.repeat(64),
    };
  f.data.get('durableJobs/job')!.steps.push({ id: 'provider_write' });
  const projection = {
    ...localSermonDeletionHeaderProjection(header),
    destinationProgram: null,
    frozenProgramDigest: header.frozenProgramDigest,
    canonicalPageCount: 1,
    canonicalChainDigest: header.canonicalChainDigest,
    immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
  };
  const identity = {
    schemaVersion: 1,
    ...ref,
    planId,
    sessionId,
    generation: 1,
    workflowId: 'workflow',
    intentFingerprint: f.certificate.intentFingerprint,
    sermonId: 'sermon',
    headerPath: `temporalSermonDeletionMirrorPlans/${sermonDeletionMirrorPlanId(ref, 'sermon')}`,
    headerDigest: acknowledgedProjectionDigest(projection),
  };
  const saved = {
    identity,
    state: 'ready',
    immutableCatalogueDigest: '1'.repeat(64),
    effectChainDigest: '2'.repeat(64),
    canonicalPageCount: 1,
    canonicalChainDigest: '3'.repeat(64),
  };
  const { state, ...evidence } = saved;
  f.data.set(identity.headerPath, header);
  f.data.set(`temporalSermonDeletionPartialStops/${planId}`, saved);
  f.certificate.operations.push({ kind: 'sermon_deletion_partial_stop', planId, sessionId });
  f.certificate.sourceEvidenceDigests.push(acknowledgedProjectionDigest(evidence));
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual(['provider_write']);
  saved.state = 'compiling';
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
  saved.state = 'ready';
  identity.sessionId = 'f'.repeat(64);
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
  identity.sessionId = sessionId;
  header.sourceParentRef = { ...ref, jobId: 'child' };
  await expect(readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).rejects.toThrow();
});
it('runtime-compatible 100-character step IDs remain bounded to the original source whitelist', async () => {
  const f = fixture(),
    id = 'a' + '_'.repeat(99);
  f.data.get('durableJobs/job')!.steps = [{ id }];
  f.catalog([id]);
  f.pin();
  expect(await readAuthoritativeCriticalRepairStepIds(ref, f.certificate, f.db)).toEqual([id]);
});
