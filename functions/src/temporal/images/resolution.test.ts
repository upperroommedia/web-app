import { assertProviderMutationTransportAllowed } from '../publishing/providerTransportPolicy';
jest.mock('../publishing/providerTransportPolicy', () => ({ assertProviderMutationTransportAllowed: jest.fn() }));
import axios from 'axios';
import computeMetadataForImage from '../../computeMetadataForImage';
import {
  resolveImageAllocation,
  resolveImageDeletionReview,
  configuredImageProviderAccount,
  type ImageAllocationReview,
  type ImageDependencies,
} from './activities';
import type { ImageIntent } from './types';
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn(async () => 'private-token'),
  createAxiosConfig: jest.fn(() => ({})),
}));
jest.mock('../../computeMetadataForImage', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../storageDownloadUrl', () => ({ ensureFirebaseDownloadUrl: jest.fn() }));
const originalSubsplashEmail = process.env.SUBSPLASH_EMAIL;
afterAll(() => {
  if (originalSubsplashEmail === undefined) delete process.env.SUBSPLASH_EMAIL;
  else process.env.SUBSPLASH_EMAIL = originalSubsplashEmail;
});
const ref = { projectId: 'project', jobId: 'cleanup-job' };
interface MemorySnapshot {
  exists: boolean;
  ref: MemoryReference;
  data(): Record<string, unknown> | undefined;
  get(field: string): unknown;
}
interface MemoryReference {
  path: string;
  get(): Promise<MemorySnapshot>;
  set(value: Record<string, unknown>, options?: { merge?: boolean }): Promise<void>;
  collection(name: string): { doc(id: string): MemoryReference };
}
function harness() {
  const records = new Map<string, Record<string, unknown>>([
    ['durableJobs/cleanup-job', { generation: 3, revision: 4 }],
    [
      '_control/temporalProviderUsage',
      {
        schemaVersion: 1,
        projectId: 'project',
        epoch: 'epoch',
        status: 'ready',
        releaseId: 'release',
        controlRevision: 1,
      },
    ],
    ['temporalImageReceipts/cleanup-job', { state: 'needs_attention', sourceGeneration: '42' }],
  ]);
  const reference = (path: string): MemoryReference => ({
    path,
    get: async () => snapshot(path),
    set: async (value, options) => {
      records.set(path, { ...(options?.merge ? records.get(path) : {}), ...value });
    },
    collection: (name) => ({ doc: (id) => reference(`${path}/${name}/${id}`) }),
  });
  const snapshot = (path: string): MemorySnapshot => ({
    exists: records.has(path),
    ref: reference(path),
    data: () => records.get(path),
    get: (field: string) => records.get(path)?.[field],
  });
  const firestore = {
    doc: reference,
    collection(name: string) {
      return {
        doc(id: string) {
          return reference(`${name}/${id}`);
        },
      };
    },
    async runTransaction(handler: (tx: unknown) => Promise<unknown>) {
      let written = false;
      const writes: [string, Record<string, unknown>, boolean][] = [];
      const result = await handler({
        get: async (doc: { path: string }) => {
          expect(written).toBe(false);
          return snapshot(doc.path);
        },
        create(doc: { path: string }, value: Record<string, unknown>) {
          written = true;
          writes.push([doc.path, value, false]);
        },
        set(doc: { path: string }, value: Record<string, unknown>, options?: { merge?: boolean }) {
          written = true;
          writes.push([doc.path, value, !!options?.merge]);
        },
      });
      for (const [path, value, merge] of writes) records.set(path, { ...(merge ? records.get(path) : {}), ...value });
      return result;
    },
  };
  const payload: ImageIntent = {
    operation: 'ingest',
    imageId: 'original',
    canonicalImageId: 'original',
    originalJobId: 'old-job',
    name: 'Image',
    type: 'wide',
    source: { bucket: 'images', path: 'speaker-images/image', generation: '42', contentType: 'image/png' },
  };
  const deps = {
    firestore,
    loadIntent: async () => ({ payload }),
    assertCurrent: jest.fn(async () => undefined),
    assertCurrentInTransaction: jest.fn(async () => undefined),
  } as unknown as Pick<ImageDependencies, 'firestore' | 'loadIntent' | 'assertCurrent' | 'assertCurrentInTransaction'>;
  const review: ImageAllocationReview = {
    actorUid: 'admin',
    commandId: 'command',
    expectedGeneration: 3,
    expectedJobRevision: 4,
    assertCurrentInTransaction: jest.fn(async () => undefined),
    decision: 'retain_existing_resource',
    duplicateRiskAcknowledged: true,
    evidenceReference: 'Provider support case 123',
    reason: 'Select this verified allocation for upload',
  };
  return { records, deps, review, payload };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assertProviderMutationTransportAllowed).mockReset();
  jest.mocked(axios).mockResolvedValue({
    data: {
      id: 'remote',
      app_key: '9XTSHD',
      type: 'wide',
      content_type: 'image/png',
      _links: { presigned_upload_url: { href: 'https://upload.test/source' } },
    },
  });
});
test('intentional upload retention is fenced, audited, and idempotent after response loss', async () => {
  const { deps, review, records } = harness();
  await resolveImageAllocation(deps, ref, 'remote', review);
  await resolveImageAllocation(deps, ref, 'remote', review);
  expect(axios).toHaveBeenCalledTimes(1);
  expect(review.assertCurrentInTransaction).toHaveBeenCalledTimes(1);
  expect(records.get('temporalImageReceipts/cleanup-job')).toMatchObject({
    state: 'retained',
    remoteId: 'remote',
  });
  expect(records.get('temporalImageResolutionAudits/command')).toMatchObject({
    decision: 'retain_existing_resource',
    duplicateRiskAcknowledged: true,
    state: 'completed',
  });
});
test('a job revision changing during provider verification prevents receipt adoption', async () => {
  const { deps, review, records } = harness();
  jest.mocked(axios).mockImplementationOnce(async () => {
    records.set('durableJobs/cleanup-job', { generation: 3, revision: 5 });
    return {
      data: {
        id: 'remote',
        app_key: '9XTSHD',
        type: 'wide',
        content_type: 'image/png',
        _links: { presigned_upload_url: { href: 'https://upload.test/source' } },
      },
    };
  });
  await expect(resolveImageAllocation(deps, ref, 'remote', review)).rejects.toThrow('changed during cleanup review');
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('needs_attention');
});
test('receipt changes during verification are rejected rather than overwritten', async () => {
  const { deps, review, records } = harness();
  jest.mocked(axios).mockImplementationOnce(async () => {
    records.set('temporalImageReceipts/cleanup-job', { state: 'needs_attention', sourceGeneration: '43' });
    return {
      data: {
        id: 'remote',
        app_key: '9XTSHD',
        type: 'wide',
        content_type: 'image/png',
        _links: { presigned_upload_url: { href: 'https://upload.test/source' } },
      },
    };
  });
  await expect(resolveImageAllocation(deps, ref, 'remote', review)).rejects.toThrow('changed during cleanup review');
});
test('omitted duplicate-risk acknowledgment is rejected before contacting a provider', async () => {
  const { deps, review } = harness();
  await expect(
    resolveImageAllocation(deps, ref, 'remote', {
      ...review,
      duplicateRiskAcknowledged: false,
    } as unknown as ImageAllocationReview)
  ).rejects.toThrow('Retain the shared resource');
  expect(axios).not.toHaveBeenCalled();
});
test('resolution commits receipt and durable command together without reading after writes', async () => {
  const { deps, review, records } = harness();
  review.onResolutionCommit = async (tx) => {
    const job = await tx.get(deps.firestore.collection('durableJobs').doc(ref.jobId));
    expect(job.get('revision')).toBe(4);
    tx.set(deps.firestore.collection('durableJobCommands').doc('command'), { state: 'pending', action: 'resolve' });
  };
  await resolveImageAllocation(deps, ref, 'remote', review);
  expect(records.get('durableJobCommands/command')?.state).toBe('pending');
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('retained');
});
test('a rejected final command guard rolls back receipt and private audit together', async () => {
  const { deps, review, records } = harness();
  review.onResolutionCommit = async () => {
    throw new Error('command no longer permitted');
  };
  await expect(resolveImageAllocation(deps, ref, 'remote', review)).rejects.toThrow('command no longer permitted');
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('needs_attention');
  expect(records.has('temporalImageResolutionAudits/command')).toBe(false);
});
test('cleanup retention seals a permanent provider binding and cannot unlock DELETE', async () => {
  const { deps, records, payload, review } = harness();
  payload.operation = 'reconcile';
  records.set('temporalImageReceipts/cleanup-job', {
    state: 'needs_attention',
    remoteId: 'remote',
    sourceGeneration: '42',
  });
  records.set('_control/temporalProviderUsage', {
    schemaVersion: 1,
    projectId: 'project',
    epoch: 'epoch',
    status: 'ready',
    releaseId: 'release',
    controlRevision: 1,
  });
  await resolveImageDeletionReview(deps, ref, { ...review, remoteId: 'remote', decision: 'retain_existing_resource' });
  expect(axios).not.toHaveBeenCalled();
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('retained');
  expect(records.get('temporalImageResourceRetentions/command')).toMatchObject({
    decision: 'retain_existing_resource',
    remoteId: 'remote',
    receiptFingerprint: expect.any(String),
  });
  expect([...records.keys()].filter((path) => path.includes('/edges/'))).toHaveLength(1);
});
test('risk acknowledgment and evidence cannot authorize shared-image deletion', async () => {
  const { deps, payload, review, records } = harness();
  payload.operation = 'reconcile';
  await expect(
    resolveImageAllocation(deps, ref, 'remote', { ...review, decision: 'adopt_existing_resource' })
  ).rejects.toThrow('forced deletion is unavailable');
  expect(axios).not.toHaveBeenCalled();
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('needs_attention');
});
test('absence review refuses an unbound original account and a different fixed ID', async () => {
  const { deps, payload, review, records } = harness();
  payload.operation = 'reconcile';
  records.set('temporalImageReceipts/cleanup-job', { state: 'needs_attention', remoteId: 'remote' });
  await expect(
    resolveImageDeletionReview(deps, ref, {
      ...review,
      remoteId: 'remote',
      decision: 'confirm_existing_resource_absent',
    })
  ).rejects.toThrow('original account');
  await expect(
    resolveImageDeletionReview(deps, ref, { ...review, remoteId: 'other', decision: 'retain_existing_resource' })
  ).rejects.toThrow('sealed image identity');
  expect(axios).not.toHaveBeenCalled();
});
test('authenticated fixed-ID404 under the sealed original account confirms absence without mutation', async () => {
  const { deps, payload, review, records } = harness();
  payload.operation = 'reconcile';
  process.env.SUBSPLASH_EMAIL = 'images-tests@example.invalid';
  records.set('temporalImageReceipts/cleanup-job', {
    state: 'needs_attention',
    remoteId: 'remote',
    providerAccount: configuredImageProviderAccount(),
  });
  jest.mocked(axios).mockResolvedValueOnce({ status: 404 });
  await resolveImageDeletionReview(deps, ref, {
    ...review,
    remoteId: 'remote',
    decision: 'confirm_existing_resource_absent',
  });
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('cleaned');
  expect(axios).toHaveBeenCalledTimes(1);
});

