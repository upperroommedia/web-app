const parseSampleRate = (rawValue: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(rawValue?.trim() || '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const webSentryConfig = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim()),
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() || process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE?.trim() || process.env.SENTRY_RELEASE?.trim() || undefined,
  tracesSampleRate: parseSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || process.env.SENTRY_TRACES_SAMPLE_RATE,
    process.env.NODE_ENV === 'development' ? 1 : 0.1
  ),
  replaysSessionSampleRate: parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE, 0.05),
  replaysOnErrorSampleRate: parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, 1),
};

export const webTracePropagationTargets = [
  /^\//,
  /^https:\/\/[^/]*upperroommedia\.org/,
  /^https:\/\/us-central1-urm-app(?:-staging)?\.cloudfunctions\.net/,
  /^http:\/\/localhost(?::\d+)?/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?/,
  ...(process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL ? [process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL] : []),
];
