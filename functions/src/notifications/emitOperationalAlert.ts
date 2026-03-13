import { logger } from 'firebase-functions/v2';
import {
  buildProfessionalEmailHtml,
  formatEmailDateTime,
} from './emailTemplates';
import { getRuntimeAlertRecipients } from './notificationParams';
import { OperationalAlertPayload } from './notificationTypes';
import { queueEmail } from './queueEmail';

const OPERATIONAL_ALERT_EMITTED = Symbol.for('urm.operationalAlertEmitted');

export interface EmitOperationalAlertInput {
  alertCode: string;
  summary: string;
  error: unknown;
  context?: Record<string, unknown>;
}

type AlertMarkedError = Error & {
  [OPERATIONAL_ALERT_EMITTED]?: boolean;
};

export const markOperationalAlertEmitted = (error: unknown): void => {
  if (error instanceof Error) {
    (error as AlertMarkedError)[OPERATIONAL_ALERT_EMITTED] = true;
  }
};

export const hasOperationalAlertBeenEmitted = (error: unknown): boolean =>
  error instanceof Error && Boolean((error as AlertMarkedError)[OPERATIONAL_ALERT_EMITTED]);

const toErrorPayload = (
  error: unknown
): Pick<OperationalAlertPayload, 'errorMessage' | 'errorName' | 'errorStack'> => {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      ...(error.name ? { errorName: error.name } : {}),
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }

  if (typeof error === 'string') {
    return { errorMessage: error };
  }

  return { errorMessage: 'Unknown error' };
};

const buildAlertPayload = (input: EmitOperationalAlertInput, occurredAtMs: number): OperationalAlertPayload => {
  const errorPayload = toErrorPayload(input.error);
  return {
    alertCode: input.alertCode,
    summary: input.summary,
    occurredAtMs,
    ...errorPayload,
    ...(input.context ? { context: input.context } : {}),
  };
};

const buildAlertMessageText = (payload: OperationalAlertPayload): string =>
  [
    'UpperRoom Media runtime alert',
    '',
    `Alert code: ${payload.alertCode}`,
    `Summary: ${payload.summary}`,
    `Occurred at: ${formatEmailDateTime(payload.occurredAtMs)}`,
    `Error message: ${payload.errorMessage}`,
    payload.errorName ? `Error name: ${payload.errorName}` : null,
    payload.errorStack ? `Error stack: ${payload.errorStack}` : null,
    payload.context ? `Context: ${JSON.stringify(payload.context, null, 2)}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

const buildAlertMessageHtml = (payload: OperationalAlertPayload): string =>
  buildProfessionalEmailHtml({
    preheader: `Runtime alert ${payload.alertCode}`,
    heading: `Runtime alert: ${payload.alertCode}`,
    intro: payload.summary,
    details: [
      { label: 'Occurred at', value: formatEmailDateTime(payload.occurredAtMs) },
      { label: 'Error message', value: payload.errorMessage },
      ...(payload.errorName ? [{ label: 'Error name', value: payload.errorName }] : []),
      ...(payload.errorStack ? [{ label: 'Error stack', value: payload.errorStack }] : []),
      ...(payload.context ? [{ label: 'Context', value: JSON.stringify(payload.context, null, 2) }] : []),
    ],
    footer: 'UpperRoom Media operational alert',
  });

export const emitOperationalAlert = async (input: EmitOperationalAlertInput): Promise<void> => {
  const payload = buildAlertPayload(input, Date.now());
  markOperationalAlertEmitted(input.error);
  try {
    const recipients = getRuntimeAlertRecipients();

    logger.error('operational alert emitted', {
      alertCode: payload.alertCode,
      summary: payload.summary,
      occurredAtMs: payload.occurredAtMs,
      errorMessage: payload.errorMessage,
      errorName: payload.errorName ?? null,
      context: payload.context ?? {},
      recipientCount: recipients.length,
    });

    // Intentionally no dedupe/suppression; each invocation emits a distinct alert message.
    await queueEmail({
      to: recipients,
      source: 'runtime-alert',
      alertType: 'runtime-error',
      alertCode: payload.alertCode,
      metadata: payload.context,
      message: {
        subject: `[URM] Runtime alert: ${payload.alertCode}`,
        text: buildAlertMessageText(payload),
        html: buildAlertMessageHtml(payload),
      },
    });
  } catch (deliveryError) {
    logger.error('failed to deliver operational alert', {
      alertCode: payload.alertCode,
      summary: payload.summary,
      originalErrorMessage: payload.errorMessage,
      deliveryErrorMessage: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
    });
  }
};
