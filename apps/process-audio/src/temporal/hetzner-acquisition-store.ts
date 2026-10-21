import { writeMediaUploadIntent } from '@upperroom/orchestration/media-artifacts';
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { YouTubeStreamReceipt } from '../processYouTubeUrl';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId, type RemoteYouTubeResult, validateAcquiredYouTubeSource } from './hetzner-acquisition';

export const YOUTUBE_ACQUISITIONS = 'temporalYouTubeAcquisitions';
export interface AcquisitionPreparer {
  buildId: string;
  serviceAccount: string;
  instanceId: string;
}
export interface AcquisitionHostProcess {
  bootId: string;
  pidNamespace: string;
  processId: number;
  startTicks: string;
  buildId: string;
}
interface Operation {
  schemaVersion: 1;
  operationId: string;
  ref: MediaJobRef;
  preparedBy: AcquisitionPreparer;
  status: 'prepared' | 'running' | RemoteYouTubeResult['kind'];
  owner?: AcquisitionHostProcess;
  result?: RemoteYouTubeResult;
  createdAt: number;
  startedAt?: number;
  drainedAt?: number;
}
const fail = (): never => {
  throw new Error('YOUTUBE_ACQUISITION_OWNERSHIP');
};
export function assertStagingAcquisitionDatabase(database: Firestore): void {
  // The native SDK exposes its resolved project through this runtime getter.
  // Narrow it explicitly because its public TypeScript interface omits it.
  if (!('projectId' in database) || database.projectId !== 'urm-app-staging' || database.databaseId !== '(default)')
    return fail();
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function preparer(value: AcquisitionPreparer): AcquisitionPreparer {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'buildId,instanceId,serviceAccount' ||
    typeof value.buildId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.buildId) ||
    typeof value.instanceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.instanceId) ||
    value.serviceAccount !== `tw-m-${value.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com`
  )
    return fail();
  return { buildId: value.buildId, instanceId: value.instanceId, serviceAccount: value.serviceAccount };
}
function host(value: AcquisitionHostProcess): AcquisitionHostProcess {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'bootId,buildId,pidNamespace,processId,startTicks' ||
    typeof value.bootId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.bootId) ||
    typeof value.pidNamespace !== 'string' ||
    !/^pid:\[[0-9]+\]$/.test(value.pidNamespace) ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1 ||
    typeof value.startTicks !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.startTicks) ||
    typeof value.buildId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.buildId)
  )
    return fail();
  return {
    bootId: value.bootId,
    pidNamespace: value.pidNamespace,
    processId: value.processId,
    startTicks: value.startTicks,
    buildId: value.buildId,
  };
}
function operation(raw: unknown, ref: MediaJobRef): Operation {
  const value = raw as Operation | undefined;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.operationId !== youtubeAcquisitionId(ref) ||
    youtubeAcquisitionId(value.ref) !== value.operationId ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    ![
      'prepared',
      'running',
      'source',
      'source_available',
      'completed',
      'waiting_auth',
      'waiting_archive',
      'restricted',
      'cancelled',
      'superseded',
      'deleted',
    ].includes(value.status)
  )
    return fail();
  preparer(value.preparedBy);
  if (value.status === 'prepared') {
    if (
      value.owner !== undefined ||
      value.result !== undefined ||
      value.startedAt !== undefined ||
      value.drainedAt !== undefined
    )
      return fail();
  } else {
    host(value.owner!);
    if (!Number.isSafeInteger(value.startedAt) || value.startedAt! < 0) return fail();
    if (value.status === 'running') {
      if (value.result !== undefined || value.drainedAt !== undefined) return fail();
    } else {
      if (
        !Number.isSafeInteger(value.drainedAt) ||
        value.drainedAt! < 0 ||
        !value.result ||
        value.result.kind !== value.status
      )
        return fail();
      if (value.result.kind === 'source') {
        if (Object.keys(value.result).sort().join(',') !== 'artifact,kind') return fail();
        validateAcquiredYouTubeSource(ref, value.result.artifact);
      } else if (value.result.kind === 'waiting_auth') {
        if (
          value.result.recoveryGeneration !== null ||
          Object.keys(value.result).sort().join(',') !== 'kind,recoveryGeneration'
        )
          return fail();
      } else if (Object.keys(value.result).join(',') !== 'kind') return fail();
    }
  }
  return value;
}

