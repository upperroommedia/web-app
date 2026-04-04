import * as Sentry from '@sentry/nextjs';
import { webSentryConfig } from './sentry.shared';

Sentry.init({
  dsn: process.env.SENTRY_DSN?.trim() || webSentryConfig.dsn,
  enabled: Boolean(process.env.SENTRY_DSN?.trim() || webSentryConfig.dsn),
  environment: process.env.SENTRY_ENVIRONMENT?.trim() || webSentryConfig.environment,
  release: process.env.SENTRY_RELEASE?.trim() || webSentryConfig.release,
  tracesSampleRate: webSentryConfig.tracesSampleRate,
  sendDefaultPii: false,
});
