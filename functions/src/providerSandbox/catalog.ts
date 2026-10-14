import { createHash } from 'node:crypto';
import { FieldPath, type Firestore, type DocumentSnapshot, type Query } from 'firebase-admin/firestore';
import { isDurableJobTerminal, type DurableJobKind } from '@upperroom/contracts/temporal';
import { isSandboxProviderIntent } from './admission';
import { assertMatchingSandboxProfile, sandboxProfileDocumentPath, type SandboxProviderProfile } from './profile';
import { sandboxResourceKey } from './store';
import { validateStageAssetRef, inspectStageAsset, inspectReviewedSandboxWav } from './assets';
import type { SandboxAssetEvidence, SandboxResource, SandboxProvider } from './types';
/** Fresh import proves reviewed fixture bytes independently of any pre-existing catalog marker. */
export async function inspectSandboxCatalogFixture(
  profile: SandboxProviderProfile,
  ref: Parameters<typeof inspectStageAsset>[1] &
    Partial<Pick<SandboxAssetEvidence, 'sha256' | 'size' | 'durationSeconds'>>
): Promise<SandboxAssetEvidence> {
  if (
    !ref.path.startsWith(`_providerSandbox/${profile.profileId}/`) ||
    !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') ||
    !Number.isSafeInteger(ref.size) ||
    !Number.isFinite(ref.durationSeconds) ||
    !(ref.durationSeconds! > 0)
  )
    throw new Error('SANDBOX_IMPORT_REVIEWED_FIXTURE_REQUIRED');
  return inspectReviewedSandboxWav(profile, ref, {
    sha256: ref.sha256!,
    size: ref.size!,
    durationSeconds: ref.durationSeconds!,
  });
}
export interface CatalogSource {
  path: string;
  data: Record<string, any>;
  updateTime: { seconds: number; nanoseconds: number };
}
export interface SandboxCatalogPlan {
  schemaVersion: 1;
  profile: SandboxProviderProfile;
  sourceDigest: string;
  importId: string;
  fixture: SandboxAssetEvidence;
  resources: SandboxResource[];
  sources: Array<{ path: string; digest: string; updateTime: { seconds: number; nanoseconds: number } }>;
  resourceDigest: string;
  provenance: 'staging-canonical-aliases-with-reviewed-simulation-audio';
  createdAtMillis: number;
}
export const CATALOG_GROUPS = [
  'sermons',
  'lists',
  'series',
  'speakers',
  'images',
  'listItems',
  'sermonLists',
  'seriesItems',
] as const;
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      )
    : value;
