import type { AddIntroOutroInputType, AudioSource } from '@upperroom/contracts/addIntroOutro/types';
import { PROCESS_AUDIO_FILE_TASK_QUEUE_NAME } from '@upperroom/contracts/processAudioQueue';
import { logger } from 'firebase-functions/v2';

export const PROCESS_AUDIO_TASK_QUEUE_NAME = PROCESS_AUDIO_FILE_TASK_QUEUE_NAME;
export const PROCESS_AUDIO_TASK_TIMEOUT_SECONDS = 1800;

export function validateAddIntroOutroData(data: unknown): data is AddIntroOutroInputType {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const inputData = data as Partial<AddIntroOutroInputType>;

  if ('youtubeUrl' in inputData) {
    if (!inputData.youtubeUrl) {
      logger.error('Invalid Argument', 'youtubeUrl cannot be empty if defined');
      return false;
    }
  } else if ('storageFilePath' in inputData) {
    if (!inputData.storageFilePath) {
      logger.error('Invalid Argument', 'storageFilePath cannot be empty if defined');
      return false;
    }
  } else {
    logger.error(
      'Invalid Argument',
      'inputData must contain either a valid youtubeUrl (string) or storageFilePath (string) property'
    );
    return false;
  }

  if (
    !inputData.id ||
    inputData.startTime === undefined ||
    inputData.startTime === null ||
    inputData.duration === undefined ||
    inputData.duration === null
  ) {
    logger.error(
      'Invalid Argument',
      'Data must contain id (string), startTime (number), and duration (number) properties'
    );
    return false;
  }

  return true;
}

export function getAudioSource(data: AddIntroOutroInputType): AudioSource {
  if ('youtubeUrl' in data) {
    return {
      id: data.id,
      source: data.youtubeUrl,
      type: 'YouTubeUrl',
    };
  }

  return {
    id: data.id,
    source: data.storageFilePath,
    type: 'StorageFilePath',
  };
}
