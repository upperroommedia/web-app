import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../functions/src/handleImageUpload.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
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

function fixture({ admissionError, acknowledgementError, providerError, owner = 'legacy' } = {}) {
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
    app: () => ({ options: { projectId: 'urm-app-staging' } }),
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
  const modules = {
    axios: async (config) => {
      record(config.method === 'PUT' ? 'provider-put' : 'provider-post');
      assert.equal(config.maxRedirects, 0);
      assert.ok(config.timeout > 0 && config.timeout <= 120_000);
      if (providerError) throw providerError;
      return {
        data: { id: 'remote1', _links: { presigned_upload_url: { href: 'https://upload.test/PRIVATE_SIGNED_URL' } } },
      };
    },
    'firebase-functions': { logger: { log: (...args) => logs.push(args) } },
    'firebase-functions/v2/storage': { onObjectFinalized: (_config, handler) => handler },
    'firebase-functions/v2/https': { HttpsError },
    './subsplashUtils': {
      authenticateSubsplash: async () => {
        record('provider-auth');
        return 'PRIVATE_BEARER';
      },
      createAxiosConfig: (url, _token, method, data) => ({ url, method, data }),
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
  const exports = {};
  runInNewContext(compiled, {
    exports,
    Buffer,
    process: { env: { TASK_ORCHESTRATOR_IMAGES: owner } },
    require(specifier) {
      assert.ok(Object.hasOwn(modules, specifier), `Unmocked dependency ${specifier}`);
      return modules[specifier];
    },
  });
  return {
    invoke: () => exports.default(event),
    calls,
    logs,
    options: () => options,
    sourceOptions: () => sourceOptions,
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
  assert.equal(f.options().projectId, 'urm-app-staging');
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
