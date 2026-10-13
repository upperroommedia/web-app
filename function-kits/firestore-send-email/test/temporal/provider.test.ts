import { EventEmitter } from 'node:events';
const mockLookup = jest.fn(async (..._args: any[]) => [{ address: '64.233.179.109', family: 4 }]);
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
        response.emit(
          'data',
          Buffer.from(
            JSON.stringify(
              options.path === '/token' || options.path === '/o/oauth2/token'
                ? { access_token: 'private-access', expires_in: 3600 }
                : { scopes: mockScopes }
            )
          )
        );
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
  resolveReviewedEmailEndpoint,
} from '../../src/temporal/provider';
const descriptor: any = {
  schemaVersion: 1,
  provider: 'smtp',
  hostname: 'smtp.example.org',
  port: 465,
  tls: 'implicit',
  addresses: ['64.233.179.109'],
};
beforeEach(() => {
  mockConfig.smtpConnectionUri = 'smtps://user@smtp.example.org:465';
  mockConfig.authenticationType = 'UsernamePassword';
  mockConfig.testing = false;
  mockConfig.tls = '{}';
  mockLookup.mockResolvedValue([{ address: '64.233.179.109', family: 4 }]);
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
  expect(bound.host).toBe('64.233.179.109');
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
    { address: '64.233.179.109', family: 4 },
    { address: '142.251.183.109', family: 4 },
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
    hostname: '64.233.179.109',
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
    oauthTokenEgress: { hostname: 'oauth2.googleapis.com', port: 443, addresses: ['64.233.179.109'] },
  };
  await verifyEmailTransportNoSend(oauth);
  const auth = mockTransports[mockTransports.length - 1].auth;
  expect(auth.provisionCallback).toEqual(expect.any(Function));
  await new Promise<void>((resolve, reject) =>
    auth.provisionCallback('user', false, (error: Error, token: string) => {
      if (error) reject(error);
      else {
        expect(token).toBe('private-access');
        resolve();
      }
    })
  );
  expect(mockHttpsOptions[0]).toMatchObject({
    hostname: '64.233.179.109',
    servername: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    rejectUnauthorized: true,
  });
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

const publicDescriptor: any = { ...descriptor, addresses: undefined, dnsMode: 'public-ipv4' };
test('public IPv4 SMTP survives normal Google DNS rotation and public AAAA records without weakening TLS', async () => {
  mockLookup.mockResolvedValueOnce([
    { address: '142.251.183.109', family: 4 },
    { address: '2607:f8b0:4001:c7d::6c', family: 6 },
  ]);
  const runtime = createEmailProviderRuntime(publicDescriptor);
  await runtime.verify();
  expect(mockTransports.at(-1)).toMatchObject({
    host: '142.251.183.109',
    port: 465,
    secure: true,
    tls: { servername: 'smtp.example.org', rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
  mockLookup.mockResolvedValueOnce([{ address: '64.233.179.109', family: 4 }]);
  await runtime.send({ to: 'recipient@example.org' });
  expect(mockTransports.at(-1).host).toBe('64.233.179.109');
  expect(mockSend).toHaveBeenCalledTimes(1);
});
test.each([
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.1',
  '169.254.169.254',
  '172.31.255.255',
  '192.0.0.9',
  '192.0.2.1',
  '192.31.196.1',
  '192.52.193.1',
  '192.88.99.1',
  '192.168.1.1',
  '192.175.48.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:8.8.8.8',
  '64:ff9b::a00:1',
  'fc00::1',
  'fe80::1',
  'ff02::1',
  '2001::1',
  '2001:db8::1',
  '2002:7f00:1::1',
  '3fff::1',
])('public DNS rejects mixed public and nonpublic address %s before auth or DATA', async (address) => {
  mockLookup.mockResolvedValue([
    { address: '142.251.183.109', family: 4 },
    { address, family: address.includes(':') ? 6 : 4 },
  ]);
  await expect(verifyEmailTransportNoSend(publicDescriptor)).rejects.toThrow('EMAIL_EGRESS_DNS_NONPUBLIC');
  expect(mockVerify).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockHttpsOptions).toHaveLength(0);
});
test('public DNS rejects missing IPv4, malformed/family-mismatched answers, private static descriptors and conflicting old pins', async () => {
  expect(() => validateEmailEgressDescriptor({ ...publicDescriptor, addresses: ['64.233.179.109'] })).toThrow(
    'WITHOUT_STATIC_IPS'
  );
  expect(() => validateEmailEgressDescriptor({ ...descriptor, addresses: ['169.254.169.254'] })).toThrow(
    'PUBLIC_LITERAL_IPS'
  );
  expect(() => validateEmailEgressDescriptor({ ...descriptor, dnsMode: 'arbitrary' })).toThrow('PUBLIC_LITERAL_IPS');
  mockLookup.mockResolvedValue([{ address: '2607:f8b0:4001:c7d::6c', family: 6 }]);
  await expect(resolveReviewedEmailEndpoint(publicDescriptor)).rejects.toThrow('PUBLIC_IPV4_REQUIRED');
  mockLookup.mockResolvedValue([{ address: '142.251.183.109', family: 6 }]);
  await expect(resolveReviewedEmailEndpoint(publicDescriptor)).rejects.toThrow('DNS_NONPUBLIC');
  mockLookup.mockRejectedValueOnce(new Error('secret DNS raw detail'));
  await expect(resolveReviewedEmailEndpoint(publicDescriptor)).rejects.toThrow('EMAIL_EGRESS_DNS_UNAVAILABLE');
});
test('SendGrid public DNS keeps literal IPv4, original HTTPS hostname and read-only scope check', async () => {
  mockConfig.smtpConnectionUri = 'smtps://user@smtp.sendgrid.net:465';
  mockLookup.mockResolvedValue([{ address: '142.251.183.109', family: 4 }]);
  await verifyEmailTransportNoSend({
    ...publicDescriptor,
    provider: 'sendgrid',
    hostname: 'api.sendgrid.com',
    port: 443,
  });
  expect(mockHttpsOptions.at(-1)).toMatchObject({
    hostname: '142.251.183.109',
    servername: 'api.sendgrid.com',
    method: 'GET',
    path: '/v3/scopes',
    headers: { Host: 'api.sendgrid.com' },
    rejectUnauthorized: true,
  });
  expect(mockSend).not.toHaveBeenCalled();
});
test('OAuth public DNS binds token refresh to literal IPv4/SNI and rejects rebinding without transmitting credentials', async () => {
  mockConfig.authenticationType = 'OAuth2';
  const oauth: any = {
    ...publicDescriptor,
    oauthTokenEgress: { hostname: 'oauth2.googleapis.com', port: 443, dnsMode: 'public-ipv4' },
  };
  await verifyEmailTransportNoSend(oauth);
  const auth = mockTransports.at(-1).auth;
  const provision = () =>
    new Promise((resolve, reject) =>
      auth.provisionCallback('user', false, (error: Error, token: string) => (error ? reject(error) : resolve(token)))
    );
  mockLookup.mockResolvedValueOnce([{ address: '142.251.183.109', family: 4 }]);
  expect(await provision()).toBe('private-access');
  expect(mockHttpsOptions.at(-1)).toMatchObject({
    hostname: '142.251.183.109',
    servername: 'oauth2.googleapis.com',
    method: 'POST',
    path: '/token',
    headers: { Host: 'oauth2.googleapis.com', 'Accept-Encoding': 'identity' },
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  });
  const requests = mockHttpsOptions.length;
  mockLookup.mockResolvedValueOnce([
    { address: '142.251.183.109', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]);
  await expect(provision()).rejects.toThrow('EMAIL_OAUTH_TOKEN_EXCHANGE_FAILED');
  expect(mockHttpsOptions).toHaveLength(requests);
  expect(mockSend).not.toHaveBeenCalled();
});

test('DNS lookup has a bounded failure even when resolver never returns', async () => {
  jest.useFakeTimers();
  try {
    mockLookup.mockImplementationOnce(() => new Promise(() => undefined));
    const resolving = resolveReviewedEmailEndpoint(publicDescriptor);
    const assertion = expect(resolving).rejects.toThrow('EMAIL_EGRESS_DNS_UNAVAILABLE');
    await jest.advanceTimersByTimeAsync(10000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});
test.each(['0x7f000001', '2130706433', '0177.0.0.1', '127.1', 'invalid-address'])(
  'DNS malformed address %s cannot bypass native IP validation',
  async (address) => {
    mockLookup.mockResolvedValue([{ address, family: 4 }]);
    await expect(resolveReviewedEmailEndpoint(publicDescriptor)).rejects.toThrow('EMAIL_EGRESS_DNS_NONPUBLIC');
  }
);
