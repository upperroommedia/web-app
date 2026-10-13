import * as Sentry from '@sentry/nextjs';
import { webSentryConfig, webTracePropagationTargets } from './sentry.shared';
import { shouldDropClientSentryEvent } from './utils/sentryNoise';

Sentry.init({
  ...webSentryConfig,
  beforeSend(event) {
    return shouldDropClientSentryEvent(event) ? null : event;
  },
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
  tracePropagationTargets: webTracePropagationTargets,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
