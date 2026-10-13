import { createHash, randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  FieldPath,
  type Firestore,
  type Transaction,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { getDurablePublishingJobId, runDurableTransaction } from '../temporal/publishing/durableOperationContext';
import { providerMutationFingerprint } from '../temporal/publishing/providerMutationGuard';
import { acknowledgedProjectionDigest } from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  desiredProviderDeletionPlanId,
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
  providerEdgeKey,
  extractProviderResources,
  type ProviderResource,
} from '../../../packages/orchestration/src/provider-usage';

export const SERIES_DELETION_MIRROR_PLANS = 'temporalSeriesDeletionMirrorPlans';
const PAGE_SIZE = 200;
const WRITE_PAGE_SIZE = 64;
export type SeriesDeletionMirrorInput = Readonly<{ seriesId: string; remoteSeriesId: string }>;
export type SeriesDeletionMirrorPlan = Readonly<
  SeriesDeletionMirrorInput & { projectId: string; jobId?: string; planId: string }
>;
type Projection = { after: 'absent' } | { after: 'resource_removed'; afterData: Record<string, unknown> };
type Row = Projection & { canonicalPath: string; sourceFingerprint: string; expectedDocumentDigest: string };
const fail = (): never => {
  throw new Error('SERIES_DELETION_MIRROR_PROOF_INVALID');
};
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const transaction = <T>(db: Firestore, jobId: string | undefined, fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  jobId ? runDurableTransaction(db, fn) : db.runTransaction(fn);
const provider = (plan: SeriesDeletionMirrorPlan): ProviderResource => ({
  projectId: plan.projectId,
  provider: 'subsplash',
  account: 'app:9XTSHD',
  remoteId: plan.remoteSeriesId,
});
const remoteRef = (db: Firestore, plan: SeriesDeletionMirrorPlan) =>
  db
    .collection('temporalProviderDesiredDeletionPlans')
    .doc(desiredProviderDeletionPlanId({ resource: provider(plan), jobId: plan.jobId!, resourceType: 'series' }));
const localRef = (db: Firestore, plan: SeriesDeletionMirrorPlan) =>
  db.collection(SERIES_DELETION_MIRROR_PLANS).doc(plan.planId);

/** Only the selected series' own membership and copies of its local sermon pointer
 * are owned. A provider ID alone never authorizes changing an unrelated document.
 */
export function projectSeriesDeletionDocument(
  path: string,
  data: unknown,
  input: SeriesDeletionMirrorInput
): Projection | undefined {
  const parts = path.split('/');
  if (parts.length === 4 && parts[0] === 'series' && parts[1] === input.seriesId && parts[2] === 'seriesItems')
    return { after: 'absent' };
  const sermon = parts.length === 2 && parts[0] === 'sermons';
  const mirror = parts.length === 4 && parts[0] === 'lists' && parts[2] === 'listItems';
  const before = object(data);
  if ((!sermon && !mirror) || !before) return undefined;
  const clearPointer = (value: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...value, seriesId: null, seriesPublishedToSubsplash: false };
    // These are series-specific references, not the sermon's media identity.
    if (next.subsplashSeriesId === input.remoteSeriesId) delete next.subsplashSeriesId;
    return next;
  };
  let changed = false;
  let afterData = { ...before };
  if (before.seriesId === input.seriesId) {
    afterData = clearPointer(before);
    changed = true;
  }
  const embedded = object(before.mediaItem);
  if (embedded?.seriesId === input.seriesId) {
    afterData.mediaItem = clearPointer(embedded);
    changed = true;
  }
  return changed ? { after: 'resource_removed', afterData } : undefined;
}

