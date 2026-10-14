import { createHash } from 'node:crypto';
import axios from '../providerSandbox/http';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  FieldPath,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  getDurablePublishingJobId,
  getPublishingMutationOperation,
  runDurableTransaction,
  prepareAcknowledgedProjectionPlan,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
} from '../temporal/publishing/providerMutationGuard';
import { providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import {
  acknowledgedProjectionDigest,
  type FrozenProjectionWrite,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import {
  desiredProviderDeletionPlanId,
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
  providerEdgeKey,
  extractProviderResources,
  type ProviderResource,
} from '../../../packages/orchestration/src/provider-usage';

export const SPEAKER_DELETION_MIRROR_PLANS = 'temporalSpeakerDeletionMirrorPlans';
const PAGE_SIZE = 200;
const WRITE_PAGE_SIZE = 64;
export type SpeakerDeletionMirrorInput = Readonly<{ speakerId: string; tagId: string }>;
export type SpeakerDeletionMirrorHandle = Readonly<
  SpeakerDeletionMirrorInput & {
    projectId: string;
    jobId: string;
    operation: string;
    planId: string;
    requestStep: string;
  }
>;
type Row = {
  canonicalPath: string;
  sourceFingerprint: string;
  expectedDocumentDigest: string;
  after: 'resource_removed';
  afterData: Record<string, unknown>;
};
const fail = (): never => {
  throw new Error('SPEAKER_DELETION_MIRROR_PROOF_INVALID');
};
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const provider = (handle: SpeakerDeletionMirrorHandle): ProviderResource => ({
  projectId: handle.projectId,
  provider: 'subsplash',
  account: 'app:9XTSHD',
  remoteId: handle.tagId,
});
const localRef = (db: Firestore, handle: SpeakerDeletionMirrorHandle) =>
  db.collection(SPEAKER_DELETION_MIRROR_PLANS).doc(handle.planId);
const remoteRef = (db: Firestore, handle: SpeakerDeletionMirrorHandle) =>
  db
    .collection('temporalProviderDesiredDeletionPlans')
    .doc(desiredProviderDeletionPlanId({ resource: provider(handle), jobId: handle.jobId, resourceType: 'tag' }));

/** A canonical ID outranks legacy tag aliases. Names never prove deletion ownership. */
export function speakerDeletionReferenceMatches(candidate: unknown, input: SpeakerDeletionMirrorInput): boolean {
  const value = object(candidate);
  if (!value) return false;
  if (typeof value.id === 'string' && value.id.trim()) return value.id === input.speakerId;
  return value.tagId === input.tagId;
}
/** Preserve the entire row and prune only the selected speaker in recognized copies. */
export function projectSpeakerDeletionDocument(
  path: string,
  data: unknown,
  input: SpeakerDeletionMirrorInput
): Record<string, unknown> | undefined {
  const parts = path.split('/');
  const canonical = parts.length === 2 && parts[0] === 'sermons';
  const mirror =
    parts.length === 4 &&
    ((parts[0] === 'lists' && parts[2] === 'listItems') || (parts[0] === 'series' && parts[2] === 'seriesItems'));
  const before = object(data);
  if ((!canonical && !mirror) || !before) return undefined;
  let changed = false;
  const prune = (speakers: unknown[]): unknown[] => {
    const next = speakers.filter((speaker) => !speakerDeletionReferenceMatches(speaker, input));
    if (next.length !== speakers.length) changed = true;
    return next;
  };
  const after = { ...before };
  if (Array.isArray(before.speakers)) after.speakers = prune(before.speakers);
  const embedded = object(before.mediaItem);
  if (embedded && Array.isArray(embedded.speakers))
    after.mediaItem = { ...embedded, speakers: prune(embedded.speakers) };
  return changed ? after : undefined;
}
async function* pages(query: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const ordered = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    const page = await (cursor ? ordered.startAfter(cursor) : ordered).get();
    if (page.empty) return;
    yield page.docs;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) return;
  }
}
function validateHandle(handle: SpeakerDeletionMirrorHandle): void {
  if (
    !validId(handle.speakerId) ||
    !validId(handle.tagId) ||
    !validId(handle.projectId) ||
    handle.jobId !== getDurablePublishingJobId() ||
    handle.operation !== getPublishingMutationOperation() ||
    firebaseAdmin.app().options.projectId !== handle.projectId ||
    !/^[a-f0-9]{64}$/.test(handle.planId) ||
    handle.planId !==
      createHash('sha256')
        .update(JSON.stringify([handle.projectId, handle.jobId, handle.operation, handle.speakerId, handle.tagId]))
        .digest('hex') ||
    handle.requestStep !==
      `deleteSubsplashTagRemote:${handle.tagId}:${providerPayloadFingerprint({ id: handle.tagId })}`
  )
    return fail();
}
async function authority(tx: Transaction, db: Firestore, handle: SpeakerDeletionMirrorHandle, requireSpeaker = true) {
  const [intentSnapshot, jobSnapshot] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${handle.jobId}`)),
    tx.get(db.doc(`durableJobs/${handle.jobId}`)),
  ]);
  const intent = intentSnapshot.data(),
    job = jobSnapshot.data(),
    domain = intent?.payload;
  if (
    !intent ||
    !job ||
    intent.projectId !== handle.projectId ||
    intent.jobId !== handle.jobId ||
    job.projectId !== intent.projectId ||
    job.jobId !== intent.jobId ||
    job.kind !== intent.kind ||
    job.generation !== intent.generation ||
    job.entity?.type !== intent.entity?.type ||
    job.entity?.id !== intent.entity?.id ||
    intent.kind !== 'speaker.mutate' ||
    intent.entity?.type !== 'speaker' ||
    intent.entity?.id !== handle.speakerId ||
    domain?.kind !== intent.kind ||
    domain?.entity?.type !== intent.entity.type ||
    domain?.entity?.id !== intent.entity.id ||
    domain?.payload?.operation !== 'delete' ||
    domain.payload.input?.speakerId !== handle.speakerId ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    !['running', 'retrying', 'reconciling', 'needs_attention'].includes(job.state)
  )
    return fail();
  if (requireSpeaker) {
    const speaker = await tx.get(db.doc(`speakers/${handle.speakerId}`));
    if (!speaker.exists || speaker.get('tagId') !== handle.tagId) return fail();
  }
  return {
    entity: intent.entity,
    generation: intent.generation,
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
  };
}

/** Stream immutable <=64-write certificate fragments before the first DELETE claim.
 * Repeated identical unclaimed request headers are handled by the certificate SDK;
 * no fleet-sized row array is assembled in this adapter.
 */
async function freezeAcknowledgedMirrors(db: Firestore, handle: SpeakerDeletionMirrorHandle): Promise<void> {
  const target = {
    provider: 'subsplash' as const,
    account: 'app:9XTSHD',
    resourceType: 'tag',
    resourceId: handle.tagId,
  };
  const payload = { id: handle.tagId };
  const request = {
    step: handle.requestStep,
    method: 'DELETE' as const,
    target,
    payload,
    fingerprint: publishingMutationRequestFingerprint({ method: 'DELETE', target, payload }),
  };
  await runDurableTransaction(db, async (tx) => {
    await authority(tx, db, handle);
    const frozen = await prepareAcknowledgedProjectionPlan(tx, {
      operation: handle.operation,
      requests: [request],
      writes: [
        {
          path: `speakers/${handle.speakerId}`,
          expectedFields: { tagId: handle.tagId },
          patch: {},
          deleteFields: ['tagId'],
          requiredSteps: [handle.requestStep],
        },
      ],
      verifications: [
        {
          ...target,
          resourceType: 'tag',
          expectedState: 'absent',
          expectedProviderFields: {},
          requiredSteps: [handle.requestStep],
        },
      ],
      finalFragment: false,
      completesActivity: false,
    });
    frozen.commit();
  });
  for await (const page of pages(localRef(db, handle).collection('rows'))) {
    for (let offset = 0; offset < page.length; offset += WRITE_PAGE_SIZE) {
      const rows = page.slice(offset, offset + WRITE_PAGE_SIZE).map((doc) => doc.data() as Row);
      await runDurableTransaction(db, async (tx) => {
        await authority(tx, db, handle);
        const snapshots = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
        const writes: FrozenProjectionWrite[] = rows.map((row, index) => {
          if (
            !snapshots[index].exists ||
            desiredProviderDeletionDocumentFingerprint(snapshots[index].data()) !== row.sourceFingerprint
          )
            return fail();
          const patch: Record<string, unknown> = {};
          if (Array.isArray(row.afterData.speakers)) patch.speakers = row.afterData.speakers;
          if (Array.isArray(object(row.afterData.mediaItem)?.speakers))
            patch['mediaItem.speakers'] = object(row.afterData.mediaItem)!.speakers;
          return {
            path: row.canonicalPath,
            expectedExists: true,
            expectedDocumentDigest: row.expectedDocumentDigest,
            expectedFields: {},
            patch,
            requiredSteps: [handle.requestStep],
          };
        });
        const frozen = await prepareAcknowledgedProjectionPlan(tx, {
          operation: handle.operation,
          requests: [request],
          writes,
          finalFragment: false,
          completesActivity: false,
          verifications: [
            {
              ...target,
              resourceType: 'tag',
              expectedState: 'absent',
              expectedProviderFields: {},
              requiredSteps: [handle.requestStep],
            },
          ],
        });
        frozen.commit();
      });
    }
  }
  await runDurableTransaction(db, async (tx) => {
    await authority(tx, db, handle);
    const seal = await prepareAcknowledgedProjectionPlan(tx, {
      operation: handle.operation,
      requests: [request],
      writes: [],
      verifications: [],
      finalFragment: true,
      completesActivity: false,
    });
    seal.commit();
  });
}

/** Trusted worker-only: preparation creates private proof rows, never canonical pruning. */
export async function prepareSpeakerDeletionMirrors(
  db: Firestore,
  input: SpeakerDeletionMirrorInput
): Promise<SpeakerDeletionMirrorHandle> {
  const projectId = firebaseAdmin.app().options.projectId,
    jobId = getDurablePublishingJobId(),
    operation = getPublishingMutationOperation();
  if (!validId(projectId) || !validId(input.speakerId) || !validId(input.tagId) || !jobId || !operation) return fail();
  const handle: SpeakerDeletionMirrorHandle = {
    ...input,
    projectId,
    jobId,
    operation,
    planId: createHash('sha256')
      .update(JSON.stringify([projectId, jobId, operation, input.speakerId, input.tagId]))
      .digest('hex'),
    requestStep: `deleteSubsplashTagRemote:${input.tagId}:${providerPayloadFingerprint({ id: input.tagId })}`,
  };
  const local = localRef(db, handle),
    remote = remoteRef(db, handle),
    scopeFingerprint = desiredProviderDeletionDocumentFingerprint(handle);
  const cached = await local.get();
  if (cached.get('state') === 'prepared') {
    await runDurableTransaction(db, async (tx) => {
      const current = await tx.get(local);
      if (current.get('scopeFingerprint') !== scopeFingerprint || current.get('state') !== 'prepared') return fail();
    });
    return handle;
  }
  await runDurableTransaction(db, async (tx) => {
    const scope = await authority(tx, db, handle);
    const [prior, priorRemote] = await Promise.all([tx.get(local), tx.get(remote)]);
    if (prior.exists && prior.get('scopeFingerprint') !== scopeFingerprint) return fail();
    const header = {
      schemaVersion: 1,
      projectId,
      jobId,
      resource: provider(handle),
      resourceType: 'tag',
      ...scope,
      method: 'DELETE',
      requestFingerprint: providerMutationFingerprint(['DELETE', { id: input.tagId }]),
      state: 'prepared',
    };
    if (priorRemote.exists)
      for (const key of Object.keys(header).filter((key) => key !== 'state'))
        if (
          desiredProviderDeletionDocumentFingerprint(priorRemote.get(key)) !==
          desiredProviderDeletionDocumentFingerprint((header as Record<string, unknown>)[key])
        )
          return fail();
    if (!prior.exists) tx.create(local, { schemaVersion: 1, ...handle, scopeFingerprint, state: 'preparing' });
    if (!priorRemote.exists) tx.create(remote, header);
  });
  const capture = async (documents: QueryDocumentSnapshot[]) => {
    for (let offset = 0; offset < documents.length; offset += WRITE_PAGE_SIZE) {
      const candidates = documents.slice(offset, offset + WRITE_PAGE_SIZE);
      await runDurableTransaction(db, async (tx) => {
        await authority(tx, db, handle);
        const snapshots = await tx.getAll(...candidates.map((doc) => doc.ref));
        const pending: Array<{ ref: ReturnType<Firestore['doc']>; row: Row }> = [];
        for (const snapshot of snapshots) {
          if (!snapshot.exists) continue;
          const afterData = projectSpeakerDeletionDocument(snapshot.ref.path, snapshot.data(), input);
          if (!afterData) continue;
          const row: Row = {
            canonicalPath: snapshot.ref.path,
            sourceFingerprint: desiredProviderDeletionDocumentFingerprint(snapshot.data()),
            expectedDocumentDigest: acknowledgedProjectionDigest(snapshot.data()),
            after: 'resource_removed',
            afterData,
          };
          const refs = [local.collection('rows').doc(providerEdgeKey(row.canonicalPath))];
          if (
            extractProviderResources(projectId, row.canonicalPath, snapshot.data()).some(
              (resource) =>
                resource.provider === 'subsplash' &&
                resource.account === 'app:9XTSHD' &&
                resource.remoteId === input.tagId
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
            } else pending.push({ ref: refs[index], row });
          }
        }
        pending.forEach((write) => tx.create(write.ref, write.row));
      });
    }
  };
  for await (const page of pages(db.collection('sermons'))) await capture(page);
  for await (const page of pages(db.collectionGroup('listItems'))) await capture(page);
  for await (const page of pages(db.collectionGroup('seriesItems'))) await capture(page);
  await freezeAcknowledgedMirrors(db, handle);
  await runDurableTransaction(db, async (tx) => {
    await authority(tx, db, handle);
    const current = await tx.get(local);
    if (current.get('scopeFingerprint') !== scopeFingerprint) return fail();
    tx.update(local, { state: 'prepared' });
  });
  return handle;
}

async function assertKnownOriginalDelete(db: Firestore, handle: SpeakerDeletionMirrorHandle): Promise<void> {
  await runDurableTransaction(db, async (tx) => {
    await authority(tx, db, handle, false);
    const scope = { projectId: handle.projectId, jobId: handle.jobId, operation: handle.operation };
    const sessionId = providerMutationFingerprint(scope),
      sessionRef = db.collection(PROVIDER_MUTATION_SESSIONS).doc(sessionId);
    const [sessionSnapshot, request] = await Promise.all([
      tx.get(sessionRef),
      tx.get(sessionRef.collection('requests').doc(providerMutationFingerprint(handle.requestStep))),
    ]);
    const target = {
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'tag',
      resourceId: handle.tagId,
    };
    const fingerprint = publishingMutationRequestFingerprint({
      method: 'DELETE',
      target,
      payload: { id: handle.tagId },
    });
    if (
      !sessionSnapshot.exists ||
      !['active', 'committed'].includes(sessionSnapshot.get('state')) ||
      providerMutationFingerprint(sessionSnapshot.get('scope')) !== providerMutationFingerprint(scope) ||
      !request.exists ||
      request.get('step') !== handle.requestStep ||
      request.get('method') !== 'DELETE' ||
      request.get('fingerprint') !== fingerprint ||
      !['acknowledged', 'rejected_no_effect'].includes(request.get('state'))
    )
      return fail();
    const session: ProviderMutationSession = { db, id: sessionId, scope, resources: sessionSnapshot.get('resources') };
    await validateProviderMutationOriginalCompletion(tx, session, [request as QueryDocumentSnapshot]);
  });
}
/** No provider mutation is issued here. A fresh fixed-ID GET and original DELETE fact
 * must both establish absence before any canonical copy changes.
 */
export async function removeSpeakerDeletionMirrors(
  db: Firestore,
  handle: SpeakerDeletionMirrorHandle
): Promise<{
  sermonsUpdated: number;
  listMirrorsUpdated: number;
  seriesMirrorsUpdated: number;
}> {
  validateHandle(handle);
  const local = localRef(db, handle),
    scopeFingerprint = desiredProviderDeletionDocumentFingerprint(handle);
  const header = await local.get();
  if (header.get('state') !== 'prepared' || header.get('scopeFingerprint') !== scopeFingerprint) return fail();
  await assertKnownOriginalDelete(db, handle);
  const token = await authenticateSubsplash();
  let absent = false;
  try {
    await axios({
      ...createAxiosConfig(`https://core.subsplash.com/tags/v1/tags/${encodeURIComponent(handle.tagId)}`, token, 'GET'),
      maxRedirects: 0,
      timeout: 30000,
    });
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status !== 404 && status !== 410) throw error;
    absent = true;
  }
  if (!absent) throw new Error('SPEAKER_DELETION_PROVIDER_ABSENCE_REQUIRED');
  const counts = { sermonsUpdated: 0, listMirrorsUpdated: 0, seriesMirrorsUpdated: 0 };
  for await (const page of pages(local.collection('rows'))) {
    for (let offset = 0; offset < page.length; offset += WRITE_PAGE_SIZE) {
      const rows = page.slice(offset, offset + WRITE_PAGE_SIZE).map((doc) => doc.data() as Row);
      for (const row of rows) {
        if (row.canonicalPath.startsWith('sermons/')) counts.sermonsUpdated++;
        else if (row.canonicalPath.startsWith('lists/')) counts.listMirrorsUpdated++;
        else if (row.canonicalPath.startsWith('series/')) counts.seriesMirrorsUpdated++;
        else return fail();
      }
      await runDurableTransaction(db, async (tx) => {
        const snapshots = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
        const pending: Array<() => void> = [];
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index],
            snapshot = snapshots[index];
          if (row.after !== 'resource_removed' || !row.afterData || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint))
            return fail();
          if (!snapshot.exists) continue;
          const current = desiredProviderDeletionDocumentFingerprint(snapshot.data());
          if (current === desiredProviderDeletionDocumentFingerprint(row.afterData)) continue;
          if (current !== row.sourceFingerprint) return fail();
          const after = projectSpeakerDeletionDocument(row.canonicalPath, snapshot.data(), handle);
          if (
            !after ||
            desiredProviderDeletionDocumentFingerprint(after) !==
              desiredProviderDeletionDocumentFingerprint(row.afterData)
          )
            return fail();
          pending.push(() => tx.set(snapshot.ref, row.afterData));
        }
        pending.forEach((write) => write());
      });
    }
  }
  return counts;
}