describe('immutable late allocation acknowledgements', () => {
  const claim = { claimId: 'claim-1', fingerprint: 'immutable-source-fingerprint' };
  it('preserves the selected retained resource and journals a distinct original response exactly once', async () => {
    const { recordImageAllocationAcknowledgement } = await import('./activities');
    const { deps, records, payload } = harness();
    records.set('temporalImageReceipts/cleanup-job', {
      state: 'retained',
      remoteId: 'selected-existing',
      reviewCommandId: 'review',
      allocationClaim: claim,
      originalAllocationStatus: 'unknown',
    });
    const result = { remoteId: 'actual-original', uploadUrl: 'https://private.invalid/upload' };
    expect(await recordImageAllocationAcknowledgement(deps.firestore, ref, claim, payload, result)).toBe(
      'review_required'
    );
    expect(
      await recordImageAllocationAcknowledgement(
        deps.firestore,
        { jobId: ref.jobId, projectId: ref.projectId },
        claim,
        payload,
        result
      )
    ).toBe('review_required');
    const receipt = records.get('temporalImageReceipts/cleanup-job')!;
    expect(receipt.remoteId).toBe('selected-existing');
    expect(receipt.uploadUrl).toBeUndefined();
    expect(receipt.originalAllocationStatus).toBe('acknowledged');
    const acknowledgements = [...records.entries()].filter(([path]) =>
      path.startsWith('temporalImageAllocationAcknowledgements/')
    );
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0][1]).toMatchObject({
      disposition: 'additional_original_allocation',
      remoteId: 'actual-original',
      source: 'authenticated_post_response',
    });
    expect(acknowledgements[0][1].uploadUrl).toBeUndefined();
    expect(receipt.additionalAcknowledgements).toEqual({
      [acknowledgements[0][0].split('/')[1]]: {
        jobId: acknowledgements[0][1].reconciliationJobId,
        remoteId: 'actual-original',
      },
    });
  });
  it('records a positive provider fact despite missing release/index readiness', async () => {
    const { recordImageAllocationAcknowledgement, ensureImageAcknowledgementReview } = await import('./activities');
    const { deps, records, payload } = harness();
    records.delete('_control/temporalProviderUsage');
    records.set('durableJobIntents/cleanup-job', { payload });
    records.set('temporalImageReceipts/cleanup-job', {
      state: 'retained',
      remoteId: 'selected-existing',
      reviewCommandId: 'review',
      allocationClaim: claim,
    });
    await recordImageAllocationAcknowledgement(deps.firestore, ref, claim, payload, {
      remoteId: 'actual-original',
      uploadUrl: 'https://private.invalid/upload',
    });
    const factPath = [...records.keys()].find((path) => path.startsWith('temporalImageAllocationAcknowledgements/'))!;
    const immutableFact = records.get(factPath);
    await expect(ensureImageAcknowledgementReview(deps.firestore, ref, factPath.split('/')[1])).rejects.toThrow();
    expect(records.get(factPath)).toEqual(immutableFact);
    expect(records.get('temporalImageReceipts/cleanup-job')?.remoteId).toBe('selected-existing');
  });
  it('rejects an ACK not associated with the immutable allocation claim', async () => {
    const { recordImageAllocationAcknowledgement } = await import('./activities');
    const { deps, records, payload } = harness();
    records.set('temporalImageReceipts/cleanup-job', { state: 'allocating', allocationClaim: claim });
    await expect(
      recordImageAllocationAcknowledgement(deps.firestore, ref, { ...claim, claimId: 'different' }, payload, {
        remoteId: 'remote',
        uploadUrl: 'https://private.invalid/upload',
      })
    ).rejects.toThrow('immutable allocation claim');
    expect([...records.keys()].filter((path) => path.startsWith('temporalImageAllocationAcknowledgements/'))).toEqual(
      []
    );
  });
});

