import { shouldDropClientSentryEvent } from '../../utils/sentryNoise';

describe('shouldDropClientSentryEvent', () => {
  it('drops route abort errors', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'Error', value: 'routeChange aborted.' }],
        },
      })
    ).toBe(true);
  });

  it('drops firestore abort noise', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'AbortError', value: 'Fetch is aborted' }],
        },
      })
    ).toBe(true);
  });

  it('drops duckduckgo load-failed noise on admin sermons', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'TypeError', value: 'Load failed' }],
        },
        tags: {
          'browser.name': 'DuckDuckGo',
        },
        transaction: '/admin/sermons',
      })
    ).toBe(true);
  });

  it('keeps unrelated load failures', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'TypeError', value: 'Load failed' }],
        },
        tags: {
          'browser.name': 'Chrome',
        },
        transaction: '/admin/sermons',
      })
    ).toBe(false);
  });

  it('drops browser extension runtime tab noise', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'Error', value: 'Invalid call to runtime.sendMessage(). Tab not found.' }],
        },
      })
    ).toBe(true);
  });

  it('drops firebase auth redirect assertion noise', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'Error', value: 'INTERNAL ASSERTION FAILED: Pending promise was never set' }],
        },
      })
    ).toBe(true);
  });

  it('drops image rewrite underscore-error noise', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'Error', value: '_error.js called with falsy error (undefined)' }],
        },
        request: {
          url: 'https://uploader.example.test/_fah/image/process',
        },
      })
    ).toBe(true);
  });

  it('drops firebase analytics load failures', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'TypeError', value: 'Load failed' }],
        },
        request: {
          url: 'https://firebase.googleapis.com/v1alpha/projects/-/apps/-/webConfig',
        },
      })
    ).toBe(true);
  });

  it('drops firebase installations request failures', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'FirebaseError', value: 'Firebase: Error (installations/request-failed).' }],
        },
      })
    ).toBe(true);
  });

  it('drops handled Algolia transport retry errors', () => {
    expect(
      shouldDropClientSentryEvent({
        exception: {
          values: [{ type: 'RetryError', value: 'Unreachable hosts - the search service could not be reached.' }],
        },
        tags: {
          'error.surface': 'handled-ui',
        },
      })
    ).toBe(true);
  });
});
