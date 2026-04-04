import * as Sentry from '@sentry/node';
import { defineSecret } from 'firebase-functions/params';
import { sentryBuildGitSha } from './sentryBuildInfo';

export const functionsSentryDsnSecret = defineSecret('FUNCTIONS_SENTRY_DSN');

let initialized = false;

const parseSampleRate = (rawValue: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(rawValue?.trim() || '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getFunctionsEnvironment = (): string => {
  if (process.env.SENTRY_ENVIRONMENT?.trim()) {
    return process.env.SENTRY_ENVIRONMENT.trim();
  }

  if (process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'development') {
    return 'development';
  }

  const projectId =
    process.env.GCLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    '';

  if (projectId.includes('staging')) {
    return 'staging';
  }

  return 'production';
};

const getFunctionsRelease = (): string | undefined => {
  const explicitRelease = process.env.SENTRY_RELEASE?.trim();
  if (explicitRelease) {
    return explicitRelease;
  }

  if (sentryBuildGitSha) {
    return `firebase-functions@${getFunctionsEnvironment()}-${sentryBuildGitSha}`;
  }

  return process.env.K_REVISION?.trim() || process.env.FUNCTION_TARGET?.trim() || undefined;
};

export const initFunctionsSentry = (): void => {
  if (initialized) {
    return;
  }

  const dsn = process.env.FUNCTIONS_SENTRY_DSN?.trim() || process.env.SENTRY_DSN?.trim() || undefined;

  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment: getFunctionsEnvironment(),
    release: getFunctionsRelease(),
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, process.env.NODE_ENV === 'development' ? 1 : 0.1),
    includeLocalVariables: true,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        service: 'firebase-functions',
        projectId:
          process.env.GCLOUD_PROJECT?.trim() ||
          process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
          process.env.FIREBASE_PROJECT_ID?.trim() ||
          'unknown',
      },
    },
  });

  initialized = true;
};
