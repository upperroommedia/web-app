import { algoliaSecretsWithRuntimeAlerts } from '../algoliaSecrets';
import { adminBaseUrlSecretsWithRuntimeAlerts, adminRequestSecretsWithRuntimeAlerts } from '../notifications/notificationSecrets';
import { functionsSentryDsnSecret } from '../sentry';
import { soundcloudSecretsWithRuntimeAlerts } from '../soundcloudSecrets';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';

describe('functions secret bundles', () => {
  it.each([
    ['subsplashSecretsWithRuntimeAlerts', subsplashSecretsWithRuntimeAlerts],
    ['adminBaseUrlSecretsWithRuntimeAlerts', adminBaseUrlSecretsWithRuntimeAlerts],
    ['adminRequestSecretsWithRuntimeAlerts', adminRequestSecretsWithRuntimeAlerts],
    ['algoliaSecretsWithRuntimeAlerts', algoliaSecretsWithRuntimeAlerts],
    ['soundcloudSecretsWithRuntimeAlerts', soundcloudSecretsWithRuntimeAlerts],
  ])('includes the functions Sentry DSN in %s', (_label, secrets) => {
    expect(secrets).toContain(functionsSentryDsnSecret);
  });
});