async function authority(tx: Transaction, db: Firestore, plan: SeriesDeletionMirrorPlan) {
  const series = await tx.get(db.doc(`series/${plan.seriesId}`));
  if (!series.exists || series.get('subsplashId') !== plan.remoteSeriesId) return fail();
  if (!plan.jobId) return undefined;
  const [intentSnapshot, jobSnapshot] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${plan.jobId}`)),
    tx.get(db.doc(`durableJobs/${plan.jobId}`)),
  ]);
  const intent = intentSnapshot.data(),
    job = jobSnapshot.data();
  const domain = intent?.payload;
  if (
    !intent ||
    !job ||
    intent.projectId !== plan.projectId ||
    intent.jobId !== plan.jobId ||
    job.projectId !== intent.projectId ||
    job.jobId !== intent.jobId ||
    job.kind !== intent.kind ||
    job.generation !== intent.generation ||
    job.entity?.type !== intent.entity?.type ||
    job.entity?.id !== intent.entity?.id ||
    intent.kind !== 'series.delete' ||
    intent.entity?.type !== 'series' ||
    intent.entity?.id !== plan.seriesId ||
    domain?.kind !== intent.kind ||
    domain?.entity?.type !== intent.entity.type ||
    domain?.entity?.id !== intent.entity.id ||
    domain?.payload?.operation !== 'delete' ||
    (domain.payload.input?.firestoreId !== undefined && domain.payload.input.firestoreId !== plan.seriesId) ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state)
  )
    return fail();
  return {
    entity: intent.entity,
    generation: intent.generation,
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
  };
}
async function* pages(query: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    const page = await (cursor ? pageQuery.startAfter(cursor) : pageQuery).get();
    if (page.empty) return;
    yield page.docs;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) return;
  }
}

/** Capture paginated canonical proof before unlink or DELETE. The handle contains no
 * fleet-sized manifest; the immutable row ledger stays in private Firestore.
 */
export async function prepareSeriesDeletionMirrors(
  db: Firestore,
  input: SeriesDeletionMirrorInput
): Promise<SeriesDeletionMirrorPlan> {
  const projectId = firebaseAdmin.app().options.projectId;
  if (!validId(projectId) || !validId(input.seriesId) || !validId(input.remoteSeriesId)) return fail();
  const jobId = getDurablePublishingJobId();
  const planId = createHash('sha256')
    .update(JSON.stringify([projectId, jobId ?? `legacy:${randomUUID()}`, input.seriesId, input.remoteSeriesId]))
    .digest('hex');
  const plan: SeriesDeletionMirrorPlan = {
    seriesId: input.seriesId,
    remoteSeriesId: input.remoteSeriesId,
    projectId,
    planId,
    ...(jobId ? { jobId } : {}),
  };
  const local = localRef(db, plan),
    remote = jobId ? remoteRef(db, plan) : undefined;
  const scopeFingerprint = desiredProviderDeletionDocumentFingerprint(plan);
  const cached = await local.get();
  if (cached.get('state') === 'prepared') {
    await transaction(db, jobId, async (tx) => {
      const latest = await tx.get(local);
      if (latest.get('scopeFingerprint') !== scopeFingerprint || latest.get('state') !== 'prepared') return fail();
    });
    return plan;
  }
  await transaction(db, jobId, async (tx) => {
    const scope = await authority(tx, db, plan);
    const prior = await tx.get(local),
      priorRemote = remote ? await tx.get(remote) : undefined;
    if (prior.exists && prior.get('scopeFingerprint') !== scopeFingerprint) return fail();
    const header = scope
      ? {
          schemaVersion: 1,
          projectId,
          jobId,
          resource: provider(plan),
          resourceType: 'series',
          ...scope,
          method: 'DELETE',
          requestFingerprint: providerMutationFingerprint(['DELETE', { id: input.remoteSeriesId }]),
          state: 'prepared',
        }
      : undefined;
    if (header && priorRemote?.exists)
      for (const key of Object.keys(header).filter((key) => key !== 'state'))
        if (
          desiredProviderDeletionDocumentFingerprint(priorRemote.get(key)) !==
          desiredProviderDeletionDocumentFingerprint((header as Record<string, unknown>)[key])
        )
          return fail();
    if (!prior.exists)
      tx.create(local, {
        schemaVersion: 1,
        projectId,
        ...(jobId ? { jobId } : {}),
        seriesId: input.seriesId,
        remoteSeriesId: input.remoteSeriesId,
        scopeFingerprint,
        state: 'preparing',
      });
    if (remote && header && !priorRemote?.exists) tx.create(remote, header);
  });
  const capture = async (documents: QueryDocumentSnapshot[]) => {
    for (let offset = 0; offset < documents.length; offset += WRITE_PAGE_SIZE) {
      const candidates = documents.slice(offset, offset + WRITE_PAGE_SIZE);
      await transaction(db, jobId, async (tx) => {
        await authority(tx, db, plan);
        const snapshots = await tx.getAll(...candidates.map((doc) => doc.ref));
        const writes: Array<{ ref: ReturnType<Firestore['doc']>; data: Row }> = [];
        for (const snapshot of snapshots) {
          if (!snapshot.exists) continue;
          const projection = projectSeriesDeletionDocument(snapshot.ref.path, snapshot.data(), input);
          if (!projection) continue;
          const row: Row = {
            canonicalPath: snapshot.ref.path,
            sourceFingerprint: desiredProviderDeletionDocumentFingerprint(snapshot.data()),
            expectedDocumentDigest: acknowledgedProjectionDigest(snapshot.data()),
            ...projection,
          };
          const refs = [local.collection('rows').doc(providerEdgeKey(row.canonicalPath))];
          if (
            remote &&
            extractProviderResources(projectId, row.canonicalPath, snapshot.data()).some(
              (entry) =>
                entry.provider === 'subsplash' &&
                entry.account === 'app:9XTSHD' &&
                entry.remoteId === input.remoteSeriesId
            )
          )
            refs.push(remote.collection('removals').doc(providerEdgeKey(row.canonicalPath)));
          const previous = await tx.getAll(...refs);
          for (let index = 0; index < refs.length; index++) {
            if (previous[index].exists) {
              if (
                desiredProviderDeletionDocumentFingerprint(previous[index].data()) !==
                desiredProviderDeletionDocumentFingerprint(row)
              )
                return fail();
            } else writes.push({ ref: refs[index], data: row });
          }
        }
        // Finish every canonical and row-ledger read before creating proof records.
        writes.forEach((write) => tx.create(write.ref, write.data));
      });
    }
  };
  for await (const page of pages(db.collection('series').doc(input.seriesId).collection('seriesItems')))
    await capture(page);
  // Full canonical scans include old copied sermon pointers nested in listItems.
  // Each activity read/write is bounded, with no fleet-sized array or total ceiling.
  for await (const page of pages(db.collection('sermons'))) await capture(page);
  for await (const page of pages(db.collectionGroup('listItems'))) await capture(page);
  await transaction(db, jobId, async (tx) => {
    await authority(tx, db, plan);
    const latest = await tx.get(local);
    if (latest.get('scopeFingerprint') !== scopeFingerprint) return fail();
    tx.update(local, { state: 'prepared' });
  });
  return plan;
}

/** Apply exactly the frozen projection after provider effects prove absence. Replaying
 * an already-applied afterData or an already-missing document is harmless; other changes block.
 * The series root is left to the caller's final canonical/session-settlement transaction.
 */
export async function removeSeriesDeletionMirrors(
  db: Firestore,
  plan: SeriesDeletionMirrorPlan
): Promise<{
  localSeriesItemsDeleted: number;
  localSermonsUnlinked: number;
  localMirrorsUpdated: number;
}> {
  if (getDurablePublishingJobId() !== plan.jobId || firebaseAdmin.app().options.projectId !== plan.projectId)
    return fail();
  const local = localRef(db, plan),
    scopeFingerprint = desiredProviderDeletionDocumentFingerprint(plan);
  const header = await local.get();
  if (header.get('state') !== 'prepared' || header.get('scopeFingerprint') !== scopeFingerprint) return fail();
  const counts = { localSeriesItemsDeleted: 0, localSermonsUnlinked: 0, localMirrorsUpdated: 0 };
  for await (const page of pages(local.collection('rows'))) {
    for (let offset = 0; offset < page.length; offset += WRITE_PAGE_SIZE) {
      const rows = page.slice(offset, offset + WRITE_PAGE_SIZE).map((doc) => doc.data() as Row);
      for (const row of rows) {
        if (row.after === 'absent') counts.localSeriesItemsDeleted++;
        else if (row.canonicalPath.split('/').length === 2) counts.localSermonsUnlinked++;
        else counts.localMirrorsUpdated++;
      }
      await transaction(db, plan.jobId, async (tx) => {
        const latest = await tx.get(local);
        if (latest.get('state') !== 'prepared' || latest.get('scopeFingerprint') !== scopeFingerprint) return fail();
        const snapshots = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
        const pending: Array<() => void> = [];
        for (let index = 0; index < snapshots.length; index++) {
          const snapshot = snapshots[index],
            row = rows[index];
          if (!snapshot.exists) continue;
          const current = desiredProviderDeletionDocumentFingerprint(snapshot.data());
          if (row.after === 'resource_removed' && current === desiredProviderDeletionDocumentFingerprint(row.afterData))
            continue;
          if (current !== row.sourceFingerprint) return fail();
          const expected = projectSeriesDeletionDocument(row.canonicalPath, snapshot.data(), plan);
          if (
            !expected ||
            desiredProviderDeletionDocumentFingerprint(expected) !==
              desiredProviderDeletionDocumentFingerprint(
                row.after === 'absent' ? { after: 'absent' } : { after: 'resource_removed', afterData: row.afterData }
              )
          )
            return fail();
          if (row.after === 'absent') pending.push(() => tx.delete(snapshot.ref));
          else pending.push(() => tx.set(snapshot.ref, row.afterData));
        }
        pending.forEach((write) => write());
      });
    }
  }
  return counts;
}
