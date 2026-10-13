/** Provider verification and delivery share this reviewed endpoint binding. */
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import * as nodemailer from 'nodemailer';
import config from '../config';
import { isSendGrid, setSmtpCredentials, parseTlsOptions } from '../helpers';
import { AuthenticatonType } from '../types';
import { SendGridTransport } from '../nodemailer-sendgrid';
import type { SendGridProviderClient } from '../nodemailer-sendgrid/types';

export interface EmailEgressDescriptor {
  schemaVersion: 1;
  provider: 'smtp' | 'sendgrid';
  hostname: string;
  port: number;
  tls: 'implicit' | 'starttls';
  addresses: string[];
  oauthTokenEgress?: { hostname: 'accounts.google.com' | 'oauth2.googleapis.com'; port: 443; addresses: string[] };
}
export interface EmailProviderDescription {
  provider: 'smtp' | 'sendgrid';
  hostname: string;
  port: number;
  tls: 'implicit' | 'starttls';
  authentication: 'password' | 'oauth2' | 'api_key';
}

function smtpOptions(): Record<string, any> {
  const transport = setSmtpCredentials(config);
  const effective = Reflect.get(transport.transporter, 'options');
  transport.close();
  if (!effective || typeof effective !== 'object') throw new Error('EMAIL_SMTP_CONFIGURATION_INVALID');
  return effective;
}
export function describeEmailProvider(): EmailProviderDescription {
  if (config.testing) throw new Error('EMAIL_CANARY_REFUSES_TESTING_TRANSPORT');
  if (isSendGrid(config))
    return {
      provider: 'sendgrid',
      hostname: 'api.sendgrid.com',
      port: 443,
      tls: 'implicit',
      authentication: 'api_key',
    };
  const options = smtpOptions();
  if (typeof options.host !== 'string' || !options.host) throw new Error('EMAIL_SMTP_HOST_MISSING');
  const secure = options.secure === true;
  return {
    provider: 'smtp',
    hostname: options.host.toLowerCase(),
    port: Number(options.port) || (secure ? 465 : 587),
    tls: secure ? 'implicit' : 'starttls',
    authentication: config.authenticationType === AuthenticatonType.OAuth2 ? 'oauth2' : 'password',
  };
}
export function validateEmailEgressDescriptor(
  value: unknown,
  actual: EmailProviderDescription = describeEmailProvider()
): EmailEgressDescriptor {
  const descriptor = value as EmailEgressDescriptor;
  if (
    !descriptor ||
    descriptor.schemaVersion !== 1 ||
    descriptor.provider !== actual.provider ||
    descriptor.hostname !== actual.hostname ||
    descriptor.port !== actual.port ||
    descriptor.tls !== actual.tls
  )
    throw new Error('EMAIL_EGRESS_DESCRIPTOR_PROVIDER_MISMATCH');
  if (
    !Array.isArray(descriptor.addresses) ||
    !descriptor.addresses.length ||
    descriptor.addresses.some((address) => typeof address !== 'string' || !isIP(address))
  )
    throw new Error('EMAIL_EGRESS_REQUIRES_LITERAL_IPS');
  if (actual.authentication === 'oauth2') {
    const token = descriptor.oauthTokenEgress;
    if (
      !token ||
      !['accounts.google.com', 'oauth2.googleapis.com'].includes(token.hostname) ||
      token.port !== 443 ||
      !Array.isArray(token.addresses) ||
      !token.addresses.length ||
      token.addresses.some((address) => !isIP(address))
    )
      throw new Error('EMAIL_OAUTH_REVIEWED_ENDPOINT_REQUIRED');
  } else if (descriptor.oauthTokenEgress) throw new Error('EMAIL_OAUTH_ENDPOINT_NOT_APPLICABLE');
  return descriptor;
}
export async function resolveReviewedEmailEndpoint(endpoint: {
  hostname: string;
  addresses: string[];
}): Promise<{ address: string; family: number }> {
  const answers = isIP(endpoint.hostname)
    ? [{ address: endpoint.hostname, family: isIP(endpoint.hostname) }]
    : await lookup(endpoint.hostname, { all: true });
  if (!answers.length || answers.some((answer) => !endpoint.addresses.includes(answer.address)))
    throw new Error('EMAIL_EGRESS_DNS_DRIFT');
  return answers[0];
}
function configuredDescriptor(): EmailEgressDescriptor {
  const path = process.env.EMAIL_EGRESS_DESCRIPTOR_PATH;
  if (!path) throw new Error('EMAIL_EGRESS_DESCRIPTOR_PATH_REQUIRED');
  try {
    return validateEmailEgressDescriptor(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EMAIL_')) throw error;
    throw new Error('EMAIL_EGRESS_DESCRIPTOR_INVALID');
  }
}
function strictTls(): Record<string, unknown> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('EMAIL_TLS_CERTIFICATE_VERIFICATION_REQUIRED');
  const options = parseTlsOptions(config.tls) as Record<string, unknown>;
  if (
    options.rejectUnauthorized === false ||
    (options.minVersion && !['TLSv1.2', 'TLSv1.3'].includes(String(options.minVersion))) ||
    (options.maxVersion && !['TLSv1.2', 'TLSv1.3'].includes(String(options.maxVersion)))
  )
    throw new Error('EMAIL_TLS_1_2_OR_NEWER_REQUIRED');
  if (options.secureProtocol || options.secureOptions) throw new Error('EMAIL_TLS_LEGACY_OVERRIDES_FORBIDDEN');
  return { ...options, rejectUnauthorized: true, minVersion: options.minVersion || 'TLSv1.2' };
}
async function sendGridRequest(
  descriptor: EmailEgressDescriptor,
  apiKey: string,
  method: 'GET' | 'POST',
  body?: unknown,
  beforeRequest?: () => Promise<void>
): Promise<{ statusCode: number; headers: Record<string, any>; body: unknown }> {
  const endpoint = await resolveReviewedEmailEndpoint(descriptor);
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('EMAIL_SENDGRID_API_KEY_REQUIRED');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (beforeRequest) await beforeRequest();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: endpoint.address,
        port: 443,
        servername: descriptor.hostname,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        method,
        path: method === 'GET' ? '/v3/scopes' : '/v3/mail/send',
        timeout: 15000,
        headers: {
          Host: descriptor.hostname,
          Authorization: `Bearer ${apiKey}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 262144) request.destroy(new Error('EMAIL_PROVIDER_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('EMAIL_PROVIDER_CONNECTION_FAILED')));
        response.on('end', () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const error = new Error('EMAIL_PROVIDER_REQUEST_REJECTED') as Error & { code: number };
            error.code = status;
            reject(error);
            return;
          }
          let data: unknown = null;
          if (chunks.length) {
            try {
              data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new Error('EMAIL_PROVIDER_RESPONSE_INVALID'));
              return;
            }
          }
          resolve({ statusCode: status, headers: response.headers, body: data });
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('EMAIL_PROVIDER_TIMEOUT')));
    request.on('error', () => reject(new Error('EMAIL_PROVIDER_CONNECTION_FAILED')));
    if (payload) request.write(payload);
    request.end();
  });
}
export function createEmailProviderRuntime(provided?: EmailEgressDescriptor): {
  verify(): Promise<void>;
  send(options: nodemailer.SendMailOptions, beforeSend?: () => Promise<void>): Promise<any>;
  close(): void;
} {
  if (config.testing && process.env.TEMPORAL_EMAIL_ALLOW_LOCAL_SMTP === 'true') {
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: 8132,
      secure: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 45000,
    });
    return {
      verify: async () => {
        await transport.verify();
      },
      send: async (options, beforeSend) => {
        if (beforeSend) await beforeSend();
        return transport.sendMail(options);
      },
      close: () => transport.close(),
    };
  }
  const descriptor = validateEmailEgressDescriptor(provided || configuredDescriptor());
  const tls = strictTls();
  if (descriptor.provider === 'sendgrid') {
    let key = config.smtpPassword || '';
    return {
      async verify() {
        const response = await sendGridRequest(descriptor, key, 'GET');
        if (
          !Array.isArray((response.body as { scopes?: unknown })?.scopes) ||
          !(response.body as { scopes: string[] }).scopes.includes('mail.send')
        )
          throw new Error('EMAIL_SENDGRID_MAIL_SEND_SCOPE_REQUIRED');
      },
      send: async (options, beforeSend) => {
        const messageClient: SendGridProviderClient = {
          setApiKey: () => undefined,
          send: async (data) => [await sendGridRequest(descriptor, key, 'POST', data, beforeSend)],
        };
        const transport = nodemailer.createTransport(new SendGridTransport({ client: messageClient }));
        try {
          return await transport.sendMail(options);
        } finally {
          transport.close();
        }
      },
      close: () => undefined,
    };
  }
  const options = smtpOptions();
  const live = new Set<nodemailer.Transporter>();
  let verified = false;
  async function boundTransport(): Promise<nodemailer.Transporter> {
    const endpoint = await resolveReviewedEmailEndpoint(descriptor);
    if (descriptor.oauthTokenEgress) await resolveReviewedEmailEndpoint(descriptor.oauthTokenEgress);
    const auth = descriptor.oauthTokenEgress
      ? {
          ...options.auth,
          accessUrl: `https://${descriptor.oauthTokenEgress.hostname}${
            descriptor.oauthTokenEgress.hostname === 'accounts.google.com' ? '/o/oauth2/token' : '/token'
          }`,
        }
      : options.auth;
    const transport = nodemailer.createTransport({
      host: endpoint.address,
      port: descriptor.port,
      secure: descriptor.tls === 'implicit',
      requireTLS: descriptor.tls === 'starttls',
      auth,
      tls: { ...tls, servername: descriptor.hostname },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 45000,
    });
    live.add(transport);
    return transport;
  }
  return {
    async verify() {
      const transport = await boundTransport();
      try {
        await transport.verify();
        verified = true;
      } finally {
        transport.close();
        live.delete(transport);
      }
    },
    async send(mail, beforeSend) {
      if (!verified) throw new Error('EMAIL_PROVIDER_VERIFY_REQUIRED');
      // Each activity gets its own connection. Another activity's verification
      // must never close a socket that is transmitting this message's DATA.
      const transport = await boundTransport();
      try {
        if (beforeSend) await beforeSend();
        return await transport.sendMail(mail);
      } finally {
        transport.close();
        live.delete(transport);
      }
    },
    close() {
      for (const transport of live) transport.close();
      live.clear();
    },
  };
}
/** Auth/TLS/permission verification only; never sends a message or initializes Firebase. */
export async function verifyEmailTransportNoSend(descriptor: EmailEgressDescriptor): Promise<{
  provider: 'smtp' | 'sendgrid';
  tlsVerified: true;
  authenticationVerified: true;
  mailPermissionVerified: boolean;
}> {
  if (config.testing) throw new Error('EMAIL_CANARY_REFUSES_TESTING_TRANSPORT');
  const provider = createEmailProviderRuntime(descriptor);
  try {
    await provider.verify();
    return {
      provider: descriptor.provider,
      tlsVerified: true,
      authenticationVerified: true,
      mailPermissionVerified: descriptor.provider === 'sendgrid',
    };
  } finally {
    provider.close();
  }
}
