/** Runtime adapter shared with the migrated Trigger Email kit. No workflow imports. */
import { Firestore } from 'firebase-admin/firestore';
import { createEmailProviderRuntime } from './provider';
import config from '../config';
import Templates from '../templates';
import { preparePayload, setDependencies } from '../prepare-payload';
import { ExtendedSendMailOptions } from '../types';
import { secureMailOptions } from './secure-options';
import {
  createMailCapture,
  emailCaptureProfile,
  authoritativeEmailProject,
  type EmailCaptureProfile,
  type EmailCaptureProvenance,
} from './capture';

export interface EmailProviderReceipt {
  deliveryTransport?: EmailCaptureProvenance;
  messageId: string;
  accepted: string[];
  rejected: string[];
  pending: string[];
  response: string | null;
  sendgridQueueId: string | null;
}
export interface EmailRuntime {
  readonly deliveryProfile?: EmailCaptureProfile;
  prepare(payload: Record<string, any>, messageId: string): Promise<ExtendedSendMailOptions>;
  verify(): Promise<void>;
  send(options: ExtendedSendMailOptions, beforeSend?: () => Promise<void>): Promise<EmailProviderReceipt>;
  close(): void;
}
/**
 * Uses the actual kit's credential, OAuth, TLS, template, UID, and SendGrid adapters.
 * A worker is bound to one Firebase project and one mail configuration. Credential
 * rotation restarts that worker, rather than sharing globals across projects.
 */
export function createEmailRuntime(db: Firestore): EmailRuntime {
  const templates = config.templatesCollection ? new Templates(db.collection(config.templatesCollection)) : undefined;
  setDependencies(db, templates);
  const profile = emailCaptureProfile(authoritativeEmailProject(db));
  const transport = profile ? createMailCapture(db, profile) : createEmailProviderRuntime();
  return {
    ...(profile ? { deliveryProfile: profile } : {}),
    async prepare(input, messageId) {
      const payload = await preparePayload(structuredClone(input));
      if (!payload.to.length && !payload.cc.length && !payload.bcc.length) throw new Error('MAIL_RECIPIENT_REQUIRED');
      const options: ExtendedSendMailOptions = {
        from: payload.from || config.defaultFrom,
        replyTo: payload.replyTo || config.defaultReplyTo,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        messageId,
        subject: payload.message?.subject,
        text: payload.message?.text,
        html: payload.message?.html,
        headers: payload.headers,
        attachments: payload.message?.attachments,
        categories: payload.categories,
        templateId: payload.sendGrid?.templateId,
        dynamicTemplateData: payload.sendGrid?.dynamicTemplateData,
        mailSettings: payload.sendGrid?.mailSettings,
        customArgs: payload.sendGrid?.customArgs,
        ipPoolName: payload.sendGrid?.ipPoolName,
      };
      // Firestore does not accept undefined; only plain serializable mail options enter a private receipt.
      return JSON.parse(JSON.stringify(secureMailOptions(options, messageId)));
    },
    async verify() {
      await transport.verify();
    },
    async send(options, beforeSend) {
      const result = (await transport.send(secureMailOptions(options, options.messageId as string), beforeSend)) as any;
      return {
        messageId: options.messageId as string,
        accepted: result.accepted || [],
        rejected: result.rejected || [],
        pending: result.pending || [],
        response: result.response || null,
        sendgridQueueId: result.sendgridQueueId || result.queueId || null,
        ...(result.deliveryTransport ? { deliveryTransport: result.deliveryTransport } : {}),
      };
    },
    close() {
      transport.close();
    },
  };
}

/** Only errors proving no DATA/request acceptance occurred permit another attempt. */
export function isDefinitelyUnsent(error: unknown): boolean {
  const failure = error as { command?: string; responseCode?: number; code?: string | number };
  const command = failure?.command?.toUpperCase() || '';
  return (
    ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'MAIL FROM', 'RCPT TO'].includes(command) ||
    command.startsWith('AUTH ') ||
    command === 'AUTH' ||
    (typeof failure?.code === 'number' && failure.code >= 400 && failure.code < 500 && failure.code !== 408)
  );
}
