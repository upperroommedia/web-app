import { GoogleAuth } from 'google-auth-library';
import type { ProcessAudioSourceType } from '@upperroom/contracts/processAudioQueue';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';

const PROCESS_AUDIO_BASE_URLS = {
  prod: {
    storage: 'https://process-audio-yshbijirxq-uc.a.run.app',
    youtube: 'https://yt-worker.upperroommedia.org',
  },
  staging: {
    storage: 'https://process-audio-staging-pvaq33fxyq-uc.a.run.app',
    youtube: 'https://yt-worker-staging.upperroommedia.org',
  },
  local: 'http://127.0.0.1:8080',
};

type ValidateYouTubeCookiesResponse = {
  ok: boolean;
  message?: string;
  validationUrl?: string;
  status: GetYouTubeCookieStatusOutputType;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/process-audio\/?$/u, '').replace(/\/+$/u, '');

const isGoogleRunUrl = (url: string): boolean => /\.run\.app$/u.test(new URL(url).hostname);

export const getProcessAudioBaseUrl = (sourceType: ProcessAudioSourceType = 'storage'): string => {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return PROCESS_AUDIO_BASE_URLS.local;
  }

  const configuredTarget =
    sourceType === 'youtube'
      ? process.env.PROCESS_AUDIO_YOUTUBE_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_YOUTUBE_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_YOUTUBE_SERVICE_URL
      : process.env.PROCESS_AUDIO_FILE_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_FILE_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_FILE_SERVICE_URL ||
        process.env.PROCESS_AUDIO_TASK_TARGET_URI ||
        process.env.PROCESS_AUDIO_SERVICE_URL ||
        process.env.NEXT_PUBLIC_PROCESS_AUDIO_SERVICE_URL;

  if (configuredTarget) {
    return normalizeBaseUrl(configuredTarget);
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const targetSet = projectId === 'urm-app-staging' ? PROCESS_AUDIO_BASE_URLS.staging : PROCESS_AUDIO_BASE_URLS.prod;
  return targetSet[sourceType];
};

export const getProcessAudioTargetUri = (sourceType: ProcessAudioSourceType = 'storage'): string =>
  `${getProcessAudioBaseUrl(sourceType)}/process-audio`;

const extractValidationResponse = (error: unknown): ValidateYouTubeCookiesResponse | null => {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { data?: unknown } }).response;
  if (!response || typeof response !== 'object') return null;
  const data = response.data;
  if (!data || typeof data !== 'object') return null;
  if (!('status' in data)) return null;
  return data as ValidateYouTubeCookiesResponse;
};

export const validateProcessAudioYouTubeCookies = async (): Promise<ValidateYouTubeCookiesResponse> => {
  const baseUrl = getProcessAudioBaseUrl('youtube');
  const url = `${baseUrl}/validate-youtube-cookies`;

  if (process.env.FUNCTIONS_EMULATOR === 'true' || !isGoogleRunUrl(baseUrl)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = (await response.json()) as ValidateYouTubeCookiesResponse;
    if (!response.ok) {
      throw Object.assign(new Error(data.message || `Validation endpoint returned HTTP ${response.status}`), {
        validationResponse: data,
      });
    }
    return data;
  }

  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(baseUrl);

  try {
    const response = await client.request<ValidateYouTubeCookiesResponse>({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    const validationResponse = extractValidationResponse(error);
    if (validationResponse) {
      throw Object.assign(new Error(validationResponse.message || 'Uploaded YouTube cookies failed validation.'), {
        validationResponse,
      });
    }
    throw error;
  }
};