/** Pure receipt parser for the real Activity's native transaction. This validates
 * original host identity/settlement; it never starts work or grants adoption. */
export function validateYouTubeAcquisitionSourceReceipt(
  raw: unknown,
  ref: MediaJobRef,
  source: unknown
): AcquisitionHostProcess {
  const value = operation(raw, ref);
  if (value.status !== 'source' || value.result?.kind !== 'source') return fail();
  const actual = validateAcquiredYouTubeSource(ref, value.result.artifact),
    expected = validateAcquiredYouTubeSource(ref, source);
  if (Object.keys(actual).some((key) => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected]))
    return fail();
  return host(value.owner!);
}

/** Called ONLY by a real registered native media Activity. The mandatory guard
 * must be the existing current-execution/actor/source transaction authorization.
 * This prepares private delegation; it starts no process or task and writes no
 * canonical request, public status or release control. Never expose it over HTTP.
 */
export async function prepareYouTubeAcquisition(options: {
  firestore: Firestore;
  ref: MediaJobRef;
  caller: AcquisitionPreparer;
  assertCurrent: (transaction: Transaction, ref: MediaJobRef) => Promise<void>;
}): Promise<void> {
  assertStagingAcquisitionDatabase(options.firestore);
  const ref = Object.freeze({ ...options.ref });
  const id = youtubeAcquisitionId(ref);
  const caller = preparer(options.caller);
  const target = options.firestore.collection(YOUTUBE_ACQUISITIONS).doc(id);
  await options.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(target);
    await options.assertCurrent(tx, ref);
    if (snapshot.exists) {
      const current = operation(snapshot.data(), ref);
      // Only an unclaimed preparation can change its native preparer. A pending
      // old POST races this transaction and can never launch a second operation.
      if (current.status === 'prepared') tx.update(target, { preparedBy: caller });
      return;
    }
    tx.create(target, {
      schemaVersion: 1,
      operationId: id,
      ref,
      preparedBy: caller,
      status: 'prepared',
      createdAt: Date.now(),
    });
  });
}

/** Host private operation store, not Temporal job authority. Host identity comes
 * from native process inspection, never HTTP inputs. The required eligibility
 * callback must read current canonical ownership/cancellation/release/source
 * bindings inside this same transaction. There is NO TTL takeover or reset API.
 */
