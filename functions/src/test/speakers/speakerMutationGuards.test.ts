const mockEvents: string[] = [];
let mockAlreadyCommitted = false;
let mockOperation: string | undefined = 'speaker-plan';
let mockSpeaker: Record<string, unknown> | undefined;
let mockList: Record<string, unknown> | undefined;
let mockSermonDocs: Array<{ ref: { path: string }; data: () => Record<string, unknown> }> = [];
const mockFrozenPlans: Array<Record<string, unknown>> = [];
const mockTx = {
  set: jest.fn(() => mockEvents.push('write')),
  delete: jest.fn(() => mockEvents.push('write')),
  update: jest.fn(() => mockEvents.push('fanout')),
  get: async (ref: { path: string }) => ({
    ref,
    exists:
      ref.path === 'speakers/speaker' ? Boolean(mockSpeaker) : ref.path === 'lists/list' ? Boolean(mockList) : true,
    data: () =>
      ref.path === 'speakers/speaker'
        ? mockSpeaker
        : ref.path === 'lists/list'
        ? mockList
        : mockSermonDocs.find((doc) => doc.ref.path === ref.path)?.data(),
  }),
};
const mockGet = async () => ({ exists: Boolean(mockSpeaker), data: () => mockSpeaker });
const mockCollection = {
  withConverter() {
    return this;
  },
  doc: () => ({ id: 'speaker', path: 'speakers/speaker', get: mockGet }),
  get: async () => ({ docs: [] }),
};
const mockListCollection = {
  withConverter() {
    return this;
  },
  doc: () => ({
    id: 'list',
    path: 'lists/list',
    get: async () => ({ exists: Boolean(mockList), data: () => mockList }),
  }),
};
const mockDb = {
  collection: (name: string) =>
    name === 'sermons'
      ? { get: async () => ({ docs: mockSermonDocs }) }
      : name === 'lists'
      ? mockListCollection
      : mockCollection,
  batch: () => ({ delete: jest.fn(), update: jest.fn(), commit: jest.fn() }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb },
}));
jest.mock('../../temporal/publishing/durableOperationContext', () => ({
  markPublishingCritical: jest.fn(),
  getPublishingMutationOperation: () => mockOperation,
  isDurablePublishingOperation: () => true,
  prepareAcknowledgedProjectionPlan: jest.fn(async (_tx: unknown, plan: Record<string, unknown>) => {
    mockFrozenPlans.push(plan);
    return { projectionDigest: 'proof', commit: () => {} };
  }),
  publishingMutationRequestFingerprint: () => 'fingerprint',
  prepareProviderMutationPlanCommit: jest.fn(async () => {
    mockEvents.push('prepare');
    return { alreadyCommitted: mockAlreadyCommitted, commit: () => mockEvents.push('commit') };
  }),
  runPublishingProviderMutation: async (request: { send: () => Promise<{ completion: string; result?: unknown }> }) => {
    const completion = await request.send();
    if (completion.completion === 'rejected_no_effect') throw new Error('PROVIDER_MUTATION_REJECTED_NO_EFFECT');
    return completion.result;
  },
  runDurableTransaction: async (_db: unknown, callback: (tx: unknown) => Promise<void>) => callback(mockTx),
  commitDurableProjection: async (callback: (tx: unknown) => Promise<void>) => callback(mockTx),
}));
jest.mock('../../temporal/publishing/providerAssociations', () => ({ reserveSubsplashAssociation: jest.fn() }));
jest.mock('../../temporal/publishing/providerReceipts', () => ({
  providerPayloadFingerprint: () => 'hash',
  providerReceiptId: () => 'receipt',
}));
jest.mock('../../firestoreDataConverter', () => ({
  firestoreAdminListConverter: {},
  firestoreAdminSpeakerConverter: {},
}));
jest.mock('../../createNewSubsplashList', () => ({ createNewSubsplashList: jest.fn() }));
jest.mock('../../helpers/speakerDeletionMirrors', () => ({
  prepareSpeakerDeletionMirrors: jest.fn(async (_db: unknown, input: { speakerId: string; tagId: string }) => {
    mockFrozenPlans.push({
      completesActivity: false,
      writes: [
        {
          path: `speakers/${input.speakerId}`,
          expectedFields: { tagId: input.tagId },
          patch: {},
          deleteFields: ['tagId'],
        },
      ],
      verifications: [{ expectedState: 'absent', expectedProviderFields: {} }],
    });
    return { ...input, planId: 'mirror-plan' };
  }),
  removeSpeakerDeletionMirrors: jest.fn(async () => ({
    sermonsUpdated: 0,
    listMirrorsUpdated: 0,
    seriesMirrorsUpdated: 0,
  })),
}));
jest.mock('../../helpers/deleteLogicalListChain', () => ({ deleteLogicalListChain: jest.fn() }));
jest.mock('../../helpers/listOverflowChain', () => ({ buildRootListMetadata: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: async (_key: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'token',
  createAxiosConfig: (url: string, _token: string, method: string, data: unknown) => ({ url, method, data }),
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: jest.fn(),
  isAxiosError: (error: { isAxiosError?: boolean }) => error?.isAxiosError === true,
}));
import axios from 'axios';
import { createSpeakerMutation, updateSpeakerMutation, deleteSpeakerMutation } from '../../speakers/speakerMutations';
import { removeSpeakerDeletionMirrors } from '../../helpers/speakerDeletionMirrors';
import { deleteLogicalListChain } from '../../helpers/deleteLogicalListChain';
import { prepareProviderMutationPlanCommit } from '../../temporal/publishing/durableOperationContext';
import type { CreateSpeakerCallableInputType } from '../../speakers/createSpeakerTypes';
const square = { id: 'image', type: 'square', subsplashId: 'remote-image', downloadLink: 'https://example.test/image' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockSermonDocs = [];
  mockFrozenPlans.length = 0;
  mockAlreadyCommitted = false;
  mockOperation = 'speaker-plan';
  mockSpeaker = { id: 'speaker', name: 'Name', images: [square], sermonCount: 0 };
  mockList = { id: 'list', name: 'Name', images: [square], subsplashId: 'remote-list' };
  jest.mocked(axios).mockResolvedValue({ status: 200, data: { id: 'tag' } });
});

