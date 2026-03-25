import { GoogleAuth } from 'google-auth-library';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';

const PROCESS_AUDIO_BASE_URLS = {
  prod: 'https://process-audio-yshbijirxq-uc.a.run.app',
  staging: 'https://process-audio-staging-pvaq33fxyq-uc.a.run.app',
  local: 'http://127.0.0.1:8080',
};

type ValidateYouTubeCookiesResponse = {
  ok: boolean;
  message?: string;
  validationUrl?: string;
  status: GetYouTubeCookieStatusOutputType;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/process-audio\/?$/u, '').replace(/\/+$/u, '');

export const getProcessAudioBaseUrl = (): string => {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return PROCESS_AUDIO_BASE_URLS.local;
  }

  const configuredTarget =
    process.env.PROCESS_AUDIO_TASK_TARGET_URI ||
    process.env.PROCESS_AUDIO_SERVICE_URL ||
    process.env.NEXT_PUBLIC_PROCESS_AUDIO_SERVICE_URL;

  if (configuredTarget) {
    return normalizeBaseUrl(configuredTarget);
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  return projectId === 'urm-app-staging' ? PROCESS_AUDIO_BASE_URLS.staging : PROCESS_AUDIO_BASE_URLS.prod;
};

export const getProcessAudioTargetUri = (): string => `${getProcessAudioBaseUrl()}/process-audio`;

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
  const baseUrl = getProcessAudioBaseUrl();
  const url = `${baseUrl}/validate-youtube-cookies`;

  if (process.env.FUNCTIONS_EMULATOR === 'true') {
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
