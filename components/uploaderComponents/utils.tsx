import { uploadStatus } from '../../types/SermonTypes';

export function showAudioTrimmerBoolean(soundCloudStatus?: string, subsplashStatus?: string) {
  return soundCloudStatus !== uploadStatus.UPLOADED && subsplashStatus !== uploadStatus.UPLOADED;
}