it.each(['create', 'update', 'delete'])('settles %s only after final canonical writes', async (operation) => {
  if (operation === 'create') {
    mockSpeaker = undefined;
    await createSpeakerMutation({
      speaker: { name: 'Name', images: [square] },
    } as unknown as CreateSpeakerCallableInputType);
  }
  if (operation === 'update') await updateSpeakerMutation({ speakerId: 'speaker', patch: { description: 'Updated' } });
  if (operation === 'delete') await deleteSpeakerMutation({ speakerId: 'speaker' });
  expect(mockEvents).toEqual(['prepare', 'write', 'commit']);
});

it.each(['create', 'update', 'delete'])(
  'skips %s canonical writes when the provider plan is already committed',
  async (operation) => {
    mockAlreadyCommitted = true;
    if (operation === 'create') {
      mockSpeaker = undefined;
      await createSpeakerMutation({
        speaker: { name: 'Name', images: [square] },
      } as unknown as CreateSpeakerCallableInputType);
    }
    if (operation === 'update')
      await updateSpeakerMutation({ speakerId: 'speaker', patch: { description: 'Updated' } });
    if (operation === 'delete') await deleteSpeakerMutation({ speakerId: 'speaker' });
    expect(mockEvents).toEqual(['prepare']);
    expect(mockTx.set).not.toHaveBeenCalled();
  }
);

it('preserves legacy writes with no active provider plan', async () => {
  mockOperation = undefined;
  await updateSpeakerMutation({ speakerId: 'speaker', patch: { description: 'Updated' } });
  expect(prepareProviderMutationPlanCommit).not.toHaveBeenCalled();
  expect(mockEvents).toEqual(['write']);
});

