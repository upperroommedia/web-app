/** A private staging sink, never an SMTP substitute in production. */
import { createHash } from 'node:crypto';
import { getApp, type App } from 'firebase-admin/app';
import config from '../config';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { ExtendedSendMailOptions } from '../types';
import { secureMailOptions } from './secure-options';

export interface EmailCaptureProfile {
  schemaVersion: 1;
  mode: 'capture';
  projectId: 'urm-app-staging';
  profileId: 'urm-app-staging-mail-capture-v1';
  version: 1;
}
export interface EmailCaptureProvenance extends EmailCaptureProfile {
  captureId: string;
  payloadSha256: string;
}
export const EMAIL_CAPTURE_PROFILE: Readonly<EmailCaptureProfile> = Object.freeze({
  schemaVersion: 1,
  mode: 'capture',
  projectId: 'urm-app-staging',
  profileId: 'urm-app-staging-mail-capture-v1',
  version: 1,
});
/** Bind only an actual SDK database belonging to the initialized Admin app. */
export function authoritativeEmailProject(db: Firestore, app: App = getApp()): string {
  const projectId = app.options.projectId;
  if (!projectId || getFirestore(app, config.database) !== db) throw new Error('EMAIL_PROJECT_UNVERIFIED');
  return projectId;
}
export function emailCaptureProfile(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env
): EmailCaptureProfile | undefined {
  if (projectId === 'urm-app-staging') {
    if (env.STAGING_PROVIDER_MODE !== 'sandbox') throw new Error('EMAIL_STAGING_CAPTURE_REQUIRED');
    return { ...EMAIL_CAPTURE_PROFILE };
  }
  if (projectId !== 'urm-app' || env.STAGING_PROVIDER_MODE !== undefined)
    throw new Error('EMAIL_CAPTURE_PROJECT_MISMATCH');
  return undefined;
}
export function assertLegacyEmailTransportAllowed(projectId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (emailCaptureProfile(projectId, env)) throw new Error('EMAIL_SANDBOX_REQUIRES_TEMPORAL_CAPTURE');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export function assertEmailCaptureReceiptProfile(
  existing: { exists: boolean; get(key: string): unknown },
  profile?: EmailCaptureProfile
): void {
  const pinned = existing.get('deliveryProfile');
  if ((profile && existing.exists && canonical(pinned) !== canonical(profile)) || (!profile && pinned !== undefined))
    throw new Error('EMAIL_DELIVERY_PROFILE_MISMATCH');
}
export function createMailCapture(db: Firestore, profile: EmailCaptureProfile, app: App = getApp()) {
  // Bind to the initialized Admin client, never a mail document or callable field.
  if (
    authoritativeEmailProject(db, app) !== profile.projectId ||
    canonical(profile) !== canonical(EMAIL_CAPTURE_PROFILE)
  )
    throw new Error('EMAIL_CAPTURE_PROJECT_MISMATCH');
  return {
    async verify() {
      /* No SMTP verification, DNS, OAuth or credentials. */
    },
    async send(input: ExtendedSendMailOptions, beforeSend?: () => Promise<void>) {
      if (authoritativeEmailProject(db, app) !== profile.projectId) throw new Error('EMAIL_CAPTURE_PROJECT_MISMATCH');
      const messageId = input.messageId;
      if (typeof messageId !== 'string' || !/^<[a-f0-9]{64}@durable\.upperroommedia\.org>$/.test(messageId))
        throw new Error('EMAIL_CAPTURE_MESSAGE_ID_REQUIRED');
      const options = JSON.parse(JSON.stringify(secureMailOptions(input, messageId))) as ExtendedSendMailOptions;
      const recipients = [options.to, options.cc, options.bcc].flatMap((v) =>
        v === undefined ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v : [v]
      );
      if (!recipients.length || recipients.some((v) => typeof v !== 'string' || !v.trim()))
        throw new Error('EMAIL_CAPTURE_RECIPIENT_INVALID');
      const accepted = [...new Set(recipients as string[])];
      const captureId = sha(messageId),
        payloadSha256 = sha(canonical(options));
      const deliveryTransport: EmailCaptureProvenance = { ...profile, captureId, payloadSha256 };
      if (beforeSend) await beforeSend();
      const ref = db.collection('_mailSandboxCaptures').doc(captureId);
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists) {
          if (
            existing.get('messageId') !== messageId ||
            existing.get('payloadSha256') !== payloadSha256 ||
            canonical(existing.get('deliveryProfile')) !== canonical(profile)
          )
            throw new Error('EMAIL_CAPTURE_CONTENT_CONFLICT');
          return;
        }
        tx.create(ref, {
          schemaVersion: 1,
          messageId,
          payloadSha256,
          deliveryProfile: profile,
          options,
          externalDelivery: false,
          capturedAt: FieldValue.serverTimestamp(),
        });
      });
      return {
        messageId,
        accepted,
        rejected: [] as string[],
        pending: [] as string[],
        response: 'Captured privately in staging; no external email was sent.',
        sendgridQueueId: null,
        deliveryTransport,
      };
    },
    close() {
      /* No transport sockets to close. */
    },
  };
}
