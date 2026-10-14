import type { SandboxProviderProfile } from './profile';
const profile: SandboxProviderProfile = {
  schemaVersion: 1,
  projectId: 'urm-app-staging',
  mode: 'sandbox',
  profileId: 'urm-app-staging-publishing-v1',
  version: 1,
  namespace: 'urm-app-staging-publishing-v1',
};
jest.mock(
  '@upperroom/shared/firebase/firebaseAdmin',
  () => ({
    __esModule: true,
    default: {
      firestore: () => db,
    },
  }),
  { virtual: true }
);
jest.mock(
  '@upperroom/orchestration/job-store',
  () => ({
    DURABLE_COLLECTIONS: { jobs: 'durableJobs', intents: 'durableJobIntents', entities: 'durableJobEntities' },
    durableEntityKey: () => 'entity-key',
  }),
  { virtual: true }
);
jest.mock('./profile', () => ({
  getProviderExecutionProfile: () => ({
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    mode: 'sandbox',
    profileId: 'urm-app-staging-publishing-v1',
    version: 1,
    namespace: 'urm-app-staging-publishing-v1',
  }),
  sandboxProfileDocumentPath: () => '_providerSandbox/urm-app-staging-publishing-v1',
  assertSandboxCatalogReady: (_profile: unknown, marker: any) => {
    if (marker?.state !== 'ready') throw new Error('catalog not ready');
  },
  assertMatchingSandboxProfile: (_profile: unknown, pin: any) => {
    if (pin?.mode !== 'sandbox' || pin.profileId !== 'urm-app-staging-publishing-v1' || pin.version !== 1)
      throw new Error('pin mismatch');
  },
}));
import { runSandboxOperation, sandboxResourceKey } from './store';
const root = '_providerSandbox/urm-app-staging-publishing-v1';
let documents: Map<string, any>;
const ref = (path: string): any => ({
  path,
  id: path.split('/').pop(),
  collection: (name: string) => collection(path + '/' + name),
});
const collection = (path: string): any => ({
  path,
  doc: (id: string) => ref(path + '/' + id),
  where: () => {
    throw new Error('Unexpected family scan');
  },
});
const db: any = {
  doc: ref,
  collection,
  runTransaction: async (work: Function) => {
    const draft = new Map(documents);
    let writesStarted = false;
    const tx = {
      get: async (target: any) => {
        if (writesStarted) throw new Error('Read after write');
        const data = draft.get(target.path);
        return { exists: !!data, data: () => data, get: (key: string) => data?.[key] };
      },
      set: (target: any, value: any) => {
        writesStarted = true;
        draft.set(target.path, JSON.parse(JSON.stringify(value)));
      },
      create: (target: any, value: any) => {
        writesStarted = true;
        if (draft.has(target.path)) throw new Error('Already exists');
        draft.set(target.path, JSON.parse(JSON.stringify(value)));
      },
      update: (target: any, value: any) => {
        writesStarted = true;
        if (!draft.has(target.path)) throw new Error('Missing');
        draft.set(target.path, { ...draft.get(target.path), ...value });
      },
    };
    const result = await work(tx);
    documents = draft;
    return result;
  },
};
const context = { jobId: 'job', sourceStepIds: ['upload'] };
const operation = { provider: 'subsplash', method: 'POST', path: '/files/v1/audios', context };
const body = () =>
  runSandboxOperation(profile, operation, async (store) => {
    const value = {
      schemaVersion: 1 as const,
      provider: 'subsplash' as const,
      family: 'audios',
      id: 'created',
      revision: 1,
      deleted: false,
      body: { id: 'created' },
      createdAtMillis: store.now,
      updatedAtMillis: store.now,
    };
    store.put(value);
    return value;
  });
function seed(scenario: string) {
  const pin = { mode: 'sandbox', profileId: profile.profileId, version: 1, scenario };
  documents = new Map([
    [root, { state: 'ready' }],
    [
      'durableJobIntents/job',
      {
        projectId: 'urm-app-staging',
        jobId: 'job',
        generation: 1,
        kind: 'sermon.publish',
        entity: { type: 'sermon', id: 'sermon' },
        payload: { providerExecution: pin },
      },
    ],
    [
      'durableJobs/job',
      { projectId: 'urm-app-staging', jobId: 'job', generation: 1, state: 'running', providerExecution: pin },
    ],
    ['durableJobEntities/entity-key', { generation: 1, activeJobId: 'job' }],
  ]);
}
const plans = () =>
  [...documents.entries()].filter(([key]) => key.startsWith(root + '/faultPlans/')).map(([, value]) => value);
const journals = () =>
  [...documents.entries()].filter(([key]) => key.startsWith(root + '/requests/')).map(([, value]) => value);
