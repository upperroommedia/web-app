// Only vendor transport and token acquisition are replaced. Admission, Auth,
// Firestore fences/journals, workflows, dispatcher and runtime adapters are real.
jest.mock('axios', () => {
  const transport = jest.fn(async () => {
    throw new Error('Unexpected vendor request');
  });
  return {
    __esModule: true,
    default: Object.assign(transport, {
      get: jest.fn(async () => {
        throw new Error('Unexpected vendor GET');
      }),
      put: jest.fn(async () => {
        throw new Error('Unexpected vendor PUT');
      }),
      post: jest.fn(async () => {
        throw new Error('Unexpected vendor POST');
      }),
      delete: jest.fn(async () => {
        throw new Error('Unexpected vendor DELETE');
      }),
    }),
    isAxiosError: () => false,
  };
});
jest.mock('../../../../functions/src/subsplashUtils', () => ({
  ...jest.requireActual('../../../../functions/src/subsplashUtils'),
  authenticateSubsplash: jest.fn(async () => 'synthetic-subsplash-token'),
}));
jest.mock('../../../../functions/src/soundcloudSecrets', () => ({
  ...jest.requireActual('../../../../functions/src/soundcloudSecrets'),
  runWithSoundCloudAccessToken: jest.fn(async (operation: (token: string) => Promise<unknown>) =>
    operation('synthetic-soundcloud-token')
  ),
}));
// Observe rejected real source operations only in this synthetic test. The
// production activity/history/public error boundary remains unchanged.
jest.mock('../../../../functions/src/temporal/publishing/firebaseDependencies', () => {
  const actual = jest.requireActual('../../../../functions/src/temporal/publishing/firebaseDependencies');
  return {
    ...actual,
    createFirebasePublishingDependencies: (...args: unknown[]) => {
      const dependencies = actual.createFirebasePublishingDependencies(...args);
      for (const name of [
        'ensureSubsplashMedia',
        'ensureSoundCloudTrack',
        'awaitSubsplashReady',
        'awaitSoundCloudReady',
        'mutateLists',
        'mutateSeries',
        'updateMetadata',
        'updateMemberships',
        'replaceAudio',
        'prepareDeletePlan',
        'deleteProviders',
        'commitProjection',
        'reconcile',
      ]) {
        const operation = dependencies[name];
        dependencies[name] = async (...input: unknown[]) => {
          try {
            return await operation(...input);
          } catch (error) {
            const value = error as { code?: unknown; message?: unknown; stack?: unknown };
            mockPrivateSourceFailures.push({
              operation: name,
              code: String(value.code ?? ''),
              message: String(value.message ?? error).slice(0, 1000),
              stack: String(value.stack ?? '')
                .split('\n')
                .slice(0, 8)
                .join('\n'),
            });
            throw error;
          }
        };
      }
      return dependencies;
    },
  };
});
jest.mock('../../../../functions/src/temporal/publishing/criticalRepairCompilation', () => {
  const actual = jest.requireActual('../../../../functions/src/temporal/publishing/criticalRepairCompilation');
  return {
    ...actual,
    compilePublishingCriticalRepairEvidence: async (...args: unknown[]) => {
      try {
        const result = await actual.compilePublishingCriticalRepairEvidence(...args);
        mockPrivateCompilerResults.push({ state: result.state, code: result.code });
        return result;
      } catch (error) {
        const value = error as { code?: unknown; message?: unknown; stack?: unknown };
        mockPrivateSourceFailures.push({
          operation: 'compilePublishingCriticalRepairEvidence',
          code: String(value.code ?? ''),
          message: String(value.message ?? error).slice(0, 1000),
          stack: String(value.stack ?? '')
            .split('\n')
            .slice(0, 8)
            .join('\n'),
        });
        throw error;
      }
    },
  };
});
jest.mock('../../../../functions/src/temporal/publishing/criticalRepair', () => {
  const actual = jest.requireActual('../../../../functions/src/temporal/publishing/criticalRepair');
  const observed = { ...actual };
  for (const name of [
    'preparePublishingCriticalRepair',
    'repairPublishingCritical',
    'loadValidatedPublishingCriticalRepairCertificate',
  ])
    observed[name] = (...args: unknown[]) => mockTracePrivateSource(name, () => actual[name](...args));
  return observed;
});
jest.mock('../../../../functions/src/temporal/publishing/criticalRepairStepAuthority', () => {
  const actual = jest.requireActual('../../../../functions/src/temporal/publishing/criticalRepairStepAuthority');
  return {
    ...actual,
    readAuthoritativeCriticalRepairStepIds: (...args: unknown[]) =>
      mockTracePrivateSource('readAuthoritativeCriticalRepairStepIds', () =>
        actual.readAuthoritativeCriticalRepairStepIds(...args)
      ),
  };
});
jest.mock('../runtime/critical-repair', () => {
  const actual = jest.requireActual('../runtime/critical-repair');
  return {
    ...actual,
    createCriticalRepairAuthority: (...args: unknown[]) => {
      const authority = actual.createCriticalRepairAuthority(...args);
      for (const name of ['loadCertificate', 'assertCurrentInTransaction', 'authorizeOperation']) {
        const operation = authority[name];
        authority[name] = (...input: unknown[]) =>
          mockTracePrivateSource(`runtimeCriticalRepair.${name}`, () => operation(...input));
      }
      return authority;
    },
  };
});
jest.mock('../runtime/execution', () => {
  const actual = jest.requireActual('../runtime/execution');
  return {
    ...actual,
    ActivityExecutionContext: class extends actual.ActivityExecutionContext {
      withRepairSteps(...args: unknown[]) {
        return mockTracePrivateSource('execution.withRepairSteps', () => super.withRepairSteps(...args));
      }
    },
  };
});

