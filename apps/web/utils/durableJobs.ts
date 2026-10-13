import type {
  DurableAdmissionRequest,
  DurableAdmissionReceipt,
  DurableJob,
  DurableAction,
  DurableJobCommand,
  DurableCommandReceipt,
} from '@upperroom/contracts/temporal';
import firebase, { isDevelopment } from '../firebase/firebase';
import auth, { onAuthStateChanged } from '../firebase/auth';
import { createFunctionV2, isRetryableCallableTransportError } from './createFunction';
import { jobRegistry } from '../context/jobs/jobRegistry';

const PREFIX = 'urm:durable:v1:';
const memory = new Map<string, string>();
let previousUid: string | undefined;
onAuthStateChanged(auth, (user) => {
  if (previousUid !== user?.uid) {
    jobRegistry.clear();
    memory.clear();
    if (previousUid && typeof window !== 'undefined') {
      try {
        Object.keys(window.localStorage)
          .filter(
            (key) =>
              (key.startsWith(PREFIX) ||
                key.startsWith('urm:image-source:v1:') ||
                key.startsWith('urm:upload-admission:v1:')) &&
              key.includes(`:${previousUid}:`)
          )
          .forEach((key) => window.localStorage.removeItem(key));
      } catch {
        /* Storage may be disabled; identity data is never required to render. */
      }
      try {
        Object.keys(window.sessionStorage)
          .filter((key) => key.startsWith('urm:invite-claim:v1:') && key.includes(`:${previousUid}:`))
          .forEach((key) => window.sessionStorage.removeItem(key));
      } catch {
        /* Session storage may be unavailable independently of local storage. */
      }
    }
    previousUid = user?.uid;
  }
});

export class DurableAdmissionUnknownError extends Error {
  constructor(public readonly requestId: string) {
    super(
      'The request may already be running. Reconnect and try again to check the same request; your source has been kept.'
    );
    this.name = 'DurableAdmissionUnknownError';
  }
}
export const canonicalIntent = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntent(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const digest = async (value: string): Promise<string> => {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const scope = (): string => {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Please sign in before starting a task.');
  return `${PREFIX}${firebase.options.projectId}:${isDevelopment ? 'emulator' : 'hosted'}:${uid}:`;
};
const pendingId = async (input: unknown): Promise<{ key: string; requestId: string }> => {
  const value = input as { purpose?: string; action?: string };
  const purpose = value.purpose === 'creation-entity' ? 'creation' : value.action ? 'command' : 'request';
  const key = `${scope()}${purpose}:${await digest(canonicalIntent(input))}`;
  const acquire = () => {
    let existing = memory.get(key);
    try {
      existing = window.localStorage.getItem(key) ?? existing;
    } catch {
      /* Private mode fallback. */
    }
    const requestId = existing || globalThis.crypto.randomUUID();
    memory.set(key, requestId);
    try {
      window.localStorage.setItem(key, requestId);
    } catch {
      /* This tab still reuses its pending ID. */
    }
    return { key, requestId };
  };
  // Synchronize acquisition across tabs; backend admission remains the concurrency boundary.
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(key, acquire) : acquire();
};
const forget = (key: string) => {
  memory.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Optional persistence. */
  }
};

/** A creation target survives reload while its admission outcome is uncertain. */
export async function getPendingCreationId(kind: string, payload: Record<string, unknown>): Promise<string> {
  return (await pendingId({ purpose: 'creation-entity', kind, payload })).requestId;
}
export async function forgetPendingCreationId(kind: string, payload: Record<string, unknown>): Promise<void> {
  forget(`${scope()}creation:${await digest(canonicalIntent({ purpose: 'creation-entity', kind, payload }))}`);
}

/** Recover accepted work after reload without storing or replaying its original payload. */
export async function recoverPendingDurableRequests(): Promise<{
  receipts: DurableAdmissionReceipt[];
  uncertain: number;
}> {
  const prefix = `${scope()}request:`;
  const uploadPrefix = `urm:upload-admission:v1:${firebase.options.projectId}:${
    isDevelopment ? 'emulator' : 'hosted'
  }:${auth.currentUser!.uid}:`;
  const entries = new Map<string, string>();
  const creationFingerprints = new Map<string, string>();
  memory.forEach((value, key) => {
    if (key.startsWith(prefix)) entries.set(key, value);
  });
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) {
        const value = window.localStorage.getItem(key);
        if (value) entries.set(key, value);
      }
      if (key?.startsWith(uploadPrefix)) {
        const value = window.localStorage.getItem(key);
        if (!value) continue;
        try {
          const record = JSON.parse(value) as {
            schemaVersion?: unknown;
            requestId?: unknown;
            creationFingerprint?: unknown;
          };
          if (
            record.schemaVersion === 1 &&
            typeof record.requestId === 'string' &&
            typeof record.creationFingerprint === 'string' &&
            /^[a-f0-9]{64}$/.test(record.creationFingerprint)
          ) {
            entries.set(key, record.requestId);
            creationFingerprints.set(key, record.creationFingerprint);
          }
        } catch {
          /* Ignore malformed local hints; never synthesize a new request. */
        }
      }
    }
  } catch {
    /* In-tab pending state remains available. */
  }
  const receipts: DurableAdmissionReceipt[] = [];
  let uncertain = 0;
  const getReceipt = createFunctionV2<{ requestId: string }, DurableAdmissionReceipt | null>('getDurableJobReceipt');
  // Bound lookup fanout. Unchecked IDs remain pending for another explicit check.
  const pending = [...entries].slice(0, 20);
  for (let offset = 0; offset < pending.length; offset += 4) {
    await Promise.all(
      pending.slice(offset, offset + 4).map(async ([key, requestId]) => {
        try {
          const receipt = await getReceipt({ requestId });
          if (receipt) {
            if (!receipts.some((known) => known.jobId === receipt.jobId)) receipts.push(receipt);
            forget(key);
            const creation = creationFingerprints.get(key);
            if (creation) forget(`${scope()}creation:${creation}`);
          } else uncertain += 1;
        } catch {
          uncertain += 1;
        }
      })
    );
  }
  return { receipts, uncertain: uncertain + Math.max(0, entries.size - pending.length) };
}

