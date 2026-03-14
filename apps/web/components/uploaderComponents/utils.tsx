import { UploaderFieldError } from '../../context/types';
import { uploadStatus } from '../../types/SermonTypes';

export function showAudioTrimmerBoolean(soundCloudStatus?: string, subsplashStatus?: string) {
  return soundCloudStatus !== uploadStatus.UPLOADED && subsplashStatus !== uploadStatus.UPLOADED;
}

export function camelCaseToCapitalWords(input: string): string {
  // Split the input string by capital letters
  const words = input.split(/(?=[A-Z])/);

  // Capitalize the first letter of each word and join them with spaces
  const capitalizedWords = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  return capitalizedWords;
}

export function createFormErrorMessage(name: string): string {
  return `${camelCaseToCapitalWords(name)} cannot be empty`;
}
export function getErrorMessage(uploaderFieldError?: UploaderFieldError): string {
  return !uploaderFieldError?.initialState && uploaderFieldError?.error ? uploaderFieldError.message : '';
}

export function showError(uploaderFieldError?: UploaderFieldError): boolean | undefined {
  return !uploaderFieldError?.initialState && uploaderFieldError?.error;
}
