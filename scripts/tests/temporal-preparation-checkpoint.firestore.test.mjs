import test from 'node:test';
import { saveDiagnosticWakeCheckpoint,pulseDiagnosticOutbox } from '../temporal-diagnostic-wake.mjs';
import { armCloudRunDispatchDiagnostic } from '../temporal-dispatch-diagnostic.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prepareCloudRunIdentity } from '../temporal-prepare-cloud-identity.mjs';
import { saveDispatchActivationCheckpoint, saveDispatchEventarcCycleCheckpoint, saveDispatchSchedulerCycleCheckpoint, saveEventarcAuditPreparationCheckpoint, saveDispatchWakeStopCheckpoint, saveDispatchAccessPreparationCheckpoint, saveDispatchServicePreparationCheckpoint, saveIdentityPreparationCheckpoint, savePoolPreparationCheckpoint, saveSecretAccessPreparationCheckpoint, saveScalerAccessPreparationCheckpoint, saveFirestoreAccessPreparationCheckpoint, saveRuntimeRolePreparationCheckpoint, saveRuntimeAccessPreparationCheckpoint } from '../temporal-preparation-checkpoint.mjs';
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

for (const subject of [{ role: 'controls', kind: 'runner' }, { role: 'dispatch', kind: 'event' }]) test(`${subject.role}/${subject.kind} native checkpoint fences control/state drift before create and preserves completed identity receipt`, async () => {
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
      const options = { platform: platform(), ...subject, creator: operatorPrincipal.email, operationId: id, evidenceDigest: 'f'.repeat(64),
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

for (const kind of ['dispatchActivation', 'eventarcCycle', 'eventarcAudit', 'wakeStop', 'dispatchAccess', 'service', 'pool', 'secret', 'scaler', 'firestore', 'runtimeRole', 'runtimeAccess']) test(`${kind} checkpoint uses its own action and field under real native authority fences`, async () => {
  const saveResource = { dispatchActivation: saveDispatchActivationCheckpoint, eventarcCycle: saveDispatchEventarcCycleCheckpoint, eventarcAudit: saveEventarcAuditPreparationCheckpoint, wakeStop: saveDispatchWakeStopCheckpoint, dispatchAccess: saveDispatchAccessPreparationCheckpoint, service: saveDispatchServicePreparationCheckpoint, pool: savePoolPreparationCheckpoint, secret: saveSecretAccessPreparationCheckpoint, scaler: saveScalerAccessPreparationCheckpoint, firestore: saveFirestoreAccessPreparationCheckpoint, runtimeRole: saveRuntimeRolePreparationCheckpoint, runtimeAccess: saveRuntimeAccessPreparationCheckpoint }[kind];
  const field = { dispatchActivation: 'cloudDispatchActivation', eventarcCycle: 'cloudDispatchEventarcCycle', eventarcAudit: 'cloudEventarcAuditPreparation', wakeStop: 'cloudDispatchWakeStop', dispatchAccess: 'cloudDispatchAccessPreparation', service: 'cloudDispatchServicePreparation', pool: 'cloudPoolPreparation', secret: 'cloudSecretAccessPreparation', scaler: 'cloudScalerAccessPreparation', firestore: 'cloudFirestoreAccessPreparation', runtimeRole: 'cloudRuntimeRolePreparation', runtimeAccess: 'cloudRuntimeAccessPreparation' }[kind];
  const action = { dispatchActivation: 'activate-cloud-run-dispatch-service', eventarcCycle: 'prepare-stop-cloud-run-dispatch-eventarc', eventarcAudit: 'prepare-cloud-run-eventarc-audit', wakeStop: 'stop-cloud-run-dispatch-wake', dispatchAccess: 'prepare-cloud-run-dispatch-access', service: 'prepare-cloud-run-dispatch-service', pool: 'prepare-cloud-run-pool', secret: 'prepare-cloud-run-secret-access', scaler: 'prepare-cloud-run-scaler-access', firestore: 'prepare-cloud-run-firestore-access', runtimeRole: 'prepare-cloud-run-runtime-role', runtimeAccess: 'prepare-cloud-run-runtime-access' }[kind];
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
    if (kind === 'dispatchActivation') {
      const withIntent = { ...options.identityState, workerIntent: { nonce: 'original' } };
      options.ownedOperation = await saveResource({ ...options, identityState: withIntent });
      await assert.rejects(saveResource({ ...options, identityState: options.identityState }));
      const attempted = { ...withIntent, stage: 'attempted', proof: { runId: 'original-run' },
        request: { etag: 'original-etag' }, attemptedAt: 'original-time', prerequisites: { runner: 'original' } };
      options.ownedOperation = await saveResource({ ...options, identityState: attempted });
      await assert.rejects(saveResource({ ...options, identityState: { ...attempted, proof: null } }));
      await assert.rejects(saveResource({ ...options, identityState: { ...attempted, request: { etag: 'foreign' } } }));
      assert.equal((await lockRef.get()).get(`${field}.proof.runId`), 'original-run');
      // Restore no authority: only the original checkpoint continues below.
      options.identityState = attempted;
    }
    await controlRef.update({ admission: 'open' });
    await assert.rejects(saveResource({ ...options, identityState: { ...options.identityState, stage: 'attempted' } }));
    assert.equal((await lockRef.get()).get(`${field}.stage`), kind === 'dispatchActivation' ? 'attempted' : 'planned');
  } finally {
    for (const ref of [lockRef, controlRef, stateRef, immutableReceipt]) await ref.delete();
    await deleteApp(app);
  }
});


for (const [cycle, saver, field] of [['scheduler', saveDispatchSchedulerCycleCheckpoint, 'cloudDispatchSchedulerCycle'], ['eventarc', saveDispatchEventarcCycleCheckpoint, 'cloudDispatchEventarcCycle']]) test(`${cycle} cycle atomically stores original creation receipt before nested stop and rejects authority/receipt drift`, async () => {
 const app=initializeApp({projectId:'demo-preparation-checkpoint'},randomUUID()),db=getFirestore(app);
 const prefix=`_identityPreparationTests/${randomUUID()}/records`,lockRef=db.doc(`${prefix}/operation`),controlRef=db.doc(`${prefix}/control`),stateRef=db.doc(`${prefix}/state`),immutableReceipt=db.doc(`${prefix}/cycle`),creationReceipt=db.doc(`${prefix}/creation`);
 const operationId=randomUUID(),releaseId=randomUUID(),bindingDigest='d'.repeat(64),config={releaseId,domains:['publishing']};
 try {
  await lockRef.create({operationId,releaseId,bindingDigest,action:`prepare-stop-cloud-run-dispatch-${cycle}`});
  await controlRef.create({releaseId,admission:'paused',domains:{publishing:{admission:'paused'}}});await stateRef.create({releaseId,phase:'provider-usage-ready'});
  const options={firestore:db,lockRef,controlRef,stateRef,immutableReceipt,creationReceipt,operationId,config,bindingDigest,operatorPrincipal:{email:'operator@example.test'},ownedOperation:nativeSnapshotProof(await lockRef.get()),expectedAuthority:{control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())}};
  const plan={creation:{operationId,source:'controlled fixture'}};
  const creationState={stage:'completed',plan:plan.creation,resource:{name:'controlled-original'}};
  options.ownedOperation=await saver({...options,identityState:{stage:'planned',plan}});
  assert.equal((await creationReceipt.get()).exists,false);
  await assert.rejects(saveDispatchWakeStopCheckpoint({...options,identityState:{stage:'attempted',plan}}));
  await assert.rejects(saver({...options,identityState:{stage:'created',plan}}));
  options.ownedOperation=await saver({...options,identityState:{stage:'created',plan,creationState}});
  const original=await creationReceipt.get();assert.deepEqual(original.get('identityState'),creationState);assert.equal((await immutableReceipt.get()).exists,false);
  options.ownedOperation=await saver({...options,identityState:{stage:'stopping',plan,creationState,stopState:{stage:'attempted'}}});
  await assert.rejects(saver({...options,identityState:{stage:'stopping',plan,creationState:{...creationState,resource:{name:'replacement'}}}}));
  assert.equal((await creationReceipt.get()).updateTime.isEqual(original.updateTime),true);
  await controlRef.update({changed:true});
  await assert.rejects(saver({...options,identityState:{stage:'completed',plan,creationState}}));
  assert.equal((await lockRef.get()).get(`${field}.stage`),'stopping');assert.equal((await immutableReceipt.get()).exists,false);
 } finally {for(const ref of [lockRef,controlRef,stateRef,immutableReceipt,creationReceipt])await ref.delete();await deleteApp(app);}
});


test('diagnostic atomic producer preserves distinct original activation binding and original authorization on resume',async()=>{
 const app=initializeApp({projectId:'demo-preparation-checkpoint'},randomUUID()),db=getFirestore(app);
 const id=randomUUID(),releaseId=randomUUID(),prefix=`_diagnosticTests/${id}/records`;
 const lockRef=db.doc(`${prefix}/operation`),controlRef=db.doc(`${prefix}/control`),stateRef=db.doc(`${prefix}/state`);
 const bindingDigest='a'.repeat(64),activationBinding='f'.repeat(64);
 const config={environment:'staging',releaseId};
 const nativeActivation={stage:'completed',plan:{operationId:randomUUID(),buildId,desired:{template:{containers:[{image}]}}},
  service:{admission:'enabled',revision:'projects/urm-app-staging/locations/us-central1/services/dispatch/revisions/dispatch-r1'},
  prerequisites:{eventUniqueId:'123456789012345678901',schedulerUniqueId:'123456789012345678902'}};
 const activationReceipt={operationId:nativeActivation.plan.operationId,releaseId,bindingDigest:activationBinding,identityState:nativeActivation};
 try{
  await lockRef.create({operationId:id,releaseId,bindingDigest,action:'prepare-cloud-run-dispatch-diagnostic'});
  await controlRef.create({releaseId,admission:'paused',domains:Object.fromEntries(['media','publishing','images','emails','accounts','bundles','search'].map(d=>[d,{admission:'paused'}]))});
  await stateRef.create({releaseId,phase:'provider-usage-ready'});
  const options={firestore:db,lockRef,controlRef,stateRef,ownedOperation:nativeSnapshotProof(await lockRef.get()),
   expectedAuthority:{control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())},
   operationId:id,bindingDigest,config,platform:platform(),activationReceipt,nativeActivation};
  options.ownedOperation=await armCloudRunDispatchDiagnostic(options);
  const original=(await lockRef.get()).get('cloudDispatchDiagnostic');
  assert.equal(original.bindingDigest,bindingDigest);
  const record=db.doc(`durableJobOutbox/diagnostic-${id}-outbox`),before=await record.get();
  assert.equal(before.get('state'),'diagnostic');
  options.ownedOperation=await armCloudRunDispatchDiagnostic(options);
  assert.equal((await record.get()).updateTime.isEqual(before.updateTime),true);
  assert.deepEqual((await lockRef.get()).get('cloudDispatchDiagnostic'),original);
  await controlRef.update({admission:'open'});
  await assert.rejects(armCloudRunDispatchDiagnostic(options));
  assert.equal((await record.get()).updateTime.isEqual(before.updateTime),true);
 }finally{
  for(const ref of [lockRef,controlRef,stateRef,db.doc(`_control/temporalDispatchDiagnosticAuthorization-${id}`),db.doc(`_control/temporalDispatchDiagnostic-${id}`),db.doc(`durableJobOutbox/diagnostic-${id}-outbox`),db.doc(`durableJobCommands/diagnostic-${id}-commands`)])await ref.delete();
  await deleteApp(app);
 }
});


