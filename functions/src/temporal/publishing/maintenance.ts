import { createHash, randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldPath } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { runSeriesItemSubtitleBackfill } from '../../helpers/backfillSeriesItemSubtitles';
import { runListOverflowMetadataBackfill } from '../../helpers/backfillListOverflowMetadata';
import {
  requireSquareImage,
  requireTrimmedSpeakerName,
  updateSubsplashSpeakerTagSquareImage,
} from '../../speakers/speakerMutations';
import { deriveSubsplashStatus } from '../../utils/deriveSubsplashStatus';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';

export const MAINTENANCE_CHECKPOINTS_COLLECTION = 'temporalEntityCheckpoints';
const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';
const OPERATIONS = ['speaker-tag-images', 'sermon-status', 'series-subtitles', 'list-overflow-metadata'] as const;
export type MaintenanceOperation = (typeof OPERATIONS)[number];
export type MaintenanceInput = Readonly<{
  operation: MaintenanceOperation;
  apply: boolean;
  pageSize: number;
  cursor?: string;
}>;
export type MaintenanceRef = Readonly<{ jobId: string; projectId: string }>;
type Outcome = Readonly<{ planned: number; updated: number; skipped: number }>;
export type MaintenancePageResult = Readonly<{
  counts: Readonly<{ scanned: number; planned: number; updated: number; skipped: number }>;
  processedIds: readonly string[];
  nextCursor?: string;
  done: boolean;
}>;
type PageCheckpoint = {
  fingerprint: string;
  ids: string[];
  done: boolean;
  outcomes: Record<string, Outcome>;
  owner?: string;
  leaseUntil?: number;
  result?: MaintenancePageResult;
};

const isSafeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 1500 &&
  !value.includes('/') &&
  value !== '.' &&
  value !== '..' &&
  !/^__.*__$/.test(value);
const invalid = (): never => {
  throw new HttpsError('invalid-argument', 'Invalid maintenance intent.');
};
/** Strict whitelist: there is no arbitrary collection, provider URL, or script argument. */
export function normalizeMaintenanceInput(raw: unknown): MaintenanceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['operation', 'apply', 'pageSize', 'cursor'].includes(key))) return invalid();
  if (!OPERATIONS.includes(value.operation as MaintenanceOperation)) return invalid();
  if (value.apply !== undefined && typeof value.apply !== 'boolean') return invalid();
  const pageSize = value.pageSize ?? 25;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25) return invalid();
  if (value.cursor !== undefined && !isSafeId(value.cursor)) return invalid();
  return Object.freeze({
    operation: value.operation as MaintenanceOperation,
    apply: value.apply === true,
    pageSize,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
  });
}