import axios from 'axios';
import { createHash, randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  prepareProviderUsageChange,
  prepareProviderUsageChanges,
  providerResourceKey,
  PROVIDER_USAGE_CONTROL,
} from '@upperroom/orchestration/provider-usage';
import type { DurableJob } from '@upperroom/contracts/temporal';
import { submitServerDurableJob } from '../../../../functions/src/temporal/bridge';
import { commandServerDurableJob } from '../../../../functions/src/temporal/admission';
import {
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_SESSIONS,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  acknowledgedProjectionDigest,
  readAcknowledgedProjectionFragments,
} from '../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair';
import {
  PUBLISHING_CRITICAL_REPAIRS,
  publishingCriticalRepairDigest,
} from '../../../../functions/src/temporal/publishing/criticalRepair';
import { PUBLISHING_ALLOCATIONS } from '../../../../functions/src/temporal/publishing/allocationBarrier';
import { createRuntimeActivities } from '../runtime/activities';
import { OutboxDispatcher } from '../runtime/dispatcher';

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const mockPrivateSourceFailures: Array<{
  operation: string;
  code: string;
  message: string;
  stack: string;
  stage?: string;
}> = [];
let mockDiagnosticStage = 'desired';
async function mockTracePrivateSource<T>(operation: string, invoke: () => Promise<T>): Promise<T> {
  const stage = mockDiagnosticStage;
  try {
    return await invoke();
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown; stack?: unknown };
    mockPrivateSourceFailures.push({
      stage,
      operation,
      code: String(value.code ?? ''),
      message: String(value.message ?? error).slice(0, 1000),
      stack: String(value.stack ?? '')
        .split('\n')
        .slice(0, 10)
        .join('\n'),
    });
    throw error;
  }
}
const mockPrivateCompilerResults: Array<{ state: string; code?: string }> = [];
const mockPrivateBindingSnapshots: Array<Record<string, unknown>> = [];
async function capturePrivateBindings(jobId: string, stage: string) {
  const db = firebaseAdmin.firestore();
  const paths = {
    cancellation: `durableJobCancellationIntents/${jobId}`,
    critical: `durableJobCriticalSections/${jobId}`,
    source: `temporalPublishingCriticalRepairSourceCatalogs/${jobId}`,
    grant: `durableJobCriticalRepairGrants/${jobId}`,
    intent: `durableJobIntents/${jobId}`,
  };
  const fields = [
    'schemaVersion',
    'projectId',
    'jobId',
    'generation',
    'workflowId',
    'purpose',
    'acceptedUserCancellation',
    'certificateId',
    'certificateDigest',
    'actorUid',
    'originalActorUid',
    'reviewCommandId',
    'sealed',
    'sealDigest',
    'criticalDigest',
    'intentDigest',
    'intentFingerprint',
    'criticalFingerprint',
    'producerProtocol',
    'sourceProgramChainDigest',
    'authorizedAt',
    'reasonCode',
    'count',
    'revision',
  ];
  const bindings: Record<string, unknown> = { stage, jobId };
  for (const [name, path] of Object.entries(paths)) {
    const snapshot = await db.doc(path).get();
    const data = snapshot.data();
    bindings[name] = {
      exists: snapshot.exists,
      ...Object.fromEntries(
        fields.filter((field) => data?.[field] !== undefined).map((field) => [field, data![field]])
      ),
      ...(data && ['critical', 'intent'].includes(name)
        ? { documentDigest: publishingCriticalRepairDigest(data) }
        : {}),
    };
  }
  mockPrivateBindingSnapshots.push(bindings);
  return bindings;
}
async function awaitJob(jobId: string, predicate: (job: DurableJob) => boolean): Promise<DurableJob> {
  const deadline = Date.now() + 60000;
  let latest: DurableJob | undefined;
  while (Date.now() < deadline) {
    latest = (await firebaseAdmin.firestore().doc(`durableJobs/${jobId}`).get()).data() as DurableJob;
    if (predicate(latest)) return latest;
    if (latest.state === 'needs_attention' && latest.error?.code === 'PUBLISHING_OPERATION_FAILED') {
      await capturePrivateBindings(jobId, 'source-rejected');
      throw new Error(
        `Synthetic publishing source rejected: ${JSON.stringify({
          job: latest,
          sourceFailures: mockPrivateSourceFailures,
          bindingSnapshots: mockPrivateBindingSnapshots,
        })}`
      );
    }
    await pause(100);
  }
  await capturePrivateBindings(jobId, 'stalled');
  throw new Error(
    `Publishing stack stalled: ${JSON.stringify({
      job: latest,
      sourceFailures: mockPrivateSourceFailures,
      compilerResults: mockPrivateCompilerResults,
      bindingSnapshots: mockPrivateBindingSnapshots,
    })}`
  );
}
async function readFrozenPages(sessionId: string) {
  const db = firebaseAdmin.firestore();
  const header = (await db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`).get()).data()!;
  expect(header.schemaVersion).toBe(2);
  expect(header.pageCount).toBeGreaterThan(0);
  const ref = { projectId: header.projectId, jobId: header.jobId };
  const pages: Array<Awaited<ReturnType<typeof readAcknowledgedProjectionFragments>>['fragments'][number]['plan']> = [];
  let chain = acknowledgedProjectionDigest([]);
  for (let offset = 0; offset < header.pageCount; ) {
    const window = await db.runTransaction((tx) => readAcknowledgedProjectionFragments(tx, db, ref, sessionId, offset));
    for (const fragment of window.fragments) {
      pages.push(fragment.plan);
      chain = acknowledgedProjectionDigest([chain, fragment.index, fragment.digest]);
    }
    expect(window.nextOffset).toBeGreaterThan(offset);
    offset = window.nextOffset;
  }
  expect(chain).toBe(header.chainDigest);
  const requests = [
    ...new Map(pages.flatMap((page) => page.requests).map((request) => [request.step, request])).values(),
  ];
  expect(requests).toHaveLength(header.requestCount);
  return {
    requests,
    verifications: pages.flatMap((page) => page.verifications),
    writes: pages.flatMap((page) => page.writes),
  };
}

test.each([
  { action: 'update' as const, revokeAfterAck: false },
  { action: 'update' as const, revokeAfterAck: true },
  { action: 'delete' as const, revokeAfterAck: false },
])(
  'production publishing composition settles original fixed $action (actor revoked: $revokeAfterAck)',
  async ({ action, revokeAfterAck }) => {
    mockPrivateSourceFailures.length = 0;
    mockPrivateCompilerResults.length = 0;
    mockPrivateBindingSnapshots.length = 0;
    mockDiagnosticStage = 'desired';
    const db = firebaseAdmin.firestore(),
      projectId = firebaseAdmin.app().options.projectId!;
    const nonce = `publishing-stack-${randomUUID()}`;
    const actorUid = nonce,
      reviewerUid = `${nonce}-reviewer`,
      sermonId = nonce;
    const mediaId = `${nonce}-media`,
      trackId = `123${Date.now()}`;
    const rootListId = `${nonce}-root`,
      physicalListId = `${nonce}-physical`,
      seriesId = `${nonce}-series`;
    const remoteRootId = `${nonce}-remote-root`,
      remotePhysicalId = `${nonce}-remote-physical`,
      remoteSeriesId = `${nonce}-remote-series`,
      rowId = `${nonce}-row`;
    let rowPresent = true,
      seriesAttached = true,
      seriesSubtitle = '1 part series';
    const control = db.doc('_control/temporalRelease'),
      marker = db.doc(PROVIDER_USAGE_CONTROL);
    const oldControl = await control.get(),
      oldMarker = await marker.get();
    const priorFlags = {
      publishing: process.env.TASK_ORCHESTRATOR_PUBLISHING,
      simulation: process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION,
      email: process.env.SUBSPLASH_EMAIL,
      password: process.env.SUBSPLASH_PASSWORD,
    };
    const baseline = new Set<string>();
    for (const collection of await db.listCollections())
      for (const doc of (await collection.get()).docs) baseline.add(doc.ref.path);
    let environment: TestWorkflowEnvironment | undefined, dispatcher: OutboxDispatcher | undefined;
    const workers: Worker[] = [],
      running: Promise<void>[] = [];
    let jobId: string | undefined, sessionId: string | undefined;
    let frozenBeforeHttp = false;
    let mediaAbsent = false,
      trackAbsent = false;
    let remoteMedia: Record<string, unknown> = {
      id: mediaId,
      app_key: '9XTSHD',
      title: 'Old title',
      ...(action === 'delete' ? { _embedded: { 'media-series': { id: remoteSeriesId } } } : {}),
    };
    let remoteTrack: Record<string, unknown> = { id: trackId, user: { id: 42 }, title: 'Old title' };
    const sent: Array<{ method: string; url: string }> = [];
    try {
      process.env.TASK_ORCHESTRATOR_PUBLISHING = 'temporal';
      process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION = 'true';
      process.env.SUBSPLASH_EMAIL = 'synthetic@example.test';
      process.env.SUBSPLASH_PASSWORD = 'synthetic-local-secret';
      await firebaseAdmin.auth().createUser({ uid: actorUid });
      await firebaseAdmin.auth().setCustomUserClaims(actorUid, { role: 'publisher' });
      await firebaseAdmin.auth().createUser({ uid: reviewerUid });
      await firebaseAdmin.auth().setCustomUserClaims(reviewerUid, { role: 'admin' });
      await control.set({
        schemaVersion: 1,
        revision: 1,
        admission: 'open',
        releaseId: nonce,
        domains: { publishing: { owner: 'temporal', admission: 'open' } },
        updatedAt: Date.now(),
      });
      await marker.set({
        schemaVersion: 1,
        projectId,
        epoch: nonce,
        status: 'ready',
        releaseId: nonce,
        controlRevision: 1,
      });
      const canonical = {
        id: sermonId,
        title: 'Old title',
        subtitle: 'Synthetic subtitle',
        description: 'Old description',
        speakers: [],
        topics: [],
        images: [],
        dateMillis: 1700000000000,
        editedAtMillis: 1000,
        durationSeconds: 3,
        uploaderId: actorUid,
        subsplashId: mediaId,
        soundCloudTrackId: trackId,
        status: { audioStatus: 'PROCESSED', subsplash: 'UPLOADED', soundCloud: 'UPLOADED' },
        ...(action === 'delete' ? { seriesId, numberOfLists: 1, numberOfListsUploadedTo: 1 } : {}),
      };
      const sermon = db.doc(`sermons/${sermonId}`);
      await db.runTransaction(async (tx) => {
        const indexed = await prepareProviderUsageChange(tx, db, {
          projectId,
          canonicalPath: sermon.path,
          before: undefined,
          after: canonical,
        });
        tx.create(sermon, canonical);
        indexed();
      });
      const mirrorPaths = [
        `sermons/${sermonId}/sermonLists/${rootListId}`,
        `lists/${rootListId}/listItems/${sermonId}`,
        `lists/${physicalListId}/listItems/${sermonId}`,
        `series/${seriesId}/seriesItems/${sermonId}`,
      ];
      if (action === 'delete') {
        const records = [
          {
            path: `lists/${rootListId}`,
            data: {
              id: rootListId,
              name: 'Root list',
              isRootList: true,
              count: 0,
              logicalCount: 1,
              subsplashId: remoteRootId,
              moreSermonsRef: remotePhysicalId,
            },
          },
          {
            path: `lists/${physicalListId}`,
            data: {
              id: physicalListId,
              name: 'Overflow list',
              isRootList: false,
              isMoreSermonsList: true,
              rootListId,
              count: 1,
              subsplashId: remotePhysicalId,
            },
          },
          {
            path: `series/${seriesId}`,
            data: {
              id: seriesId,
              name: 'Series',
              ownerId: actorUid,
              itemCount: 1,
              publishedItemCount: 1,
              subsplashId: remoteSeriesId,
              subtitle: seriesSubtitle,
            },
          },
          ...mirrorPaths.map((path, index) => ({
            path,
            data: {
              id: index === 0 ? rootListId : sermonId,
              sermonId,
              sermonSubsplashId: mediaId,
              uploadStatus: { status: 'UPLOADED', listItemId: `${nonce}-row` },
              ...(index === 0 ? { physicalPlacement: { firestoreListId: physicalListId } } : {}),
            },
          })),
        ];
        await db.runTransaction(async (tx) => {
          const indexed = await prepareProviderUsageChanges(
            tx,
            db,
            records.map((record) => ({
              projectId,
              canonicalPath: record.path,
              before: undefined,
              after: record.data,
            }))
          );
          for (const record of records) tx.create(db.doc(record.path), record.data);
          indexed();
        });
        for (const [provider, remoteId] of [
          ['subsplash', mediaId],
          ['soundcloud', trackId],
        ] as const) {
          const allocationId = createHash('sha256')
            .update(JSON.stringify([projectId, sermonId, provider]))
            .digest('hex');
          await db.doc(`${PUBLISHING_ALLOCATIONS}/${allocationId}`).set({
            schemaVersion: 1,
            projectId,
            sermonId,
            provider,
            ownerJobId: `${nonce}-original-publish`,
            operationKey: `${nonce}-original-${provider}`,
            receiptIds: [],
            state: 'bound',
            remoteId,
            boundAtMillis: 1000,
          });
        }
      }
      const receipt = await submitServerDurableJob({
        actorUid,
        requestId: `${nonce}-request`,
        kind: action === 'delete' ? 'sermon.delete' : 'sermon.update',
        entity: { type: 'sermon', id: sermonId },
        payload:
          action === 'delete'
            ? {}
            : {
                expectedEditedAtMillis: 1000,
                patch: { title: 'Confirmed title', description: 'Confirmed description' },
              },
      });
      jobId = receipt.jobId;

      const assertFrozenDeletion = async () => {
        const sessions = await db.collection(PROVIDER_MUTATION_SESSIONS).where('scope.jobId', '==', jobId!).get();
        expect(sessions.size).toBe(1);
        sessionId = sessions.docs[0].id;
        expect(sessions.docs[0].get('state')).toBe('active');
        expect(sessions.docs[0].get('resources')).toHaveLength(6);
        const frozen = await readFrozenPages(sessionId);
        expect(frozen.requests.map((request: any) => [request.method, request.step])).toEqual(
          expect.arrayContaining([
            ['DELETE', `delete:subsplash:${mediaId}`],
            ['DELETE', `delete:soundcloud:${trackId}`],
          ])
        );
        expect(frozen.requests).toHaveLength(5);
        expect(frozen.requests.map((request) => request.step)).toEqual(
          expect.arrayContaining([
            `sermon-delete-row:${remotePhysicalId}:${rowId}`,
            `sermon-delete-series:${mediaId}:${remoteSeriesId}`,
            `sermon-delete-series-subtitle:${remoteSeriesId}:0`,
          ])
        );
        expect(frozen.verifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ provider: 'subsplash', resourceId: mediaId, expectedState: 'absent' }),
            expect.objectContaining({ provider: 'soundcloud', resourceId: trackId, expectedState: 'absent' }),
          ])
        );
        for (const [provider, account, remoteId] of [
          ['subsplash', 'app:9XTSHD', mediaId],
          ['soundcloud', 'configured-account', trackId],
        ] as const) {
          const key = providerResourceKey({ projectId, provider, account, remoteId });
          const indexed = await db.doc(`temporalProviderUsage/${key}/epochs/${nonce}`).get();
          expect(indexed.get('state')).toBe('reserved');
          expect(indexed.get('desiredDeletionProof.jobId')).toBe(jobId);
        }
        expect((await sermon.get()).exists).toBe(true);
        for (const path of mirrorPaths) expect((await db.doc(path).get()).exists).toBe(true);
        frozenBeforeHttp = true;
      };

      jest.mocked(axios).mockImplementation(async (config: any) => {
        const url = String(config.url),
          method = String(config.method).toUpperCase();
        sent.push({ method, url });
        if (action === 'delete') {
          const parsed = new URL(url);
          if (method === 'GET' && parsed.pathname.startsWith('/builder/v1/lists/'))
            return {
              status: 200,
              data: { id: parsed.pathname.split('/').at(-1), app_key: '9XTSHD', type: 'standard' },
            } as any;
          if (method === 'GET' && parsed.pathname === '/builder/v1/list-rows') {
            const source = parsed.searchParams.get('filter[source_list]');
            const rows =
              source === remoteRootId
                ? [
                    {
                      id: `${nonce}-continuation`,
                      app_key: '9XTSHD',
                      type: 'list',
                      method: 'static',
                      _embedded: { 'source-list': { id: remoteRootId }, list: { id: remotePhysicalId } },
                    },
                  ]
                : rowPresent
                ? [
                    {
                      id: rowId,
                      app_key: '9XTSHD',
                      type: 'media-item',
                      method: 'static',
                      _embedded: { 'source-list': { id: remotePhysicalId }, 'media-item': { id: mediaId } },
                    },
                  ]
                : [];
            return { status: 200, data: { total: rows.length, _embedded: { 'list-rows': rows } } } as any;
          }
          if (method === 'GET' && parsed.pathname === `/builder/v1/list-rows/${rowId}`) {
            if (!rowPresent) throw { response: { status: 404 } };
            return {
              status: 200,
              data: {
                id: rowId,
                app_key: '9XTSHD',
                type: 'media-item',
                method: 'static',
                _embedded: { 'source-list': { id: remotePhysicalId }, 'media-item': { id: mediaId } },
              },
            } as any;
          }
          if (method === 'GET' && parsed.pathname === '/media/v1/media-items') {
            const items =
              seriesAttached && parsed.searchParams.get('filter[status]') === 'published'
                ? [
                    {
                      id: mediaId,
                      app_key: '9XTSHD',
                      status: 'published',
                      _embedded: { 'media-series': { id: remoteSeriesId } },
                    },
                  ]
                : [];
            return { status: 200, data: { total: items.length, _embedded: { 'media-items': items } } } as any;
          }
          if (method === 'GET' && parsed.pathname === `/media/v1/media-series/${remoteSeriesId}`)
            return { status: 200, data: { id: remoteSeriesId, app_key: '9XTSHD', subtitle: seriesSubtitle } } as any;
          if (method === 'DELETE' && parsed.pathname === `/builder/v1/list-rows/${rowId}`) {
            await assertFrozenDeletion();
            expect(config.maxRedirects).toBe(0);
            rowPresent = false;
            return { status: 204, data: null } as any;
          }
          if (method === 'PATCH' && parsed.pathname === `/media/v1/media-items/${mediaId}`) {
            await assertFrozenDeletion();
            expect(config.maxRedirects).toBe(0);
            seriesAttached = false;
            remoteMedia = { ...remoteMedia, _embedded: { 'media-series': null } };
            return { status: 200, data: remoteMedia } as any;
          }
          if (method === 'PATCH' && parsed.pathname === `/media/v1/media-series/${remoteSeriesId}`) {
            await assertFrozenDeletion();
            expect(config.maxRedirects).toBe(0);
            seriesSubtitle = typeof config.data === 'string' ? JSON.parse(config.data).subtitle : config.data.subtitle;
            return { status: 200, data: { id: remoteSeriesId, app_key: '9XTSHD', subtitle: seriesSubtitle } } as any;
          }
        }
        if (
          action === 'delete' &&
          method === 'DELETE' &&
          url === `https://core.subsplash.com/media/v1/media-items/${mediaId}`
        ) {
          await assertFrozenDeletion();
          expect(config.maxRedirects).toBe(0);
          mediaAbsent = true;
          return { status: 204, data: null } as any;
        }
        if (
          action === 'delete' &&
          method === 'GET' &&
          url.startsWith(`https://core.subsplash.com/media/v1/media-items/${mediaId}`)
        ) {
          if (mediaAbsent) throw { response: { status: 404 } };
          return { status: 200, data: remoteMedia } as any;
        }
        if (method === 'PATCH' && url === `https://core.subsplash.com/media/v1/media-items/${mediaId}`) {
          const sessions = await db.collection(PROVIDER_MUTATION_SESSIONS).where('scope.jobId', '==', jobId!).get();
          expect(sessions.size).toBe(1);
          sessionId = sessions.docs[0].id;
          expect(sessions.docs[0].get('state')).toBe('active');
          expect(sessions.docs[0].get('resources')).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ provider: 'subsplash', resourceId: mediaId, account: 'app:9XTSHD' }),
              expect.objectContaining({ provider: 'soundcloud', resourceId: trackId, account: 'soundcloud:users:42' }),
            ])
          );
          const frozen = await readFrozenPages(sessionId);
          expect(frozen.requests).toHaveLength(2);
          const frozenSoundCloud = frozen.requests.find((request) => request.target?.provider === 'soundcloud');
          expect(frozenSoundCloud).toBeDefined();
          expect(frozenSoundCloud!.payload).not.toHaveProperty('imageSource');
          expect(frozen.verifications).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ resourceId: mediaId }),
              expect.objectContaining({ resourceId: trackId }),
            ])
          );
          expect(frozen.writes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: sermon.path,
                patch: expect.objectContaining({ title: 'Confirmed title' }),
              }),
            ])
          );
          expect((await sermon.get()).get('title')).toBe('Old title');
          expect(config.maxRedirects).toBe(0);
          remoteMedia = { ...remoteMedia, ...JSON.parse(config.data) };
          frozenBeforeHttp = true;
          // The real domain normalizer records {updated:true}, never this raw config.
          return {
            status: 200,
            data: remoteMedia,
            config: { headers: { Authorization: 'never-persist-this-token' } },
          } as any;
        }
        if (method === 'GET' && url.startsWith(`https://core.subsplash.com/media/v1/media-items/${mediaId}`))
          return { status: 200, data: remoteMedia } as any;
        throw new Error(`Unexpected vendor transport ${method} ${url}`);
      });
      jest.mocked(axios.get).mockImplementation(async (url: any) => {
        sent.push({ method: 'GET', url: String(url) });
        if (url === 'https://api.soundcloud.com/me') return { status: 200, data: { id: 42 } } as any;
        if (url === `https://api.soundcloud.com/tracks/${trackId}`) {
          if (trackAbsent) throw { response: { status: 404 } };
          return { status: 200, data: remoteTrack } as any;
        }
        throw new Error(`Unexpected vendor GET ${url}`);
      });
      jest.mocked(axios.put).mockImplementation(async (url: any, body: any, options: any) => {
        expect(action).toBe('update');
        sent.push({ method: 'PUT', url: String(url) });
        expect(url).toBe(`https://api.soundcloud.com/tracks/${trackId}`);
        expect(frozenBeforeHttp).toBe(true);
        expect(options.maxRedirects).toBe(0);
        remoteTrack = { ...remoteTrack, ...body.track };
        if (revokeAfterAck) await firebaseAdmin.auth().setCustomUserClaims(actorUid, { role: 'user' });
        return { status: 200, data: remoteTrack } as any;
      });
      jest.mocked(axios.delete).mockImplementation(async (url: any, options: any) => {
        expect(action).toBe('delete');
        expect(url).toBe(`https://api.soundcloud.com/tracks/${trackId}`);
        sent.push({ method: 'DELETE', url: String(url) });
        await assertFrozenDeletion();
        expect(options.maxRedirects).toBe(0);
        trackAbsent = true;
        return { status: 204, data: null } as any;
      });
      environment = await TestWorkflowEnvironment.createLocal();
      const composition = createRuntimeActivities(
        projectId,
        ['urm-orchestration', 'urm-controls'],
        environment.client,
        { instanceId: randomUUID(), buildId: 'local-publishing-stack' }
      );
      for (const queue of ['urm-orchestration', 'urm-controls'] as const) {
        const worker = await Worker.create({
          connection: environment.nativeConnection,
          taskQueue: queue,
          ...(queue === 'urm-orchestration' ? { workflowsPath: require.resolve('../workflows/publishing') } : {}),
          activities: composition.queues[queue],
          shutdownGraceTime: '5 seconds',
          shutdownForceTime: '20 seconds',
        });
        workers.push(worker);
        running.push(worker.run());
      }
      dispatcher = new OutboxDispatcher({ db, projectId, client: environment.client });
      await dispatcher.tick();
      expect(dispatcher.healthy).toBe(true);
      dispatcher.start();
      if (revokeAfterAck) {
        const blocked = await awaitJob(
          jobId,
          (job) => job.state === 'needs_attention' && job.attention?.resolutionKind === 'critical_repair'
        );
        expect((await sermon.get()).get('title')).toBe('Old title');
        expect(blocked.actions).toEqual(['resolve']);
        const certificateId = blocked.attention!.certificateId!;
        const certificate = (await db.doc(`${PUBLISHING_CRITICAL_REPAIRS}/${certificateId}`).get()).data()!;
        expect(
          certificate.certificate.operations.some((operation: any) => operation.kind === 'acknowledged_projection')
        ).toBe(true);
        await expect(
          commandServerDurableJob(actorUid, {
            action: 'resolve',
            jobId,
            requestId: `${nonce}-forbidden-review`,
            expectedRevision: blocked.revision,
            resolution: {
              decision: 'continue_critical_repair',
              certificateId,
              evidenceReference: 'Local integration original HTTP acknowledgement',
              reason: 'Repair already confirmed facts',
            },
          })
        ).rejects.toMatchObject({ code: 'permission-denied' });
        mockDiagnosticStage = 'admin-command';
        await capturePrivateBindings(jobId, 'before-admin-command');
        await commandServerDurableJob(reviewerUid, {
          action: 'resolve',
          jobId,
          requestId: `${nonce}-admin-review`,
          expectedRevision: blocked.revision,
          resolution: {
            decision: 'continue_critical_repair',
            certificateId,
            evidenceReference: 'Local integration original HTTP acknowledgement',
            reason: 'Repair already confirmed facts',
          },
        });
        mockDiagnosticStage = 'approved-repair';
        await capturePrivateBindings(jobId, 'after-admin-command');
        expect((await db.doc(`durableJobCancellationIntents/${jobId}`).get()).data()).toMatchObject({
          projectId,
          jobId,
          generation: blocked.generation,
          workflowId: blocked.workflowId,
          purpose: 'critical_repair_cleanup',
          certificateId,
          acceptedUserCancellation: false,
          actorUid: reviewerUid,
        });
        await awaitJob(jobId, (job) => job.state === 'cancelled');
      } else {
        await awaitJob(jobId, (job) => job.state === 'succeeded');
      }
      expect(frozenBeforeHttp).toBe(true);
      if (action === 'delete') {
        expect((await sermon.get()).exists).toBe(false);
        for (const path of mirrorPaths) expect((await db.doc(path).get()).exists).toBe(false);
        for (const [provider, account, remoteId] of [
          ['subsplash', 'app:9XTSHD', mediaId],
          ['soundcloud', 'configured-account', trackId],
        ] as const) {
          const key = providerResourceKey({ projectId, provider, account, remoteId });
          const indexed = await db.doc(`temporalProviderUsage/${key}/epochs/${nonce}`).get();
          expect(indexed.data()).toMatchObject({ state: 'deleted', referenceCount: 0, settlement: 'confirmed_absent' });
          const allocationId = createHash('sha256')
            .update(JSON.stringify([projectId, sermonId, provider]))
            .digest('hex');
          expect((await db.doc(`${PUBLISHING_ALLOCATIONS}/${allocationId}`).get()).data()).toMatchObject({
            state: 'cancelled',
            settlement: 'verified_provider_absence',
            retiredByJobId: jobId,
          });
        }
        expect(sent.filter((request) => request.method === 'DELETE')).toEqual([
          { method: 'DELETE', url: `https://core.subsplash.com/builder/v1/list-rows/${rowId}` },
          { method: 'DELETE', url: `https://core.subsplash.com/media/v1/media-items/${mediaId}` },
          { method: 'DELETE', url: `https://api.soundcloud.com/tracks/${trackId}` },
        ]);
        for (const url of [
          `https://core.subsplash.com/media/v1/media-items/${mediaId}`,
          `https://api.soundcloud.com/tracks/${trackId}`,
        ]) {
          const deletion = sent.findIndex((request) => request.method === 'DELETE' && request.url === url);
          expect(sent.slice(deletion + 1).some((request) => request.method === 'GET' && request.url === url)).toBe(
            true
          );
        }
        expect(sent.filter((request) => request.method === 'PATCH')).toEqual(
          expect.arrayContaining([
            { method: 'PATCH', url: `https://core.subsplash.com/media/v1/media-items/${mediaId}` },
            { method: 'PATCH', url: `https://core.subsplash.com/media/v1/media-series/${remoteSeriesId}` },
          ])
        );
        expect(sent.some((request) => ['PUT', 'POST'].includes(request.method))).toBe(false);
        expect(rowPresent).toBe(false);
        expect(seriesAttached).toBe(false);
        expect(seriesSubtitle).toBe('0 part series');
      } else {
        expect((await sermon.get()).data()).toMatchObject({
          title: 'Confirmed title',
          description: 'Confirmed description',
          subsplashId: mediaId,
          soundCloudTrackId: trackId,
        });
      }
      expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`).get()).get('state')).toBe('committed');
      const facts = await db.collection(PROVIDER_MUTATION_FACTS).where('sessionId', '==', sessionId!).get();
      expect(facts.size).toBe(action === 'delete' ? 5 : 2);
      expect(facts.docs.every((fact) => fact.get('completion') === 'acknowledged')).toBe(true);
      if (action === 'update')
        expect(facts.docs.find((fact) => fact.get('step') === 'subsplash-metadata')!.get('result')).toEqual({
          updated: true,
        });
      expect(JSON.stringify(facts.docs.map((fact) => fact.data()))).not.toContain('never-persist-this-token');
      if (action === 'update') {
        expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(1);
        expect(sent.filter((request) => request.method === 'PUT')).toHaveLength(1);
        expect(sent.some((request) => ['POST', 'DELETE'].includes(request.method))).toBe(false);
      }
    } finally {
      await dispatcher?.stop();
      for (const worker of workers) if (worker.getState() === 'RUNNING') worker.shutdown();
      await Promise.allSettled(running);
      await environment?.teardown();
      for (const collection of await db.listCollections())
        for (const doc of (await collection.get()).docs) {
          if (![control.path, marker.path].includes(doc.ref.path) && !baseline.has(doc.ref.path))
            await db.recursiveDelete(doc.ref);
        }
      if (oldControl.exists) await control.set(oldControl.data()!);
      else await control.delete();
      if (oldMarker.exists) await marker.set(oldMarker.data()!);
      else await marker.delete();
      for (const uid of [actorUid, reviewerUid])
        await firebaseAdmin
          .auth()
          .deleteUser(uid)
          .catch(() => {});
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('TASK_ORCHESTRATOR_PUBLISHING', priorFlags.publishing);
      restore('TEMPORAL_PROVIDER_MUTATION_SIMULATION', priorFlags.simulation);
      restore('SUBSPLASH_EMAIL', priorFlags.email);
      restore('SUBSPLASH_PASSWORD', priorFlags.password);
      jest.clearAllMocks();
    }
  },
  240000
);
