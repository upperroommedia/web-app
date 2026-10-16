import { createHash, randomUUID } from 'node:crypto';
import { Context, heartbeat } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createSearchProviderSession, classifyProviderError, SearchProviderError } from './provider-session';
import {
  searchDigest,
  sourceVersion,
  readSearchTask,
  readConfirmedSearchSave,
  singleSearchTaskId,
  type SearchTaskReceipt,
  type ConfirmedSearchSave,
} from './checkpoint';
import type { DurableJobRef } from '../../../../../packages/contracts/temporal';
import { converge } from '../../../../../function-kits/firestore-algolia-search/src/sync';
import {
  extract,
  objectId,
  type RecordConfig,
} from '../../../../../function-kits/firestore-algolia-search/src/records';

export interface SearchConfig extends RecordConfig {
  appId: string;
  indexName: string;
  collectionPath: string;
  recordPolicy?: string;
}
export interface SearchIntent {
  instanceId: string;
  documentPath?: string;
  previousObjectId?: string;
}
export interface SearchDependencies {
  firestore: Firestore;
  assertCurrent(ref: DurableJobRef): Promise<void>;
  assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<unknown>;
  loadIntent(ref: DurableJobRef): Promise<{ payload: SearchIntent }>;
  configurations: Record<string, SearchConfig & { writeKey: string }>;
  project(
    ref: DurableJobRef,
    patch: {
      state: 'running' | 'retrying' | 'succeeded' | 'superseded' | 'cancelled' | 'needs_attention';
      actions?: ('resume' | 'cancel')[];
      result?: Record<string, unknown>;
    }
  ): Promise<void>;
  enqueueDocument(input: { instanceId: string; documentPath: string; requestId: string }): Promise<DurableJobRef>;
}
export interface SearchActivities {
  syncSearchDocument(ref: DurableJobRef): Promise<void>;
  searchBackfillPage(
    ref: DurableJobRef,
    cursor?: string
  ): Promise<{ cursor?: string; jobs: DurableJobRef[]; complete: boolean }>;
  confirmSearchPage(jobs: DurableJobRef[]): Promise<boolean>;
  finishSearch(ref: DurableJobRef, state: 'cancelled' | 'needs_attention' | 'superseded'): Promise<void>;
  finishSearchBackfill(ref: DurableJobRef, count: number): Promise<void>;
}
export function createSearchActivities(deps: SearchDependencies): SearchActivities {
  async function authorizeSearch(ref: DurableJobRef) {
    try {
      await deps.assertCurrent(ref);
    } catch (error) {
      if ((error as { code?: string })?.code === 'PERMISSION_CHANGED')
        throw ApplicationFailure.nonRetryable('Search permission changed', 'SearchPermissionChanged');
      throw error;
    }
  }
  async function configuration(ref: DurableJobRef) {
    const { payload } = await deps.loadIntent(ref);
    const config = deps.configurations[payload.instanceId];
    if (!config || config.projectId !== ref.projectId)
      throw ApplicationFailure.nonRetryable(
        'Search instance is not configured for this project',
        'SearchConfigurationInvalid'
      );
    return {
      intent: payload,
      config,
    };
  }
  return {
    async syncSearchDocument(ref) {
      const { intent, config } = await configuration(ref);
      if (config.recordPolicy === 'empty-private') {
        await deps.project(ref, { state: 'succeeded' });
        return;
      }
      if (!intent.documentPath)
        throw ApplicationFailure.nonRetryable('Search source is missing', 'SearchSourceInvalid');
      const targetDigest = searchDigest([
        ref.projectId,
        config.appId,
        config.indexName,
        intent.instanceId,
        intent.documentPath,
        config.collectionPath,
        config.fields,
        config.altObjectId,
        config.transformFunction,
        config.recordPolicy ?? null,
      ]);
      const lock = deps.firestore
        .collection('_algoliaSyncLocks')
        .doc(createHash('sha256').update(`${intent.instanceId}:${intent.documentPath}`).digest('hex'));
      const owner = randomUUID();
      let state: Record<string, unknown> = {};
      await deps.firestore.runTransaction(async (tx) => {
        await deps.assertCurrentInTransaction(tx, ref);
        const saved = (await tx.get(lock)).data() ?? {};
        if (saved.leaseUntil > Date.now())
          throw ApplicationFailure.retryable('Search document is already being synchronized', 'SearchLeaseBusy');
        state = saved;
        tx.set(lock, { owner, leaseUntil: Date.now() + 600000 }, { merge: true });
      });
      const timer = setInterval(() => heartbeat({ documentPath: intent.documentPath }), 5000);
      let session: ReturnType<typeof createSearchProviderSession> | undefined;
      const mutateOwned = async (patch: (saved: Record<string, unknown>) => Record<string, unknown>) => {
        state = await deps.firestore.runTransaction(async (tx) => {
          await deps.assertCurrentInTransaction(tx, ref);
          const saved = (await tx.get(lock)).data() ?? {};
          if (saved.owner !== owner || !Number.isFinite(saved.leaseUntil) || saved.leaseUntil <= Date.now())
            throw ApplicationFailure.nonRetryable('Search lease is no longer current', 'SearchLeaseLost');
          const next = patch(saved);
          tx.set(lock, next, { merge: true });
          return { ...saved, ...next };
        });
      };
      try {
        // This session owns all provider I/O for the attempt. The deadline never resets per object/poll.
        session = createSearchProviderSession({
          appId: config.appId,
          writeKey: config.writeKey,
          cancellation: Context.current().cancellationSignal,
        });
        const activeSession = session;
        const deleted = new Set<string>();
        const settle = async (receipt: SearchTaskReceipt) => {
          await authorizeSearch(ref);
          await activeSession.waitPublished(config.indexName, receipt.taskID);
          activeSession.check();
          await mutateOwned((saved) => {
            const pending = readSearchTask(saved.pendingAlgoliaTask, targetDigest);
            if (!pending || searchDigest(pending) !== searchDigest(receipt))
              throw new SearchProviderError('SearchTaskReceiptChanged', true);
            const next: Record<string, unknown> = { pendingAlgoliaTask: null };
            if (receipt.action === 'addObject') {
              next.lastObjectId = receipt.objectId;
              if (saved.pendingObjectId === receipt.objectId) next.pendingObjectId = null;
              next.confirmedSearchSave = {
                schemaVersion: 1,
                confirmedForJobId: ref.jobId,
                targetDigest,
                objectId: receipt.objectId,
                sourceVersion: receipt.sourceVersion,
                recordDigest: receipt.recordDigest!,
              } satisfies ConfirmedSearchSave;
            } else {
              if (saved.lastObjectId === receipt.objectId) next.lastObjectId = null;
              if (saved.pendingObjectId === receipt.objectId) next.pendingObjectId = null;
              if ((saved.confirmedSearchSave as ConfirmedSearchSave | undefined)?.objectId === receipt.objectId)
                next.confirmedSearchSave = null;
            }
            return next;
          });
          if (receipt.action === 'deleteObject') deleted.add(receipt.objectId);
        };
        await deps.project(ref, { state: Context.current().info.attempt > 1 ? 'retrying' : 'running' });
        const pending = readSearchTask(state.pendingAlgoliaTask, targetDigest);
        if (pending) await settle(pending); // Never POST again while the previous task's outcome is known but pending.
        const write = async (
          action: SearchTaskReceipt['action'],
          id: string,
          version: string,
          record?: Record<string, unknown>
        ) => {
          activeSession.check();
          await authorizeSearch(ref);
          await mutateOwned((saved) => {
            if (readSearchTask(saved.pendingAlgoliaTask, targetDigest))
              throw new SearchProviderError('SearchTaskReceiptChanged', true);
            // This survives the unavoidable ACK-lost-before-taskID window, preserving old-ID cleanup.
            return action === 'addObject' ? { pendingObjectId: id } : {};
          });
          await authorizeSearch(ref);
          activeSession.check();
          const result =
            action === 'addObject'
              ? await activeSession.client.saveObjects({
                  indexName: config.indexName,
                  objects: [record!],
                  waitForTasks: false,
                })
              : await activeSession.client.deleteObjects({
                  indexName: config.indexName,
                  objectIDs: [id],
                  waitForTasks: false,
                });
          const receipt: SearchTaskReceipt = {
            schemaVersion: 1,
            targetDigest,
            action,
            objectId: id,
            taskID: singleSearchTaskId(result),
            sourceVersion: version,
            requestedByJobId: ref.jobId,
            ...(record ? { recordDigest: searchDigest(record) } : {}),
          };
          // Persist the actual ACK before polling; no taskID guessed from request correlation IDs.
          await mutateOwned((saved) => {
            if (readSearchTask(saved.pendingAlgoliaTask, targetDigest))
              throw new SearchProviderError('SearchTaskReceiptChanged', true);
            return { pendingAlgoliaTask: receipt };
          });
          await settle(receipt);
        };
        await converge(
          () => deps.firestore.doc(intent.documentPath!).get(),
          async (snapshot) => {
            activeSession.check();
            const version = sourceVersion(snapshot);
            const currentId = snapshot.exists ? objectId(snapshot, config.altObjectId) : undefined;
            for (const oldId of new Set([state.lastObjectId, state.pendingObjectId, intent.previousObjectId])) {
              if (oldId !== undefined && oldId !== null && (typeof oldId !== 'string' || !oldId))
                throw new SearchProviderError('SearchLockIdentityInvalid', true);
              if (typeof oldId === 'string' && oldId !== currentId && !deleted.has(oldId))
                await write('deleteObject', oldId, version);
            }
            if (snapshot.exists) {
              const record = await extract(snapshot, config);
              const confirmed = readConfirmedSearchSave(state.confirmedSearchSave, targetDigest);
              if (
                !confirmed ||
                confirmed.confirmedForJobId !== ref.jobId ||
                confirmed.objectId !== currentId ||
                confirmed.sourceVersion !== version ||
                confirmed.recordDigest !== searchDigest(record)
              )
                await write('addObject', currentId!, version, record);
            }
            await mutateOwned(() => ({ lastObjectId: currentId ?? null, pendingObjectId: null }));
          }
        );
        activeSession.check();
        await deps.project(ref, { state: 'succeeded' });
      } catch (error) {
        if ((error as { code?: string })?.code === 'STALE_GENERATION') {
          await deps.project(ref, { state: 'superseded' });
          return;
        }
        if (Context.current().cancellationSignal.aborted) throw error;
        if (error instanceof ApplicationFailure) throw error;
        const failure = classifyProviderError(error);
        throw ApplicationFailure.create({
          message: 'Search synchronization could not be confirmed',
          type: failure.code,
          nonRetryable: failure.nonRetryable,
        });
      } finally {
        // No Promise.race: every provider promise settled before close and lock release.
        session?.close();
        clearInterval(timer);
        await deps.firestore.runTransaction(async (tx) => {
          const saved = (await tx.get(lock)).data();
          if (saved?.owner === owner) tx.set(lock, { owner: null, leaseUntil: 0 }, { merge: true });
        });
      }
    },
    async searchBackfillPage(ref, cursor) {
      const { intent, config } = await configuration(ref);
      await deps.project(ref, { state: Context.current().info.attempt > 1 ? 'retrying' : 'running' });
      const group = /\{[^}]+\}/.test(config.collectionPath);
      let query = (
        group
          ? deps.firestore.collectionGroup(config.collectionPath.split('/').at(-1)!)
          : deps.firestore.collection(config.collectionPath)
      )
        .orderBy(FieldPath.documentId())
        .limit(25);
      if (cursor) query = query.startAfter(group ? deps.firestore.doc(cursor) : cursor);
      const page = await query.get();
      const jobs: DurableJobRef[] = [];
      for (const doc of page.docs) {
        await authorizeSearch(ref);
        heartbeat({ cursor: doc.ref.path });
        jobs.push(
          await deps.enqueueDocument({
            instanceId: intent.instanceId,
            documentPath: doc.ref.path,
            requestId: `backfill:${ref.jobId}:${doc.ref.path}`,
          })
        );
      }
      return {
        jobs,
        complete: page.size < 25,
        ...(page.size ? { cursor: group ? page.docs.at(-1)!.ref.path : page.docs.at(-1)!.id } : {}),
      };
    },
    ...createSearchControlActivities(deps),
  };
}

