/* Copyright 2021 Algolia. Adapted from firestore-algolia-search 1.3.0.
 * Licensed under the Apache License, Version 2.0; see ../LICENSE.
 */
import { createHash, randomUUID } from 'node:crypto';
import { algoliasearch } from 'algoliasearch';
import { getApps, initializeApp } from 'firebase-admin/app';
import { DocumentSnapshot, FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { requiresAPI, requiresRole, logger } from 'firebase-functions';
import { afterFirstDeploy, afterRedeploy } from 'firebase-functions/lifecycle';
import { defineSecret, defineString, expr } from 'firebase-functions/params';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { extract, objectId } from './records';
import { converge } from './sync';
import { migratedRuntimeOptions } from './runtime-options';
import { enqueueSearchIntent, temporalSearchEnabled, assertLegacySearchOwnership } from './temporal-outbox';

const migratedOptions = migratedRuntimeOptions(process.env);

const collectionPath = defineString('COLLECTION_PATH');
const databaseId = defineString('DATABASE_ID', {default: '(default)'});
const location = defineString('LOCATION', {default: 'us-central1'});
const appId = defineString('ALGOLIA_APP_ID');
const apiKey = defineSecret('ALGOLIA_API_KEY');
const indexName = defineString('ALGOLIA_INDEX_NAME');
const indexedFields = defineString('FIELDS', {default: ''});
const alternateId = defineString('ALT_OBJECT_ID', {default: ''});
const transformFunction = defineString('TRANSFORM_FUNCTION', {default: ''});
const fullIndexing = defineString('DO_FULL_INDEXING', {default: 'true'});
// Retain the existing extension parameter for configuration export compatibility.
// All writes now read current state; FORCE_DATA_SYNC=no also gains ordering protection.
defineString('FORCE_DATA_SYNC', {default: 'yes'});
requiresAPI('firestore.googleapis.com', 'Read indexed documents and coordinate indexing');
requiresAPI('cloudtasks.googleapis.com', 'Paginated full indexing');
requiresRole('roles/datastore.user');
requiresRole("roles/eventarc.eventReceiver");
requiresRole('roles/cloudtasks.enqueuer');
requiresRole('roles/run.invoker');

function runtime() {
  const app = getApps()[0] ?? initializeApp();
  return {db: getFirestore(app, databaseId.value()), client: algoliasearch(appId.value(), apiKey.value(), {timeouts: {connect: 5_000, read: 15_000, write: 15_000}})};
}

async function safeBoundary(operation: string, handler: () => Promise<void>): Promise<void> {
  try { await handler(); }
  catch (error) {
    // Provider errors can embed authorization headers, request bodies and transport
    // stacks. Never forward them to the SDK's automatic error logger or attach a cause.
    const candidate = error as {name?: unknown; status?: unknown; statusCode?: unknown};
    const errorType = ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError'].includes(String(candidate?.name)) ? String(candidate.name) : 'Error';
    const status = candidate?.status ?? candidate?.statusCode;
    logger.error('Algolia indexing failed; retry required', {operation, errorType,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {})});
    throw new Error('Algolia indexing failed; retry required');
  }
}

