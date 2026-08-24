import { randomUUID } from 'crypto';

export type YouTubeSuccessfulAcquisitionAuthority = 'public_provider' | 'cookie_provider' | 'browser_fallback';

export interface LogContext {
  requestId: string;
  sermonId?: string;
  operation?: string;
  youtubeSuccessfulAcquisitionAuthority?: YouTubeSuccessfulAcquisitionAuthority;
  [key: string]: string | number | boolean | undefined;
}

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
  return {
    ...parent,
    operation: parent.operation ? `${parent.operation}.${operation}` : operation,
  };
}
