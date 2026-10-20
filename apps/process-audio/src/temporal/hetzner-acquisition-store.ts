import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
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
  assertEligible: (transaction: Transaction, ref: MediaJobRef) => Promise<void>;
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
          : ['completed', 'waiting_archive', 'restricted', 'cancelled', 'superseded', 'deleted'].includes(result.kind)
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
        tx.update(doc, { status: safe.kind, result: safe, drainedAt: Date.now() });
      });
    },
  };
}
