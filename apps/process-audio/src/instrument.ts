import * as Sentry from '@sentry/node';
import { scrubMosesSentryPayload } from './sentryMosesPrivacy';

const dsn = process.env.SENTRY_DSN?.trim() || '';
const runtimeEnv =
  process.env.SENTRY_ENVIRONMENT?.trim() || process.env.PROCESS_AUDIO_RUNTIME_ENV?.trim() || process.env.NODE_ENV || 'unknown';
const runtimeProfile = process.env.PROCESS_AUDIO_RUNTIME_PROFILE?.trim() || 'unknown';
const runtimeHost = process.env.PROCESS_AUDIO_RUNTIME_HOST?.trim() || 'unknown';
const release = process.env.SENTRY_RELEASE?.trim() || process.env.K_REVISION?.trim() || undefined;
const tracesSampleRate = Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE?.trim() || '');
const sentryEnabled = Boolean(dsn);
const sentryLogsEnabled = sentryEnabled && process.env.SENTRY_ENABLE_LOGS?.trim() !== 'false';
const sentryTracesSampleRate = Number.isFinite(tracesSampleRate)
  ? tracesSampleRate
  : process.env.NODE_ENV === 'development'
    ? 1
    : 0.1;

Sentry.init({
  dsn: dsn || undefined,
  enabled: sentryEnabled,
  environment: runtimeEnv,
  release,
  tracesSampleRate: sentryTracesSampleRate,
  enableLogs: sentryLogsEnabled,
  includeLocalVariables: true,
  sendDefaultPii: false,
  transport(options) {
    const transport = Sentry.makeNodeTransport(options);
    return {
      flush: transport.flush,
      send(envelope) {
        const items = envelope[1];
        for (let index = items.length - 1; index >= 0; index--) {
          const item = items[index];
          if (!['event', 'transaction', 'span', 'log'].includes(item[0].type)) continue;
          try {
            item[1] = scrubMosesSentryPayload(item[1], process.env.MOSES_GUEST_AUDIO_TOKEN);
          } catch {
            items.splice(index, 1);
          }
        }
        return items.length ? transport.send(envelope) : Promise.resolve({});
      },
    };
  },
  initialScope: {
    tags: {
      service: 'process-audio',
      runtimeHost,
      runtimeProfile,
    },
  },
});

export {
  Sentry,
  runtimeEnv as sentryEnvironment,
  sentryEnabled,
  sentryLogsEnabled,
  sentryTracesSampleRate,
  release as sentryRelease,
};