it('seals original tag DELETE 404 as no-effect before independently verifying and projecting absence', async () => {
  mockSpeaker!.tagId = 'remote-tag';
  jest.mocked(axios).mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
  await expect(deleteSpeakerMutation({ speakerId: 'speaker' })).resolves.toMatchObject({
    status: 'success',
    tagDeleted: true,
  });
  expect(removeSpeakerDeletionMirrors).toHaveBeenCalledTimes(1);
  expect(mockEvents).toEqual(['prepare', 'write', 'commit']);
});

it('does not turn an ambiguous non-404 delete into canonical success', async () => {
  mockSpeaker!.tagId = 'remote-tag';
  const failure = { isAxiosError: true, response: { status: 400, data: { errors: [{ code: 'resource_not_found' }] } } };
  jest.mocked(axios).mockRejectedValue(failure);
  await expect(deleteSpeakerMutation({ speakerId: 'speaker' })).rejects.toBe(failure);
  expect(mockEvents).toEqual([]);
});

it.each([undefined, false])('preserves an associated list without explicit deletion approval: %p', async (flag) => {
  mockSpeaker!.listId = 'shared-list';
  await expect(deleteSpeakerMutation({ speakerId: 'speaker', deleteAssociatedList: flag })).resolves.toMatchObject({
    listDeleted: false,
  });
  expect(deleteLogicalListChain).not.toHaveBeenCalled();
});
it('deletes the associated list when explicitly approved', async () => {
  mockSpeaker!.listId = 'list';
  jest
    .mocked(deleteLogicalListChain)
    .mockResolvedValue({ rootListId: 'list', rootSubsplashListId: 'remote-list' } as never);
  await expect(deleteSpeakerMutation({ speakerId: 'speaker', deleteAssociatedList: true })).resolves.toMatchObject({
    listDeleted: true,
  });
  expect(deleteLogicalListChain).toHaveBeenCalledTimes(1);
});

it('canonical speaker IDs prevent removal of different speakers sharing names or legacy tags', async () => {
  const candidates = [
    { id: 'another', name: 'Name', tagId: 'shared-tag' },
    { id: 'speaker', name: 'Old name', tagId: 'old-tag' },
    { name: 'Name' },
  ];
  mockSermonDocs = [{ ref: { path: 'sermons/s' }, data: () => ({ speakers: candidates }) }];
  await deleteSpeakerMutation({ speakerId: 'speaker' });
  expect(mockTx.update).toHaveBeenCalledWith(
    { path: 'sermons/s' },
    expect.objectContaining({ speakers: [candidates[0]] })
  );
  expect(mockEvents).toEqual(['fanout', 'prepare', 'write', 'commit']);
});

it.each([202, undefined])(
  'does not commit canonical speaker state for an unverified tag PATCH HTTP %p',
  async (status) => {
    mockSpeaker!.tagId = 'tag';
    jest.mocked(axios).mockResolvedValue({ status, data: { id: 'tag' } });
    await expect(updateSpeakerMutation({ speakerId: 'speaker', patch: { description: 'Updated' } })).rejects.toThrow(
      'PROVIDER_MUTATION_COMPLETION_UNCONFIRMED'
    );
    expect(mockEvents).toEqual([]);
  }
);
it.each([202, undefined])(
  'does not commit canonical speaker deletion for an unverified tag DELETE HTTP %p',
  async (status) => {
    mockSpeaker!.tagId = 'tag';
    jest.mocked(axios).mockResolvedValue({ status, data: { id: 'tag' } });
    await expect(deleteSpeakerMutation({ speakerId: 'speaker' })).rejects.toThrow(
      'PROVIDER_MUTATION_COMPLETION_UNCONFIRMED'
    );
    expect(mockEvents).toEqual([]);
    expect(removeSpeakerDeletionMirrors).not.toHaveBeenCalled();
  }
);

