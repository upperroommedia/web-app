export type NotificationSource = 'role-request' | 'speaker-request' | 'runtime-alert';

interface SpeakerRequestImageAsset {
  downloadLink: string;
  storagePath: string;
  fileName: string;
  contentType: string;
}

export interface RoleRequestNotificationPayload {
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  requestedRole: string;
  reason: string;
  requestedAtMs: number;
  adminUrl: string;
}

export interface SpeakerRequestNotificationPayload {
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  speakerName: string;
  description: string;
  image: SpeakerRequestImageAsset;
  requestedAtMs: number;
  adminUrl: string;
}

export interface OperationalAlertPayload {
  alertCode: string;
  summary: string;
  occurredAtMs: number;
  errorMessage: string;
  errorName?: string;
  errorStack?: string;
  context?: Record<string, unknown>;
}

export interface QueueEmailMessage {
  subject: string;
  text?: string;
  html?: string;
}

export interface QueueEmailInput {
  to: string[];
  message: QueueEmailMessage;
  source: NotificationSource;
  alertType: string;
  alertCode?: string;
  metadata?: Record<string, unknown>;
}