export const catalogDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const alias = (seed: string): string => {
  const hex = catalogDigest(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export function buildSandboxCatalogPlan(
  profile: SandboxProviderProfile,
  documents: CatalogSource[],
  fixture: SandboxAssetEvidence,
  createdAtMillis: number
): SandboxCatalogPlan {
  assertMatchingSandboxProfile(profile, {
    mode: 'sandbox',
    profileId: profile.profileId,
    version: 1,
    scenario: 'success',
  });
  validateStageAssetRef(fixture);
  if (
    !Number.isFinite(fixture.durationSeconds) ||
    Number(fixture.durationSeconds) <= 0 ||
    Number(fixture.durationSeconds) > 86400
  )
    fail('SANDBOX_REVIEWED_AUDIO_DURATION_REQUIRED');
  if (
    !fixture.path.startsWith(`_providerSandbox/${profile.profileId}/`) ||
    !/^audio\//.test(fixture.contentType) ||
    !Number.isSafeInteger(fixture.size) ||
    fixture.size < 1 ||
    !/^([a-f0-9]{64})$/.test(fixture.sha256)
  )
    fail('SANDBOX_REVIEWED_AUDIO_FIXTURE_REQUIRED');
  if (!Number.isSafeInteger(createdAtMillis) || createdAtMillis < 1) fail('SANDBOX_IMPORT_TIME_INVALID');
  const sources = documents
    .map((doc) => ({ path: doc.path, digest: catalogDigest(doc.data), updateTime: doc.updateTime }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(sources.map((row) => row.path)).size !== sources.length) fail('SANDBOX_CATALOG_DUPLICATE_SOURCE');
  const ordered = [...documents].sort((a, b) => a.path.localeCompare(b.path));
  const map = new Map(documents.map((doc) => [doc.path, doc])),
    resources = new Map<string, SandboxResource>();
  const put = (
    provider: SandboxProvider,
    family: string,
    remoteId: unknown,
    body: Record<string, any>,
    source?: SandboxAssetEvidence,
    overwrite = false
  ) => {
    if (!id(remoteId)) fail('SANDBOX_CATALOG_INVALID_ALIAS');
    const key = sandboxResourceKey(provider, family, remoteId);
    if (resources.has(key) && !overwrite) return;
    resources.set(key, {
      schemaVersion: 1,
      provider,
      family,
      id: remoteId,
      revision: 1,
      deleted: false,
      body: { id: remoteId, ...(provider === 'subsplash' ? { app_key: '9XTSHD' } : {}), ...body },
      ...(source ? { source } : {}),
      createdAtMillis,
      updatedAtMillis: createdAtMillis,
    });
  };
  const walk = (value: any, root: string, context = root): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, root, context));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const family =
        key === 'tagId'
          ? 'tags'
          : key === 'subsplashAudioId'
          ? 'audios'
          : ['moreSermonsRef', 'subsplashListId', 'manualOverflowTargetSubsplashId'].includes(key)
          ? 'lists'
          : key === 'subsplashSeriesId'
          ? 'media-series'
          : key === 'sermonSubsplashId'
          ? 'media-items'
          : key === 'subsplashId'
          ? context === 'images' || root === 'images'
            ? 'images'
            : root === 'lists'
            ? 'lists'
            : root === 'series'
            ? 'media-series'
            : 'media-items'
          : undefined;
      if (family && id(item)) put('subsplash', family, item, {}, family === 'audios' ? fixture : undefined);
      if (key === 'soundCloudTrackId' && id(item)) {
        if (!/^(?:soundcloud:tracks:)?[0-9]+$/.test(item)) fail('SANDBOX_CATALOG_INVALID_TRACK_ALIAS');
        put(
          'soundcloud',
          'tracks',
          item.replace(/^soundcloud:tracks:/, ''),
          {
            urn: item.startsWith('soundcloud:tracks:') ? item : `soundcloud:tracks:${item}`,
            title: value.title ?? '',
            streamable: true,
            sharing: value.soundCloudPublication?.sharing ?? 'public',
            user: { id: 9000000000001, id_str: '9000000000001', urn: 'soundcloud:users:9000000000001' },
          },
          fixture
        );
      }
      if (item && typeof item === 'object') walk(item, root, key === 'images' ? 'images' : context);
    }
  };
  ordered.forEach((doc) => walk(doc.data, doc.path.split('/')[0]));
  for (const doc of ordered) {
    const parts = doc.path.split('/'),
      root = parts[0],
      data = doc.data;
    if (parts.length !== 2) continue;
    if (root === 'sermons' && id(data.subsplashId)) {
      const audio = id(data.subsplashAudioId) ? data.subsplashAudioId : alias(`sandbox-audio:${doc.path}`);
      put('subsplash', 'audios', audio, { title: data.title ?? '' }, fixture, true);
      put(
        'subsplash',
        'media-items',
        data.subsplashId,
        {
          title: data.title ?? '',
          subtitle: data.subtitle ?? '',
          summary: data.description ?? '',
          status: 'published',
          _embedded: {
            audio: { id: audio },
            images: (data.images ?? []).filter((x: any) => id(x.subsplashId)).map((x: any) => ({ id: x.subsplashId })),
          },
        },
        undefined,
        true
      );
    }
    if (root === 'lists' && id(data.subsplashId))
      put('subsplash', 'lists', data.subsplashId, { title: data.name ?? '', type: 'standard' }, undefined, true);
    if (root === 'series' && id(data.subsplashId))
      put(
        'subsplash',
        'media-series',
        data.subsplashId,
        { title: data.name ?? '', subtitle: data.subtitle ?? '', status: data.status ?? 'draft' },
        undefined,
        true
      );
    if (root === 'speakers' && id(data.tagId))
      put(
        'subsplash',
        'tags',
        data.tagId,
        { title: data.name ?? '', name: data.name ?? '', type: 'speaker' },
        undefined,
        true
      );
    if (root === 'images' && id(data.subsplashId))
      put(
        'subsplash',
        'images',
        data.subsplashId,
        { title: data.name ?? '', type: data.type ?? 'square' },
        undefined,
        true
      );
  }
  // Canonical speaker membership and explicit overflow links are virtual catalog relationships, not vendor observations.
  for (const doc of ordered) {
    const parts = doc.path.split('/'),
      data = doc.data;
    if (parts.length !== 2) continue;
    if (parts[0] === 'sermons' && id(data.subsplashId))
      for (const speaker of Array.isArray(data.speakers) ? data.speakers : []) {
        if (!id(speaker?.tagId)) continue;
        const media = resources.get(sandboxResourceKey('subsplash', 'media-items', data.subsplashId));
        put('subsplash', 'taggings', alias(`sandbox-tagging:${doc.path}:${speaker.tagId}`), {
          _embedded: { tag: { id: speaker.tagId }, 'media-item': media!.body },
        });
      }
    if (
      parts[0] === 'lists' &&
      id(data.subsplashId) &&
      (data.manualOverflowRowId || data.manualOverflowTargetSubsplashId)
    ) {
      if (!id(data.manualOverflowRowId) || !id(data.manualOverflowTargetSubsplashId))
        fail('SANDBOX_MANUAL_OVERFLOW_REFERENCE_MISSING');
      put('subsplash', 'list-rows', data.manualOverflowRowId, {
        type: 'list',
        position: 200,
        _embedded: { 'source-list': { id: data.subsplashId }, list: { id: data.manualOverflowTargetSubsplashId } },
      });
    }
  }
  for (const doc of ordered) {
    const parts = doc.path.split('/'),
      data = doc.data;
    if (
      parts.length === 4 &&
      parts[0] === 'lists' &&
      parts[2] === 'listItems' &&
      data.uploadStatus?.status === 'UPLOADED'
    ) {
      const list = map.get(`lists/${parts[1]}`)?.data,
        sermon = map.get(`sermons/${parts[3]}`)?.data;
      const listId = data.physicalPlacement?.subsplashListId ?? data.subsplashListId ?? list?.subsplashId;
      const mediaId = data.sermonSubsplashId ?? sermon?.subsplashId ?? data.mediaItem?.subsplashId;
      if (!id(listId) || !id(mediaId)) fail('SANDBOX_PUBLISHED_LIST_REFERENCE_MISSING');
      put('subsplash', 'lists', listId, {});
      put('subsplash', 'media-items', mediaId, {});
      const rowId =
        data.physicalPlacement?.listItemId ?? data.uploadStatus.listItemId ?? alias(`sandbox-list-row:${doc.path}`);
      put('subsplash', 'list-rows', rowId, {
        type: 'media-item',
        position: Math.max(1, Number(data.position ?? 0) + 1),
        _embedded: { 'source-list': { id: listId }, 'media-item': { id: mediaId } },
      });
    }
    if (
      parts.length === 4 &&
      parts[0] === 'series' &&
      parts[2] === 'seriesItems' &&
      data.publishedToSubsplash === true
    ) {
      const seriesId = map.get(`series/${parts[1]}`)?.data.subsplashId,
        mediaId = data.sermonSubsplashId ?? map.get(`sermons/${parts[3]}`)?.data.subsplashId;
      if (!id(seriesId) || !id(mediaId)) fail('SANDBOX_PUBLISHED_SERIES_REFERENCE_MISSING');
      const media = resources.get(sandboxResourceKey('subsplash', 'media-items', mediaId));
      if (!media) fail('SANDBOX_PUBLISHED_SERIES_MEDIA_MISSING');
      const previous = media.body._embedded?.['media-series']?.id;
      if (previous && previous !== seriesId) fail('SANDBOX_CONFLICTING_SERIES_REFERENCE');
      media.body._embedded = { ...media.body._embedded, 'media-series': { id: seriesId } };
      media.body.position = Number(data.position ?? 0);
    }
  }
  put('soundcloud', 'accounts', '9000000000001', {
    id: 9000000000001,
    id_str: '9000000000001',
    urn: 'soundcloud:users:9000000000001',
    username: 'staging-sandbox',
  });
  const values = [...resources.values()].sort((a, b) =>
    sandboxResourceKey(a.provider, a.family, a.id).localeCompare(sandboxResourceKey(b.provider, b.family, b.id))
  );
  const sourceDigest = catalogDigest(sources),
    resourceDigest = catalogDigest(values),
    importId = catalogDigest({ profile, sourceDigest, resourceDigest, fixture });
  return {
    schemaVersion: 1,
    profile,
    sourceDigest,
    resourceDigest,
    importId,
    fixture,
    resources: values,
    sources,
    createdAtMillis,
    provenance: 'staging-canonical-aliases-with-reviewed-simulation-audio',
  };
}
export async function readSandboxCatalogSources(db: Firestore): Promise<CatalogSource[]> {
  const rows: CatalogSource[] = [];
  for (const group of CATALOG_GROUPS) {
    let cursor: DocumentSnapshot | undefined;
    for (;;) {
      let query: Query = ['listItems', 'sermonLists', 'seriesItems'].includes(group)
        ? db.collectionGroup(group)
        : db.collection(group);
      query = query.orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs)
        rows.push({
          path: doc.ref.path,
          data: doc.data(),
          updateTime: { seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds },
        });
      if (page.size < 200) break;
      cursor = page.docs[page.docs.length - 1];
    }
  }
  return rows;
}
export function assertSandboxImportFrozen(control: any, state: any, releaseId: string, revision: number): void {
  if (
    control?.schemaVersion !== 1 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    control?.releaseId !== releaseId ||
    control.revision !== revision ||
    state?.releaseId !== releaseId ||
    state.controlRevision !== revision ||
    !['ui-frozen', 'compatibility-ready', 'paused-for-recovery'].includes(state.phase) ||
    control.admission !== 'paused' ||
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
      (domain) =>
        !['legacy', 'temporal'].includes(control.domains?.[domain]?.owner) ||
        !['open', 'paused'].includes(control.domains?.[domain]?.admission)
    )
  )
    fail('SANDBOX_IMPORT_RELEASE_NOT_FROZEN');
}
export function assertNoUnprofiledPublishingJobs(jobs: Array<{ id: string; data: Record<string, any> }>): void {
  for (const { data } of jobs)
    if (
      !isDurableJobTerminal(data.state) &&
      (data.kind === 'speaker.resolve' || isSandboxProviderIntent(data.kind as DurableJobKind, data.payload ?? {}))
    )
      fail('SANDBOX_IMPORT_NONTERMINAL_PROVIDER_JOB');
}

