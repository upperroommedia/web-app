import { EventEmitter } from 'node:events';
const mockLookup = jest.fn(async (..._args: any[]) => [{ address: '203.0.113.10', family: 4 }]);
const mockVerify = jest.fn(async () => true);
const mockSend = jest.fn();
const mockClose = jest.fn();
let mockScopes = ['mail.send'];
const mockHttpsOptions: any[] = [];
const mockTransports: any[] = [];
const mockConfig: any = {
  smtpConnectionUri: 'smtps://user@smtp.example.org:465',
  smtpPassword: 'private-key',
  authenticationType: 'UsernamePassword',
  tls: '{}',
  testing: false,
  port: 465,
  secure: true,
  host: 'smtp.example.org',
  user: 'user',
  clientId: 'private-client',
  clientSecret: 'private-client-secret',
  refreshToken: 'private-refresh',
};
jest.mock('../../src/config', () => ({ __esModule: true, default: mockConfig }));
jest.mock('node:dns/promises', () => ({ lookup: (...args: any[]) => mockLookup(...args) }));
jest.mock('node:https', () => ({
  request: (options: any, onResponse: any) => {
    mockHttpsOptions.push(options);
    const req: any = new EventEmitter();
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.end = () => {
      const response: any = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      onResponse(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify({ scopes: mockScopes })));
        response.emit('end');
      });
    };
    return req;
  },
}));
jest.mock('nodemailer', () => ({
  createTransport: (options: any) => {
    const url = options.url ? new URL(options.url) : undefined;
    const effective = {
      ...options,
      ...(url ? { host: url.hostname, port: Number(url.port), secure: url.protocol === 'smtps:' } : {}),
    };
    mockTransports.push(effective);
    return { transporter: { options: effective }, verify: mockVerify, sendMail: mockSend, close: mockClose };
  },
}));
import {
  describeEmailProvider,
  validateEmailEgressDescriptor,
  verifyEmailTransportNoSend,
  createEmailProviderRuntime,
} from '../../src/temporal/provider';
const descriptor: any = {
  schemaVersion: 1,
  provider: 'smtp',
  hostname: 'smtp.example.org',
  port: 465,
  tls: 'implicit',
  addresses: ['203.0.113.10'],
};
beforeEach(() => {
  mockConfig.smtpConnectionUri = 'smtps://user@smtp.example.org:465';
  mockConfig.authenticationType = 'UsernamePassword';
  mockConfig.testing = false;
  mockConfig.tls = '{}';
  mockLookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
  mockScopes = ['mail.send'];
  mockHttpsOptions.length = 0;
  mockTransports.length = 0;
  mockVerify.mockClear();
  mockSend.mockReset().mockResolvedValue({ messageId: 'id' });
  mockClose.mockClear();
});
test('SMTP no-send canary binds actual auth and reviewed address with original TLS hostname', async () => {
  expect(describeEmailProvider()).toEqual({
    provider: 'smtp',
    hostname: 'smtp.example.org',
    port: 465,
    tls: 'implicit',
    authentication: 'password',
  });
  expect(await verifyEmailTransportNoSend(descriptor)).toEqual({
    provider: 'smtp',
    tlsVerified: true,
    authenticationVerified: true,
    mailPermissionVerified: false,
  });
  const bound = mockTransports[mockTransports.length - 1];
  expect(bound.host).toBe('203.0.113.10');
  expect(bound.tls.servername).toBe('smtp.example.org');
  expect(bound.tls.rejectUnauthorized).toBe(true);
  expect(bound.tls.minVersion).toBe('TLSv1.2');
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(mockSend).not.toHaveBeenCalled();
});
test('STARTTLS is required for smtp URI', async () => {
  mockConfig.smtpConnectionUri = 'smtp://user@smtp.example.org:587';
  await verifyEmailTransportNoSend({ ...descriptor, port: 587, tls: 'starttls' });
  expect(mockTransports[mockTransports.length - 1].requireTLS).toBe(true);
});
test('endpoint mismatch and DNS drift fail before verification', async () => {
  expect(() => validateEmailEgressDescriptor({ ...descriptor, hostname: 'attacker.example' })).toThrow(
    'PROVIDER_MISMATCH'
  );
  mockLookup.mockResolvedValue([
    { address: '203.0.113.10', family: 4 },
    { address: '198.51.100.20', family: 4 },
  ]);
  await expect(verifyEmailTransportNoSend(descriptor)).rejects.toThrow('EMAIL_EGRESS_DNS_DRIFT');
  expect(mockVerify).not.toHaveBeenCalled();
});
test('canary refuses emulator/testing transport and insecure TLS', async () => {
  mockConfig.testing = true;
  await expect(verifyEmailTransportNoSend(descriptor)).rejects.toThrow('REFUSES_TESTING');
  mockConfig.testing = false;
  mockConfig.tls = '{"rejectUnauthorized":false}';
  await expect(verifyEmailTransportNoSend(descriptor)).rejects.toThrow('TLS_OPTIONS');
});
test('SendGrid canary authenticates GET scopes on pinned HTTPS without sending a message', async () => {
  mockConfig.smtpConnectionUri = 'smtps://user@smtp.sendgrid.net:465';
  const grid: any = { ...descriptor, provider: 'sendgrid', hostname: 'api.sendgrid.com', port: 443, tls: 'implicit' };
  const proof = await verifyEmailTransportNoSend(grid);
  expect(proof.provider).toBe('sendgrid');
  expect(JSON.stringify(proof)).not.toContain('private-key');
  expect(mockHttpsOptions).toHaveLength(1);
  expect(mockHttpsOptions[0]).toMatchObject({
    hostname: '203.0.113.10',
    servername: 'api.sendgrid.com',
    method: 'GET',
    path: '/v3/scopes',
    rejectUnauthorized: true,
  });
  expect(mockSend).not.toHaveBeenCalled();
  mockScopes = ['api_keys.read'];
  await expect(verifyEmailTransportNoSend(grid)).rejects.toThrow('MAIL_SEND_SCOPE_REQUIRED');
});
test('OAuth requires reviewed canonical token endpoint and preserves strict SMTP certificate checks', async () => {
  mockConfig.authenticationType = 'OAuth2';
  expect(() => validateEmailEgressDescriptor(descriptor)).toThrow('OAUTH_REVIEWED_ENDPOINT_REQUIRED');
  const oauth: any = {
    ...descriptor,
    oauthTokenEgress: { hostname: 'oauth2.googleapis.com', port: 443, addresses: ['203.0.113.10'] },
  };
  await verifyEmailTransportNoSend(oauth);
  expect(mockTransports[mockTransports.length - 1].auth.accessUrl).toBe('https://oauth2.googleapis.com/token');
  expect(mockTransports[mockTransports.length - 1].auth.refreshToken).toBe('private-refresh');
  expect(mockTransports[mockTransports.length - 1].tls.servername).toBe('smtp.example.org');
});
test('SMTP send cannot happen before provider verification', async () => {
  const provider = createEmailProviderRuntime(descriptor);
  await expect(provider.send({ to: 'recipient@example.org' })).rejects.toThrow('VERIFY_REQUIRED');
  expect(mockSend).not.toHaveBeenCalled();
});
test('concurrent verification does not close another activity in-flight DATA connection', async () => {
  const provider = createEmailProviderRuntime(descriptor);
  await provider.verify();
  let release!: () => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ messageId: 'id' });
      })
  );
  const sending = provider.send({ to: 'recipient@example.org' });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const closesBefore = mockClose.mock.calls.length;
  await provider.verify();
  expect(mockClose.mock.calls.length).toBe(closesBefore + 1); // only its own verification socket
  release();
  await sending;
  expect(mockClose.mock.calls.length).toBe(closesBefore + 2); // sending socket closes after acknowledgement
});
test('the final execution fence runs after endpoint binding and before SMTP transmission', async () => {
  const provider = createEmailProviderRuntime(descriptor);
  await provider.verify();
  await expect(
    provider.send({ to: 'recipient@example.org' }, async () => {
      throw new Error('STALE_EXECUTION');
    })
  ).rejects.toThrow('STALE_EXECUTION');
  expect(mockSend).not.toHaveBeenCalled();
});
