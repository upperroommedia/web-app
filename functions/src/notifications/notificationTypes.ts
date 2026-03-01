export type NotificationSource = 'role-request' | 'runtime-alert';

export interface RoleRequestNotificationPayload {
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  requestedRole: string;
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
