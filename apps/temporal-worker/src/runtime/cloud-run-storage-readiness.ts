import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import type { WorkerReadinessRole } from './readiness-probe';
import type { WorkerWitness } from './worker-witness';

const mediaBucket = 'urm-app-staging.firebasestorage.app';
const imagesBucket = 'urm-app-staging-images';
const read = 'storage.objects.get';
const create = 'storage.objects.create';
const remove = 'storage.objects.delete';
const update = 'storage.objects.update';

const roleAccess = {
  orchestration: { bucket: mediaBucket, permissions: [create, remove, read] },
  controls: { bucket: mediaBucket, permissions: [read] },
  media: { bucket: mediaBucket, permissions: [create, remove, read] },
  images: { bucket: imagesBucket, permissions: [remove, read, update] },
  email: null,
  search: null,
} as const satisfies Record<WorkerReadinessRole, { bucket: string; permissions: readonly string[] } | null>;

const overrides = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GCE_METADATA_HOST',
  'GCE_METADATA_IP',
  'GCE_METADATA_ROOT',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST',
];

type StorageAccess = NonNullable<(typeof roleAccess)[WorkerReadinessRole]>;
type StorageReadiness = StorageAccess & { observedAt: string };

export function expectedCloudRunStorageAccess(role: WorkerReadinessRole): StorageAccess | null {
  return roleAccess[role];
}

function unconfirmed(): Error {
  return new Error('CLOUD_RUN_STORAGE_READINESS_UNCONFIRMED');
}

/** Ask Storage to evaluate bucket IAM as the verified runtime principal.
 * This read-only probe does not exercise object creation, deletion or ACLs.
 */
export async function verifyCloudRunStorageReadiness(
  role: WorkerReadinessRole,
  witness: WorkerWitness,
  cancellationSignal: AbortSignal
): Promise<StorageReadiness | null> {
  const access = expectedCloudRunStorageAccess(role);
  if (access === null) return null;

  const signal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(10000)]);
  const onAbort = () => rejectDeadline?.(unconfirmed());
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const owned = getSharedFirebaseAppOwnership();
    const cloud = witness.cloudRun;
    const credential = owned?.app.options.credential;
    if (
      overrides.some((name) => process.env[name] !== undefined) ||
      !cloud ||
      cloud.projectId !== 'urm-app-staging' ||
      cloud.region !== 'us-central1' ||
      !cloud.serviceAccount ||
      !owned?.isRegistered() ||
      owned.app.name !== '[DEFAULT]' ||
      owned.app.options.projectId !== cloud.projectId ||
      !credential
    )
      throw unconfirmed();

    const compute = Reflect.get(credential, 'isComputeEngineCredential');
    const email = Reflect.get(credential, 'getServiceAccountEmail');
    if (
      typeof compute !== 'function' ||
      typeof email !== 'function' ||
      (await Promise.race([Promise.resolve(compute.call(credential)), deadline])) !== true ||
      (await Promise.race([Promise.resolve(email.call(credential)), deadline])) !== cloud.serviceAccount
    )
      throw unconfirmed();

    signal.throwIfAborted();
    const { access_token: token } = await Promise.race([credential.getAccessToken(), deadline]);
    signal.throwIfAborted();
    if (typeof token !== 'string' || !token.trim()) throw unconfirmed();
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${access.bucket}/iam/testPermissions`);
    for (const permission of access.permissions) url.searchParams.append('permissions', permission);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw unconfirmed();
    const result = await response.json();
    signal.throwIfAborted();
    if (
      result?.kind !== 'storage#testIamPermissionsResponse' ||
      !Array.isArray(result.permissions) ||
      result.permissions.length !== access.permissions.length ||
      [...result.permissions].sort().some((permission, index) => permission !== access.permissions[index])
    )
      throw unconfirmed();

    return { ...access, observedAt: new Date().toISOString() };
  } catch {
    throw unconfirmed();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
