jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: jest.fn(), firestore: jest.fn() },
}));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareProviderBinding: jest.fn(),
  prepareProviderBindingRelease: jest.fn(),
  extractProviderResources: jest.fn(),
}));
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  prepareProviderBinding,
  prepareProviderBindingRelease,
  extractProviderResources,
} from '../../../../packages/orchestration/src/provider-usage';
import {
  runDurablePublishingOperation,
  reserveDurableProviderBindings,
  releaseDurableProviderBindings,
} from './durableOperationContext';
const resources = [
  { provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId: 'audio' },
  { provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId: 'image' },
];
describe('fenced provider association reservations', () => {
  const records = new Map<string, Record<string, unknown>>();
  const target = (path: string) => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => target(`${path}/${name}/${id}`) }),
  });
  const tx = {
    get: jest.fn(async (ref: { path: string }) => ({
      exists: records.has(ref.path),
      get: (key: string) => records.get(ref.path)?.[key],
      data: () => records.get(ref.path),
    })),
    create: jest.fn((ref: { path: string }, value: Record<string, unknown>) => records.set(ref.path, value)),
    update: jest.fn((ref: { path: string }, value: Record<string, unknown>) =>
      Object.assign(records.get(ref.path)!, value)
    ),
    set: jest.fn((ref: { path: string }, value: Record<string, unknown>) => records.set(ref.path, value)),
  };
  const fence = jest.fn(async (run: (tx: unknown) => Promise<void>) => run(tx));
  beforeEach(() => {
    records.clear();
    jest.clearAllMocks();
    (admin.app as jest.Mock).mockReturnValue({ options: { projectId: 'project' } });
    (admin.firestore as jest.Mock).mockReturnValue({
      collection: (name: string) => ({ doc: (id: string) => target(`${name}/${id}`) }),
      doc: target,
    });
    (prepareProviderBinding as jest.Mock).mockResolvedValue(jest.fn());
    (prepareProviderBindingRelease as jest.Mock).mockResolvedValue(jest.fn());
    (extractProviderResources as jest.Mock).mockImplementation((_project, _path, value) => value?.resources ?? []);
  });
  it('ignores a legacy caller even with a durable-looking binding key', async () => {
    await reserveDurableProviderBindings(resources, 'durable:fake');
    expect(admin.firestore).not.toHaveBeenCalled();
  });
  it('fences each resource before an HTTP association and preserves deterministic private proof', async () => {
    await runDurablePublishingOperation(
      'job',
      () => reserveDurableProviderBindings(resources, 'attach', { targetReceiptId: 'a'.repeat(64) }),
      fence as never
    );
    expect(fence).toHaveBeenCalledTimes(2);
    expect(prepareProviderBinding).toHaveBeenCalledTimes(2);
    expect(records.size).toBe(2);
    for (const value of records.values())
      expect(value).toMatchObject({
        projectId: 'project',
        jobId: 'job',
        state: 'reserved',
        targetReceiptId: 'a'.repeat(64),
      });
    await runDurablePublishingOperation(
      'job',
      () => reserveDurableProviderBindings(resources, 'attach', { targetReceiptId: 'a'.repeat(64) }),
      fence as never
    );
    expect(prepareProviderBinding).toHaveBeenCalledTimes(2);
  });
  it('rejects before reserving when a newer generation invalidates authority', async () => {
    await expect(
      runDurablePublishingOperation(
        'job',
        () => reserveDurableProviderBindings(resources, 'attach'),
        async () => {
          throw new Error('superseded');
        }
      )
    ).rejects.toThrow('superseded');
    expect(prepareProviderBinding).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });
  it('blocks the association before HTTP when cleanup has reserved the resource', async () => {
    (prepareProviderBinding as jest.Mock).mockRejectedValue(new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED'));
    const post = jest.fn();
    await expect(
      runDurablePublishingOperation(
        'job',
        async () => {
          await reserveDurableProviderBindings([resources[0]], 'attach');
          await post();
        },
        fence as never
      )
    ).rejects.toThrow('PROVIDER_RESOURCE_CLEANUP_RESERVED');
    expect(post).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });
  it('requires exact canonical resource proof inside the same transaction before edge release', async () => {
    await runDurablePublishingOperation(
      'job',
      () => reserveDurableProviderBindings([resources[0]], 'attach'),
      fence as never
    );
    records.set('sermons/sermon', { resources: [{ ...resources[1], projectId: 'project' }] });
    await expect(
      runDurablePublishingOperation(
        'job',
        () => releaseDurableProviderBindings([resources[0]], 'attach', { canonicalPaths: ['sermons/sermon'] }),
        fence as never
      )
    ).rejects.toThrow('PROVIDER_BINDING_CANONICAL_PROOF_MISSING');
    expect(prepareProviderBindingRelease).not.toHaveBeenCalled();
    records.set('sermons/sermon', { resources: [{ ...resources[0], projectId: 'project' }] });
    await runDurablePublishingOperation(
      'job',
      () => releaseDurableProviderBindings([resources[0]], 'attach', { canonicalPaths: ['sermons/sermon'] }),
      fence as never
    );
    expect(prepareProviderBindingRelease).toHaveBeenCalledTimes(1);
  });
  it('releases only through the explicit post-proof API and fences re-reservation after a lost completion acknowledgement', async () => {
    await runDurablePublishingOperation(
      'job',
      () => reserveDurableProviderBindings(resources, 'attach'),
      fence as never
    );
    expect(prepareProviderBindingRelease).not.toHaveBeenCalled();
    await runDurablePublishingOperation(
      'job',
      () => releaseDurableProviderBindings(resources, 'attach'),
      fence as never
    );
    expect(prepareProviderBindingRelease).toHaveBeenCalledTimes(2);
    await runDurablePublishingOperation(
      'job',
      () => reserveDurableProviderBindings(resources, 'attach'),
      fence as never
    );
    expect(prepareProviderBinding).toHaveBeenCalledTimes(4);
    for (const value of records.values()) expect(value.state).toBe('reserved');
  });
});
