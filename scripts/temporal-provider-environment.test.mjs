import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRuntimeEnvironment } from './provider-runtime-environment.mjs';
import { upsertFunctionFlags } from './temporal-release-lib.mjs';

test('only the exact staging deployment selects the isolated provider transport', () => {
  assert.deepEqual(providerRuntimeEnvironment('urm-app-staging'), { STAGING_PROVIDER_MODE: 'sandbox' });
  assert.deepEqual(providerRuntimeEnvironment('urm-app'), {});
  for (const project of [undefined, '', 'staging', 'urm-app-staging-other', 'urm-app-other'])
    assert.throws(() => providerRuntimeEnvironment(project));
});

test('regeneration removes stale provider modes while preserving unrelated settings', () => {
  const original = 'MAIL_COLLECTION=mail\nSTAGING_PROVIDER_MODE=live\nexport STAGING_PROVIDER_MODE = sandbox\n';
  const stage = upsertFunctionFlags(original, providerRuntimeEnvironment('urm-app-staging'));
  assert.equal(stage.match(/^STAGING_PROVIDER_MODE=/gm)?.length, 1);
  assert.match(stage, /^STAGING_PROVIDER_MODE=sandbox$/m);
  assert.match(stage, /^MAIL_COLLECTION=mail$/m);
  assert.equal(upsertFunctionFlags(stage, providerRuntimeEnvironment('urm-app-staging')), stage);
  const production = upsertFunctionFlags(stage, providerRuntimeEnvironment('urm-app'));
  assert.doesNotMatch(production, /STAGING_PROVIDER_MODE/);
  assert.match(production, /^MAIL_COLLECTION=mail$/m);
});
