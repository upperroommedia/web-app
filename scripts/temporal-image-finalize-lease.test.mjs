import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import ts from 'typescript';

function compile(relativePath) {
  return ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}
const compiled = compile('../functions/src/handleImageUpload.ts');
const profileCompiled = compile('../functions/src/providerSandbox/profile.ts');
const httpCompiled = compile('../functions/src/providerSandbox/http.ts');
class HttpsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
const event = {
  id: 'finalize-event',
  data: {
    bucket: 'staging-images',
    name: 'speaker-images/original.png',
    generation: '12345678901234567',
    contentType: 'image/png',
    metadata: { type: 'square', firebaseStorageDownloadTokens: 'PRIVATE_DOWNLOAD_TOKEN' },
  },
};

function fixture({
  admissionError,
  acknowledgementError,
  providerError,
  owner = 'legacy',
  projectId = 'urm-app',
} = {}) {
  const calls = [];
  const logs = [];
  let options;
  let sourceOptions;
  const record = (name) => calls.push(name);
  const firestore = {
    collection(name) {
      assert.equal(name, 'images');
      return { withConverter: () => ({ doc: () => ({ set: async () => record('canonical-write') }) }) };
    },
  };
  const remote = { download: async () => record('download') };
  const admin = {
    app: () => ({ options: { projectId } }),
    firestore: () => firestore,
    storage() {
      record('storage-client');
      return {
        bucket(name) {
          assert.equal(name, event.data.bucket);
          return {
            file(name, supplied) {
              assert.equal(name, event.data.name);
              sourceOptions = supplied;
              return remote;
            },
          };
        },
      };
    },
  };
  const environment = { env: { TASK_ORCHESTRATOR_IMAGES: owner } };
  function evaluate(code, dependencies) {
    const exports = {};
    runInNewContext(code, {
      exports,
      Buffer,
      URL,
      process: environment,
      require(specifier) {
        assert.ok(Object.hasOwn(dependencies, specifier), `Unmocked dependency ${specifier}`);
        return dependencies[specifier];
      },
    });
    return exports;
  }
  const profile = evaluate(profileCompiled, { '@upperroom/shared/firebase/firebaseAdmin': admin });
  const http = evaluate(httpCompiled, {
    axios: async (config) => {
      assert.equal(projectId, 'urm-app', 'Only the actual production profile can reach the live transport');
      assert.ok(calls.includes('effects-ack'), 'Transport must remain behind accepted lease effects');
      assert.ok(['POST', 'PUT'].includes(config.method), 'Unexpected provider method');
      assert.equal(config.maxRedirects, 0);
      assert.equal(config.timeout, config.method === 'POST' ? 30_000 : 120_000);
      if (config.method === 'POST') {
        assert.equal(config.url, 'https://core.subsplash.com/files/v1/images');
        assert.equal(config.data.app_key, '9XTSHD');
        assert.equal(config.data.content_type, event.data.contentType);
        assert.equal(config.data.type, event.data.metadata.type);
      } else {
        assert.equal(config.url, 'https://upload.test/PRIVATE_SIGNED_URL');
        assert.equal(config.headers['Content-Type'], event.data.contentType);
        assert.ok(Buffer.isBuffer(config.data));
        assert.equal(config.data.toString(), 'image');
      }
      record(config.method === 'PUT' ? 'provider-put' : 'provider-post');
      if (providerError) throw providerError;
      return {
        data: { id: 'remote1', _links: { presigned_upload_url: { href: 'https://upload.test/PRIVATE_SIGNED_URL' } } },
      };
    },
    'node:async_hooks': { AsyncLocalStorage },
    './profile': profile,
    '@upperroom/shared/firebase/firebaseAdmin': admin,
    '../temporal/publishing/durableOperationContext': {
      getDurablePublishingJobId: () => assert.fail('Legacy live transport must not inspect a durable context'),
      getPublishingSourceStepIds: () => assert.fail('Legacy live transport must not inspect durable steps'),
    },
  });
  const modules = {
    axios: () => assert.fail('Image handler must use the isolated provider HTTP boundary'),
    './providerSandbox/http': http,
    'firebase-functions': { logger: { log: (...args) => logs.push(args) } },
    'firebase-functions/v2/storage': { onObjectFinalized: (_config, handler) => handler },
    'firebase-functions/v2/https': { HttpsError },
    './subsplashUtils': {
      authenticateSubsplash: async () => {
        profile.getProviderExecutionProfile();
        record('provider-auth');
        return 'PRIVATE_BEARER';
      },
      createAxiosConfig: (url, token, method, data) => {
        assert.equal(token, 'PRIVATE_BEARER');
        return { url, method, data };
      },
    },
    '@upperroom/shared/firebase/firebaseAdmin': admin,
    '@upperroom/shared/types/Image': { ImageSizes: ['square', 'wide', 'banner'] },
    fs: {
      readFileSync: () => {
        record('read-source');
        return Buffer.from('image');
      },
    },
    os,
    path,
    'fs/promises': {
      mkdtemp: async () => {
        record('temp');
        return '/tmp/owned-test';
      },
      rm: async () => record('cleanup'),
    },
    './computeMetadataForImage': async () => ({
      width: 1,
      height: 1,
      averageColorHex: '#000000',
      vibrantColorHex: '#000000',
    }),
    './firestoreDataConverter': { firestoreAdminImagesConverter: {} },
    '@upperroom/shared/shared/firebaseProjectConfig': { getFirebaseImagesBucket: () => event.data.bucket },
    './subsplashSecrets': { subsplashSecretsWithRuntimeAlerts: [] },
    './storageDownloadUrl': {
      ensureFirebaseDownloadUrl: async () => {
        record('metadata-write');
        return 'https://download.test/PRIVATE_DOWNLOAD_TOKEN';
      },
    },
    './handleError': () => record('alert'),
    './temporal/legacyAdmissionLease': {
      withLegacyAdmissionLease: async (db, supplied, callback) => {
        assert.equal(db, firestore);
        record('lease-claim');
        options = supplied;
        if (admissionError) throw admissionError;
        try {
          const value = await callback({
            markEffectsStarted: async () => {
              record('effects-ack');
              if (acknowledgementError) throw acknowledgementError;
            },
          });
          record('lease-completed');
          return value;
        } catch (error) {
          record('lease-error');
          throw error;
        }
      },
    },
    './temporal/images/admission': { enqueueSystemImage: async () => record('durable-ingress') },
    './temporal/publishing/providerTransportPolicy': {
      assertProviderMutationTransportAllowed: () => record('provider-fence'),
    },
    'node:crypto': { createHash },
  };
  const exports = evaluate(compiled, modules);
  return {
    invoke: () => exports.default(event),
    calls,
    logs,
    options: () => options,
    sourceOptions: () => sourceOptions,
    request: (config) => http.default(config),
  };
}

