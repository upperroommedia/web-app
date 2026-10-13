import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
let mockDb: Firestore;
let mockProjectId: string;
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: mockProjectId } }) },
}));
import { executeProviderCreate, providerReceiptId, PROVIDER_RECEIPTS_COLLECTION } from './providerReceipts';
import { runDurablePublishingOperation } from './durableOperationContext';
import {
  prepareCriticalRepairCatalogSourceSeal,
  assertV1PublishingSourceProducerBarrier,
} from './criticalRepairCatalog';
import { PUBLISHING_SOURCE_PROTOCOL } from '@upperroom/orchestration/job-store';
const dedicated = process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':18081') ? describe : describe.skip;
dedicated('actual create first-claim versus source catalog freeze', () => {
  let app: App;
  beforeAll(() => {
    app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'urm-app' }, `source-claim-${randomUUID()}`);
    mockDb = getFirestore(app);
    mockProjectId = app.options.projectId!;
  });
  afterAll(async () => {
    await deleteApp(app);
  });
  const fixture = async () => {
    const jobId = `source-claim-${randomUUID()}`,
      ref = { projectId: mockProjectId, jobId },
      workflowId = `workflow-${jobId}`;
    await mockDb.doc(`durableJobIntents/${jobId}`).set({
      schemaVersion: 1,
      ...ref,
      kind: 'sermon.publish',
      entity: { type: 'sermon', id: jobId },
      actorUid: 'synthetic-source-claim',
      generation: 1,
      payload: {},
      publishingSourceProtocol: PUBLISHING_SOURCE_PROTOCOL,
    });
    await mockDb.doc(`durableJobs/${jobId}`).set({ ...ref, generation: 1, workflowId, state: 'running' });
    await mockDb
      .doc(`durableJobCriticalSections/${jobId}`)
      .set({ schemaVersion: 1, ...ref, generation: 1, workflowId, reasonCode: 'SOURCE_CLAIM_TEST', revision: 1 });
    const seal = () =>
      mockDb.runTransaction(async (tx) => {
        const prepared = await prepareCriticalRepairCatalogSourceSeal(tx, mockDb, ref, (current) =>
          assertV1PublishingSourceProducerBarrier(current, mockDb, ref)
        );
        prepared.commit();
      });
    const options = {
      operationKey: `durable:${ref.projectId}:${ref.jobId}:create`,
      step: 'soundcloud-track',
      payload: { title: 'Synthetic fixture' },
      getProviderAccount: () => ({ provider: 'soundcloud' as const, account: 'soundcloud:users:1' }),
    };
    return { ref, seal, options };
  };
  test('a seal between preparation and first claim prevents POST and leaves the receipt prepared', async () => {
    const f = await fixture(),
      execute = jest.fn().mockResolvedValue({ id: 'track-test' });
    await expect(
      runDurablePublishingOperation(f.ref.jobId, () =>
        executeProviderCreate({ ...f.options, prepare: f.seal, execute })
      )
    ).rejects.toMatchObject({ details: { code: 'PUBLISHING_SOURCE_CLAIMS_FROZEN' } });
    expect(execute).not.toHaveBeenCalled();
    const receipt = await mockDb
      .collection(PROVIDER_RECEIPTS_COLLECTION)
      .doc(providerReceiptId(f.options.operationKey, f.options.step))
      .get();
    expect(receipt.get('state')).toBe('prepared');
  });
  test('a previously claimed positive completion is retained after seal and cached replay sends nothing', async () => {
    const f = await fixture();
    let started!: () => void, complete!: (value: { id: string }) => void;
    const entered = new Promise<void>((resolve) => {
        started = resolve;
      }),
      reply = new Promise<{ id: string }>((resolve) => {
        complete = resolve;
      });
    const execute = jest.fn(async () => {
      started();
      return reply;
    });
    const running = runDurablePublishingOperation(f.ref.jobId, () => executeProviderCreate({ ...f.options, execute }));
    await entered;
    await f.seal();
    complete({ id: 'track-test' });
    await expect(running).resolves.toEqual({ id: 'track-test' });
    await expect(
      runDurablePublishingOperation(f.ref.jobId, () => executeProviderCreate({ ...f.options, execute }))
    ).resolves.toEqual({ id: 'track-test' });
    expect(execute).toHaveBeenCalledTimes(1);
    const next = jest.fn().mockResolvedValue({ id: 'another-track' });
    await expect(
      runDurablePublishingOperation(f.ref.jobId, () =>
        executeProviderCreate({ ...f.options, operationKey: f.options.operationKey + '-second', execute: next })
      )
    ).rejects.toMatchObject({ details: { code: 'PUBLISHING_SOURCE_CLAIMS_FROZEN' } });
    expect(next).not.toHaveBeenCalled();
  });
});