/** Import writes only private virtual resources and its owned operation/audit. Canonical source documents are never changed. */
export async function applySandboxCatalogPlan(
  db: Firestore,
  plan: SandboxCatalogPlan,
  authority: {
    releaseId: string;
    revision: number;
    operationId: string;
    operator: string;
    operatorEvidence?: Record<string, unknown>;
  },
  verifyFixture: typeof inspectSandboxCatalogFixture = inspectSandboxCatalogFixture
): Promise<{ importId: string; resourceCount: number }> {
  if (
    plan.schemaVersion !== 1 ||
    !/^\S+@\S+$/.test(authority.operator) ||
    !/^[a-f0-9-]{36}$/.test(authority.operationId)
  )
    fail('SANDBOX_IMPORT_AUTHORITY_INVALID');
  const actualFixture = await verifyFixture(plan.profile, plan.fixture);
  if (catalogDigest(actualFixture) !== catalogDigest(plan.fixture)) fail('SANDBOX_IMPORT_FIXTURE_CHANGED');
  const profile = plan.profile,
    root = db.doc(sandboxProfileDocumentPath(profile)),
    controlRef = db.doc('_control/temporalRelease'),
    stateRef = db.doc('_control/temporalReleaseState'),
    operationRef = db.doc('_control/temporalReleaseOperation');
  const planDigest = catalogDigest(plan),
    auditRef = root.collection('catalogImports').doc(plan.importId);
  const snapshotProof = (snapshot: DocumentSnapshot) => ({
    data: catalogDigest(snapshot.data()),
    createTime: snapshot.createTime ? `${snapshot.createTime.seconds}:${snapshot.createTime.nanoseconds}` : null,
    updateTime: snapshot.updateTime ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : null,
  });
  let nativeControl: ReturnType<typeof snapshotProof>,
    nativeState: ReturnType<typeof snapshotProof>,
    nativeOperation: ReturnType<typeof snapshotProof>;
  const validateOperation = (operation: any) => {
    if (
      operation?.operationId !== authority.operationId ||
      operation.action !== 'provider-sandbox-catalog-import' ||
      operation.planDigest !== planDigest ||
      operation.releaseId !== authority.releaseId ||
      operation.operator !== authority.operator
    )
      fail('SANDBOX_IMPORT_OPERATION_CHANGED');
  };
  const checkFrozen = async (tx: FirebaseFirestore.Transaction) => {
    const [control, state, operation] = await Promise.all([tx.get(controlRef), tx.get(stateRef), tx.get(operationRef)]);
    assertSandboxImportFrozen(control.data(), state.data(), authority.releaseId, authority.revision);
    validateOperation(operation.data());
    if (catalogDigest(snapshotProof(operation)) !== catalogDigest(nativeOperation))
      fail('SANDBOX_IMPORT_OPERATION_CHANGED');
    if (
      catalogDigest(snapshotProof(control)) !== catalogDigest(nativeControl) ||
      catalogDigest(snapshotProof(state)) !== catalogDigest(nativeState)
    )
      fail('SANDBOX_IMPORT_NATIVE_AUTHORITY_CHANGED');
  };
  const current = await readSandboxCatalogSources(db);
  if (
    catalogDigest(
      current
        .map((doc) => ({ path: doc.path, digest: catalogDigest(doc.data), updateTime: doc.updateTime }))
        .sort((a, b) => a.path.localeCompare(b.path))
    ) !== plan.sourceDigest
  )
    fail('SANDBOX_IMPORT_SOURCE_CHANGED');
  if (catalogDigest(buildSandboxCatalogPlan(profile, current, plan.fixture, plan.createdAtMillis)) !== planDigest)
    fail('SANDBOX_IMPORT_PLAN_CHANGED');

  // The normal release operation path serializes this import against every controller action.
  await db.runTransaction(async (tx) => {
    const [control, state, operation, marker, firstResource] = await Promise.all([
      tx.get(controlRef),
      tx.get(stateRef),
      tx.get(operationRef),
      tx.get(root),
      tx.get(root.collection('resources').limit(1)),
    ]);
    const activeJobs = await tx.get(
      db
        .collection('durableJobs')
        .where('state', 'in', [
          'awaiting_source',
          'queued',
          'running',
          'retrying',
          'waiting_for_auth',
          'cancel_requested',
          'reconciling',
          'needs_attention',
        ])
    );
    assertNoUnprofiledPublishingJobs(activeJobs.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
    if (
      !(
        await tx.get(
          db.collection('legacyAdmissionLeases').where('state', 'in', ['active', 'needs_attention']).limit(1)
        )
      ).empty
    )
      fail('SANDBOX_IMPORT_LEGACY_WORK_ACTIVE');
    assertSandboxImportFrozen(control.data(), state.data(), authority.releaseId, authority.revision);
    nativeControl = snapshotProof(control);
    nativeState = snapshotProof(state);
    if (operation.exists) {
      validateOperation(operation.data());
      nativeControl = operation.get('nativeControl');
      nativeState = operation.get('nativeState');
      if (
        catalogDigest(snapshotProof(control)) !== catalogDigest(nativeControl) ||
        catalogDigest(snapshotProof(state)) !== catalogDigest(nativeState)
      )
        fail('SANDBOX_IMPORT_NATIVE_AUTHORITY_CHANGED');
      if (marker.get('importId') !== plan.importId || marker.get('state') !== 'building')
        fail('SANDBOX_IMPORT_RESUME_MARKER_CHANGED');
    } else {
      if (marker.exists || !firstResource.empty) fail('SANDBOX_IMPORT_NAMESPACE_NOT_EMPTY');
      tx.create(operationRef, {
        operationId: authority.operationId,
        action: 'provider-sandbox-catalog-import',
        releaseId: authority.releaseId,
        revision: authority.revision,
        planDigest,
        operator: authority.operator,
        nativeControl,
        nativeState,
        createdAtMillis: Date.now(),
      });
      tx.create(root, { state: 'building', profile, importId: plan.importId, planDigest, createdAtMillis: Date.now() });
    }
  });
  nativeOperation = snapshotProof(await operationRef.get());
  // Any failure retains the owned operation and incomplete marker for explicit same-plan inspection/resume.
  await db.runTransaction(async (tx) => {
    await checkFrozen(tx);
    const jobs = await tx.get(
      db
        .collection('durableJobs')
        .where('state', 'in', [
          'awaiting_source',
          'queued',
          'running',
          'retrying',
          'waiting_for_auth',
          'cancel_requested',
          'reconciling',
          'needs_attention',
        ])
    );
    assertNoUnprofiledPublishingJobs(jobs.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
    if (
      !(
        await tx.get(
          db.collection('legacyAdmissionLeases').where('state', 'in', ['active', 'needs_attention']).limit(1)
        )
      ).empty
    )
      fail('SANDBOX_IMPORT_LEGACY_WORK_ACTIVE');
  });
  for (let offset = 0; offset < plan.resources.length; offset += 100) {
    const page = plan.resources.slice(offset, offset + 100);
    await db.runTransaction(async (tx) => {
      await checkFrozen(tx);
      const refs = page.map((value) =>
          root.collection('resources').doc(sandboxResourceKey(value.provider, value.family, value.id))
        ),
        snapshots = await tx.getAll(...refs);
      snapshots.forEach((snapshot, index) => {
        if (snapshot.exists && catalogDigest(snapshot.data()) !== catalogDigest(page[index]))
          fail('SANDBOX_IMPORT_RESOURCE_CHANGED');
      });
      page.forEach((value, index) => {
        if (!snapshots[index].exists) tx.create(refs[index], value);
      });
    });
  }
  await db.runTransaction(async (tx) => {
    await checkFrozen(tx);
    const marker = await tx.get(root),
      audit = await tx.get(auditRef);
    if (marker.get('state') !== 'building' || marker.get('planDigest') !== planDigest || audit.exists)
      fail('SANDBOX_IMPORT_FINAL_MARKER_CHANGED');
    const jobs = await tx.get(
      db
        .collection('durableJobs')
        .where('state', 'in', [
          'awaiting_source',
          'queued',
          'running',
          'retrying',
          'waiting_for_auth',
          'cancel_requested',
          'reconciling',
          'needs_attention',
        ])
    );
    assertNoUnprofiledPublishingJobs(jobs.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
    if (
      !(
        await tx.get(
          db.collection('legacyAdmissionLeases').where('state', 'in', ['active', 'needs_attention']).limit(1)
        )
      ).empty
    )
      fail('SANDBOX_IMPORT_LEGACY_WORK_ACTIVE');
    // Full native source verification occurs in the final transaction; an independent admin change cannot be silently adopted.
    for (let offset = 0; offset < plan.sources.length; offset += 100) {
      const rows = plan.sources.slice(offset, offset + 100),
        snapshots = await tx.getAll(...rows.map((row) => db.doc(row.path)));
      snapshots.forEach((snapshot, index) => {
        const expected = rows[index];
        if (
          !snapshot.exists ||
          catalogDigest(snapshot.data()) !== expected.digest ||
          snapshot.updateTime?.seconds !== expected.updateTime.seconds ||
          snapshot.updateTime.nanoseconds !== expected.updateTime.nanoseconds
        )
          fail('SANDBOX_IMPORT_SOURCE_CHANGED');
      });
    }
    // Query each canonical group as well: expected native snapshots alone would miss newly inserted source documents.
    let count = 0;
    for (const group of CATALOG_GROUPS) {
      const query = ['listItems', 'sermonLists', 'seriesItems'].includes(group)
        ? db.collectionGroup(group)
        : db.collection(group);
      const snapshot = await tx.get(query);
      count += snapshot.size;
    }
    if (count !== plan.sources.length) fail('SANDBOX_IMPORT_SOURCE_SET_CHANGED');
    const resources = await tx.get(root.collection('resources'));
    if (
      resources.size !== plan.resources.length ||
      catalogDigest(
        resources.docs
          .map((doc) => doc.data())
          .sort((a, b) =>
            sandboxResourceKey(a.provider, a.family, a.id).localeCompare(sandboxResourceKey(b.provider, b.family, b.id))
          )
      ) !== plan.resourceDigest
    )
      fail('SANDBOX_IMPORT_RESOURCE_CHANGED');
    tx.create(auditRef, {
      schemaVersion: 1,
      importId: plan.importId,
      planDigest,
      profile,
      sourceDigest: plan.sourceDigest,
      resourceDigest: plan.resourceDigest,
      sourceCount: plan.sources.length,
      resourceCount: plan.resources.length,
      fixture: plan.fixture,
      provenance: plan.provenance,
      authority,
      nativeControl,
      nativeState,
      nativeOperation,
      completedAtMillis: Date.now(),
      providerNetworkRequests: 0,
      canonicalWrites: 0,
    });
    tx.set(root, {
      state: 'ready',
      profile,
      catalogImportId: plan.importId,
      planDigest,
      sourceDigest: plan.sourceDigest,
      resourceDigest: plan.resourceDigest,
      sourceCount: plan.sources.length,
      resourceCount: plan.resources.length,
      provenance: plan.provenance,
      fixture: plan.fixture,
      completedAtMillis: Date.now(),
    });
    tx.delete(operationRef);
  });
  return { importId: plan.importId, resourceCount: plan.resources.length };
}