export interface MaintenanceDependencies {
  authorize(actorUid: string, operation: MaintenanceOperation): Promise<void>;
  list(input: MaintenanceInput): Promise<{ ids: string[]; done: boolean }>;
  process(id: string, ref: MaintenanceRef, input: MaintenanceInput): Promise<Outcome>;
  checkpoint<T>(
    id: string,
    update: (existing: PageCheckpoint | undefined) => { record?: PageCheckpoint; value: T }
  ): Promise<T>;
  now(): number;
  owner(): string;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outcomeKey = (id: string): string => hash(id);
const sanitizeFailure = (): HttpsError =>
  new HttpsError('unavailable', 'Maintenance could not complete this page. Retry after the provider is available.');

/** Persist the page's membership before processing, then checkpoint after every successful entity.
 * Retry resumes the exact same page, even if records were deleted meanwhile. Only the current
 * uncheckpointed entity can replay; its operations are desired-state writes, never creation POSTs.
 */
export function createMaintenancePageExecutor(deps: MaintenanceDependencies) {
  return async (ref: MaintenanceRef, actorUid: string, raw: MaintenanceInput): Promise<MaintenancePageResult> => {
    const input = normalizeMaintenanceInput(raw);
    if (!isSafeId(ref.jobId) || !/^[a-z][a-z0-9-]{4,62}$/.test(ref.projectId) || !isSafeId(actorUid)) return invalid();
    await deps.authorize(actorUid, input.operation);
    const pageId = hash([ref.projectId, ref.jobId, input.operation, input.cursor ?? '']);
    const fingerprint = hash([actorUid, input]);
    const owner = deps.owner();
    let page = await deps.checkpoint(pageId, (existing) => {
      if (existing && existing.fingerprint !== fingerprint)
        throw new HttpsError('failed-precondition', 'Maintenance intent cannot change during a job.');
      if (existing?.result) return { value: existing };
      if (existing?.owner && (existing.leaseUntil ?? 0) > deps.now())
        throw new HttpsError('aborted', 'This maintenance page is already running.');
      const record: PageCheckpoint = {
        ...existing,
        fingerprint,
        ids: existing?.ids ?? [],
        done: existing?.done ?? false,
        outcomes: existing?.outcomes ?? {},
        owner,
        leaseUntil: deps.now() + 30 * 60_000,
      };
      return { record, value: record };
    });
    if (page.result) return page.result;
    try {
      // An initialized empty page can be read again safely; no entities have been processed.
      if (!page.ids.length && !page.done) {
        const listed = await deps.list(input);
        if (
          listed.ids.length > input.pageSize ||
          listed.ids.some((id) => !isSafeId(id)) ||
          new Set(listed.ids).size !== listed.ids.length
        )
          throw new HttpsError('internal', 'Maintenance page returned invalid IDs.');
        page = await deps.checkpoint(pageId, (existing) => {
          if (!existing || existing.owner !== owner) throw new HttpsError('aborted', 'Maintenance lease changed.');
          const record = { ...existing, ids: listed.ids, done: listed.done };
          return { record, value: record };
        });
      }
      for (const id of page.ids) {
        const key = outcomeKey(id);
        if (page.outcomes[key]) continue;
        const outcome = await deps.process(id, ref, input);
        page = await deps.checkpoint(pageId, (existing) => {
          if (!existing || existing.owner !== owner) throw new HttpsError('aborted', 'Maintenance lease changed.');
          const record = {
            ...existing,
            outcomes: { ...existing.outcomes, [key]: outcome },
            leaseUntil: deps.now() + 30 * 60_000,
          };
          return { record, value: record };
        });
      }
      const counts = Object.values(page.outcomes).reduce<MaintenancePageResult['counts']>(
        (sum, next) => ({
          scanned: sum.scanned + 1,
          planned: sum.planned + next.planned,
          updated: sum.updated + next.updated,
          skipped: sum.skipped + next.skipped,
        }),
        { scanned: 0, planned: 0, updated: 0, skipped: 0 }
      );
      const result: MaintenancePageResult = {
        counts,
        processedIds: page.ids,
        done: page.done,
        ...(!page.done && page.ids.length ? { nextCursor: page.ids[page.ids.length - 1] } : {}),
      };
      await deps.checkpoint(pageId, (existing) => {
        if (!existing || existing.owner !== owner) throw new HttpsError('aborted', 'Maintenance lease changed.');
        return { record: { ...existing, owner: undefined, leaseUntil: 0, result }, value: undefined };
      });
      return result;
    } catch (error) {
      await deps.checkpoint(pageId, (existing) =>
        existing?.owner === owner
          ? { record: { ...existing, owner: undefined, leaseUntil: 0 }, value: undefined }
          : { value: undefined }
      );
      // Never attach provider errors, request payloads, URLs, or credentials to workflow outputs.
      if (error instanceof HttpsError && ['aborted', 'failed-precondition'].includes(error.code)) throw error;
      throw sanitizeFailure();
    }
  };
}

const collectionFor = (operation: MaintenanceOperation): string =>
  ({
    'speaker-tag-images': 'speakers',
    'sermon-status': 'sermons',
    'series-subtitles': 'series',
    'list-overflow-metadata': 'lists',
  }[operation]);

const dependencies: MaintenanceDependencies = {
  now: Date.now,
  owner: randomUUID,
  async authorize(actorUid, operation) {
    const actor = await firebaseAdmin.auth().getUser(actorUid);
    const designated = operation === 'speaker-tag-images' || operation === 'sermon-status';
    if (
      actor.disabled ||
      actor.customClaims?.role !== 'admin' ||
      (designated && (actor.email?.trim().toLowerCase() !== SCRIPT_RUNNER_EMAIL || !actor.emailVerified))
    )
      throw new HttpsError('permission-denied', 'Maintenance requires an authorized administrator.');
  },
  async list(input) {
    let query = firebaseAdmin
      .firestore()
      .collection(collectionFor(input.operation))
      .orderBy(FieldPath.documentId())
      .limit(input.pageSize + 1);
    if (input.cursor) query = query.startAfter(input.cursor);
    const snapshot = await query.get();
    return {
      ids: snapshot.docs.slice(0, input.pageSize).map((doc) => doc.id),
      done: snapshot.docs.length <= input.pageSize,
    };
  },
  async checkpoint(id, update) {
    const db = firebaseAdmin.firestore();
    const ref = db.collection(MAINTENANCE_CHECKPOINTS_COLLECTION).doc(id);
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const next = update(snapshot.exists ? (snapshot.data() as PageCheckpoint) : undefined);
      // Undefined optional ownership is omitted explicitly; Firestore must not rely on global ignoreUndefinedProperties.
      if (next.record) {
        const { owner, ...record } = next.record;
        tx.set(ref, { ...record, ...(owner ? { owner } : {}) });
      }
      return next.value;
    });
  },
  async process(id, ref, input) {
    const db = firebaseAdmin.firestore();
    if (input.operation === 'sermon-status') {
      const doc = db.collection('sermons').doc(id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(doc);
        if (!snapshot.exists) return { planned: 0, updated: 0, skipped: 1 };
        const sermon = snapshot.data()!;
        const status = deriveSubsplashStatus(sermon.numberOfLists, sermon.numberOfListsUploadedTo);
        const changed = (sermon.status?.subsplash ?? uploadStatus.NOT_UPLOADED) !== status;
        if (changed && input.apply) tx.update(doc, { 'status.subsplash': status });
        return { planned: changed ? 1 : 0, updated: changed && input.apply ? 1 : 0, skipped: changed ? 0 : 1 };
      });
    }
    if (input.operation === 'speaker-tag-images') {
      const snapshot = await db.collection('speakers').doc(id).get();
      const speaker = snapshot.data();
      if (!speaker?.tagId) return { planned: 0, updated: 0, skipped: 1 };
      let image;
      try {
        requireTrimmedSpeakerName(speaker.name);
        image = requireSquareImage(speaker.images);
      } catch {
        return { planned: 0, updated: 0, skipped: 1 };
      }
      if (input.apply)
        await updateSubsplashSpeakerTagSquareImage({
          tagId: speaker.tagId,
          squareImage: image,
          operationKey: `temporal-maintenance:${ref.projectId}:${ref.jobId}:${id}`,
        });
      return { planned: 1, updated: input.apply ? 1 : 0, skipped: 0 };
    }
    if (input.operation === 'series-subtitles') {
      const result = await runSeriesItemSubtitleBackfill({
        firestore: db,
        firestoreSeriesId: id,
        apply: input.apply,
        logger: () => {},
      });
      if (result.errors.length) throw sanitizeFailure();
      return {
        planned: result.mismatchesFound,
        updated: result.mediaItemsUpdated,
        skipped: result.unlinkedSeriesSkipped,
      };
    }
    const result = await runListOverflowMetadataBackfill({
      firestore: db,
      listId: id,
      apply: input.apply,
      logger: () => {},
    });
    return { planned: result.documentsPlanned, updated: result.documentsUpdated, skipped: result.chainsSkipped };
  },
};

export const executeMaintenancePage = createMaintenancePageExecutor(dependencies);
