import * as Sentry from '@sentry/nextjs';
import { webSentryConfig, webTracePropagationTargets } from './sentry.shared';
import { shouldDropClientSentryEvent } from './utils/sentryNoise';

Sentry.init({
  ...webSentryConfig,
  beforeSend(event) {
    return shouldDropClientSentryEvent(event) ? null : event;
  },
  sendDefaultPii: false,
  integrations: [Sentry.replayIntegration({
    maskAllText: false,
    blockAllMedia: false,
  })],
  tracePropagationTargets: webTracePropagationTargets,
});
