import { createHash, randomUUID } from 'node:crypto';
import { Context, heartbeat } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { algoliasearch } from 'algoliasearch';
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
      client: algoliasearch(config.appId, config.writeKey, { timeouts: { connect: 5000, read: 15000, write: 15000 } }),
    };
  }
  return {
    async syncSearchDocument(ref) {
      const { intent, config, client } = await configuration(ref);
      if (config.recordPolicy === 'empty-private') {
        await deps.project(ref, { state: 'succeeded' });
        return;
      }
      if (!intent.documentPath)
        throw ApplicationFailure.nonRetryable('Search source is missing', 'SearchSourceInvalid');
      const lock = deps.firestore
        .collection('_algoliaSyncLocks')
        .doc(createHash('sha256').update(`${intent.instanceId}:${intent.documentPath}`).digest('hex'));
      const owner = randomUUID();
      let lastObjectId: string | undefined;
      let pendingObjectId: string | undefined;
      await deps.firestore.runTransaction(async (tx) => {
        const saved = (await tx.get(lock)).data();
        if (saved?.leaseUntil > Date.now())
          throw ApplicationFailure.retryable('Search document is already being synchronized', 'SearchLeaseBusy');
        lastObjectId = saved?.lastObjectId;
        pendingObjectId = saved?.pendingObjectId;
        tx.set(lock, { owner, leaseUntil: Date.now() + 600000 }, { merge: true });
      });
      const timer = setInterval(() => heartbeat({ documentPath: intent.documentPath }), 5000);
      try {
        await deps.project(ref, { state: Context.current().info.attempt > 1 ? 'retrying' : 'running' });
        const started = Date.now();
        await converge(
          () => deps.firestore.doc(intent.documentPath!).get(),
          async (snapshot) => {
            Context.current().cancellationSignal.throwIfAborted();
            if (Date.now() - started > 180000) throw new Error('Search lease budget exhausted');
            // A bounded lease and shared legacy lock serialize old and new owners during drain.
            const currentId = snapshot.exists ? objectId(snapshot, config.altObjectId) : undefined;
            for (const oldId of new Set([lastObjectId, pendingObjectId, intent.previousObjectId])) {
              if (oldId && oldId !== currentId) {
                await authorizeSearch(ref);
                await client.deleteObjects({
                  indexName: config.indexName,
                  objectIDs: [oldId],
                  waitForTasks: true,
                  maxRetries: 2,
                });
              }
            }
            if (snapshot.exists) {
              const record = await extract(snapshot, config);
              await lock.set({ pendingObjectId: currentId }, { merge: true });
              pendingObjectId = currentId;
              await authorizeSearch(ref);
              await client.saveObjects({
                indexName: config.indexName,
                objects: [record],
                waitForTasks: true,
                maxRetries: 2,
              });
            }
            lastObjectId = currentId;
            await lock.set({ lastObjectId: currentId ?? null, pendingObjectId: null }, { merge: true });
            pendingObjectId = undefined;
          }
        );
        await deps.project(ref, { state: 'succeeded' });
      } catch (error) {
        if (error instanceof ApplicationFailure && error.type === 'SearchPermissionChanged') throw error;
        if ((error as { code?: string })?.code === 'STALE_GENERATION') {
          await deps.project(ref, { state: 'superseded' });
          return;
        }
        if (Context.current().cancellationSignal.aborted) throw error;
        throw ApplicationFailure.retryable('Search synchronization could not be confirmed', 'SearchProviderFailure');
      } finally {
        clearInterval(timer);
        await deps.firestore.runTransaction(async (tx) => {
          const saved = (await tx.get(lock)).data();
          if (saved?.owner === owner) tx.set(lock, { owner: null, leaseUntil: 0 }, { merge: true });
        });
      }
    },
    async searchBackfillPage(ref, cursor) {
      const { intent, config } = await configuration(ref);
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
