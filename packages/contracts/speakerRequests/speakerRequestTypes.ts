import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { CreateSpeakerPayloadType } from '../speakers/createSpeakerTypes';

export const SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED = 'SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED' as const;
export const SPEAKER_REQUESTS_COLLECTION = 'speakerRequests' as const;
export const SPEAKER_REQUEST_STATUS_PENDING = 'pending' as const;
export const SPEAKER_REQUEST_STATUS_ACCEPTED = 'accepted' as const;
export const SPEAKER_REQUEST_STATUS_DENIED = 'denied' as const;
export const SPEAKER_REQUEST_STATUSES = [
  SPEAKER_REQUEST_STATUS_PENDING,
  SPEAKER_REQUEST_STATUS_ACCEPTED,
  SPEAKER_REQUEST_STATUS_DENIED,
] as const;
export type SpeakerRequestStatusType = (typeof SPEAKER_REQUEST_STATUSES)[number];

export const SPEAKER_REQUEST_NOTIFICATION_STATUSES = [
  'not_attempted',
  'queued',
  'queue_failed',
  'skipped_existing',
] as const;
export type SpeakerRequestNotificationStatus = (typeof SPEAKER_REQUEST_NOTIFICATION_STATUSES)[number];

const MAX_SPEAKER_REQUEST_NAME_LENGTH = 200;
const MAX_SPEAKER_REQUEST_DESCRIPTION_LENGTH = 4_000;

export interface SpeakerRequestNotificationState {
  status: SpeakerRequestNotificationStatus;
  attemptedAtMs?: number;
  queueMailId?: string;
  queueErrorMessage?: string;
  warningCode?: string;
}

export interface SpeakerRequestImageAsset {
  downloadLink: string;
  storagePath: string;
  fileName: string;
  contentType: string;
}

export interface CreateSpeakerRequestInputType {
  speakerName: string;
  description: string;
  image: SpeakerRequestImageAsset;
}

export interface PersistedSpeakerRequestDocument {
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  speakerName: string;
  description: string;
  image: SpeakerRequestImageAsset;
  status: SpeakerRequestStatusType;
  createdAtMs: number;
  updatedAtMs: number;
  adminUrl: string;
  notification: SpeakerRequestNotificationState;
  confirmationNotification?: SpeakerRequestNotificationState;
  resolutionNotification?: SpeakerRequestNotificationState;
  resolvedAtMs?: number;
  resolvedByUid?: string;
  resolvedByEmail?: string | null;
  declineMessage?: string;
  speakerId?: string;
  speakerNameAtResolution?: string;
}

export interface SpeakerRequestSummary {
  speakerRequestId: string;
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  speakerName: string;
  description: string;
  image: SpeakerRequestImageAsset;
  status: SpeakerRequestStatusType;
  createdAtMs: number;
  updatedAtMs: number;
  notificationStatus: SpeakerRequestNotificationStatus;
  notificationAttemptedAtMs?: number;
  resolvedAtMs?: number;
  resolvedByUid?: string;
  resolvedByEmail?: string | null;
  declineMessage?: string;
  speakerId?: string;
  speakerNameAtResolution?: string;
}

export interface CreateSpeakerRequestSuccessData {
  speakerRequestId: string;
  requestStatus: 'created' | 'existing';
  notification: SpeakerRequestNotificationState;
  confirmationNotification: SpeakerRequestNotificationState;
  warning?: {
    code: typeof SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED;
    message: string;
  };
}

export type CreateSpeakerRequestOutputType = FunctionOutputType<CreateSpeakerRequestSuccessData>;

export interface ListSpeakerRequestsInputType {
  limit?: number;
  requesterUid?: string;
  pageToken?: string;
}

export interface ListSpeakerRequestsResultData {
  speakerRequests: SpeakerRequestSummary[];
  nextPageToken?: string;
}

export type ListSpeakerRequestsOutputType = FunctionOutputType<ListSpeakerRequestsResultData>;

export interface AcceptSpeakerRequestInputType {
  speakerRequestId: string;
  speaker: CreateSpeakerPayloadType;
  createSpeakerList?: boolean;
}

export interface SpeakerRequestResolutionWarning {
  code: typeof SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED;
  message: string;
}