test('control projection requires an exact child identity and sealed absence proof before closing retained ingest', async () => {
  const { createImageControlActivities } = await import('./activities');
  const { deps, records } = harness();
  records.set('temporalImageReceipts/cleanup-job', {
    state: 'retained',
    remoteId: 'selected',
    additionalAcknowledgements: { ack: { jobId: 'child', remoteId: 'original' } },
  });
  const control = createImageControlActivities({ ...deps, project: jest.fn(async () => undefined) });
  records.set('temporalImageReceipts/child', { state: 'cleaned', remoteId: 'original' });
  expect(await control.getImageDisposition(ref)).toBe('additional_review');
  const account = { appKey: '9XTSHD', principalHash: 'sealed-principal' };
  records.set('temporalImageReceipts/child', {
    state: 'cleaned',
    remoteId: 'original',
    originalJobId: ref.jobId,
    sourceAcknowledgementId: 'ack',
    providerAccount: account,
    absenceProof: {
      source: 'authenticated_fixed_id_404',
      remoteId: 'original',
      providerAccount: account,
      verifiedAt: 1,
    },
  });
  expect(await control.getImageDisposition(ref)).toBe('retained');
});

test('a late POST response during operator retention remains an additional-review failure and never replaces the selected receipt', async () => {
  const { MockActivityEnvironment } = await import('@temporalio/testing');
  const { createImageActivities } = await import('./activities');
  const { deps, records } = harness();
  records.delete('temporalImageReceipts/cleanup-job');
  jest.mocked(axios).mockImplementationOnce(async () => {
    const allocated = records.get('temporalImageReceipts/cleanup-job')!;
    records.set('temporalImageReceipts/cleanup-job', {
      ...allocated,
      state: 'retained',
      remoteId: 'selected',
      reviewCommandId: 'operator-review',
    });
    return {
      data: {
        id: 'actual-original',
        _links: { presigned_upload_url: { href: 'https://private.invalid/own-allocation' } },
      },
    };
  });
  const activities = createImageActivities({
    ...deps,
    loadJob: async () => ({ steps: [] }),
    recordStep: async () => undefined,
    project: async () => undefined,
    storage: { bucket: () => ({ file: () => ({}) }) },
  } as unknown as ImageDependencies);
  await expect(new MockActivityEnvironment().run(activities.allocateImage, ref)).rejects.toMatchObject({
    type: 'ImageAdditionalAllocationReview',
    nonRetryable: true,
  });
  expect(records.get('temporalImageReceipts/cleanup-job')).toMatchObject({
    state: 'retained',
    remoteId: 'selected',
    originalAllocationStatus: 'acknowledged',
  });
  expect(axios).toHaveBeenCalledTimes(1);
  expect(axios).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
});

