import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prepareCloudRunIdentity } from '../temporal-prepare-cloud-identity.mjs';
import { saveIdentityPreparationCheckpoint, savePoolPreparationCheckpoint, saveSecretAccessPreparationCheckpoint, saveScalerAccessPreparationCheckpoint, saveFirestoreAccessPreparationCheckpoint, saveRuntimeRolePreparationCheckpoint, saveRuntimeAccessPreparationCheckpoint } from '../temporal-preparation-checkpoint.mjs';
import { nativeSnapshotProof } from '../temporal-release-runtime.mjs';
import { serverlessResourceNames } from '../temporal-serverless-platform.mjs';
import { dispatchResourceNames } from '../temporal-serverless-dispatch-resources.mjs';
const harness = JSON.parse(readFileSync(new URL('../../firebase.test.json', import.meta.url)));
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`) throw new Error('DEDICATED_TEST_EMULATOR_REQUIRED');
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}

test('native checkpoint fences control/state drift before create and preserves completed identity receipt', async () => {
  const app = initializeApp({ projectId: 'demo-preparation-checkpoint' }, randomUUID()), db = getFirestore(app);
  try {
    for (const drift of ['control', 'state', 'none']) {
      const id = randomUUID(), releaseId = randomUUID(), prefix = `_identityPreparationTests/${id}`;
      const lockRef = db.doc(`${prefix}/records/operation`), controlRef = db.doc(`${prefix}/records/control`), stateRef = db.doc(`${prefix}/records/state`), receipt = db.doc(`${prefix}/records/receipt`);
      const bindingDigest = 'e'.repeat(64), operatorPrincipal = { email: 'operator@example.test' };
      const config = { releaseId, domains: ['publishing'] };
      await lockRef.create({ operationId: id, releaseId, action: 'prepare-cloud-run-identity', bindingDigest });
      await controlRef.create({ releaseId, admission: 'paused', domains: { publishing: { admission: 'paused' } } });
      await stateRef.create({ releaseId, phase: 'provider-usage-ready' });
      let ownedOperation = nativeSnapshotProof(await lockRef.get());
      const expectedAuthority = { control: nativeSnapshotProof(await controlRef.get()), state: nativeSnapshotProof(await stateRef.get()) };
      let posts = 0, account, saves = 0;
      const options = { platform: platform(), role: 'controls', kind: 'runner', creator: operatorPrincipal.email, operationId: id, evidenceDigest: 'f'.repeat(64),
        save: async identityState => {
          // Race after the planned transaction but before the HTTP-authorizing attempted checkpoint.
          if (++saves === 2 && drift !== 'none') await (drift === 'control' ? controlRef : stateRef).update({ changedDuringEvidence: true });
          ownedOperation = await saveIdentityPreparationCheckpoint({ firestore: db, lockRef, controlRef, stateRef, immutableReceipt: receipt, ownedOperation, expectedAuthority, config, operationId: id, bindingDigest, operatorPrincipal, identityState });
        },
        api: async (url, method = 'GET', body) => {
          if (method === 'GET') { if (!account) throw Object.assign(new Error('absent'), { status: 404 }); return account; }
          posts++;
          assert.equal((await lockRef.get()).get('cloudIdentityPreparation.stage'), 'attempted');
          account = { projectId: 'urm-app-staging', email: `${body.accountId}@urm-app-staging.iam.gserviceaccount.com`, uniqueId: '123456789012345678901', ...body.serviceAccount };
          return account;
        } };
      if (drift !== 'none') {
        await assert.rejects(prepareCloudRunIdentity(options));
        assert.equal(posts, 0);
        assert.equal((await lockRef.get()).get('cloudIdentityPreparation.stage'), 'planned');
        assert.equal((await receipt.get()).exists, false);
      } else {
        await prepareCloudRunIdentity(options);
        assert.equal(posts, 1);
        const original = await receipt.get();
        assert.equal(original.get('identityState.stage'), 'completed');
        assert.equal(original.get('identityState.account.uniqueId'), account.uniqueId);
        await assert.rejects(saveIdentityPreparationCheckpoint({ firestore: db, lockRef, controlRef, stateRef, immutableReceipt: receipt, ownedOperation, expectedAuthority, config, operationId: id, bindingDigest, operatorPrincipal,
          identityState: { ...(await lockRef.get()).get('cloudIdentityPreparation'), verifiedAt: 'different' } }));
        assert.equal((await receipt.get()).updateTime.isEqual(original.updateTime), true);
      }
      for (const ref of [lockRef, controlRef, stateRef, receipt]) await ref.delete();
    }
  } finally { await deleteApp(app); }
});

for (const kind of ['pool', 'secret', 'scaler', 'firestore', 'runtimeRole', 'runtimeAccess']) test(`${kind} checkpoint uses its own action and field under real native authority fences`, async () => {
  const saveResource = { pool: savePoolPreparationCheckpoint, secret: saveSecretAccessPreparationCheckpoint, scaler: saveScalerAccessPreparationCheckpoint, firestore: saveFirestoreAccessPreparationCheckpoint, runtimeRole: saveRuntimeRolePreparationCheckpoint, runtimeAccess: saveRuntimeAccessPreparationCheckpoint }[kind];
  const field = { pool: 'cloudPoolPreparation', secret: 'cloudSecretAccessPreparation', scaler: 'cloudScalerAccessPreparation', firestore: 'cloudFirestoreAccessPreparation', runtimeRole: 'cloudRuntimeRolePreparation', runtimeAccess: 'cloudRuntimeAccessPreparation' }[kind];
  const action = { pool: 'prepare-cloud-run-pool', secret: 'prepare-cloud-run-secret-access', scaler: 'prepare-cloud-run-scaler-access', firestore: 'prepare-cloud-run-firestore-access', runtimeRole: 'prepare-cloud-run-runtime-role', runtimeAccess: 'prepare-cloud-run-runtime-access' }[kind];
  const app = initializeApp({ projectId: 'demo-preparation-checkpoint' }, randomUUID()), db = getFirestore(app);
  const prefix = `_identityPreparationTests/${randomUUID()}/records`;
  const lockRef = db.doc(`${prefix}/operation`), controlRef = db.doc(`${prefix}/control`), stateRef = db.doc(`${prefix}/state`), immutableReceipt = db.doc(`${prefix}/receipt`);
  const operationId = randomUUID(), releaseId = randomUUID(), bindingDigest = 'e'.repeat(64), config = { releaseId, domains: ['publishing'] };
  try {
    await lockRef.create({ operationId, releaseId, action, bindingDigest });
    await controlRef.create({ releaseId, admission: 'paused', domains: { publishing: { admission: 'paused' } } });
    await stateRef.create({ releaseId, phase: 'provider-usage-ready' });
    const options = { firestore: db, lockRef, controlRef, stateRef, immutableReceipt, config, operationId, bindingDigest, operatorPrincipal: { email: 'operator@example.test' },
      ownedOperation: nativeSnapshotProof(await lockRef.get()), expectedAuthority: { control: nativeSnapshotProof(await controlRef.get()), state: nativeSnapshotProof(await stateRef.get()) },
      identityState: { stage: 'planned', plan: { source: 'synthetic' } } };
    options.ownedOperation = await saveResource(options);
    assert.equal((await lockRef.get()).get(`${field}.stage`), 'planned');
    assert.equal((await lockRef.get()).get('cloudIdentityPreparation'), undefined);
    await assert.rejects(saveIdentityPreparationCheckpoint(options));
    await controlRef.update({ admission: 'open' });
    await assert.rejects(saveResource({ ...options, identityState: { ...options.identityState, stage: 'attempted' } }));
    assert.equal((await lockRef.get()).get(`${field}.stage`), 'planned');
  } finally {
    for (const ref of [lockRef, controlRef, stateRef, immutableReceipt]) await ref.delete();
    await deleteApp(app);
  }
});