async function syncDocument(path: string, previous?: DocumentSnapshot): Promise<void> {
  const {db, client} = runtime();
  const instanceId = process.env.FIREBASE_KIT_INSTANCE_ID;
  if (!instanceId) throw new Error('FIREBASE_KIT_INSTANCE_ID must be set by the Firebase kit CLI');
  const lockId = createHash('sha256').update(`${instanceId}:${path}`).digest('hex');
  const lock = db.collection('_algoliaSyncLocks').doc(lockId);
  const owner = randomUUID();
  const deadline = Date.now() + 150_000;
  let lastObjectId: string | undefined;
  let pendingObjectId: string | undefined;
  await db.runTransaction(async transaction => {
    await assertLegacySearchOwnership(db, transaction, true);
    const state = (await transaction.get(lock)).data();
    if (state?.leaseUntil > Date.now()) throw new Error(`Algolia sync already running for ${path}; retry required`);
    lastObjectId = state?.lastObjectId;
    pendingObjectId = state?.pendingObjectId;
    transaction.set(lock, {owner, leaseUntil: Date.now() + 600_000}, {merge: true});
  });
  try {
    await converge(() => db.doc(path).get(), async snapshot => {
      if (Date.now() > deadline) throw new Error('Algolia sync lease budget exhausted; retry required');
      const currentId = snapshot.exists ? objectId(snapshot, alternateId.value()) : undefined;
      const oldIds = new Set([lastObjectId, pendingObjectId, previous?.exists ? objectId(previous, alternateId.value()) : undefined]);
      for (const oldId of oldIds) {
        if (oldId && oldId !== currentId) await client.deleteObjects({indexName: indexName.value(), objectIDs: [oldId], waitForTasks: true, maxRetries: 10});
      }
      if (snapshot.exists) {
        const record = await extract(snapshot, {fields: indexedFields.value(), altObjectId: alternateId.value(), transformFunction: transformFunction.value(), location: location.value(), projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? ''});
        // Write ahead: a provider save can succeed while its acknowledgment or the
        // following metadata write fails. Retain this identity for the next retry,
        // even if the source has since changed its alternate ID or been deleted.
        await lock.set({pendingObjectId: currentId}, {merge: true});
        pendingObjectId = currentId;
        await client.saveObjects({indexName: indexName.value(), objects: [record], waitForTasks: true, maxRetries: 10});
      }
      lastObjectId = currentId;
      // Persist before releasing: retries can remove an alternate ID even after the source is deleted.
      await lock.set({lastObjectId: currentId ?? null, pendingObjectId: null}, {merge: true});
      pendingObjectId = undefined;
    });
    logger.info('Algolia document synchronized', {path, indexName: indexName.value(), instanceId});
  } finally {
    await db.runTransaction(async transaction => {
      const state = (await transaction.get(lock)).data();
      if (state?.owner === owner) transaction.set(lock, {owner: null, leaseUntil: 0}, {merge: true});
    });
  }
}

export const executeIndexOperation = onDocumentWritten({
  timeoutSeconds: 180, maxInstances: 20, ...migratedOptions,
  document: expr`${collectionPath}/{documentId}`, database: databaseId, region: location,
  secrets: [apiKey], retry: true,
}, async event => {
  if (!event.data) return;
  if (temporalSearchEnabled()) {
    const {db} = runtime();
    await enqueueSearchIntent(db, {projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '',
      instanceId: process.env.FIREBASE_KIT_INSTANCE_ID ?? '', requestId: event.id, documentPath: event.data.after.ref.path,
      ...(event.data.before.exists ? {previousObjectId: objectId(event.data.before, alternateId.value())} : {})});
    return;
  }
  await safeBoundary('live-index', () => syncDocument(event.data!.after.ref.path, event.data!.before));
});

interface FullIndexData {docId?: string; successCount?: number}
export const executeFullIndexOperation = onTaskDispatched<FullIndexData>({
  timeoutSeconds: 540, maxInstances: 2, ...migratedOptions,
  region: location, secrets: [apiKey],
  retryConfig: {maxAttempts: 10, minBackoffSeconds: 30},
  rateLimits: {maxConcurrentDispatches: 1},
}, async request => safeBoundary('full-index', async () => {
  if (fullIndexing.value() !== 'true') {logger.info('Full Algolia indexing disabled'); return;}
  const {db} = runtime();
  if (temporalSearchEnabled()) {
    await enqueueSearchIntent(db, {projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '',
      instanceId: process.env.FIREBASE_KIT_INSTANCE_ID ?? '', requestId: request.id});
    return;
  }
  await assertLegacySearchOwnership(db, undefined, true);
  const path = collectionPath.value();
  const group = /\{[^}]+\}/.test(path);
  let query = (group ? db.collectionGroup(path.split('/').at(-1)!) : db.collection(path)).orderBy(FieldPath.documentId()).limit(25);
  if (request.data.docId) query = query.startAfter(group ? db.doc(request.data.docId) : request.data.docId);
  const page = await query.get();
  // All settled ensures no in-flight work remains after a failed page starts its retry.
  for (let offset = 0; offset < page.size; offset += 5) {
    const results = await Promise.allSettled(page.docs.slice(offset, offset + 5).map(doc => syncDocument(doc.ref.path, doc)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  const successCount = (request.data.successCount ?? 0) + page.size;
  if (page.size === 25) {
    const cursor = page.docs.at(-1)!;
    await getFunctions().taskQueue(`locations/${location.value()}/functions/executeFullIndexOperation`).enqueue({docId: group ? cursor.ref.path : cursor.id, successCount});
  } else logger.info('Full Algolia indexing complete', {successCount, indexName: indexName.value()});
}));
afterFirstDeploy({task: {function: 'executeFullIndexOperation', body: {data: {}}}});
afterRedeploy({task: {function: 'executeFullIndexOperation', body: {data: {}}}});