const created = () => documents.get(root + '/resources/' + sandboxResourceKey('subsplash', 'audios', 'created'));
beforeEach(() => seed('success'));
it('consumes one safe read failure atomically, never faking nonidempotent mutation retry safety', async () => {
  seed('transient-failure');
  await body();
  expect(plans()).toEqual([]);
  const read = () =>
    runSandboxOperation(profile, { ...operation, method: 'GET', path: '/files/v1/audios/created' }, async () => true);
  await expect(read()).rejects.toMatchObject({ response: { status: 503 } });
  expect(plans()[0].remaining).toBe(0);
  await expect(read()).resolves.toBe(true);
  expect(journals().map((x) => x.outcome)).toEqual(['acknowledged', 'rejected-before-effect', 'acknowledged']);
});
it('retains permanent failure across retries and step changes', async () => {
  seed('permanent-failure');
  await expect(body()).rejects.toMatchObject({ response: { status: 403 } });
  await expect(
    runSandboxOperation(
      profile,
      { ...operation, context: { ...context, sourceStepIds: ['new-attempt'] } },
      async () => true
    )
  ).rejects.toMatchObject({ response: { status: 403 } });
  expect(plans()).toHaveLength(1);
  expect(plans()[0].remaining).toBe(1);
  expect(created()).toBeUndefined();
});
it('commits the actual resource and lost-response journal before throwing without a response', async () => {
  seed('commit-then-lost-response');
  await expect(body()).rejects.toMatchObject({ code: 'ECONNRESET' });
  expect(created()).toBeDefined();
  expect(journals()[0].outcome).toBe('committed-response-lost');
  expect(plans()[0].remaining).toBe(0);
});
it('does not arm faults on reads or ineligible processing allocations', async () => {
  seed('delayed-processing');
  await runSandboxOperation(profile, { ...operation, method: 'GET' }, async () => true);
  expect(plans()).toEqual([]);
  await body();
  expect(plans()).toEqual([]);
  await runSandboxOperation(profile, { ...operation, path: '/transcoder/v1/jobs' }, async (_store, fault) => {
    expect(fault?.delayMillis).toBe(15000);
    return true;
  });
  expect(plans()).toHaveLength(1);
});
it('fails closed on stale entity generation and conflicting public provenance', async () => {
  documents.set('durableJobEntities/entity-key', { generation: 2, activeJobId: 'new' });
  await expect(body()).rejects.toThrow('superseded');
  expect(journals()).toEqual([]);
  seed('success');
  documents.get('durableJobs/job').providerExecution = {
    mode: 'sandbox',
    profileId: profile.profileId,
    version: 1,
    scenario: 'permanent-failure',
  };
  await expect(body()).rejects.toThrow('provenance');
  expect(created()).toBeUndefined();
});
it('rolls back fault initialization and journal when resource validation fails', async () => {
  seed('success');
  await expect(
    runSandboxOperation(profile, operation, async () => {
      throw new Error('invalid relation');
    })
  ).rejects.toThrow('invalid relation');
  expect(plans()).toEqual([]);
  expect(journals()).toEqual([]);
});

it('reserves only one bounded private preparation for repeated job/source paths', async () => {
  const { beginSandboxAssetPreparation } = await import('./store');
  const path = `_providerSandbox/${profile.profileId}/media/fixed/asset`;
  const first = await beginSandboxAssetPreparation(profile, context, path),
    second = await beginSandboxAssetPreparation(profile, context, path);
  expect(first.id).toBe(second.id);
  expect([...documents.keys()].filter((key) => key.startsWith(root + '/preparedAssets/'))).toHaveLength(1);
  expect(plans()).toEqual([]);
});
it('retains exact completed private evidence after supersession while refusing another stale write preparation', async () => {
  const { beginSandboxAssetPreparation, completeSandboxAssetPreparation, assertSandboxAssetPreparation } = await import(
    './store'
  );
  const path = `_providerSandbox/${profile.profileId}/media/fixed/asset`;
  const preparation = await beginSandboxAssetPreparation(profile, context, path);
  documents.set('durableJobEntities/entity-key', { generation: 2, activeJobId: 'new' });
  await completeSandboxAssetPreparation(profile, preparation.id, {
    bucket: 'urm-app-staging.firebasestorage.app',
    path,
    generation: '123',
    sha256: 'a'.repeat(64),
    size: 123,
    contentType: 'audio/wav',
  });
  expect(documents.get(root + '/preparedAssets/' + preparation.id).state).toBe('retained');
  await expect(assertSandboxAssetPreparation(profile, context)).rejects.toThrow('superseded');
  await expect(beginSandboxAssetPreparation(profile, context, path + '-another')).rejects.toThrow('superseded');
  expect([...documents.keys()].filter((key) => key.startsWith(root + '/preparedAssets/'))).toHaveLength(1);
});