it('freezes a server-resolved speaker metadata patch before tag PATCH and marks it as partial factual projection', async () => {
  mockSpeaker!.tagId = 'tag';
  jest.mocked(axios).mockImplementation(async () => {
    expect(mockFrozenPlans).toHaveLength(1);
    return { status: 200, data: { id: 'tag' } };
  });
  await updateSpeakerMutation({ speakerId: 'speaker', patch: { description: 'New description' } });
  expect(mockFrozenPlans[0]).toMatchObject({
    completesActivity: false,
    requests: [{ method: 'PATCH', target: { resourceId: 'tag', resourceType: 'tag' } }],
    writes: [
      {
        path: 'speakers/speaker',
        expectedFields: { tagId: 'tag' },
        patch: { name: 'Name', description: 'New description' },
      },
    ],
  });
});
it('freezes only factual tag unlink for tag DELETE, never the whole desired speaker deletion', async () => {
  mockSpeaker!.tagId = 'tag';
  jest.mocked(axios).mockImplementation(async () => {
    expect(mockFrozenPlans).toHaveLength(1);
    return { status: 204, data: null };
  });
  await deleteSpeakerMutation({ speakerId: 'speaker' });
  expect(mockFrozenPlans[0]).toMatchObject({
    completesActivity: false,
    writes: [{ path: 'speakers/speaker', expectedFields: { tagId: 'tag' }, patch: {}, deleteFields: ['tagId'] }],
    verifications: [{ expectedState: 'absent', expectedProviderFields: {} }],
  });
});

it('freezes the exact canonical associated-list mirror before its PATCH', async () => {
  mockSpeaker!.listId = 'list';
  jest.mocked(axios).mockImplementation(async () => {
    expect(mockFrozenPlans).toHaveLength(1);
    return { status: 200, data: { id: 'remote-list' } };
  });
  await updateSpeakerMutation({ speakerId: 'speaker', patch: { name: 'Renamed' } });
  expect(mockFrozenPlans[0]).toMatchObject({
    completesActivity: false,
    requests: [{ method: 'PATCH', target: { resourceType: 'list', resourceId: 'remote-list' } }],
    writes: expect.arrayContaining([
      expect.objectContaining({ path: 'lists/list', patch: { name: 'Renamed', images: [square] } }),
    ]),
  });
});
it('a square-tag acknowledgement does not freeze unrelated desired wide-image changes', async () => {
  mockSpeaker!.tagId = 'tag';
  const oldWide = { ...square, id: 'old-wide', type: 'wide', subsplashId: 'old-remote-wide' };
  const newWide = { ...square, id: 'new-wide', type: 'wide', subsplashId: 'new-remote-wide' };
  mockSpeaker!.images = [square, oldWide];
  await updateSpeakerMutation({ speakerId: 'speaker', patch: { images: [square, newWide] as never } });
  expect(mockFrozenPlans[0]).toMatchObject({ writes: [{ patch: { images: [oldWide, square] } }] });
});

it('full desired speaker images require both the actual tag and associated-list ACK steps', async () => {
  mockSpeaker!.tagId = 'tag';
  mockSpeaker!.listId = 'list';
  const oldWide = { ...square, id: 'old-wide', type: 'wide', subsplashId: 'old-remote-wide' };
  const newWide = { ...square, id: 'new-wide', type: 'wide', subsplashId: 'new-remote-wide' };
  mockSpeaker!.images = [square, oldWide];
  await updateSpeakerMutation({ speakerId: 'speaker', patch: { images: [square, newWide] as never } });
  expect(mockFrozenPlans).toHaveLength(2);
  expect(mockFrozenPlans[0]).toMatchObject({ writes: [{ patch: { images: [oldWide, square] } }] });
  expect(mockFrozenPlans[1]).toMatchObject({
    writes: [
      expect.anything(),
      {
        path: 'speakers/speaker',
        requiredSteps: ['speaker-tag-patch:tag:hash', 'syncSubsplashSpeakerListRemote:remote-list:hash'],
        patch: { images: [square, newWide] },
      },
    ],
  });
});
