import {
  mediaJobParentFailureLine,
  mediaJobPhase,
  tagMediaJobFailure,
  type MediaJobLaunchPhase,
} from './media-job-launch-failure';

const event = 'media_recovery_job_parent_start_failed';
const originalEnv = process.env;
beforeEach(() => {
  process.env = {
    ...originalEnv,
    FIREBASE_PROJECT_ID: 'urm-app-staging',
    TEMPORAL_MEDIA_RECOVERY_COMPUTE: 'cloud-run-job-v1',
  };
  delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
});
afterEach(() => {
  process.env = originalEnv;
});

test.each<[MediaJobLaunchPhase, unknown, string, string | number]>([
  ['task-list', { response: { status: 403, data: 'secret body' } }, 'http', 403],
  ['task-get', { response: { status: 403 }, config: { headers: { authorization: 'secret bearer' } } }, 'http', 403],
  ['metadata-account', { status: 404 }, 'http', 404],
  ['metadata-instance', { name: 'TimeoutError' }, 'local', 'timeout-or-abort'],
  ['metadata-project-number', { cause: { code: 'EAI_AGAIN', message: 'private hostname' } }, 'local', 'EAI_AGAIN'],
  ['task-identity', new Error('MEDIA_RECOVERY_JOB_IDENTITY_UNCONFIRMED'), 'local', 'validation-failed'],
  ['capability-firestore', { code: 7 }, 'grpc', 7],
  ['capability-auth', { code: 'auth/insufficient-permission' }, 'firebase-auth', 'auth/insufficient-permission'],
  ['temporal-connect', { code: 4 }, 'grpc', 4],
  ['kernel-create', { code: 7 }, 'grpc', 7],
  ['kernel-reconcile', { code: 14 }, 'grpc', 14],
  ['capability-auth', { code: 'auth/secret bearer', message: 'secret actor' }, 'local', 'unknown'],
  [
    'worker-witness',
    {
      get response() {
        throw new Error('secret response');
      },
    },
    'local',
    'unknown',
  ],
])('preserves only the allowed %s failure classification', (phase, cause, protocol, code) => {
  const error = Object.assign(new Error('secret error'), { cause, request: { private: 'secret request' } });
  tagMediaJobFailure(phase, cause, error);
  tagMediaJobFailure('worker-witness', error);
  expect(JSON.parse(mediaJobParentFailureLine(error))).toEqual({ event, phase, protocol, code });
});

test('a throwing SDK code accessor preserves the original error and leaves the phase untagged', () => {
  const error = {
    get code() {
      throw new Error('secret accessor error');
    },
  };
  expect(() => tagMediaJobFailure('capability-firestore', error, error, 'grpc')).not.toThrow();
  expect(JSON.parse(mediaJobParentFailureLine(error))).toEqual({
    event,
    phase: 'launcher',
    protocol: 'local',
    code: 'unknown',
  });
});

test('tags only the throwing parallel request, preserves its exception and never retries', async () => {
  const error = Object.assign(new Error('secret url'), { response: { status: 503 } });
  const get = jest.fn(async () => {
    throw error;
  });
  await expect(
    Promise.all([mediaJobPhase('execution-get', async () => ({})), mediaJobPhase('task-list', get)])
  ).rejects.toBe(error);
  expect(get).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mediaJobParentFailureLine(error))).toEqual({
    event,
    phase: 'task-list',
    protocol: 'http',
    code: 503,
  });
});

test('ordinary workers and children keep the original line while finite parents receive a safe fallback', () => {
  const error = new Error('secret stderr');
  const generic = 'Application worker launch failed.';
  expect(JSON.parse(mediaJobParentFailureLine(error))).toEqual({
    event,
    phase: 'launcher',
    protocol: 'local',
    code: 'unknown',
  });
  tagMediaJobFailure('launcher', error);
  process.env.TEMPORAL_MEDIA_RECOVERY_CHILD = 'original';
  expect(mediaJobParentFailureLine(error)).toBe(generic);
  delete process.env.TEMPORAL_MEDIA_RECOVERY_CHILD;
  delete process.env.TEMPORAL_MEDIA_RECOVERY_COMPUTE;
  expect(mediaJobParentFailureLine(error)).toBe(generic);
  process.env.TEMPORAL_MEDIA_RECOVERY_COMPUTE = 'cloud-run-job-v1';
  process.env.FIREBASE_PROJECT_ID = 'urm-app';
  expect(mediaJobParentFailureLine(error)).toBe(generic);
});
