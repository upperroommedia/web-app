import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  reconcileCurrentCanonicalMirrors,
  canonicalMirrorPatch,
} from '../../DocumentListeners/currentCanonicalMirrors';
import { withProviderIndexedTransaction } from '@upperroom/orchestration/provider-transaction';
import { providerEdgeKey, providerResourceKey, PROVIDER_USAGE_CONTROL } from '@upperroom/orchestration/provider-usage';

const enabled =
  /^(127\.0\.0\.1|localhost):18081$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') &&
  process.env.GCLOUD_PROJECT === 'urm-app';
(enabled ? describe : describe.skip)('canonical mirror provider-index coherence on real Firestore', () => {
  let app: App, db: Firestore, prior: Record<string, unknown> | undefined;
  const nonce = randomUUID(),
    epoch = `mirror-${nonce}`,
    owned = new Set<string>();
  const marker = {
    schemaVersion: 1,
    projectId: 'urm-app',
    epoch,
    status: 'ready',
    releaseId: 'mirror-test',
    controlRevision: 1,
  };
  beforeAll(async () => {
    app = initializeApp({ projectId: 'urm-app' }, `mirror-${nonce}`);
    db = getFirestore(app);
    prior = (await db.doc(PROVIDER_USAGE_CONTROL).get()).data();
  });
  beforeEach(async () => {
    await db.doc(PROVIDER_USAGE_CONTROL).set(marker);
  });
  afterAll(async () => {
    for (const path of owned) await db.recursiveDelete(db.doc(path));
    if (prior) await db.doc(PROVIDER_USAGE_CONTROL).set(prior);
    else await db.doc(PROVIDER_USAGE_CONTROL).delete();
    await deleteApp(app);
  });
  async function fixture() {
    const id = `mirror-${randomUUID()}`,
      list = `list-${randomUUID()}`;
    const source = `sermons/${id}`,
      parent = `lists/${list}`,
      mirror = `${parent}/listItems/${id}`;
    owned.add(source);
    owned.add(parent);
    await db.doc(source).set({ id, title: 'new', subsplashId: `media-${id}`, soundCloudTrackId: `track-${id}` });
    await db.doc(parent).set({ name: 'owned list' });
    await db.doc(mirror).set({ id, title: 'old', position: 4, uploadStatus: { status: 'NOT_UPLOADED' } });
    const resources = ['subsplash', 'soundcloud'].map((provider) => ({
      projectId: 'urm-app',
      provider,
      account: provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
      remoteId: `${provider === 'subsplash' ? 'media' : 'track'}-${id}`,
    }));
    const refs = resources.map((resource) => {
      const root = `temporalProviderUsage/${providerResourceKey(resource as never)}`;
      owned.add(root);
      return db.doc(`${root}/epochs/${epoch}`);
    });
    const run = () =>
      reconcileCurrentCanonicalMirrors(db, {
        sourcePath: source,
        collectionGroup: 'listItems',
        id,
        parentCollection: 'lists',
        project: (canonical, current) => canonicalMirrorPatch(canonical, current, ['subsplashId', 'soundCloudTrackId']),
      });
    return { source, mirror, refs, run };
  }
  it('propagates both acknowledged allocations and their edges before a later list projection; replay has no duplicate counts', async () => {
    const f = await fixture();
    await f.run();
    for (const ref of f.refs) {
      expect((await ref.collection('edges').doc(providerEdgeKey(f.mirror)).get()).exists).toBe(true);
      expect((await ref.get()).get('referenceCount')).toBe(1);
    }
    await expect(
      db.runTransaction((tx) =>
        withProviderIndexedTransaction(tx, db, 'urm-app', async (recording) => {
          recording.update(db.doc(f.mirror), { position: 5 });
        })
      )
    ).resolves.toBeUndefined();
    await f.run();
    for (const ref of f.refs) expect((await ref.get()).get('referenceCount')).toBe(1);
    expect((await db.doc(f.mirror).get()).get('position')).toBe(5);
    await db.doc(f.source).update({ subsplashId: FieldValue.delete(), soundCloudTrackId: FieldValue.delete() });
    await f.run();
    for (const ref of f.refs) {
      expect((await ref.collection('edges').doc(providerEdgeKey(f.mirror)).get()).exists).toBe(false);
      expect((await ref.get()).get('referenceCount')).toBe(0);
    }
  });
  it('does not publish mirror references while the provider index is building', async () => {
    const f = await fixture();
    await db.doc(PROVIDER_USAGE_CONTROL).update({ status: 'building' });
    await expect(f.run()).rejects.toThrow('PROVIDER_USAGE_INDEX_NOT_READY');
    expect((await db.doc(f.mirror).get()).get('subsplashId')).toBeUndefined();
  });
  it('retains pre-migration mirror behavior when no provider index exists', async () => {
    const f = await fixture();
    await db.doc(PROVIDER_USAGE_CONTROL).delete();
    await f.run();
    expect((await db.doc(f.mirror).get()).get('title')).toBe('new');
  });
  it('rolls back canonical propagation when a new provider reference is reserved for cleanup', async () => {
    const f = await fixture();
    await f.refs[0].set({ referenceCount: 0, state: 'reserved' });
    await expect(f.run()).rejects.toThrow('PROVIDER_RESOURCE_CLEANUP_RESERVED');
    expect((await db.doc(f.mirror).get()).get('subsplashId')).toBeUndefined();
  });
  it('splits reference replacement by index fanout instead of only mirror count', async () => {
    const id = `fanout-${randomUUID()}`,
      source = `sermons/${id}`;
    owned.add(source);
    const refs = (prefix: string) => Array.from({ length: 7 }, (_, n) => `media-${prefix}-${id}-${n}`);
    const oldIds = refs('old'),
      newIds = refs('new');
    const data = (ids: string[]) => ({ id, images: ids.map((subsplashId) => ({ subsplashId })) });
    await db.doc(source).set(data(newIds));
    const paths: string[] = [];
    for (let n = 0; n < 40; n++) {
      const parent = `lists/fanout-${id}-${n}`;
      owned.add(parent);
      await db.doc(parent).set({ name: 'owned list' });
      paths.push(`${parent}/listItems/${id}`);
    }
    for (const remoteId of [...oldIds, ...newIds])
      owned.add(
        `temporalProviderUsage/${providerResourceKey({
          projectId: 'urm-app',
          provider: 'subsplash',
          account: 'app:9XTSHD',
          remoteId,
        })}`
      );
    await db.runTransaction((tx) =>
      withProviderIndexedTransaction(tx, db, 'urm-app', async (recording) => {
        for (const path of paths) recording.create(db.doc(path), data(oldIds));
      })
    );
    let evaluations = 0;
    await reconcileCurrentCanonicalMirrors(db, {
      sourcePath: source,
      collectionGroup: 'listItems',
      id,
      parentCollection: 'lists',
      project: (canonical) => {
        evaluations++;
        return canonical;
      },
    });
    // Overflow is reconsidered on the next transaction, never skipped by the query cursor.
    expect(evaluations).toBeGreaterThan(40);
    for (const [ids, count] of [
      [oldIds, 0],
      [newIds, 40],
    ] as const) {
      for (const remoteId of ids) {
        const key = providerResourceKey({
          projectId: 'urm-app',
          provider: 'subsplash',
          account: 'app:9XTSHD',
          remoteId,
        });
        expect((await db.doc(`temporalProviderUsage/${key}/epochs/${epoch}`).get()).get('referenceCount')).toBe(count);
      }
    }
    for (const path of paths) expect((await db.doc(path).get()).get('images')).toEqual(data(newIds).images);
  });
});
