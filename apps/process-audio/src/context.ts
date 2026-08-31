import { randomUUID } from 'crypto';

export type YouTubeSuccessfulAcquisitionAuthority = 'public_provider' | 'cookie_provider' | 'browser_fallback';

export interface LogContext {
  requestId: string;
  sermonId?: string;
  operation?: string;
  youtubeSuccessfulAcquisitionAuthority?: YouTubeSuccessfulAcquisitionAuthority;
  youtubeBrowserPoTokenAttempted?: boolean;
  youtubeCookieRefreshAttempted?: boolean;
  youtubeCookieRefreshSucceeded?: boolean;
  [key: string]: string | number | boolean | undefined;
}

const requestEvidenceFields = [
  'youtubeSuccessfulAcquisitionAuthority',
  'youtubeBrowserPoTokenAttempted',
  'youtubeCookieRefreshAttempted',
  'youtubeCookieRefreshSucceeded',
] as const satisfies readonly (keyof LogContext)[];

// Create a new context for a request/process
export function createContext(sermonId?: string, operation?: string): LogContext {
  return {
    requestId: randomUUID(),
    sermonId,
    operation,
  };
}

// Create a child context (for sub-operations)
export function createChildContext(parent: LogContext, operation: string): LogContext {
  const child: LogContext = {
    ...parent,
    operation: parent.operation ? `${parent.operation}.${operation}` : operation,
  };

  // Child operations add their own operation label, but acquisition/session
  // evidence belongs to the request. Forward reads and writes so evidence
  // discovered deep in trim/download is visible to the HTTP handler and queue
  // completion even when multiple child contexts are nested.
  for (const field of requestEvidenceFields) {
    Object.defineProperty(child, field, {
      configurable: true,
      enumerable: true,
      get: () => Reflect.get(parent, field),
      set: (value: LogContext[typeof field]) => {
        Reflect.set(parent, field, value);
      },
    });
  }

  return child;
}
