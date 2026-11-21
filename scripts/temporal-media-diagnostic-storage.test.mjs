import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  observeMediaDiagnosticStorage,
  readRetiredMediaDiagnosticStorage,
} from './temporal-media-diagnostic-storage.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';

function fixture() {
  const releaseId = '13330954-291f-4a64-bb46-516339a61c91';
  const buildId = 'a'.repeat(40);
  const bucket = 'urm-app-staging-mr-' + releaseId.replaceAll('-', '');
  const resource = 'https://storage.googleapis.com/storage/v1/b/' + bucket;
  const roleName = 'projects/urm-app-staging/roles/tw_media_recovery_storage_' + buildId.slice(0, 20);
  const member = 'serviceAccount:tw-m-' + buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com';
  const metadata = {
    name: bucket,
    id: bucket,
    projectNumber: '251680231116',
    location: 'US-CENTRAL1',
    timeCreated: '2026-11-21T16:52:00.000Z',
    metageneration: '1',
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
    versioning: { enabled: true },
  };
  const policy = { etag: 'policy', bindings: [{ role: roleName, members: [member] }] };
  const role = {
    name: roleName,
    etag: 'role',
    includedPermissions: [
      'storage.objects.get',
      'storage.objects.list',
      'storage.objects.create',
      'storage.objects.delete',
    ],
  };
  const listing = { kind: 'storage#objects' };
  const replies = new Map([
    [resource, metadata],
    [resource + '/iam?optionsRequestedPolicyVersion=3', policy],
    ['https://iam.googleapis.com/v1/' + roleName, role],
    [resource + '/o?versions=true&maxResults=1', listing],
  ]);
  const api = async (url) => {
    assert.ok(replies.has(url));
    return structuredClone(replies.get(url));
  };
  return { options: { api, releaseId, buildId, requireEmpty: true }, metadata, policy, role, listing, bucket };
}

test('seals the native synthetic bucket, exact runtime grant and initially empty versions', async () => {
  const { options, bucket, policy } = fixture();
  const before = await observeMediaDiagnosticStorage(options);
  assert.equal(before.bucket, bucket);
  assert.match(before.preparationSHA256, /^[a-f0-9]{64}$/);
  policy.etag = 'new-policy';
  assert.notEqual((await observeMediaDiagnosticStorage(options)).preparationSHA256, before.preparationSHA256);
});

test('stops on an incomplete version inventory, absent permission, or overbroad binding', async () => {
  for (const change of [
    (f) => {
      f.listing.nextPageToken = 'next';
    },
    (f) => {
      f.listing.items = [{ generation: '1' }];
    },
    (f) => {
      f.role.includedPermissions = f.role.includedPermissions.filter((x) => x !== 'storage.objects.list');
    },
    (f) => {
      f.policy.bindings[0].members.push('serviceAccount:other@urm-app-staging.iam.gserviceaccount.com');
    },
    (f) => {
      f.metadata.iamConfiguration.uniformBucketLevelAccess.enabled = false;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(observeMediaDiagnosticStorage(f.options), /MEDIA_RECOVERY_DIAGNOSTIC_STORAGE_UNCONFIRMED/);
  }
});

test('restoration requires the exact immutable retirement receipt and the native policy without the grant', async () => {
  const { bucket, options, metadata } = fixture();
  const diagnosticStorage = await observeMediaDiagnosticStorage(options);
  const { metageneration, ...rest } = metadata;
  const configuration = { ...rest, kind: 'storage#bucket' };
  const nativeBucket = { ...configuration, etag: 'bucket', metageneration };
  const terminalProof = { dataDigest: '1'.repeat(64) };
  const operationId = '8540b04c-82d7-40eb-bfe2-f7d40a81edfa';
  const bindingDigest = '2'.repeat(64);
  const plan = {
    releaseId: options.releaseId,
    buildId: options.buildId,
    diagnosticStorage,
    runner: 'tw-m-' + options.buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com',
  };
  const policy = { kind: 'storage#policy', resourceId: 'projects/_/buckets/' + bucket, etag: 'retired', bindings: [] };
  const receipt = {
    operationId,
    releaseId: plan.releaseId,
    bindingDigest,
    identityState: {
      stage: 'completed',
      plan: {
        ...plan,
        action: 'retire-media-diagnostic-storage-grant',
        operationId,
        bucket,
        terminalProof,
        bindingDigest,
      },
      retiredBucket: {
        name: bucket,
        timeCreated: diagnosticStorage.createdAt,
        etag: nativeBucket.etag,
        metageneration,
        configurationSHA256: proofDigest(configuration),
      },
      retiredPolicyETag: policy.etag,
      revocation: {
        stage: 'acknowledged',
        before: { certificate: diagnosticStorage },
        ack: { etag: policy.etag, version: 1, bindings: [] },
      },
    },
  };
  const query = {
    where: (...args) => {
      assert.deepEqual(args, ['identityState.plan.terminalProof.dataDigest', '==', terminalProof.dataDigest]);
      return query;
    },
    limit: (count) => (assert.equal(count, 2), query),
    get: async () => ({
      size: 1,
      docs: [
        {
          id: 'temporalMediaDiagnosticStorageRetirement-' + operationId,
          data: () => receipt,
          createTime: { isEqual: () => true },
        },
      ],
    }),
  };
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    collection: (name) => (assert.equal(name, '_control'), query),
  };
  const api = async (url) => {
    if (url === 'https://storage.googleapis.com/storage/v1/b/' + bucket) return nativeBucket;
    assert.equal(url, 'https://storage.googleapis.com/storage/v1/b/' + bucket + '/iam?optionsRequestedPolicyVersion=3');
    return policy;
  };
  assert.match(await readRetiredMediaDiagnosticStorage({ db, plan, terminalProof, api }), /^[a-f0-9]{64}$/);
  nativeBucket.timeCreated = '2026-11-21T16:55:00.000Z';
  await assert.rejects(
    readRetiredMediaDiagnosticStorage({ db, plan, terminalProof, api }),
    /MEDIA_RECOVERY_DIAGNOSTIC_STORAGE_UNCONFIRMED/
  );
  nativeBucket.timeCreated = diagnosticStorage.createdAt;
  policy.bindings.push({ role: 'roles/storage.objectViewer', members: ['serviceAccount:' + plan.runner] });
  await assert.rejects(
    readRetiredMediaDiagnosticStorage({ db, plan, terminalProof, api }),
    /MEDIA_RECOVERY_DIAGNOSTIC_STORAGE_UNCONFIRMED/
  );
});
