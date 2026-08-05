import type { Event } from '@sentry/nextjs';

const getExceptionValue = (event: Event): string => {
  const value = event.exception?.values?.[0]?.value;
  return typeof value === 'string' ? value : '';
};

const getExceptionType = (event: Event): string => {
  const type = event.exception?.values?.[0]?.type;
  return typeof type === 'string' ? type : '';
};

const getTagValue = (event: Event, key: string): string => {
  const value = event.tags?.[key];
  return typeof value === 'string' ? value : '';
};

const getRequestUrl = (event: Event): string => {
  const url = event.request?.url;
  return typeof url === 'string' ? url : '';
};

const getRequestApiTarget = (event: Event): string => {
  const url = getRequestUrl(event);
  const exceptionValue = getExceptionValue(event);
  const message = event.message;

  return [url, exceptionValue, typeof message === 'string' ? message : ''].join(' ');
};

export const shouldDropClientSentryEvent = (event: Event): boolean => {
  const exceptionType = getExceptionType(event);
  const exceptionValue = getExceptionValue(event);
  const browserName = getTagValue(event, 'browser.name');
  const transaction = event.transaction || '';
  const requestUrl = getRequestUrl(event);

  if (exceptionValue === 'routeChange aborted.') {
    return true;
  }

  if (exceptionType === 'AbortError' && exceptionValue === 'Fetch is aborted') {
    return true;
  }

  if (
    exceptionType === 'TypeError' &&
    exceptionValue === 'Load failed' &&
    browserName === 'DuckDuckGo' &&
    (transaction === '/admin/sermons' || requestUrl.includes('/admin/sermons'))
  ) {
    return true;
  }

  if (exceptionValue === 'Invalid call to runtime.sendMessage(). Tab not found.') {
    return true;
  }

  if (exceptionValue === 'INTERNAL ASSERTION FAILED: Pending promise was never set') {
    return true;
  }

  const apiTarget = getRequestApiTarget(event);
  if (
    apiTarget.includes('/_fah/image/process') &&
    exceptionValue.includes('_error.js called with falsy error')
  ) {
    return true;
  }

  if (
    exceptionType === 'TypeError' &&
    exceptionValue === 'Load failed' &&
    apiTarget.includes('firebase.googleapis.com')
  ) {
    return true;
  }

  if (apiTarget.includes('installations/request-failed')) {
    return true;
  }

  if (
    exceptionType === 'RetryError' &&
    exceptionValue.includes('Unreachable hosts') &&
    getTagValue(event, 'error.surface') === 'handled-ui'
  ) {
    return true;
  }

  return false;
};
