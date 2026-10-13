import * as nodemailer from 'nodemailer';
import { secureMailOptions } from '../../src/temporal/secure-options';

test.each([
  { path: '/run/secrets/temporal/client.key' },
  { path: 'file:///etc/passwd' },
  { path: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token' },
  { href: 'http://127.0.0.1:7233' },
])('blocks filesystem and network attachment instruction %j', (attachment) => {
  expect(() => secureMailOptions({ attachments: [attachment] })).toThrow('MAIL_EXTERNAL_ATTACHMENT_NOT_SNAPSHOTTED');
});
test('blocks nested content URL/file instructions', () => {
  expect(() => secureMailOptions({ attachments: [{ content: { path: '/etc/passwd' } } as any] })).toThrow(
    'MAIL_ATTACHMENT_CONTENT_INVALID'
  );
  expect(() => secureMailOptions({ attachments: [{ content: { href: 'http://localhost' } } as any] })).toThrow(
    'MAIL_ATTACHMENT_CONTENT_INVALID'
  );
});
test('bounded inline bytes survive MIME encoding without external reads', async () => {
  const bytes = Buffer.from('safe inline bytes');
  const options = secureMailOptions(
    {
      from: 'sender@example.org',
      to: 'recipient@example.org',
      text: 'test',
      attachments: [{ filename: 'test.txt', content: bytes }],
    },
    '<durable@example.org>'
  );
  expect(options.disableFileAccess).toBe(true);
  expect(options.disableUrlAccess).toBe(true);
  expect(options.attachments?.[0].content).toBe(bytes.toString('base64'));
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const result = await transport.sendMail(options);
  expect(result.message.toString()).toContain(bytes.toString('base64'));
  expect(result.message.toString()).toContain('Message-ID: <durable@example.org>');
});
test('caller headers cannot replace deterministic message identity', async () => {
  const options = secureMailOptions(
    {
      from: 'sender@example.org',
      to: 'recipient@example.org',
      text: 'test',
      headers: { 'Message-ID': '<forged@example.org>', 'message-id': '<other@example.org>', 'X-Trace': 'safe' },
    },
    '<durable@example.org>'
  );
  expect(options.headers).toEqual({ 'X-Trace': 'safe' });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const result = await transport.sendMail(options);
  expect(result.message.toString()).not.toContain('forged');
  expect(result.message.toString()).not.toContain('other@example');
});
test('array-style Message-ID override is removed too', () => {
  expect(
    secureMailOptions(
      {
        headers: [
          { key: 'mEsSaGe-Id', value: '<forged@example>' },
          { key: 'X-Test', value: 'safe' },
        ],
      },
      '<durable@example>'
    ).headers
  ).toEqual([{ key: 'X-Test', value: 'safe' }]);
});
test('bounds attachment and serialized envelope size before provider submission', () => {
  expect(() => secureMailOptions({ attachments: [{ content: Buffer.alloc(256 * 1024 + 1) }] })).toThrow(
    'MAIL_ATTACHMENTS_TOO_LARGE'
  );
  expect(() => secureMailOptions({ html: 'x'.repeat(512 * 1024 + 1) })).toThrow('MAIL_ENVELOPE_TOO_LARGE');
});