export async function submitDurableIntent(
  input: Omit<DurableAdmissionRequest, 'requestId'> & { requestId?: string }
): Promise<DurableAdmissionReceipt> {
  const pending = input.requestId
    ? { key: `${scope()}explicit:${input.requestId}`, requestId: input.requestId }
    : await pendingId(input);
  const submit = createFunctionV2<DurableAdmissionRequest, DurableAdmissionReceipt>('submitDurableJob');
  try {
    const receipt = await submit({ ...input, requestId: pending.requestId });
    forget(pending.key);
    return receipt;
  } catch (error) {
    if (!isRetryableCallableTransportError(error)) {
      forget(pending.key);
      throw error;
    }
    try {
      const getReceipt = createFunctionV2<{ requestId: string }, DurableAdmissionReceipt | null>(
        'getDurableJobReceipt'
      );
      const receipt = await getReceipt({ requestId: pending.requestId });
      if (receipt) {
        forget(pending.key);
        return receipt;
      }
    } catch {
      /* Keep the same ID until admission can be checked safely. */
    }
    throw new DurableAdmissionUnknownError(pending.requestId);
  }
}

export async function submitDurableCommand(
  job: DurableJob,
  action: DurableAction,
  resolution?: Record<string, unknown>
): Promise<DurableCommandReceipt> {
  if (!job.actions.includes(action)) throw new Error('This action is no longer available. Refresh the task status.');
  const input = { jobId: job.jobId, expectedRevision: job.revision, action, ...(resolution ? { resolution } : {}) };
  const pending = await pendingId(input);
  try {
    const command = createFunctionV2<DurableJobCommand, DurableCommandReceipt>('commandDurableJob');
    const receipt = await command({ ...input, requestId: pending.requestId });
    forget(pending.key);
    return receipt;
  } catch (error) {
    if (!isRetryableCallableTransportError(error)) forget(pending.key);
    throw error;
  }
}
