import { Context } from '@temporalio/activity';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import type { Client } from '@temporalio/client';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';
import { CRC32C, type Bucket } from '@google-cloud/storage';
import { createHash, randomUUID } from 'node:crypto';
import { createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
import { computeProcessAudioRequestVersion } from '../../../../packages/contracts/processAudioQueue';
import { createActorAuthorization } from './authorization';
import { workerReadinessDigest as hash } from './readiness-probe';
import type { WorkerWitness } from './worker-witness';
const projectId = 'urm-app-staging';
export const MEDIA_RECOVERY_QUEUE = 'urm-media-kernel-recovery';
export const MEDIA_RECOVERY_DEPLOYMENT = 'urm-worker-media-recovery-staging';
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
function fail(): never {
  throw ApplicationFailure.nonRetryable('Private media work cannot be verified', 'MEDIA_RECOVERY_WORK_UNCONFIRMED');
}
const uuid = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function stamp(s: any) {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return {
    dataDigest: hash(s.data()),
    createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
    updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
  };
}
/** Source-fixed synthetic bytes; no URLs, providers, mail, user media or payload inputs. */
export function mediaRecoveryPCM() {
  const b = Buffer.alloc(32044);
  b.write('RIFF');
  b.writeUInt32LE(32036, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) b.writeInt16LE(Math.round(10000 * Math.sin((i * Math.PI) / 20)), 44 + 2 * i);
  return b;
}

/** Native original-start evidence, independent of later name/current routing.
 * Return only a hash; no payload, actor, header or token is exported. */
export function mediaRecoveryNativeStart(
  first: any,
  start: any,
  input: { operationId: string; startNonce: string },
  runId: string
) {
  const a = first?.workflowExecutionStartedEventAttributes,
    payloads = a?.input?.payloads;
  if (
    !first?.eventTime ||
    String(first.eventId) !== '1' ||
    !a ||
    a.workflowType?.name !== 'MediaRecoveryProbe' ||
    a.taskQueue?.name !== MEDIA_RECOVERY_QUEUE ||
    a.originalExecutionRunId !== runId ||
    a.firstExecutionRunId !== runId ||
    a.continuedExecutionRunId ||
    !Array.isArray(payloads) ||
    payloads.length !== 1 ||
    !payloads[0]?.data ||
    payloads[0].data.byteLength > 4096 ||
    hash(defaultPayloadConverter.fromPayload(payloads[0])) !== hash(input) ||
    start?.inputSHA256 !== hash(input) ||
    start.nonce !== input.startNonce ||
    !uuid(start.nonce)
  )
    fail();
  const seconds = BigInt(String(first.eventTime.seconds)),
    nanos = Number(first.eventTime.nanos ?? 0);
  if (
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9 ||
    !Number.isFinite(Date.parse(start.attemptedAt)) ||
    seconds * 1000000000n + BigInt(nanos) < BigInt(Date.parse(start.attemptedAt)) * 1000000n
  )
    fail();
  return hash({
    runId,
    inputSHA256: hash(input),
    nativeStartNanos: (seconds * 1000000000n + BigInt(nanos)).toString(),
    workflowType: 'MediaRecoveryProbe',
    queue: MEDIA_RECOVERY_QUEUE,
  });
}

/** Separate private producer. Normal admission/store APIs and dispatchers are unchanged.
 * The normal store constructs/validates the records through a write-only capture;
 * only its one exact outbox write is withheld. No general skip-dispatch flag exists.
 * Actual worker registration and supervisor replacement remain separate gates. */
export function createMediaRecoveryWorkActivities(o: {
  firestore: Firestore;
  auth: Auth;
  bucket: Bucket;
  client: Pick<Client, 'workflow' | 'connection' | 'workflowService'>;
  witness: WorkerWitness;
}) {
  const { firestore: db, auth, bucket, client, witness } = o;
  const store = createDurableJobStore({ firestore: db, projectId });
  const authorizeActor = createActorAuthorization(auth, db);
  return {
    admitMediaRecoveryWork: async (input: { operationId: string; startNonce: string }) => {
      try {
        if (
          !input ||
          Object.keys(input).sort().join(',') !== 'operationId,startNonce' ||
          !uuid(input.startNonce) ||
          !uuid(input.operationId) ||
          !('projectId' in db) ||
          db.projectId !== projectId ||
          db.databaseId !== '(default)' ||
          bucket.name !== `${projectId}.appspot.com` ||
          bucket.storage.retryOptions.autoRetry !== false
        )
          fail();
        const info = Context.current().info,
          operationId = input.operationId,
          id = `media-recovery-${operationId}`;
        const execution = info.workflowExecution;
        if (!execution) fail();
        if (
          info.namespace !== `${projectId}.qwejt` ||
          info.taskQueue !== MEDIA_RECOVERY_QUEUE ||
          info.activityType !== 'admitMediaRecoveryWork' ||
          info.activityId !== 'media-recovery-admit' ||
          info.workflowType !== 'MediaRecoveryProbe' ||
          execution.workflowId !== id ||
          !uuid(execution.runId)
        )
          fail();
        const native = await client.connection.withDeadline(Date.now() + 5000, () =>
          client.workflow.getHandle(id, execution.runId).describe()
        );
        const vi = native.raw.workflowExecutionInfo?.versioningInfo;
        if (
          native.raw.workflowExecutionInfo?.execution?.runId !== execution.runId ||
          native.raw.workflowExecutionInfo?.status !== 1 ||
          vi?.behavior !== 1 ||
          vi.deploymentVersion?.deploymentName !== MEDIA_RECOVERY_DEPLOYMENT ||
          vi.deploymentVersion.buildId !== witness.buildId
        )
          fail();
        const history = await client.connection.withDeadline(Date.now() + 5000, () =>
          client.workflowService.getWorkflowExecutionHistory({
            namespace: info.namespace,
            execution: { workflowId: id, runId: execution.runId },
            maximumPageSize: 32,
            waitNewEvent: false,
          })
        );
        if (!history.history?.events?.length || history.history.events.length > 32 || history.nextPageToken?.length)
          fail();
        const first = history.history.events[0];
        let nativeStartSHA256: string | undefined;
        const refs = [
          '_control/temporalReleaseOperation',
          '_control/temporalRelease',
          '_control/temporalReleaseState',
          `_control/temporalMediaRecoveryJournal-${operationId}`,
        ].map((p) => db.doc(p));
        let plan: any, expected: any, actorUid: string | undefined, email: string | undefined;
        const fresh = () => {
          if (
            !plan ||
            !Number.isSafeInteger(plan.expiresAt) ||
            !Number.isFinite(Date.parse(plan.createdAt)) ||
            plan.expiresAt !== Date.parse(plan.createdAt) + 300000 ||
            Date.now() >= plan.expiresAt ||
            Date.parse(plan.createdAt) > Date.now() + 5000
          )
            fail();
          if (Context.current().cancellationSignal.aborted) fail();
        };
        const authority = async (tx: Transaction) => {
          const [parent, control, state, arming] = await Promise.all(refs.map((r) => tx.get(r)));
          const cycle = parent.get('cloudMediaRecovery'),
            p = cycle?.plan,
            a = arming.data(),
            cloud = witness.cloudRun;
          const start = parent.get('mediaRecoveryWorkflowStart');
          if (
            parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
            parent.get('operationId') !== operationId ||
            parent.get('bindingDigest') !== p?.bindingDigest ||
            parent.get('releaseId') !== p?.releaseId ||
            p?.operationId !== operationId ||
            p?.role !== 'media' ||
            cycle.stage !== 'prepared' ||
            cycle.start?.stage !== 'completed' ||
            cycle.diagnostic?.stage !== 'completed' ||
            cycle.stop ||
            cycle.recovery ||
            cycle.recoveryFailed ||
            !a ||
            a.scope !== 'arming-only-no-execution-authority' ||
            a.planSHA256 !== hash(p) ||
            a.operationId !== operationId ||
            cycle.prepared?.proofSHA256 !== hash(a) ||
            parent.get('mediaRecoveryJournalAttempt.stage') !== 'completed' ||
            parent.get('mediaRecoveryJournalAttempt.recordSHA256') !== hash(a) ||
            hash(a.authority.control) !== hash(stamp(control)) ||
            hash(a.authority.state) !== hash(stamp(state)) ||
            control.get('admission') !== 'paused' ||
            control.get('releaseId') !== p.releaseId ||
            state.get('releaseId') !== p.releaseId ||
            state.get('phase') !== 'provider-usage-ready' ||
            domains.some((d) => control.get(`domains.${d}.admission`) !== 'paused') ||
            p.contract?.deploymentName !== MEDIA_RECOVERY_DEPLOYMENT ||
            p.contract?.queue !== MEDIA_RECOVERY_QUEUE ||
            p.contract?.workflowType !== 'MediaRecoveryProbe' ||
            p.contract?.protocol !== 'owned-media-recovery-v1' ||
            !cloud ||
            cloud.projectId !== projectId ||
            cloud.region !== 'us-central1' ||
            cloud.pool !== p.name.split('/').at(-1) ||
            cloud.revision !== cycle.start.pool?.revision.split('/').at(-1) ||
            cloud.revisionUid !== cycle.start.pool?.revisionUid ||
            cloud.serviceAccount !== p.runner ||
            cloud.imageDigest !== p.image.split('@')[1] ||
            witness.buildId !== p.buildId ||
            !cloud.instanceId ||
            start?.stage !== 'attempted' ||
            start.operationId !== operationId ||
            start.planSHA256 !== hash(p) ||
            start.workflowId !== id ||
            start.workflowType !== 'MediaRecoveryProbe' ||
            start.taskQueue !== MEDIA_RECOVERY_QUEUE ||
            start.inputSHA256 !== hash(input) ||
            hash(start.deploymentVersion) !== hash({ deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: p.buildId }) ||
            !Number.isFinite(Date.parse(start.attemptedAt)) ||
            Date.parse(start.attemptedAt) < Date.parse(p.createdAt) ||
            Date.parse(start.attemptedAt) >= p.expiresAt ||
            parent.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
            typeof parent.get('operatorPrincipal.email') !== 'string'
          )
            fail();
          nativeStartSHA256 = mediaRecoveryNativeStart(first, start, input, execution.runId);
          const next = { parent: stamp(parent), control: stamp(control), state: stamp(state), arming: stamp(arming) };
          if (expected && hash(expected) !== hash(next)) fail();
          plan = p;
          expected = next;
          email = parent.get('operatorPrincipal.email');
          fresh();
          const actor = actorUid ? await auth.getUser(actorUid) : await auth.getUserByEmail(email!);
          if (
            actor.disabled ||
            actor.email !== email ||
            actor.customClaims?.role !== 'admin' ||
            (actorUid && actorUid !== actor.uid)
          )
            fail();
          actorUid = actor.uid;
          fresh();
        };
        await db.runTransaction(authority, { readOnly: true });
        const journal = db.doc(`_control/temporalMediaRecoveryWork-${operationId}`),
          bytes = mediaRecoveryPCM(),
          sourcePath = `temporal-diagnostics/media/${operationId}/source.wav`,
          file = bucket.file(sourcePath);
        let record: any = (await journal.get()).data(),
          newIntent = false;
        if (!record) {
          // Existing names cannot become owned through a new upload. The native
          // generation-zero condition below remains the atomic race fence.
          let absent = false;
          try {
            await file.getMetadata();
          } catch (error) {
            absent = Number((error as { code?: unknown })?.code) === 404;
          }
          if (!absent) fail();
          record = {
            schemaVersion: 1,
            stage: 'upload-attempted',
            operationId,
            planSHA256: hash(plan),
            nativeStartSHA256,
            actorUid,
            runId: execution.runId,
            workflowId: id,
            worker: witness,
            nonce: randomUUID(),
            sourcePath,
            sourceSHA256: sha(bytes),
            sourceSize: bytes.length,
            createdAt: new Date().toISOString(),
            expiresAt: plan.expiresAt,
          };
          try {
            await db.runTransaction(
              async (tx) => {
                await authority(tx);
                if ((await tx.get(journal)).exists) fail();
                tx.create(journal, record);
              },
              { maxAttempts: 1 }
            );
            newIntent = true;
          } catch {
            const same = (await journal.get()).data();
            if (hash(same ?? null) !== hash(record)) fail();
            newIntent = true;
          }
        }
        const identity = {
          schemaVersion: record.schemaVersion,
          operationId: record.operationId,
          planSHA256: record.planSHA256,
          nativeStartSHA256: record.nativeStartSHA256,
          actorUid: record.actorUid,
          runId: record.runId,
          workflowId: record.workflowId,
          sourcePath: record.sourcePath,
          sourceSHA256: record.sourceSHA256,
          sourceSize: record.sourceSize,
          expiresAt: record.expiresAt,
        };
        if (
          hash(identity) !==
            hash({
              schemaVersion: 1,
              operationId,
              planSHA256: hash(plan),
              nativeStartSHA256,
              actorUid,
              runId: execution.runId,
              workflowId: id,
              sourcePath,
              sourceSHA256: sha(bytes),
              sourceSize: bytes.length,
              expiresAt: plan.expiresAt,
            }) ||
          !uuid(record.nonce) ||
          !Number.isFinite(Date.parse(record.createdAt)) ||
          !['upload-attempted', 'source-ready', 'admitted'].includes(record.stage)
        )
          fail();
        if (newIntent) {
          await db.runTransaction(authority, { readOnly: true });
          fresh();
          try {
            await file.save(bytes, {
              resumable: false,
              timeout: 8000,
              validation: false,
              preconditionOpts: { ifGenerationMatch: 0 },
              metadata: {
                contentType: 'audio/wav',
                metadata: { operationId, nonce: record.nonce, sha256: record.sourceSHA256 },
              },
            });
          } catch (e) {
            const status = Number((e as { code?: unknown })?.code);
            if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
              await db.runTransaction(
                async (tx) => {
                  const current = await tx.get(journal);
                  if (hash(current.data()) !== hash(record)) fail();
                  tx.update(journal, { stage: 'upload-rejected', status });
                },
                { maxAttempts: 1 }
              );
              fail();
            }
          }
        }
        // Reconcile only the CURRENT object, then pin its bytes and recheck current
        // generation. Existing names alone and old pinned generations grant nothing.
        const crc = new CRC32C();
        crc.update(bytes);
        const [metadata] = await file.getMetadata();
        if (
          metadata.name !== sourcePath ||
          metadata.bucket !== bucket.name ||
          String(metadata.size) !== String(bytes.length) ||
          !/^[1-9]\d*$/.test(String(metadata.generation)) ||
          !/^[1-9]\d*$/.test(String(metadata.metageneration)) ||
          metadata.md5Hash !== createHash('md5').update(bytes).digest('base64') ||
          metadata.crc32c !== crc.toString() ||
          metadata.contentType !== 'audio/wav' ||
          hash(metadata.metadata) !== hash({ operationId, nonce: record.nonce, sha256: record.sourceSHA256 })
        )
          fail();
        const [download] = await bucket
          .file(sourcePath, { generation: String(metadata.generation) })
          .download({ start: 0, end: bytes.length - 1, validation: false });
        const [current] = await file.getMetadata();
        if (
          !download.equals(bytes) ||
          metadata.generation !== current.generation ||
          metadata.metageneration !== current.metageneration ||
          metadata.md5Hash !== current.md5Hash ||
          metadata.crc32c !== current.crc32c
        )
          fail();
        const source = {
          path: sourcePath,
          generation: String(metadata.generation),
          metageneration: String(metadata.metageneration),
          size: String(metadata.size),
          md5Hash: metadata.md5Hash,
          crc32c: metadata.crc32c,
          sha256: sha(download),
        };
        if (record.source && hash(record.source) !== hash(source)) fail();
        if (record.stage === 'upload-attempted') {
          const next = { ...record, stage: 'source-ready', source };
          try {
            await db.runTransaction(
              async (tx) => {
                await authority(tx);
                if (hash((await tx.get(journal)).data()) !== hash(record)) fail();
                tx.set(journal, next);
              },
              { maxAttempts: 1 }
            );
          } catch {
            if (hash((await journal.get()).data() ?? null) !== hash(next)) fail();
          }
          record = next;
        }
        const payload = { id, storageFilePath: sourcePath, startTime: 0, duration: 1 };
        const ref = {
          projectId,
          jobId: id,
          sermonId: id,
          revision: 1,
          requestVersion: computeProcessAudioRequestVersion(payload),
        };
        const writes: Array<{ kind: 'create' | 'set'; ref: DocumentReference; data: any; options?: any }> = [];
        const capture = {
          create: (r: DocumentReference, data: any) => {
            writes.push({ kind: 'create', ref: r, data });
            return capture;
          },
          set: (r: DocumentReference, data: any, options?: any) => {
            writes.push({ kind: 'set', ref: r, data, ...(options ? { options } : {}) });
            return capture;
          },
        };
        // A write-only adapter of the existing production schema builder. No normal
        // transaction runs through this capture, no public input can select it.
        store.createInTransaction(capture as unknown as Transaction, {
          ref: { projectId, jobId: id },
          kind: 'audio.process',
          entity: { type: 'sermon', id },
          actorUid: actorUid!,
          payload,
          requestId: id,
          generation: 1,
          createdAt: Date.parse(record.createdAt),
          dispatch: { ref, workflowId: id, workflowType: 'MediaRecoveryProbe', taskQueue: MEDIA_RECOVERY_QUEUE },
        });
        const outbox = writes.filter((w) => w.ref.path === `durableJobOutbox/${id}`),
          commit = writes.filter((w) => w.ref.path !== `durableJobOutbox/${id}`);
        if (
          writes.length !== 5 ||
          outbox.length !== 1 ||
          outbox[0].kind !== 'create' ||
          outbox[0].data.dispatch.workflowType !== 'MediaRecoveryProbe' ||
          outbox[0].data.dispatch.taskQueue !== MEDIA_RECOVERY_QUEUE ||
          commit
            .filter((w) => w.kind === 'create')
            .map((w) => w.ref.path)
            .sort()
            .join(',') !== [`durableJobIntents/${id}`, `durableJobs/${id}`].sort().join(',')
        )
          fail();
        const intent = commit.find((w) => w.ref.path === `durableJobIntents/${id}`)!.data;
        const sermon = db.doc(`sermons/${id}`),
          request = db.doc(`temporalMediaRequests/${id}`),
          state = db.doc(`temporalMediaState/${id}`),
          outboxRef = db.doc(`durableJobOutbox/${id}`);
        const requestValue = {
          ref,
          payload,
          sources: { storage: { path: source.path, generation: source.generation } },
        };
        const grant = {
          schemaVersion: 1,
          scope: 'fixed-private-media-acquire-only',
          nativeStartSHA256,
          operationId,
          planSHA256: hash(plan),
          actorUid,
          workflowId: id,
          runId: execution.runId,
          deploymentVersion: { deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: plan.buildId },
          queue: MEDIA_RECOVERY_QUEUE,
          ref,
          source,
          intentSHA256: hash(intent),
          expiresAt: plan.expiresAt,
        };
        if (record.stage === 'admitted') {
          await db.runTransaction(
            async (tx) => {
              await authority(tx);
              const [j, actual, box] = await Promise.all([
                tx.get(journal),
                tx.get(db.doc(`durableJobIntents/${id}`)),
                tx.get(outboxRef),
              ]);
              if (
                hash(j.data()) !== hash(record) ||
                hash(record.grant) !== hash(grant) ||
                !actual.exists ||
                hash(actual.data()) !== grant.intentSHA256 ||
                box.exists
              )
                fail();
              await authorizeActor(intent, tx);
              fresh();
            },
            { readOnly: true }
          );
          return { ref, grantSHA256: hash(grant) };
        }
        if (record.stage !== 'source-ready') fail();
        const next = { ...record, stage: 'admitted', grant };
        try {
          await db.runTransaction(
            async (tx) => {
              await authority(tx);
              await authorizeActor(intent, tx);
              const all = [journal, sermon, request, state, outboxRef, ...commit.map((w) => w.ref)];
              const snapshots = await Promise.all(all.map((r) => tx.get(r)));
              if (hash(snapshots[0].data()) !== hash(record) || snapshots.slice(1).some((s) => s.exists)) fail();
              const commands = await tx.get(db.collection('durableJobCommands').where('jobId', '==', id).limit(1));
              if (!commands.empty) fail();
              fresh();
              tx.create(sermon, { uploaderId: actorUid, status: { audioStatus: 'PENDING', subsplash: 'UPLOADED' } });
              tx.create(request, requestValue);
              tx.create(state, { owner: 'temporal', ref });
              for (const w of commit)
                if (w.kind === 'create') tx.create(w.ref, w.data);
                else if (w.options) tx.set(w.ref, w.data, w.options);
                else tx.set(w.ref, w.data);
              tx.set(journal, next);
            },
            { maxAttempts: 1 }
          );
        } catch {
          const actual = (await journal.get()).data();
          if (hash(actual ?? null) !== hash(next)) fail();
        }
        await db.runTransaction(
          async (tx) => {
            await authority(tx);
            await authorizeActor(intent, tx);
            if (hash((await tx.get(journal)).data()) !== hash(next) || (await tx.get(outboxRef)).exists) fail();
            fresh();
          },
          { readOnly: true }
        );
        fresh();
        return { ref, grantSHA256: hash(grant) };
      } catch {
        return fail();
      }
    },
  };
}
