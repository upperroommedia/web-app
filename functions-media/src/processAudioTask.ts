import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import {
  PROCESS_AUDIO_FILE_TASK_QUEUE_NAME,
  PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME,
  type ProcessAudioTaskQueueName,
} from '@upperroom/contracts/processAudioQueue';

const buildProcessAudioPlaceholder = (queueName: ProcessAudioTaskQueueName) =>
  onTaskDispatched(
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
        queueName,
        payloadKeys: request.data && typeof request.data === 'object' ? Object.keys(request.data as Record<string, unknown>) : [],
      });

      throw new Error(`Audio task reached the Firebase placeholder queue ${queueName} instead of the process-audio target service.`);
    }
  );

export const processaudiofiletask = buildProcessAudioPlaceholder(PROCESS_AUDIO_FILE_TASK_QUEUE_NAME);
export const processaudioyoutubetask = buildProcessAudioPlaceholder(PROCESS_AUDIO_YOUTUBE_TASK_QUEUE_NAME);
