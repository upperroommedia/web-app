import * as Sentry from '@sentry/nextjs';
import type { SeverityLevel } from '@sentry/nextjs';

const CONSOLE_ERROR_CAPTURE_FLAG = '__urmConsoleErrorCaptureInstalled';
const FIREBASE_LOGGER_PATTERN = /@firebase\/[a-z0-9-]+:/i;

type HandledErrorContext = {
  area: string;
  action?: string;
  level?: SeverityLevel;
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shouldSkipConsoleCapture = (args: unknown[]): boolean => {
  const [firstArg] = args;

  return typeof firstArg === 'string' && FIREBASE_LOGGER_PATTERN.test(firstArg);
};

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return new Error(error.trim());
  }

  return new Error(fallbackMessage);
};

const applyContext = (scope: Sentry.Scope, context: HandledErrorContext): void => {
  scope.setLevel(context.level ?? 'error');
  scope.setTag('error.surface', 'handled-ui');
  scope.setTag('ui.area', context.area);

  if (context.action) {
    scope.setTag('ui.action', context.action);
  }

  Object.entries(context.tags ?? {}).forEach(([key, value]) => {
    scope.setTag(key, value);
  });

  Object.entries(context.extras ?? {}).forEach(([key, value]) => {
    scope.setExtra(key, value);
  });
};

export const reportHandledError = (error: unknown, context: HandledErrorContext): void => {
  const normalizedError = toError(error, 'A handled UI error was reported');

  Sentry.withScope((scope) => {
    applyContext(scope, context);

    if (!(error instanceof Error)) {
      scope.setExtra('non_error_value', error);
    }

    Sentry.captureException(normalizedError);
  });
};

export const reportHandledMessage = (
  message: string,
  context: Omit<HandledErrorContext, 'level'> & { level?: SeverityLevel }
): void => {
  reportHandledError(new Error(message), context);
};

export const installConsoleErrorCapture = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const target = window as Window & { [CONSOLE_ERROR_CAPTURE_FLAG]?: boolean };
  if (target[CONSOLE_ERROR_CAPTURE_FLAG]) {
    return;
  }

  target[CONSOLE_ERROR_CAPTURE_FLAG] = true;

  const originalConsoleError = console.error.bind(console);
  let isCapturing = false;

  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);

    if (isCapturing) {
      return;
    }

    if (shouldSkipConsoleCapture(args)) {
      return;
    }

    const primaryError = args.find((value) => value instanceof Error);
    const firstArg = args[0];
    const message =
      typeof firstArg === 'string' && firstArg.trim().length > 0
        ? firstArg.trim()
        : primaryError instanceof Error
          ? primaryError.message
          : 'console.error invoked';

    const extras: Record<string, unknown> = {};
    const secondaryArgs = args.filter((value) => value !== primaryError);
    if (secondaryArgs.length > 0) {
      extras.console_args = secondaryArgs.map((value) => (isObjectRecord(value) ? { ...value } : value));
    }

    try {
      isCapturing = true;
      reportHandledError(primaryError ?? new Error(message), {
        area: 'browser-console',
        action: 'console.error',
        level: 'error',
        extras,
      });
    } finally {
      isCapturing = false;
    }
  };
};
