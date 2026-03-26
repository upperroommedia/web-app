import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { PROCESS_AUDIO_TASK_QUEUE_NAME } from './audioTaskPayload';

const processaudiotask = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 5,
      maxBackoffSeconds: 300,
      maxDoublings: 5,
      maxRetrySeconds: 1800,
    },
    rateLimits: {
      maxConcurrentDispatches: 10,
      maxDispatchesPerSecond: 5,
    },
  },
  async (request) => {
    logger.error('Misrouted audio task reached Firebase task placeholder', {
      queueName: PROCESS_AUDIO_TASK_QUEUE_NAME,
      payloadKeys: request.data && typeof request.data === 'object' ? Object.keys(request.data as Record<string, unknown>) : [],
    });

    throw new Error('Audio task reached the Firebase placeholder queue target instead of the process-audio Cloud Run service.');
  }
);

export default processaudiotask;
