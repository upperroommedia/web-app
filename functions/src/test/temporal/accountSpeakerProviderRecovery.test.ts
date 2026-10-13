jest.mock('../../temporal/publishing/providerAssociations', () => ({ reserveSubsplashAssociation: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({
  logger: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (options: unknown, handler: unknown) => handler ?? options,
  HttpsError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  },
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'token',
  createAxiosConfig: (url: string, _token: string, method: string, data?: unknown) => ({ url, method, data }),
}));
jest.mock('../../soundcloudSecrets', () => ({ runWithSoundCloudAccessToken: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: string[], run: () => Promise<unknown>) => run(),
}));
jest.mock('../../firestoreDataConverter', () => ({
  firestoreAdminSpeakerConverter: {},
  firestoreAdminListConverter: {},
}));
jest.mock('../../createNewSubsplashList', () => ({ createNewSubsplashList: jest.fn() }));
jest.mock('../../helpers/deleteLogicalListChain', () => ({ deleteLogicalListChain: jest.fn() }));
jest.mock('../../helpers/listOverflowChain', () => ({ buildRootListMetadata: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn(), isAxiosError: () => false }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => {
  const records = new Map<string, Record<string, unknown>>();
  const document = (path: string) => ({
    id: path.split('/').pop(),
    path,
    get: async () => snapshot(path),
    withConverter: () => document(path),
  });
  const snapshot = (path: string) => ({
    ref: document(path),
    id: path.split('/').pop(),
    exists: records.has(path),
    data: () => records.get(path),
    get: (key: string) => records.get(path)?.[key],
  });
  const db = {
    records,
    doc: document,
    collection(path: string) {
      const collection = {
        withConverter: () => collection,
        get: async () => ({
          docs: [...records.keys()]
            .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === 2)
            .map(snapshot),
        }),
        doc(id = 'generated-doc') {
          return document(`${path}/${id}`);
        },
      };
      return collection;
    },
    async runTransaction(run: (tx: unknown) => Promise<unknown>) {
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>) => writes.push(() => records.set(ref.path, data)),
        update: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push(() => {
            if (!records.has(ref.path)) throw new Error('Missing document');
            records.set(ref.path, { ...records.get(ref.path), ...data });
          }),
        create: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push(() => {
            if (records.has(ref.path)) throw new Error('Journal already exists');
            records.set(ref.path, data);
          }),
      };
      const result = await run(tx);
      for (const write of writes) write();
      return result;
    },
  };
  return {
    __esModule: true,
    default: { firestore: () => db, app: () => ({ options: { projectId: 'urm-app-staging' } }) },
  };
});
import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { createSpeakerMutation } from '../../speakers/speakerMutations';
import { runDurablePublishingOperation } from '../../temporal/publishing/durableOperationContext';
import {
  PROVIDER_RECEIPTS_COLLECTION,
  PROVIDER_ACKNOWLEDGEMENTS_COLLECTION,
  providerReceiptId,
} from '../../temporal/publishing/providerReceipts';
import { resolvePublishingProviderReceipt } from '../../temporal/publishing/receiptResolution';
import type { ImageType } from '@upperroom/shared/types/Image';

const mockAxios = axios as unknown as jest.Mock;
const ref = { projectId: 'urm-app-staging', jobId: 'account-approval-job' };
const operationKey = `durable:${ref.projectId}:${ref.jobId}:speaker-request:request-1`;
const image: ImageType = {
  id: 'image-local',
  subsplashId: 'image-remote',
  type: 'square',
  size: 'original',
  height: 100,
  width: 100,
  downloadLink: 'https://storage.example/image',
  name: 'Speaker image',
  dateAddedMillis: 1,
};
const input = {
  operationKey,
  speaker: { name: 'Approved Speaker', images: [image], shortDescription: 'Biography', description: 'Description' },
  createSpeakerList: false,
};
const db = firebaseAdmin.firestore() as unknown as {
  records: Map<string, Record<string, unknown>>;
  runTransaction: (run: (tx: never) => Promise<void>) => Promise<void>;
};
const mutate = () =>
  runDurablePublishingOperation(
    ref.jobId,
    () => createSpeakerMutation(input, { speakerId: 'approved-speaker-local' }),
    (write) => db.runTransaction(write)
  );