export type SearchControlActivities = Pick<
  SearchActivities,
  'confirmSearchPage' | 'finishSearch' | 'finishSearchBackfill'
>;
export function createSearchControlActivities(
  deps: Pick<SearchDependencies, 'firestore' | 'project'>
): SearchControlActivities {
  return {
    async confirmSearchPage(jobs) {
      let allComplete = true;
      for (const job of jobs) {
        let saved = (await deps.firestore.collection('durableJobs').doc(job.jobId).get()).data();
        if (saved?.state === 'superseded') {
          const key = createHash('sha256')
            .update(JSON.stringify([job.projectId, saved.entity.type, saved.entity.id, 'search']))
            .digest('hex');
          const current = (await deps.firestore.collection('durableJobEntities').doc(key).get()).data();
          if (!current?.activeJobId) return false;
          saved = (await deps.firestore.collection('durableJobs').doc(current.activeJobId).get()).data();
        }
        if (['failed', 'cancelled', 'needs_attention'].includes(saved?.state))
          throw ApplicationFailure.nonRetryable('A backfill document requires attention', 'SearchBackfillIncomplete');
        allComplete &&= saved?.state === 'succeeded';
      }
      return allComplete;
    },
    async finishSearch(ref, state) {
      await deps.project(ref, { state, actions: state === 'needs_attention' ? ['resume', 'cancel'] : [] });
    },
    async finishSearchBackfill(ref, count) {
      await deps.project(ref, { state: 'succeeded', result: { count } });
    },
  };
}
