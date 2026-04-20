import {
  isSafeInternalCallbackDestination,
  isMobileSafariUserAgent,
  resolveAuthCallbackDestination,
  shouldPreferFirebaseRedirectAuth,
} from './authRedirect';

describe('resolveAuthCallbackDestination', () => {
  it('returns root when callback is missing', () => {
    expect(resolveAuthCallbackDestination(undefined, undefined)).toBe('/');
  });

  it('keeps internal paths and query/hash fragments', () => {
    expect(resolveAuthCallbackDestination('/admin/sermons?tab=drafts#top', undefined)).toBe(
      '/admin/sermons?tab=drafts#top'
    );
  });

  it('normalizes bare internal paths', () => {
    expect(resolveAuthCallbackDestination('admin/sermons', undefined)).toBe('/admin/sermons');
  });

  it('supports encoded invite claim callback destinations', () => {
    const encoded = encodeURIComponent('/invite/claim?token=abc123');
    expect(resolveAuthCallbackDestination(encoded, undefined)).toBe('/invite/claim?token=abc123');
  });

  it('rejects absolute external urls', () => {
    expect(resolveAuthCallbackDestination('https://evil.example/phish', undefined)).toBe('/');
  });

  it('rejects protocol-relative urls', () => {
    expect(resolveAuthCallbackDestination('//evil.example/phish', undefined)).toBe('/');
    expect(resolveAuthCallbackDestination('%2F%2Fevil.example/phish', undefined)).toBe('/');
  });

  it('rejects callback destinations with a javascript scheme', () => {
    expect(resolveAuthCallbackDestination('javascript:alert(1)', undefined)).toBe('/');
  });

  it('rejects login callback loops', () => {
    expect(resolveAuthCallbackDestination('/login', undefined)).toBe('/');
    expect(resolveAuthCallbackDestination('/login?callbackurl=%2Fadmin', undefined)).toBe('/');
  });

  it('rejects paths with backslashes', () => {
    expect(resolveAuthCallbackDestination('/\\evil.example', undefined)).toBe('/');
    expect(resolveAuthCallbackDestination('/%5Cevil.example', undefined)).toBe('/');
  });
});

describe('isSafeInternalCallbackDestination', () => {
  it('accepts valid internal destinations', () => {
    expect(isSafeInternalCallbackDestination('/admin/sermons')).toBe(true);
  });

  it('rejects unsafe destinations', () => {
    expect(isSafeInternalCallbackDestination('//evil.example')).toBe(false);
    expect(isSafeInternalCallbackDestination('/\\evil.example')).toBe(false);
    expect(isSafeInternalCallbackDestination('/login')).toBe(false);
  });
});

describe('isMobileSafariUserAgent', () => {
  it('detects mobile safari on iphone', () => {
    expect(
      isMobileSafariUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe(true);
  });

  it('rejects ios browsers that are not safari', () => {
    expect(
      isMobileSafariUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.53 Mobile/15E148 Safari/604.1'
      )
    ).toBe(false);
  });
});

describe('shouldPreferFirebaseRedirectAuth', () => {
  const mobileSafariUserAgent =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

  it('does not switch to redirect on mobile safari when auth runs on a firebaseapp.com helper domain', () => {
    expect(
      shouldPreferFirebaseRedirectAuth({
        userAgent: mobileSafariUserAgent,
        currentHostname: 'uploader.upperroommedia.org',
        authDomain: 'urm-app.firebaseapp.com',
      })
    ).toBe(false);
  });

  it('allows redirect when mobile safari is running against a same-host auth domain', () => {
    expect(
      shouldPreferFirebaseRedirectAuth({
        userAgent: mobileSafariUserAgent,
        currentHostname: 'uploader.upperroommedia.org',
        authDomain: 'uploader.upperroommedia.org',
      })
    ).toBe(true);
  });
});