export interface AcceptSpeakerRequestResultData {
  speakerRequestId: string;
  requesterUid: string;
  speakerName: string;
  speakerId: string;
  status: typeof SPEAKER_REQUEST_STATUS_ACCEPTED;
  speakerListCreated: boolean;
  warning?: SpeakerRequestResolutionWarning;
}

export type AcceptSpeakerRequestOutputType = FunctionOutputType<AcceptSpeakerRequestResultData>;

export interface DenySpeakerRequestInputType {
  speakerRequestId: string;
  message: string;
}

export interface DenySpeakerRequestResultData {
  speakerRequestId: string;
  requesterUid: string;
  speakerName: string;
  status: typeof SPEAKER_REQUEST_STATUS_DENIED;
  warning?: SpeakerRequestResolutionWarning;
}

export type DenySpeakerRequestOutputType = FunctionOutputType<DenySpeakerRequestResultData>;

export const sanitizeSpeakerRequestName = (value: string): string => value.replace(/\s+/g, ' ').trim();
export const sanitizeSpeakerRequestDescription = (value: string): string => value.replace(/\s+/g, ' ').trim();
export const sanitizeSpeakerRequestDecisionMessage = (value: string): string => value.replace(/\s+/g, ' ').trim();
export const normalizeSpeakerRequestNameForDuplicateCheck = (value: string): string =>
  sanitizeSpeakerRequestName(value).toLowerCase();

export const buildSpeakerRequestAdminUrl = (adminBaseUrl: string): string =>
  `${adminBaseUrl.replace(/\/+$/, '')}/admin/speakers`;

export const buildUploadPageUrl = (adminBaseUrl: string): string => `${adminBaseUrl.replace(/\/+$/, '')}/`;

const isSpeakerRequestImageAsset = (value: unknown): value is SpeakerRequestImageAsset => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SpeakerRequestImageAsset>;
  return (
    typeof candidate.downloadLink === 'string' &&
    candidate.downloadLink.trim().length > 0 &&
    typeof candidate.storagePath === 'string' &&
    candidate.storagePath.trim().length > 0 &&
    typeof candidate.fileName === 'string' &&
    candidate.fileName.trim().length > 0 &&
    typeof candidate.contentType === 'string' &&
    candidate.contentType.trim().length > 0
  );
};

export type CreateSpeakerRequestValidationResult =
  | {
      ok: true;
      value: {
        speakerName: string;
        description: string;
        image: SpeakerRequestImageAsset;
      };
    }
  | {
      ok: false;
      error: string;
    };

export const validateCreateSpeakerRequestInput = (
  input: Partial<CreateSpeakerRequestInputType> | undefined
): CreateSpeakerRequestValidationResult => {
  const speakerName = sanitizeSpeakerRequestName(input?.speakerName ?? '');
  if (!speakerName) {
    return { ok: false, error: 'Speaker name is required.' };
  }
  if (speakerName.length > MAX_SPEAKER_REQUEST_NAME_LENGTH) {
    return {
      ok: false,
      error: `Speaker name must be ${MAX_SPEAKER_REQUEST_NAME_LENGTH} characters or fewer.`,
    };
  }

  const description = sanitizeSpeakerRequestDescription(input?.description ?? '');
  if (!description) {
    return { ok: false, error: 'Description is required.' };
  }
  if (description.length > MAX_SPEAKER_REQUEST_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description must be ${MAX_SPEAKER_REQUEST_DESCRIPTION_LENGTH} characters or fewer.`,
    };
  }

  if (!isSpeakerRequestImageAsset(input?.image)) {
    return { ok: false, error: 'A speaker image upload is required.' };
  }

  return {
    ok: true,
    value: {
      speakerName,
      description,
      image: input.image,
    },
  };
};

export type DenySpeakerRequestValidationResult =
  | {
      ok: true;
      value: {
        speakerRequestId: string;
        message: string;
      };
    }
  | {
      ok: false;
      error: string;
    };

export const validateDenySpeakerRequestInput = (
  input: Partial<DenySpeakerRequestInputType> | undefined
): DenySpeakerRequestValidationResult => {
  const speakerRequestId = input?.speakerRequestId?.trim();
  if (!speakerRequestId) {
    return { ok: false, error: 'Speaker request id is required.' };
  }

  const message = sanitizeSpeakerRequestDecisionMessage(input?.message ?? '');
  if (!message) {
    return { ok: false, error: 'A response message is required.' };
  }

  return {
    ok: true,
    value: {
      speakerRequestId,
      message,
    },
  };
};