for (const activityName of ['allocateImage', 'uploadImageBytes'] as const) {
  test(`${activityName} rejects denied provider transport before any source or signed URL effect`, async () => {
    const { MockActivityEnvironment } = await import('@temporalio/testing');
    const { createImageActivities } = await import('./activities');
    const { deps, records } = harness();
    const before = records.get('temporalImageReceipts/cleanup-job');
    const bucket = jest.fn();
    jest.mocked(assertProviderMutationTransportAllowed).mockImplementation(() => {
      throw new Error('Staging writes require verified isolated account');
    });
    const activities = createImageActivities({
      ...deps,
      loadJob: async () => ({ steps: [] }),
      recordStep: async () => undefined,
      project: async () => undefined,
      storage: { bucket },
    } as unknown as ImageDependencies);
    await expect(new MockActivityEnvironment().run(activities[activityName], ref)).rejects.toMatchObject({
      type: 'ProviderAccountIsolationRequired',
      nonRetryable: true,
    });
    expect(assertProviderMutationTransportAllowed).toHaveBeenCalledWith('subsplash');
    expect(axios).not.toHaveBeenCalled();
    expect(bucket).not.toHaveBeenCalled();
    expect(records.get('temporalImageReceipts/cleanup-job')).toEqual(before);
  });
}

