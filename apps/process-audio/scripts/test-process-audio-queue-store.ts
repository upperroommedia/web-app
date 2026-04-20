import assert from 'node:assert/strict';
import {
  buildCloudTasksCreateTaskRequest,
  enqueueTaskViaCloudTasksApi,
} from '../src/processAudioQueueStore';

async function main(): Promise<void> {
  const youtubePayload = {
    id: 'sermon-123',
    startTime: 12,
    duration: 345,
    youtubeUrl: 'https://www.youtube.com/watch?v=dKaZ89SkVYY',
  } as const;

  const request = buildCloudTasksCreateTaskRequest({
    payload: youtubePayload,
    queueName: 'processaudioyoutubetask',
    taskId: 'pa-test-task',
    projectId: 'urm-app',
    location: 'us-central1',
  });

  assert.equal(
    request.url,
    'https://cloudtasks.googleapis.com/v2/projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks'
  );

  const parsedBody = JSON.parse(request.init.body) as {
    task: {
      name: string;
      dispatchDeadline: string;
      httpRequest: {
        httpMethod: string;
        url: string;
        headers: Record<string, string>;
        body: string;
      };
    };
  };

  assert.equal(
    parsedBody.task.name,
    'projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/pa-test-task'
  );
  assert.equal(parsedBody.task.dispatchDeadline, '1800s');
  assert.equal(parsedBody.task.httpRequest.httpMethod, 'POST');
  assert.equal(parsedBody.task.httpRequest.url, 'https://yt-worker.upperroommedia.org/process-audio');
  assert.deepEqual(parsedBody.task.httpRequest.headers, {
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(Buffer.from(parsedBody.task.httpRequest.body, 'base64').toString('utf8')), {
    data: {
      id: 'sermon-123',
      startTime: 12,
      duration: 345,
      deleteOriginal: false,
      skipTranscode: false,
      youtubeUrl: 'https://www.youtube.com/watch?v=dKaZ89SkVYY',
    },
  });

  let fetchUrl: string | undefined;
  let fetchInit: RequestInit | undefined;

  await enqueueTaskViaCloudTasksApi(youtubePayload, 'processaudioyoutubetask', 'pa-test-task', {
    authFactory: async () => ({
      getAccessToken: async () => 'test-token',
    }),
    fetchImpl: async (url, init) => {
      fetchUrl = String(url);
      fetchInit = init;
      return new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    },
  });

  assert.equal(fetchUrl, request.url);
  assert.equal(fetchInit?.method, 'POST');
  assert.equal((fetchInit?.headers as Record<string, string>).Authorization, 'Bearer test-token');
  assert.equal((fetchInit?.headers as Record<string, string>)['Content-Type'], 'application/json');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
