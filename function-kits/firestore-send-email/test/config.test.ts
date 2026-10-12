import config from '../src/config';
const original = {...process.env};
afterEach(() => {process.env = {...original};});
test('exported empty and whitespace optional settings retain defaults', () => {
  Object.assign(process.env, {TEMPLATES_COLLECTION: '  ', USERS_COLLECTION: '\t', DEFAULT_REPLY_TO: ' ', AUTH_TYPE: '', TTL_EXPIRE_TYPE: '\t ', DATABASE: ''});
  expect(config.templatesCollection).toBe('');
  expect(config.usersCollection).toBe('');
  expect(config.defaultReplyTo).toBe('');
  expect(config.authenticationType).toBe('UsernamePassword');
  expect(config.TTLExpireType).toBe('never');
  expect(config.database).toBe('(default)');
});
test('configured SMTP connection and identity values remain intact', () => {
  Object.assign(process.env, {SMTP_CONNECTION_URI: ' smtps://sender@smtp.example.com:465 ', CLIENT_ID: ' client-id ', USER: ' sender@example.com ', HOST: ' smtp.example.com ', AUTH_TYPE: ' OAuth2 ', TEMPLATES_COLLECTION: ' templates '});
  expect(config.smtpConnectionUri).toBe('smtps://sender@smtp.example.com:465');
  expect(config.clientId).toBe('client-id');
  expect(config.user).toBe('sender@example.com');
  expect(config.host).toBe('smtp.example.com');
  expect(config.authenticationType).toBe('OAuth2');
  expect(config.templatesCollection).toBe('templates');
});
