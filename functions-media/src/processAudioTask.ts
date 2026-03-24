import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { PROCESS_AUDIO_TASK_QUEUE_NAME } from './audioTaskPayload';

const processaudiotask = onTaskDispatched(async (request) => {
  logger.error('Misrouted audio task reached Firebase task placeholder', {
    queueName: PROCESS_AUDIO_TASK_QUEUE_NAME,
    payloadKeys: request.data && typeof request.data === 'object' ? Object.keys(request.data as Record<string, unknown>) : [],
  });

  throw new Error('Audio task reached the Firebase placeholder queue target instead of the process-audio Cloud Run service.');
});

export default processaudiotask;
