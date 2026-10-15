import {
  assertMediaAuthPopupUrl,
  assertMediaBrowserLoginEnvironment,
  isUnexpectedMediaLoginDocument,
} from '../helpers/mediaBrowserLogin';

const environment = (): NodeJS.ProcessEnv => ({
  URM_MEDIA_BROWSER_STATUS_FIXTURE: 'true',
  GCLOUD_PROJECT: 'demo-temporal-ci',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-temporal-ci',
  NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: 'true',
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: '9100',
  PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3004',
});
const popup = 'http://127.0.0.1:9100/emulator/auth/handler?providerId=google.com&authType=signInViaPopup';

it.each(['/', '/admin/sermons'])('accepts only the isolated demo environment and supported callback %s', (path) => {
  expect(() => assertMediaBrowserLoginEnvironment(environment(), path)).not.toThrow();
});
it.each<[string, string | undefined]>([
  ['URM_MEDIA_BROWSER_STATUS_FIXTURE', undefined],
  ['GCLOUD_PROJECT', 'urm-app'],
  ['NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'urm-app-staging'],
  ['NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS', 'false'],
  ['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT', undefined],
  ['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT', '9099'],
  ['PLAYWRIGHT_BASE_URL', 'https://127.0.0.1:3004'],
  ['PLAYWRIGHT_BASE_URL', 'http://localhost:3004'],
  ['PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:3002'],
  ['PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:3004/admin'],
  ['PLAYWRIGHT_BASE_URL', 'http://user@127.0.0.1:3004'],
  ['PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:3004/?override=true'],
  ['PLAYWRIGHT_BASE_URL', 'not a URL'],
])('rejects mismatched isolation configuration %s=%s', (key, value) => {
  expect(() => assertMediaBrowserLoginEnvironment({ ...environment(), [key]: value }, '/')).toThrow();
});
it.each(['/login', '//outside.example', '/admin/sermons/', '/?redirect=external', '/admin/users'])(
  'rejects unsupported callback %s',
  (path) => expect(() => assertMediaBrowserLoginEnvironment(environment(), path)).toThrow()
);
it('accepts the official local Google popup, including ordinary SDK routing parameters', () => {
  expect(() =>
    assertMediaAuthPopupUrl(new URL(popup + '&apiKey=synthetic-public&appName=%5BDEFAULT%5D'))
  ).not.toThrow();
});
it.each([
  popup.replace('127.0.0.1:9100', 'accounts.google.com'),
  popup.replace('127.0.0.1:9100', '127.0.0.1:9099'),
  popup.replace('http:', 'https:'),
  popup.replace('127.0.0.1', 'localhost'),
  popup.replace('/emulator/auth/handler', '/emulator/auth/iframe'),
  popup.replace('google.com', 'microsoft.com'),
  popup.replace('signInViaPopup', 'signInViaRedirect'),
  popup + '&providerId=google.com',
  popup + '&authType=signInViaPopup',
  popup + '&tid=',
  popup + '&tenantId=another',
  popup + '#fragment',
  popup.replace('http://', 'http://user:password@'),
])('rejects unexpected popup authority or flow %s', (url) => {
  expect(() => assertMediaAuthPopupUrl(new URL(url))).toThrow();
});

it.each([
  'https://accounts.google.com/o/oauth2/auth',
  'http://localhost:9100/emulator/auth/handler',
  'https://127.0.0.1:9100/emulator/auth/handler',
  'http://127.0.0.1:3002/login',
])('blocks untrusted document navigation before request %s', (url) => {
  expect(isUnexpectedMediaLoginDocument(new URL(url), true, 'document')).toBe(true);
});
it.each(['http://127.0.0.1:3004/login', 'http://127.0.0.1:9100/emulator/auth/handler', 'about:blank'])(
  'allows only actual local document navigation %s',
  (url) => {
    expect(isUnexpectedMediaLoginDocument(new URL(url), true, 'document')).toBe(false);
  }
);
it('does not replace third-party script or font responses', () => {
  expect(isUnexpectedMediaLoginDocument(new URL('https://apis.google.com/js/api.js'), false, 'script')).toBe(false);
  expect(isUnexpectedMediaLoginDocument(new URL('https://fonts.googleapis.com/font'), false, 'stylesheet')).toBe(false);
});