export function createYouTubeAcquisitionHostStore(options: {
  firestore: Firestore;
  projectId: string;
  owner: AcquisitionHostProcess;
  assertEligible: (transaction: Transaction, ref: MediaJobRef, purpose?: 'source_available') => Promise<void>;
}) {
  if (options.projectId !== 'urm-app-staging') return fail();
  assertStagingAcquisitionDatabase(options.firestore);
  const owner = host(options.owner);
  const target = (ref: MediaJobRef) =>
    options.firestore.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
  const owned = (current: Operation) => {
    if (current.status !== 'running' || fingerprint(host(current.owner!)) !== fingerprint(owner)) return fail();
  };
  return {
    async read(ref: MediaJobRef): Promise<Operation | undefined> {
      ref = Object.freeze({ ...ref });
      const snapshot = await target(ref).get();
      return snapshot.exists ? operation(snapshot.data(), ref) : undefined;
    },
    async assertCurrent(ref: MediaJobRef): Promise<void> {
      ref = Object.freeze({ ...ref });
      await options.firestore.runTransaction(async (tx) => {
        owned(operation((await tx.get(target(ref))).data(), ref));
        await options.assertEligible(tx, ref);
      });
    },
    async claim(ref: MediaJobRef, verifiedCallerEmail: string): Promise<{ launch: boolean }> {
      ref = Object.freeze({ ...ref });
      const doc = target(ref);
      return options.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(doc);
        if (!snapshot.exists) return fail(); // An HTTP caller cannot create its own delegation.
        const current = operation(snapshot.data(), ref);
        await options.assertEligible(tx, ref);
        if (current.preparedBy.serviceAccount !== verifiedCallerEmail) return fail();
        if (current.status !== 'prepared') return { launch: false };
        tx.update(doc, { status: 'running', owner, startedAt: Date.now() });
        return { launch: true };
      });
    },
    /** Upload attempts are private children of the actual running host owner.
     * An unresolved attempt fences later attempts; no timeout or lease takeover.
     * A repeated begin is reconciliation-only and never authorizes another producer.
     */
    upload(ref: MediaJobRef, attemptId: string) {
      ref = Object.freeze({ ...ref });
      if (!/^[a-f0-9-]{36}$/.test(attemptId)) return fail();
      const parent = target(ref);
      const doc = parent.collection('uploads').doc(attemptId);
      const path = `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-${attemptId}.bin`;
      type Bytes = { bytes: number; crc32c: string };
      const checkedBytes = (raw: Bytes): Bytes => {
        if (
          !raw ||
          Object.keys(raw).sort().join(',') !== 'bytes,crc32c' ||
          !Number.isSafeInteger(raw.bytes) ||
          raw.bytes <= 0 ||
          raw.bytes > 20 * 1024 ** 3 ||
          typeof raw.crc32c !== 'string' ||
          !/^[A-Za-z0-9+/]{6}==$/.test(raw.crc32c)
        )
          return fail();
        return { bytes: raw.bytes, crc32c: raw.crc32c };
      };
      type Upload = {
        state: 'streaming' | 'bytes_complete' | 'retained';
        expected?: Bytes;
        receipt?: YouTubeStreamReceipt;
      };
      const checked = (raw: unknown): Upload => {
        const value = raw as Upload & { path: string; owner: AcquisitionHostProcess };
        if (
          !value ||
          value.path !== path ||
          fingerprint(host(value.owner)) !== fingerprint(owner) ||
          !['streaming', 'bytes_complete', 'retained'].includes(value.state)
        )
          return fail();
        const keys = Object.keys(value).sort().join(',');
        if (value.state === 'streaming') {
          if (keys !== 'createdAt,owner,path,state') return fail();
        } else {
          checkedBytes(value.expected!);
          if (value.state === 'bytes_complete') {
            if (keys !== 'createdAt,expected,owner,path,state') return fail();
          } else {
            const receipt = value.receipt;
            if (
              keys !== 'createdAt,expected,owner,path,receipt,state' ||
              !receipt ||
              Object.keys(receipt).sort().join(',') !== 'bytes,crc32c,generation,path' ||
              receipt.path !== path ||
              typeof receipt.generation !== 'string' ||
              !/^[1-9][0-9]{0,29}$/.test(receipt.generation) ||
              receipt.bytes !== value.expected!.bytes ||
              receipt.crc32c !== value.expected!.crc32c
            )
              return fail();
          }
        }
        if (!('createdAt' in value) || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0)
          return fail();
        return value;
      };
      const current = async (tx: Transaction) => {
        const snapshot = await tx.get(parent);
        owned(operation(snapshot.data(), ref));
        const upload = await tx.get(doc);
        await options.assertEligible(tx, ref);
        if (snapshot.get('activeUpload') !== attemptId) return fail();
        return checked(upload.data());
      };
      return {
        path,
        binding: Object.freeze({
          jobId: ref.jobId,
          requestVersion: ref.requestVersion,
          operationId: youtubeAcquisitionId(ref),
          attemptId,
        }),
        async begin(): Promise<{ launch: boolean; expected?: Bytes; receipt?: YouTubeStreamReceipt }> {
          return options.firestore.runTransaction(async (tx) => {
            const snapshot = await tx.get(parent);
            owned(operation(snapshot.data(), ref));
            const upload = await tx.get(doc);
            await options.assertEligible(tx, ref);
            if (upload.exists) {
              if (snapshot.get('activeUpload') !== attemptId) return fail();
              const value = checked(upload.data());
              return {
                launch: false,
                ...(value.expected ? { expected: value.expected } : {}),
                ...(value.receipt ? { receipt: value.receipt } : {}),
              };
            }
            if (snapshot.get('activeUpload') !== undefined) return fail();
            writeMediaUploadIntent(tx, options.firestore, {
              projectId: ref.projectId,
              sermonId: ref.sermonId,
              jobId: ref.jobId,
              path,
              createdAt: Date.now(),
            });
            tx.create(doc, { state: 'streaming', path, owner, createdAt: Date.now() });
            tx.update(parent, { activeUpload: attemptId });
            return { launch: true };
          });
        },
        async recordBytes(raw: Bytes): Promise<void> {
          const expected = checkedBytes(raw);
          await options.firestore.runTransaction(async (tx) => {
            const value = await current(tx);
            if (value.state !== 'streaming' || value.expected) return fail();
            tx.update(doc, { state: 'bytes_complete', expected });
          });
        },
        /** Only the concrete uploader calls this after a confirmed native
         * producer failure accompanies a successful bounded transfer. Uncertain drain/upload
         * never releases this fence, and the failed attempt ID never relaunches.
         * Partial objects remain discoverable in this private upload journal.
         */
        async rejectFailedProducer(drain: () => Promise<void>): Promise<void> {
          await drain();
          await options.firestore.runTransaction(async (tx) => {
            const value = await current(tx);
            if (value.state !== 'streaming') return fail();
            tx.update(doc, { state: 'failed', failedAt: Date.now() });
            tx.update(parent, { activeUpload: FieldValue.delete() });
          });
        },
        async retain(raw: YouTubeStreamReceipt): Promise<void> {
          const receipt = { ...raw };
          if (
            Object.keys(receipt).sort().join(',') !== 'bytes,crc32c,generation,path' ||
            receipt.path !== path ||
            typeof receipt.generation !== 'string' ||
            !/^[1-9][0-9]{0,29}$/.test(receipt.generation)
          )
            return fail();
          checkedBytes({ bytes: receipt.bytes, crc32c: receipt.crc32c });
          await options.firestore.runTransaction(async (tx) => {
            const value = await current(tx);
            if (!value.expected || value.expected.bytes !== receipt.bytes || value.expected.crc32c !== receipt.crc32c)
              return fail();
            if (value.state === 'retained' && value.receipt!.generation !== receipt.generation) return fail();
            tx.update(doc, { state: 'retained', receipt });
          });
        },
      };
    },
    /** The process driver must drain its real children before this call can
     * settle. Unknown/failed drain leaves ownership running. Never accept a
     * caller's boolean "drained" or unverified termination assertion instead.
     * No artifact or canonical document is deleted or adopted here.
     */
    async settle(ref: MediaJobRef, result: RemoteYouTubeResult, drain: () => Promise<void>): Promise<void> {
      ref = Object.freeze({ ...ref });
      const safe: RemoteYouTubeResult =
        result.kind === 'source'
          ? { kind: 'source', artifact: validateAcquiredYouTubeSource(ref, result.artifact) }
          : result.kind === 'waiting_auth'
          ? { kind: 'waiting_auth', recoveryGeneration: null }
          : [
              'completed',
              'source_available',
              'waiting_archive',
              'restricted',
              'cancelled',
              'superseded',
              'deleted',
            ].includes(result.kind)
          ? { kind: result.kind }
          : fail();
      await drain();
      ref = Object.freeze({ ...ref });
      const doc = target(ref);
      await options.firestore.runTransaction(async (tx) => {
        const current = operation((await tx.get(doc)).data(), ref);
        owned(current);
        // A ready source must still be eligible. Inert stop/defer receipts may
        // settle after cancellation/deletion so resource drain remains visible.
        if (safe.kind === 'source') await options.assertEligible(tx, ref);
        if (safe.kind === 'source_available') await options.assertEligible(tx, ref, 'source_available');
        tx.update(doc, { status: safe.kind, result: safe, drainedAt: Date.now() });
      });
    },
  };
}