describe('account speaker approval provider ambiguity recovery', () => {
  beforeEach(() => {
    db.records.clear();
    db.records.set(`durableJobs/${ref.jobId}`, {
      ...ref,
      generation: 1,
      workflowId: 'account-approval-workflow',
      kind: 'account.request_approve',
      entity: { type: 'speakerRequest', id: 'request-1' },
    });
    db.records.set(`durableJobIntents/${ref.jobId}`, {
      schemaVersion: 1,
      ...ref,
      generation: 1,
      kind: 'account.request_approve',
      entity: { type: 'speakerRequest', id: 'request-1' },
      actorUid: 'admin-1',
      payload: {},
      createdAt: 1,
    });
    jest.clearAllMocks();
  });
  it('keeps an accepted-but-lost tag POST private, blocks automatic replay, then resumes after explicit verified adoption', async () => {
    let providerCreates = 0;
    const remote = {
      id: 'tag-created-before-response-loss',
      app_key: '9XTSHD',
      type: 'speaker',
      title: input.speaker.name,
      short_description: 'Biography',
      description: 'Description',
      _embedded: { 'square-image': { id: 'image-remote', type: 'square' } },
    };
    mockAxios.mockImplementation(async (config: { method: string; url: string }) => {
      if (config.method === 'POST') {
        providerCreates += 1;
        throw new Error('Response lost after provider accepted tag');
      }
      if (config.method === 'GET' && config.url.endsWith(`/tags/${remote.id}`)) return { status: 200, data: remote };
      throw new Error(`Unexpected provider operation ${config.method}`);
    });
    await expect(mutate()).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    const receiptId = providerReceiptId(`${operationKey}:create-speaker-tag`, 'speaker-tag-create');
    expect(db.records.get(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`)).toMatchObject({
      projectId: ref.projectId,
      jobId: ref.jobId,
      state: 'needs_review',
    });
    expect(db.records.has('speakers/approved-speaker-local')).toBe(false);
    await expect(mutate()).rejects.toMatchObject({ details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' } });
    expect(providerCreates).toBe(1);
    await resolvePublishingProviderReceipt({
      receiptId,
      remoteId: remote.id,
      actorUid: 'admin-1',
      commandId: 'review-1',
      decision: 'adopt_existing_resource',
      duplicateRiskAcknowledged: true,
      evidenceReference: 'provider-audit-accepted-tag-1',
      reason: 'Adopt the selected compatible tag after reviewing the accepted provider operation.',
    });
    expect(await mutate()).toMatchObject({
      status: 'success',
      speakerId: 'approved-speaker-local',
      speaker: { tagId: remote.id },
    });
    expect(providerCreates).toBe(1);
    expect(db.records.get('speakers/approved-speaker-local')).toMatchObject({ tagId: remote.id });
  });
  it('rejects a stale worker generation before writing or dispatching a provider creation', async () => {
    mockAxios.mockResolvedValue({ status: 201, data: { id: 'must-not-be-created' } });
    await expect(
      runDurablePublishingOperation(
        ref.jobId,
        () => createSpeakerMutation(input, { speakerId: 'approved-speaker-local' }),
        async () => {
          throw new Error('Generation superseded');
        }
      )
    ).rejects.toThrow('Generation superseded');
    expect(mockAxios).not.toHaveBeenCalled();
    expect([...db.records.keys()].some((path) => path.startsWith(`${PROVIDER_RECEIPTS_COLLECTION}/`))).toBe(false);
  });
  it('rechecks the generation in the executing claim after a safe preparation record', async () => {
    const receiptId = providerReceiptId(`${operationKey}:create-speaker-tag`, 'speaker-tag-create');
    await expect(
      runDurablePublishingOperation(
        ref.jobId,
        () => createSpeakerMutation(input, { speakerId: 'approved-speaker-local' }),
        async (write) => {
          if (db.records.get(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`)?.state === 'prepared')
            throw new Error('Generation superseded before POST');
          await db.runTransaction(write);
        }
      )
    ).rejects.toThrow('Generation superseded before POST');
    expect(mockAxios).not.toHaveBeenCalled();
    expect(db.records.get(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`)?.state).toBe('prepared');
  });
  it('records a confirmed private provider fact after cancellation while canonical writes stay fenced', async () => {
    mockAxios.mockResolvedValue({ status: 201, data: { id: 'accepted-tag' } });
    await expect(
      runDurablePublishingOperation(
        ref.jobId,
        () => createSpeakerMutation(input, { speakerId: 'approved-speaker-local' }),
        async (write) => {
          if (mockAxios.mock.calls.some(([config]) => config.method === 'POST'))
            throw new Error('Generation cancelled after POST');
          await db.runTransaction(write);
        }
      )
    ).rejects.toThrow('Generation cancelled after POST');
    expect(mockAxios).toHaveBeenCalledTimes(1);
    const receiptId = providerReceiptId(`${operationKey}:create-speaker-tag`, 'speaker-tag-create');
    expect(db.records.get(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`)).toMatchObject({
      state: 'confirmed',
      result: { tagId: 'accepted-tag' },
    });
    expect(db.records.has('speakers/approved-speaker-local')).toBe(false);
  });
  it('preserves operator adoption and journals only the bounded original acknowledgement identity', async () => {
    const receiptId = providerReceiptId(`${operationKey}:create-speaker-tag`, 'speaker-tag-create');
    const path = `${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`;
    mockAxios.mockImplementation(async () => {
      const claim = db.records.get(path)!;
      db.records.set(path, {
        ...claim,
        state: 'confirmed',
        result: { tagId: 'operator-selected' },
        revision: Number(claim.revision) + 1,
        resolutionCommandId: 'review-new-resource',
      });
      return {
        status: 201,
        data: { id: 'original-post-ack', private_url: 'https://provider.example/private?token=must-not-journal' },
      };
    });
    await expect(mutate()).rejects.toMatchObject({ details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' } });
    expect(db.records.get(path)).toMatchObject({
      state: 'confirmed',
      result: { tagId: 'operator-selected' },
      resolutionCommandId: 'review-new-resource',
    });
    const facts = [...db.records.entries()].filter(([key]) =>
      key.startsWith(`${PROVIDER_ACKNOWLEDGEMENTS_COLLECTION}/`)
    );
    expect(facts).toHaveLength(1);
    expect(facts[0][0].split('/')[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(facts[0][1]).toMatchObject({
      receiptId,
      projectId: ref.projectId,
      jobId: ref.jobId,
      step: 'speaker-tag-create',
      remoteId: 'original-post-ack',
      disposition: 'orphaned',
    });
    expect(JSON.stringify(facts[0][1])).not.toContain('must-not-journal');
    expect(db.records.has('speakers/approved-speaker-local')).toBe(false);
  });
  it.each([
    ['owner', 'other-attempt'],
    ['fingerprint', 'different-payload'],
    ['jobId', 'other-job'],
    ['revision', 100],
  ])('requires exact %s before confirming an acknowledgement', async (field, changed) => {
    const receiptId = providerReceiptId(`${operationKey}:create-speaker-tag`, 'speaker-tag-create');
    const path = `${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`;
    mockAxios.mockImplementation(async () => {
      const claim = db.records.get(path)!;
      db.records.set(path, { ...claim, [field]: changed });
      return { status: 201, data: { id: 'accepted-but-stale' } };
    });
    await expect(mutate()).rejects.toMatchObject({ details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' } });
    expect(db.records.get(path)).toMatchObject({ state: 'executing', [field]: changed });
    const facts = [...db.records.entries()].filter(([key]) =>
      key.startsWith(`${PROVIDER_ACKNOWLEDGEMENTS_COLLECTION}/`)
    );
    expect(facts).toHaveLength(1);
    expect(facts[0][1]).toMatchObject({
      remoteId: 'accepted-but-stale',
      projectId: ref.projectId,
      jobId: ref.jobId,
      disposition: 'orphaned',
    });
  });
  it('rejects a configured-project mismatch even when the active job identity matches', async () => {
    await expect(
      runDurablePublishingOperation(
        ref.jobId,
        () =>
          createSpeakerMutation(
            { ...input, operationKey: `durable:foreign-project:${ref.jobId}:speaker-request:request-1` },
            { speakerId: 'approved-speaker-local' }
          ),
        (write) => db.runTransaction(write)
      )
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'The original speaker create program is unavailable or changed.',
    });
    expect(mockAxios).not.toHaveBeenCalled();
    expect([...db.records.keys()].filter((path) => !path.startsWith('durableJob'))).toEqual([]);
  });
});