test('signed image PUT disables redirects so a provider redirect cannot replay the same bytes', async () => {
  const { MockActivityEnvironment } = await import('@temporalio/testing');
  const { writeFile } = await import('node:fs/promises');
  const { createImageActivities } = await import('./activities');
  const { deps, records } = harness();
  records.set('temporalImageReceipts/cleanup-job', {
    state: 'allocated',
    remoteId: 'own-allocation',
    uploadUrl: 'https://signed.invalid/own-allocation',
  });
  jest
    .mocked(computeMetadataForImage)
    .mockResolvedValue({ width: 10, height: 10, averageColorHex: '#000000', vibrantColorHex: '#000000' });
  const download = jest.fn(async ({ destination }: { destination: string }) =>
    writeFile(destination, Buffer.from('owned-source'))
  );
  const activities = createImageActivities({
    ...deps,
    loadJob: async () => ({ steps: [] }),
    recordStep: async () => undefined,
    project: async () => undefined,
    storage: { bucket: () => ({ file: () => ({ download }) }) },
  } as unknown as ImageDependencies);
  await new MockActivityEnvironment().run(activities.uploadImageBytes, ref);
  expect(axios).toHaveBeenCalledTimes(1);
  expect(axios).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://signed.invalid/own-allocation',
      method: 'PUT',
      maxRedirects: 0,
    })
  );
  expect(records.get('temporalImageReceipts/cleanup-job')?.state).toBe('uploaded');
});