for (const code of ['unavailable', 'failed-precondition']) {
  test(`legacy finalize propagates ${code} before all source/network/mutation work`, async () => {
    const error = new HttpsError(code);
    const f = fixture({ admissionError: error });
    await assert.rejects(f.invoke, (caught) => caught === error);
    assert.deepEqual(f.calls, ['lease-claim']);
    assert.equal(f.options().domain, 'images');
    assert.equal(f.options().continuation, undefined);
  });
}

test('effect acknowledgement failure blocks metadata, providers and canonical writes without alert conversion', async () => {
  const error = new HttpsError('aborted');
  const f = fixture({ acknowledgementError: error });
  await assert.rejects(f.invoke, (caught) => caught === error);
  assert.deepEqual(f.calls, [
    'lease-claim',
    'temp',
    'storage-client',
    'download',
    'effects-ack',
    'cleanup',
    'lease-error',
  ]);
});

test('accepted legacy work pins source generation and acknowledges effects before each destination', async () => {
  const f = fixture();
  await f.invoke();
  assert.equal(f.options().actorUid, 'system:firebase-event');
  assert.equal(f.options().operation, 'uploadimage');
  assert.equal(f.options().projectId, 'urm-app');
  assert.equal(f.sourceOptions().generation, event.data.generation);
  for (const effect of ['metadata-write', 'provider-post', 'provider-put', 'canonical-write']) {
    assert.ok(f.calls.indexOf(effect) > f.calls.indexOf('effects-ack'));
  }
  assert.equal(f.calls.at(-1), 'lease-completed');
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_'));
});

test('failure after effect acknowledgement rejects the lease and cleans its private temporary directory', async () => {
  const f = fixture({ providerError: new Error('upstream failure') });
  await assert.rejects(f.invoke, /Image ingestion failed/);
  assert.ok(f.calls.includes('effects-ack'));
  assert.ok(f.calls.includes('lease-error'));
  assert.ok(f.calls.includes('cleanup'));
  assert.ok(!f.calls.includes('canonical-write'));
  assert.ok(!f.calls.includes('lease-completed'));
});

test('Temporal-owned deployment uses only the durable ingress path', async () => {
  const f = fixture({ owner: 'temporal' });
  await f.invoke();
  assert.deepEqual(f.calls, ['durable-ingress']);
});

test('actual staging profile without explicit sandbox mode refuses transport without any side effect', async () => {
  const f = fixture({ projectId: 'urm-app-staging' });
  await assert.rejects(
    () => f.request({ url: 'https://core.subsplash.com/files/v1/images', method: 'POST' }),
    (error) => error.code === 'PROVIDER_PROFILE_NOT_CONFIGURED'
  );
  assert.deepEqual(f.calls, []);
});
test('strict live-transport fixture rejects unexpected endpoints and methods', async () => {
  const f = fixture();
  await f.invoke();
  const accepted = [...f.calls];
  await assert.rejects(
    () => f.request({ url: 'https://wrong.test/', method: 'GET', maxRedirects: 0, timeout: 30000 }),
    /Unexpected provider method/
  );
  await assert.rejects(
    () => f.request({ url: 'https://wrong.test/', method: 'POST', maxRedirects: 0, timeout: 30000 }),
    /https:\/\/core.subsplash.com/
  );
  assert.deepEqual(f.calls, accepted);
});
