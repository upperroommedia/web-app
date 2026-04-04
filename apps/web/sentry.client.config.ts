import * as Sentry from '@sentry/nextjs';
import { webSentryConfig, webTracePropagationTargets } from './sentry.shared';

Sentry.init({
  ...webSentryConfig,
  sendDefaultPii: false,
  integrations: [Sentry.replayIntegration()],
  tracePropagationTargets: webTracePropagationTargets,
});
