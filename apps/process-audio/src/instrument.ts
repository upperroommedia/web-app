import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN?.trim() || '';
const runtimeEnv = process.env.SENTRY_ENVIRONMENT?.trim() || process.env.PROCESS_AUDIO_RUNTIME_ENV?.trim() || process.env.NODE_ENV || 'unknown';
const runtimeProfile = process.env.PROCESS_AUDIO_RUNTIME_PROFILE?.trim() || 'unknown';
const runtimeHost = process.env.PROCESS_AUDIO_RUNTIME_HOST?.trim() || 'unknown';
const release = process.env.SENTRY_RELEASE?.trim() || process.env.K_REVISION?.trim() || undefined;
const tracesSampleRate = Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE?.trim() || '');

Sentry.init({
  dsn: dsn || undefined,
  enabled: Boolean(dsn),
  environment: runtimeEnv,
  release,
  tracesSampleRate: Number.isFinite(tracesSampleRate)
    ? tracesSampleRate
    : process.env.NODE_ENV === 'development'
      ? 1
      : 0.1,
  includeLocalVariables: true,
  sendDefaultPii: false,
  initialScope: {
    tags: {
      service: 'process-audio',
      runtimeHost,
      runtimeProfile,
    },
  },
});

export { Sentry };