test('native diagnostic wake checkpoint/pulse preserve original creation and unknown pulse ACK emits no second write',async()=>{
 const app=initializeApp({projectId:`demo-diagnostic-pulse-${randomUUID().slice(0,8)}`},randomUUID()),db=getFirestore(app);
 const operationId=randomUUID(),releaseId=randomUUID(),bindingDigest='a'.repeat(64);
 const lockRef=db.doc('_control/temporalReleaseOperation'),controlRef=db.doc('_control/temporalRelease'),stateRef=db.doc('_control/temporalReleaseState');
 const activationReceipt={identityState:{stage:'completed'}},version=s=>`${s.updateTime.seconds}:${s.updateTime.nanoseconds}`;
 const refs=[lockRef,controlRef,stateRef,db.doc(`_control/temporalDispatchDiagnosticAuthorization-${operationId}`),db.doc(`_control/temporalDispatchDiagnostic-${operationId}`),
  db.doc(`durableJobOutbox/diagnostic-${operationId}-outbox`),db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-outbox`)];
 try{
  await controlRef.create({releaseId,admission:'paused',domains:Object.fromEntries(['media','publishing','images','emails','accounts','bundles','search'].map(d=>[d,{admission:'paused'}]))});
  await stateRef.create({releaseId,phase:'provider-usage-ready'});
  const {proofDigest}=await import('../temporal-release-runtime.mjs');
  const m={operationId,releaseId,bindingDigest,nonce:'b'.repeat(32),expiresAt:Date.now()+300000,controlVersion:version(await controlRef.get()),stateVersion:version(await stateRef.get()),activationDigest:proofDigest(activationReceipt)};
  await lockRef.create({action:'prepare-cloud-run-dispatch-diagnostic',operationId,releaseId,bindingDigest,cloudDispatchDiagnostic:m});
  await refs[3].create(m);await refs[4].create({manifestDigest:proofDigest(m)});await refs[5].create({state:'diagnostic',manifestDigest:proofDigest(m)});
  const diagnostic={firestore:db,manifest:m,activationReceipt},creation={stage:'completed',plan:{operationId,surface:'outbox-trigger'},resource:{uid:'native-fixture-trigger'}};
  const child={stage:'created',plan:{creation:creation.plan,diagnosticManifestSHA256:proofDigest(m)},creationState:creation};
  const options={firestore:db,lockRef,controlRef,stateRef,ownedOperation:nativeSnapshotProof(await lockRef.get()),expectedAuthority:{control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())},diagnostic,operatorPrincipal:{email:'operator@example.test'}};
  options.ownedOperation=await saveDiagnosticWakeCheckpoint(options,child);
  const receipt=await refs[6].get();assert.equal(receipt.get('identityState.resource.uid'),'native-fixture-trigger');
  await assert.rejects(saveDiagnosticWakeCheckpoint(options,{...child,creationState:{...creation,resource:{uid:'foreign'}}}));
  let calls=0;const lostDb=new Proxy(db,{get(target,key){if(key==='runTransaction')return async fn=>{const r=await target.runTransaction(fn);if(++calls===2)throw new Error('controlled pulse commit ACK loss');return r;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  await assert.rejects(pulseDiagnosticOutbox({...diagnostic,firestore:lostDb}));
  const first=await refs[5].get();assert.ok(first.get('diagnosticPulse'));
  await pulseDiagnosticOutbox(diagnostic);assert.equal((await refs[5].get()).updateTime.isEqual(first.updateTime),true);
  await controlRef.update({admission:'open'});await assert.rejects(pulseDiagnosticOutbox(diagnostic));assert.equal((await refs[5].get()).updateTime.isEqual(first.updateTime),true);
 }finally{for(const ref of refs)await ref.delete();await db.terminate();await deleteApp(app);}
});
