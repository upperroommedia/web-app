import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('image codebase discovers only retained handlers and cannot load retired mutation APIs', () => {
  const loaded = [];
  const handlers = new Map([['../../functions/src/handleImageUpload', { default: Symbol('uploadimage') }]]);
  const dependencies = new Map([
    ...handlers,
    ['../../functions/src/sentry', { initFunctionsSentry() {}, functionsSentryDsnSecret: 'sentry' }],
    ['firebase-functions/v2', { setGlobalOptions() {} }],
    ['../../functions/src/notifications/notificationSecrets', { runtimeAlertRecipientsSecret: 'alerts' }],
    ['../../functions/src/providerRelay', { providerEgressRelayTokenSecret: 'relay' }],
  ]);
  const exports = {};
  const compiled = ts.transpileModule(read('functions-image/src/index.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require(specifier) {
      loaded.push(specifier);
      assert.ok(dependencies.has(specifier), `Unexpected image entrypoint import: ${specifier}`);
      return dependencies.get(specifier);
    },
  });
  assert.deepEqual(Object.keys(exports).sort(), ['uploadimage']);
  for (const [specifier, value] of handlers) {
    assert.ok(loaded.includes(specifier));
    assert.ok(Object.values(exports).includes(value.default));
  }
  for (const retired of [
    'functions/src/saveImage.ts',
    'functions/src/getImage.ts',
    'functions/src/helpers/updateImageMetadata.ts',
    'functions/src/DocumentListeners/Images/imageOnDelete.ts',
  ]) {
    assert.equal(existsSync(fileURLToPath(new URL(retired, root))), false, `${retired} must remain retired`);
  }
});

test('image selection retains durable ingress and durable completion instead of removed callables', () => {
  const selector = read('apps/web/components/ImageSelector.tsx');
  assert.match(selector, /await ingestDurableImage\(croppedImageData, name\)/);
  assert.match(selector, /setImageJobId\(receipt\.jobId\)/);
  assert.match(selector, /imageJob\?\.state !== 'succeeded'/);
  assert.doesNotMatch(selector, /httpsCallable[^\n]*(?:saveimage|getimage|updateimagemetadata)/i);
});

test('durable image deletion owns generation-pinned effects and checks canonical identity', () => {
  const activities = read('functions/src/temporal/images/activities.ts');
  assert.match(activities, /ifGenerationMatch: intent\.source\.generation/);
  assert.match(activities, /current\.source\?\.generation !== intent\.source\.generation/);
  assert.match(activities, /ImageDeletionCanonicalChanged/);
  assert.match(read('apps/web/utils/durableImages.ts'), /kind: 'image\.delete'/);
});
