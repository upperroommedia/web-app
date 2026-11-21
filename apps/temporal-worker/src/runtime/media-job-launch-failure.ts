const phases = [
  'launcher',
  'config',
  'firebase-bootstrap',
  'dependencies',
  'worker-witness',
  'metadata-project',
  'metadata-project-number',
  'metadata-account',
  'metadata-instance',
  'adc-client',
  'execution-get',
  'task-list',
  'task-get',
  'task-identity',
  'capability',
  'capability-firestore',
  'capability-auth',
  'temporal-connect',
  'kernel-create',
  'kernel-reconcile',
  'kernel-authorize',
  'supervisor',
] as const;
export type MediaJobLaunchPhase = (typeof phases)[number];
type Fact = {
  phase: MediaJobLaunchPhase;
  protocol: 'http' | 'grpc' | 'firebase-auth' | 'local';
  code: string | number;
};
const facts = new WeakMap<object, Fact>();

function privateParent() {
  return (
    process.env.FIREBASE_PROJECT_ID === 'urm-app-staging' &&
    process.env.TEMPORAL_MEDIA_RECOVERY_COMPUTE === 'cloud-run-job-v1' &&
    process.env.TEMPORAL_MEDIA_RECOVERY_CHILD === undefined
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function classify(phase: MediaJobLaunchPhase, error: unknown): Fact {
  // Inspect only known scalar fields. SDK exceptions can contain entire authenticated requests.
  try {
    if (object(error)) {
      const status = object(error.response) ? error.response.status : error.status;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        return { phase, protocol: 'http', code: status };
      const code = error.code;
      if (
        typeof code === 'number' &&
        Number.isInteger(code) &&
        code >= 1 &&
        code <= 16 &&
        ['capability-firestore', 'kernel-create', 'kernel-reconcile', 'temporal-connect'].includes(phase)
      )
        return { phase, protocol: 'grpc', code };
      if (
        phase === 'capability-auth' &&
        typeof code === 'string' &&
        [
          'auth/insufficient-permission',
          'auth/user-not-found',
          'auth/invalid-credential',
          'auth/internal-error',
        ].includes(code)
      )
        return { phase, protocol: 'firebase-auth', code };
      if (
        code === 'ETIMEDOUT' ||
        code === 'ECONNABORTED' ||
        error.name === 'TimeoutError' ||
        error.name === 'AbortError'
      )
        return { phase, protocol: 'local', code: 'timeout-or-abort' };
      const transportCode = code ?? (object(error.cause) ? error.cause.code : undefined);
      if (
        typeof transportCode === 'string' &&
        [
          'ENOTFOUND',
          'EAI_AGAIN',
          'ECONNREFUSED',
          'ECONNRESET',
          'UND_ERR_CONNECT_TIMEOUT',
          'ERR_TLS_CERT_ALTNAME_INVALID',
        ].includes(transportCode)
      )
        return { phase, protocol: 'local', code: transportCode };
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND')
        return { phase, protocol: 'local', code: 'module-unavailable' };
      if (
        typeof error.message === 'string' &&
        [
          'MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED',
          'CLOUD_RUN_WORKER_IDENTITY_MISMATCH',
          'MEDIA_RECOVERY_CAPABILITY_UNCONFIRMED',
          'MEDIA_KERNEL_SUPERVISION_UNCONFIRMED',
          'MEDIA_RECOVERY_CONFIGURATION_UNCONFIRMED',
          'MEDIA_RECOVERY_FIREBASE_OWNER_REQUIRED',
        ].includes(error.message)
      )
        return { phase, protocol: 'local', code: 'validation-failed' };
    }
  } catch {
    /* SDK accessors may throw; never allow reporting to replace the failure. */
  }
  return { phase, protocol: 'local', code: 'unknown' };
}

/** Transfer only the bounded classification when a guard replaces an SDK exception. */
export function tagMediaJobFailure(
  phase: MediaJobLaunchPhase,
  error: unknown,
  destination: unknown = error,
  protocol?: Fact['protocol']
) {
  if (!privateParent() || !object(destination) || facts.has(destination)) return;
  const inner = object(error) ? facts.get(error) : undefined;
  const fact = inner ?? classify(phases.includes(phase) ? phase : 'launcher', error);
  if (!protocol || fact.protocol === protocol) facts.set(destination, fact);
}
export async function mediaJobPhase<T>(phase: MediaJobLaunchPhase, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    tagMediaJobFailure(phase, error);
    throw error;
  }
}
/** The caller uses this string for the existing single stderr line on terminal failure. */
export function mediaJobParentFailureLine(error: unknown): string {
  if (!privateParent()) return 'Application worker launch failed.';
  const known = object(error) ? facts.get(error) : undefined;
  const fact = known ?? classify('launcher', error);
  return JSON.stringify({ event: 'media_recovery_job_parent_start_failed', ...fact });
}
