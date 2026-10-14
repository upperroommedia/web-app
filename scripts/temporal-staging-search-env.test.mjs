import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagingSearchEnvironmentRelease } from './temporal-staging-search-env.mjs';
import { firebaseEnvironmentSources } from './temporal-release-lib.mjs';
import { selectKitDeployConfig } from './create-kit-deploy-config.mjs';
const input = {
  project: 'urm-app-staging',
  commit: 'a'.repeat(40),
  release: {
    environment: 'staging',
    projectId: 'urm-app-staging',
    mode: 'initial-cutover',
    domains: ['search'],
    compatibilityCommit: 'a'.repeat(40),
    releaseId: 'release',
  },
  control: { releaseId: 'release', domains: { search: { owner: 'legacy' } } },
};
test('search opt-in binds exact active immutable search-only descriptor including before ownership flip', () => {
  assert.doesNotThrow(() => assertStagingSearchEnvironmentRelease(input));
  assert.doesNotThrow(() =>
    assertStagingSearchEnvironmentRelease({
      ...input,
      control: { ...input.control, domains: { search: { owner: 'temporal' } } },
    })
  );
  for (const patch of [
    { project: 'urm-app' },
    { commit: 'b'.repeat(40) },
    { control: { ...input.control, releaseId: 'other' } },
    { release: { ...input.release, domains: ['search', 'images'] } },
    { release: { ...input.release, mode: 'durable-upgrade' } },
  ])
    assert.throws(() => assertStagingSearchEnvironmentRelease({ ...input, ...patch }));
});
test('automatic staging environment excludes search while explicit inclusion and kit-only selection stay scoped', () => {
  const manifest = {
    functions: [
      { source: 'functions-core' },
      { kit: 'firestore-send-email', instances: { email: 'email-config' } },
      { kit: 'firestore-algolia-search', instances: { search: 'search-config' } },
    ],
  };
  assert.deepEqual(firebaseEnvironmentSources(manifest, 'urm-app-staging'), ['functions-core', 'email-config']);
  assert.deepEqual(firebaseEnvironmentSources(manifest, 'urm-app-staging', { includeStagingSearch: true }), [
    'functions-core',
    'email-config',
    'search-config',
  ]);
  assert.deepEqual(selectKitDeployConfig(manifest, { onlySearch: true }).functions, [manifest.functions[2]]);
  assert.throws(() => selectKitDeployConfig(manifest, { onlySearch: true, withoutSearch: true }));
});

test('a later durable upgrade may include already-Temporal search without reopening onboarding', () => {
  assert.doesNotThrow(() =>
    assertStagingSearchEnvironmentRelease({
      ...input,
      release: { ...input.release, mode: 'durable-upgrade', domains: ['search', 'images'] },
      control: { ...input.control, domains: { search: { owner: 'temporal' }, images: { owner: 'temporal' } } },
    })
  );
});
