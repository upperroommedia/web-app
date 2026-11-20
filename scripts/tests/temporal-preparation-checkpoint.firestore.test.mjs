import test from 'node:test';
import { saveDiagnosticWakeCheckpoint,pulseDiagnosticOutbox,pulseDiagnosticWake } from '../temporal-diagnostic-wake.mjs';
import { armCloudRunDispatchDiagnostic } from '../temporal-dispatch-diagnostic.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prepareCloudRunIdentity } from '../temporal-prepare-cloud-identity.mjs';
import { mediaPoolPreSendAbortReason, mediaPoolSendFenceVersion } from '../temporal-prepare-cloud-pool.mjs';
import { saveDispatchActivationCheckpoint, saveDispatchEventarcCycleCheckpoint, saveDispatchSchedulerCycleCheckpoint, saveEventarcAuditPreparationCheckpoint, saveDispatchWakeStopCheckpoint, saveDispatchAccessPreparationCheckpoint, saveDispatchServicePreparationCheckpoint, saveIdentityPreparationCheckpoint, savePoolPreparationCheckpoint, saveSecretAccessPreparationCheckpoint, saveScalerAccessPreparationCheckpoint, saveFirestoreAccessPreparationCheckpoint, saveRuntimeRolePreparationCheckpoint, saveRuntimeAccessPreparationCheckpoint } from '../temporal-preparation-checkpoint.mjs';
import { assertNativeSnapshot,nativeSnapshotProof } from '../temporal-release-runtime.mjs';
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


test('media pool journals a pre-send abort only for the new attempt fence and never writes a success receipt', async () => {
  const app = initializeApp({ projectId: 'demo-preparation-checkpoint' }, randomUUID());
  const db = getFirestore(app);
  try {
    for (const withSendFence of [false, true]) {
      const operationId = randomUUID(), releaseId = randomUUID(), bindingDigest = 'b'.repeat(64);
      const prefix = `_identityPreparationTests/${operationId}/records`;
      const lockRef = db.doc(`${prefix}/operation`), controlRef = db.doc(`${prefix}/control`), stateRef = db.doc(`${prefix}/state`);
      const immutableReceipt = db.doc(`_control/temporalCloudPoolPreparation-${operationId}`);
      const poolAbortReceipt = db.doc(`_control/temporalCloudPoolPreSendAbort-${operationId}`);
      try {
        await lockRef.create({ operationId, releaseId, bindingDigest, action: 'prepare-cloud-run-pool' });
        await controlRef.create({ releaseId, admission: 'paused', domains: { media: { admission: 'paused' } } });
        await stateRef.create({ releaseId, phase: 'provider-usage-ready' });
        const options = { firestore: db, lockRef, controlRef, stateRef, immutableReceipt, poolAbortReceipt,
          operationId, bindingDigest, config: { releaseId, domains: ['media'], environment: 'staging', projectId: 'urm-app-staging' },
          operatorPrincipal: { email: 'operator@example.test' },
          ownedOperation: nativeSnapshotProof(await lockRef.get()),
          expectedAuthority: { control: nativeSnapshotProof(await controlRef.get()), state: nativeSnapshotProof(await stateRef.get()) } };
        const plan = { role: 'media', source: 'controlled' };
        options.ownedOperation = await savePoolPreparationCheckpoint({ ...options, identityState: { plan, stage: 'planned' } });
        const attempt = { plan, stage: 'attempted', attemptedAt: new Date().toISOString(),
          prerequisites: { signature: 'original quota observation' }, isolation: { inventory: 'original' },
          ...(withSendFence ? { sendFenceVersion: mediaPoolSendFenceVersion } : {}) };
        options.ownedOperation = await savePoolPreparationCheckpoint({ ...options, identityState: attempt });
        const aborted = { ...attempt, stage: 'not-sent', noSendReason: mediaPoolPreSendAbortReason };
        await assert.rejects(savePoolPreparationCheckpoint({ ...options, identityState: { ...aborted, isolation: {} } }));
        if (withSendFence) {
          await immutableReceipt.create({ controlledConflictingReceipt: true });
          await assert.rejects(savePoolPreparationCheckpoint({ ...options, identityState: aborted }));
          assert.equal((await poolAbortReceipt.get()).exists, false);
          await immutableReceipt.delete();
          const originalAttemptProof = options.ownedOperation;
          options.ownedOperation = await savePoolPreparationCheckpoint({ ...options, identityState: aborted });
          const audit = await poolAbortReceipt.get();
          assert.deepEqual(audit.get('identityState'), aborted);
          assert.deepEqual(audit.get('originalAuthority.attempt'), originalAttemptProof);
          assert.ok(audit.createTime.isEqual(audit.updateTime));
          assert.deepEqual((await lockRef.get()).get('cloudPoolPreparation'), aborted);
          await assert.rejects(savePoolPreparationCheckpoint({ ...options, identityState: attempt }));
        } else {
          await assert.rejects(savePoolPreparationCheckpoint({ ...options, identityState: aborted }));
          assert.equal((await poolAbortReceipt.get()).exists, false);
          assert.deepEqual((await lockRef.get()).get('cloudPoolPreparation'), attempt);
          const acknowledged = { ...attempt, stage: 'acknowledged', nativeOperation: 'controlled-lro' };
          options.ownedOperation = await savePoolPreparationCheckpoint({ ...options, identityState: acknowledged });
          await poolAbortReceipt.create({ controlledConflictingReceipt: true });
          await assert.rejects(savePoolPreparationCheckpoint({ ...options, identityState: { ...acknowledged, stage: 'completed' } }));
          assert.deepEqual((await lockRef.get()).get('cloudPoolPreparation'), acknowledged);
        }
        assert.equal((await immutableReceipt.get()).exists, false);
      } finally {
        await Promise.all([lockRef, controlRef, stateRef, immutableReceipt, poolAbortReceipt].map((ref) => ref.delete()));
      }
    }
  } finally {
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
  const commandsRef=db.doc(`durableJobCommands/diagnostic-${operationId}-commands`), commandsReceiptRef=db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-commands`);
  refs.push(commandsRef,commandsReceiptRef);
  await commandsRef.create({state:'diagnostic',manifestDigest:proofDigest(m)});
  const commandsCreation={...creation,plan:{operationId,surface:'commands-trigger'},resource:{uid:'commands-owned'}};
  const commandsChild={...child,plan:{...child.plan,creation:commandsCreation.plan},creationState:commandsCreation};
  await assert.rejects(saveDiagnosticWakeCheckpoint(options,commandsChild)); // outbox is not stopped yet
  options.ownedOperation=await saveDiagnosticWakeCheckpoint(options,{...child,stage:'completed',stopState:{stage:'completed'},diagnosticObservation:{scope:'controlled fixture'}});
  const originalOutbox=(await lockRef.get()).get('cloudDispatchDiagnosticWake');
  options.ownedOperation=await saveDiagnosticWakeCheckpoint(options,commandsChild);
  assert.deepEqual((await lockRef.get()).get('cloudDispatchDiagnosticWake'),originalOutbox);
  await assert.rejects(saveDiagnosticWakeCheckpoint(options,{...commandsChild,creationState:creation}));
  calls=0;
  await assert.rejects(pulseDiagnosticWake({...diagnostic,firestore:lostDb},'commands-trigger'));
  const commandsFirst=await commandsRef.get();
  assert.notEqual(commandsFirst.get('diagnosticPulse.creationReceiptDigest'),first.get('diagnosticPulse.creationReceiptDigest'));
  await pulseDiagnosticWake(diagnostic,'commands-trigger');
  assert.equal((await commandsRef.get()).updateTime.isEqual(commandsFirst.updateTime),true);
  const schedulerReceiptRef=db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-scheduler`);refs.push(schedulerReceiptRef);
  const schedulerCreation={...creation,plan:{operationId,surface:'scheduler',body:{name:'controlled-owned-job'}},resource:{name:'controlled-owned-job',userUpdateTime:new Date().toISOString()}};
  const schedulerChild={...child,plan:{...child.plan,creation:schedulerCreation.plan},creationState:schedulerCreation};
  await assert.rejects(saveDiagnosticWakeCheckpoint(options,schedulerChild));
  options.ownedOperation=await saveDiagnosticWakeCheckpoint(options,{...commandsChild,stage:'completed',stopState:{stage:'completed'},diagnosticObservation:{recovery:'retry'}});
  options.ownedOperation=await saveDiagnosticWakeCheckpoint(options,schedulerChild);
  assert.equal((await schedulerReceiptRef.get()).get('identityState.resource.name'),'controlled-owned-job');
  await assert.rejects(pulseDiagnosticWake(diagnostic,'scheduler'));
  await assert.rejects(saveDiagnosticWakeCheckpoint(options,{...schedulerChild,creationState:{...schedulerCreation,resource:{name:'foreign'}}}));
  await controlRef.update({admission:'open'});await assert.rejects(pulseDiagnosticOutbox(diagnostic));assert.equal((await refs[5].get()).updateTime.isEqual(first.updateTime),true);
 }finally{for(const ref of refs)await ref.delete();await db.terminate();await deleteApp(app);}
});

test('controls bootstrap uses native authority checkpoints, immutable activation before observation and same-parent stop',async()=>{
 const {savePoolBootstrapCycleCheckpoint}=await import('../temporal-preparation-checkpoint.mjs');
 const {bootstrapStopCloudRunControlsPool}=await import('../temporal-bootstrap-pool.mjs');
 const {controlsBootstrapFixture}=await import('./fixtures/controls-bootstrap.mjs');
 const app=initializeApp({projectId:'demo-preparation-checkpoint'},randomUUID()),db=getFirestore(app);
 try{
  for(const drift of ['control','state','none']){
   const f=controlsBootstrapFixture(),{operationId,releaseId}=f.options,prefix=`_identityPreparationTests/${randomUUID()}/records`;
   const lockRef=db.doc(`${prefix}/operation`),controlRef=db.doc(`${prefix}/control`),stateRef=db.doc(`${prefix}/state`),immutableReceipt=db.doc(`${prefix}/receipt`),creationReceipt=db.doc(`${prefix}/activation`);
   const config={releaseId,domains:['publishing']},bindingDigest='e'.repeat(64),operatorPrincipal={email:'operator@example.test'};
   await lockRef.create({operationId,releaseId,bindingDigest,action:'bootstrap-stop-cloud-run-controls'});
   await controlRef.create({releaseId,admission:'paused',domains:{publishing:{admission:'paused'}}});await stateRef.create({releaseId,phase:'provider-usage-ready'});
   let ownedOperation=nativeSnapshotProof(await lockRef.get());
   const expectedAuthority={control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())},save=f.options.save;
   const options={firestore:db,lockRef,controlRef,stateRef,immutableReceipt,creationReceipt,config,operationId,bindingDigest,operatorPrincipal,expectedAuthority};
   f.options.save=async identityState=>{
    if(drift!=='none'&&identityState.start?.stage==='attempted')await (drift==='control'?controlRef:stateRef).update({changed:true});
    ownedOperation=await savePoolBootstrapCycleCheckpoint({...options,ownedOperation,identityState});await save(identityState);
    if(drift==='none'&&identityState.start?.stage==='attempted')
      await assert.rejects(savePoolBootstrapCycleCheckpoint({...options,ownedOperation,identityState:{...identityState,start:{...identityState.start,stage:'planned'}}}));
   };
   f.options.observeRegistration=async()=>{
    assert.equal((await creationReceipt.get()).get('identityState.stage'),'completed');
    const original=f.saved;
    await assert.rejects(savePoolBootstrapCycleCheckpoint({...options,ownedOperation,identityState:{...original,activationState:null}}));
    await assert.rejects(savePoolBootstrapCycleCheckpoint({...options,ownedOperation,identityState:{...original,start:{...original.start,request:{changed:true}}}}));
    return {role:'controls',buildId:f.options.platform.workerBuildId,observedAt:new Date().toISOString(),registrationSHA256:'f'.repeat(64)};
   };
   if(drift==='none'){
    const result=await bootstrapStopCloudRunControlsPool(f.options);
    assert.equal(result.stop.pool.desiredManualInstanceCount,0);assert.equal((await immutableReceipt.get()).get('identityState.stage'),'completed');
    assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
   }else{await assert.rejects(bootstrapStopCloudRunControlsPool(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);assert.equal((await creationReceipt.get()).exists,false);}
   for(const ref of [lockRef,controlRef,stateRef,immutableReceipt,creationReceipt])await ref.delete();
  }
 }finally{await deleteApp(app);}
});

for(const role of ['controls','orchestration','search','email','images','media'])for(const mode of ['cycle','retain','abort'])test(`${role} ${mode} native checkpoints retain exact origin, deny rollback/drift and distinguish immutable outcomes`,async()=>{
 const {savePoolBootstrapCycleCheckpoint,saveControlsActivationCheckpoint,saveControlsActivationStopCheckpoint,saveOrchestrationBootstrapCycleCheckpoint,saveOrchestrationActivationCheckpoint,saveOrchestrationActivationStopCheckpoint,saveSearchBootstrapCycleCheckpoint,saveSearchActivationCheckpoint,saveSearchActivationStopCheckpoint,saveEmailBootstrapCycleCheckpoint,saveEmailActivationCheckpoint,saveEmailActivationStopCheckpoint,saveImagesBootstrapCycleCheckpoint,saveImagesActivationCheckpoint,saveImagesActivationStopCheckpoint,saveMediaBootstrapCycleCheckpoint,saveMediaActivationCheckpoint,saveMediaActivationStopCheckpoint}=await import('../temporal-preparation-checkpoint.mjs');
 const {bootstrapStopCloudRunControlsPool,activateCloudRunControlsPool,stopCloudRunControlsActivation,bootstrapStopCloudRunOrchestrationPool,activateCloudRunOrchestrationPool,stopCloudRunOrchestrationActivation,bootstrapStopCloudRunSearchPool,activateCloudRunSearchPool,stopCloudRunSearchActivation,bootstrapStopCloudRunEmailPool,activateCloudRunEmailPool,stopCloudRunEmailActivation,bootstrapStopCloudRunImagesPool,activateCloudRunImagesPool,stopCloudRunImagesActivation,bootstrapStopCloudRunMediaPool,activateCloudRunMediaPool,stopCloudRunMediaActivation}=await import('../temporal-bootstrap-pool.mjs');
 const {controlsBootstrapFixture}=await import('./fixtures/controls-bootstrap.mjs');
 const app=initializeApp({projectId:'demo-preparation-checkpoint'},randomUUID()),db=getFirestore(app);
 try{
  for(const drift of ['control','state','credential-control','credential-state','none']){
   const runs=role==='media'?{cycle:bootstrapStopCloudRunMediaPool,retain:activateCloudRunMediaPool,abort:stopCloudRunMediaActivation}:role==='images'?{cycle:bootstrapStopCloudRunImagesPool,retain:activateCloudRunImagesPool,abort:stopCloudRunImagesActivation}:role==='email'?{cycle:bootstrapStopCloudRunEmailPool,retain:activateCloudRunEmailPool,abort:stopCloudRunEmailActivation}:role==='search'?{cycle:bootstrapStopCloudRunSearchPool,retain:activateCloudRunSearchPool,abort:stopCloudRunSearchActivation}:role==='controls'?{cycle:bootstrapStopCloudRunControlsPool,retain:activateCloudRunControlsPool,abort:stopCloudRunControlsActivation}:
     {cycle:bootstrapStopCloudRunOrchestrationPool,retain:activateCloudRunOrchestrationPool,abort:stopCloudRunOrchestrationActivation};
   const f=controlsBootstrapFixture(role);
   if(mode!=='cycle'){
    const cycle=await runs.cycle(f.options);
    f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(cycle)};
    f.options.operationId=randomUUID();
   }
   if(mode==='abort'){
    const kept=await runs.retain(f.options);
    f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};
    f.options.operationId=randomUUID();
   }
   const {operationId,releaseId}=f.options,prefix=`_identityPreparationTests/${randomUUID()}/records`,baseline=f.calls.filter(c=>c.method==='PATCH').length;
   const lockRef=db.doc(`${prefix}/operation`),controlRef=db.doc(`${prefix}/control`),stateRef=db.doc(`${prefix}/state`),immutableReceipt=db.doc(`${prefix}/receipt`),creationReceipt=db.doc(`${prefix}/activation`);
   const config={releaseId,domains:['publishing']},bindingDigest='e'.repeat(64),operatorPrincipal={email:'operator@example.test'};
   const action=mode==='cycle'?`bootstrap-stop-cloud-run-${role}`:mode==='retain'?`activate-cloud-run-${role}-pool`:`stop-cloud-run-${role}-activation`,key=mode==='abort'?'stop':'start';
   await lockRef.create({operationId,releaseId,bindingDigest,action});
   await controlRef.create({releaseId,admission:'paused',domains:{publishing:{admission:'paused'}}});await stateRef.create({releaseId,phase:'provider-usage-ready'});
   let ownedOperation=nativeSnapshotProof(await lockRef.get());
   const expectedAuthority={control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())},save=f.options.save;
   const options={firestore:db,lockRef,controlRef,stateRef,immutableReceipt,creationReceipt,config,operationId,bindingDigest,operatorPrincipal,expectedAuthority};
   const checkpoint=(role==='media'?{cycle:saveMediaBootstrapCycleCheckpoint,retain:saveMediaActivationCheckpoint,abort:saveMediaActivationStopCheckpoint}:role==='images'?{cycle:saveImagesBootstrapCycleCheckpoint,retain:saveImagesActivationCheckpoint,abort:saveImagesActivationStopCheckpoint}:role==='email'?{cycle:saveEmailBootstrapCycleCheckpoint,retain:saveEmailActivationCheckpoint,abort:saveEmailActivationStopCheckpoint}:role==='search'?{cycle:saveSearchBootstrapCycleCheckpoint,retain:saveSearchActivationCheckpoint,abort:saveSearchActivationStopCheckpoint}:role==='controls'?{cycle:savePoolBootstrapCycleCheckpoint,retain:saveControlsActivationCheckpoint,abort:saveControlsActivationStopCheckpoint}:
     {cycle:saveOrchestrationBootstrapCycleCheckpoint,retain:saveOrchestrationActivationCheckpoint,abort:saveOrchestrationActivationStopCheckpoint})[mode];
   const guard=f.options.observeProtection,api=f.options.api;
   f.options.observeProtection=async()=>{
    assertNativeSnapshot(expectedAuthority.control,await controlRef.get());assertNativeSnapshot(expectedAuthority.state,await stateRef.get());return guard();
   };
   f.options.api=async(...args)=>{
    if(args[1]==='PATCH'&&drift.startsWith('credential-'))await (drift==='credential-control'?controlRef:stateRef).update({changedDuringCredential:true});
    return api(...args);
   };

   f.options.save=async identityState=>{
    if(identityState.stage==='planned')await assert.rejects(checkpoint({...options,ownedOperation,identityState:{...identityState,plan:{...identityState.plan,role:role==='controls'?'orchestration':'controls'}}}));
    if(['control','state'].includes(drift)&&identityState[key]?.stage==='attempted')await (drift==='control'?controlRef:stateRef).update({changed:true});
    if(drift==='none'&&identityState.disposition==='retained'){
      const bad={...identityState};delete bad.retainedRegistration;
      await assert.rejects(checkpoint({...options,ownedOperation,identityState:bad}));
      assert.equal((await immutableReceipt.get()).exists,false);
    }
    ownedOperation=await checkpoint({...options,ownedOperation,identityState});await save(identityState);
    if(drift==='none'&&identityState[key]?.stage==='attempted')
      await assert.rejects(checkpoint({...options,ownedOperation,identityState:{...identityState,[key]:{...identityState[key],stage:'planned'}}}));
   };
   const observe=f.options.observeRegistration;
   if(mode!=='abort')f.options.observeRegistration=async()=>{assert.equal((await creationReceipt.get()).get('identityState.stage'),'completed');return observe();};
   const run=runs[mode];
   if(drift==='none'){
    const result=await run(f.options);assert.equal(result.disposition,mode==='retain'?'retained':'stopped');
    assert.equal((await immutableReceipt.get()).get('identityState.disposition'),result.disposition);
    assert.equal(f.calls.filter(c=>c.method==='PATCH').length,baseline+(mode==='cycle'?2:1));
    await run({...f.options,saved:f.saved});assert.equal(f.calls.filter(c=>c.method==='PATCH').length,baseline+(mode==='cycle'?2:1));
   }else{
    await assert.rejects(run(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,baseline);assert.equal((await immutableReceipt.get()).exists,false);
   }
   for(const ref of [lockRef,controlRef,stateRef,immutableReceipt,creationReceipt])await ref.delete();
  }
 }finally{await deleteApp(app);}
});

test('pool readonly native pre-send fence preserves the original operation/control/state snapshots',async()=>{
 const {assertPoolPreparationAuthority}=await import('../temporal-preparation-checkpoint.mjs');
 const app=initializeApp({projectId:'demo-pool-presend'},randomUUID()),firestore=getFirestore(app);
 try{for(const drift of ['operation','control','state']){
  const prefix=`_poolPreSendTests/${randomUUID()}/records`,lockRef=firestore.doc(`${prefix}/op`),controlRef=firestore.doc(`${prefix}/control`),stateRef=firestore.doc(`${prefix}/state`);
  const releaseId=randomUUID(),operationId=randomUUID(),bindingDigest='e'.repeat(64),config={releaseId,domains:['publishing']};
  await lockRef.create({action:'prepare-cloud-run-pool',operationId,releaseId,bindingDigest});await controlRef.create({releaseId,admission:'paused',domains:{publishing:{admission:'paused'}}});await stateRef.create({releaseId,phase:'provider-usage-ready'});
  const options={firestore,lockRef,controlRef,stateRef,config,operationId,bindingDigest,ownedOperation:nativeSnapshotProof(await lockRef.get()),expectedAuthority:{control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())}};
  await assertPoolPreparationAuthority(options);await ({operation:lockRef,control:controlRef,state:stateRef}[drift]).update({changedDuringCredential:true});await assert.rejects(assertPoolPreparationAuthority(options));
  for(const ref of [lockRef,controlRef,stateRef])await ref.delete();
 }}finally{await deleteApp(app);}
});

test('pool quota and isolation original attempt cannot be replaced or rolled back in native checkpoints',async()=>{
 const app=initializeApp({projectId:'demo-pool-immutable'},randomUUID()),firestore=getFirestore(app);
 const prefix=`_poolImmutableTests/${randomUUID()}/records`,lockRef=firestore.doc(`${prefix}/op`),controlRef=firestore.doc(`${prefix}/control`),stateRef=firestore.doc(`${prefix}/state`),immutableReceipt=firestore.doc(`${prefix}/receipt`);
 try{
 const releaseId=randomUUID(),operationId=randomUUID(),bindingDigest='e'.repeat(64),config={releaseId,domains:['publishing']};
 await lockRef.create({action:'prepare-cloud-run-pool',operationId,releaseId,bindingDigest});await controlRef.create({releaseId,admission:'paused',domains:{publishing:{admission:'paused'}}});await stateRef.create({releaseId,phase:'provider-usage-ready'});
 const options={firestore,lockRef,controlRef,stateRef,immutableReceipt,config,operationId,bindingDigest,operatorPrincipal:{email:'operator@example.test'},expectedAuthority:{control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())}};
 let ownedOperation=nativeSnapshotProof(await lockRef.get());const planned={stage:'planned',plan:{operationId,role:'media'}};
 ownedOperation=await savePoolPreparationCheckpoint({...options,ownedOperation,identityState:planned});
 const attempted={...planned,stage:'attempted',attemptedAt:new Date().toISOString(),prerequisites:{mediaDiskQuota:{quotaSHA256:'a'.repeat(64)}},isolation:{inventorySHA256:'b'.repeat(64)}};
 ownedOperation=await savePoolPreparationCheckpoint({...options,ownedOperation,identityState:attempted});
 for(const bad of [{...attempted,stage:'planned'},{...attempted,prerequisites:{mediaDiskQuota:{quotaSHA256:'c'.repeat(64)}}},{...attempted,isolation:{inventorySHA256:'d'.repeat(64)}}])await assert.rejects(savePoolPreparationCheckpoint({...options,ownedOperation,identityState:bad}));
 }finally{for(const ref of [lockRef,controlRef,stateRef,immutableReceipt])await ref.delete();await deleteApp(app);}
});

test('dispatch activation confirms a lost probe-intent commit acknowledgement by exact Firestore readback', async () => {
  const app = initializeApp({ projectId: 'demo-preparation-checkpoint' }, randomUUID());
  const db = getFirestore(app);
  try {
    for (const scenario of ['committed', 'missing', 'changed lock', 'changed authority', 'known PATCH', 'lost PATCH', 'changed PATCH']) {
      const patch = scenario.endsWith('PATCH');
      const outcome = ({ 'known PATCH': 'committed', 'lost PATCH': 'committed', 'changed PATCH': 'changed lock' })[scenario] ?? scenario;
      const operationId = randomUUID(), releaseId = randomUUID(), bindingDigest = 'e'.repeat(64);
      const prefix = `_dispatchIntentAckTests/${operationId}/records`;
      const [lockRef, controlRef, stateRef, immutableReceipt] =
        ['operation', 'control', 'state', 'receipt'].map(name => db.doc(`${prefix}/${name}`));
      const action = 'activate-cloud-run-dispatch-service';
      const nonce = randomUUID().replaceAll('-', '');
      const workerIntent = { nonce, workflowId: `serverless-readiness-${nonce}` };
      const planned = { stage: 'planned', plan: { operationId, releaseId }, ...(patch && { workerIntent }) };
      await Promise.all([
        lockRef.create({ operationId, releaseId, bindingDigest, action, cloudDispatchActivation: planned }),
        controlRef.create({ releaseId, admission: 'paused', domains: { publishing: { admission: 'paused' } } }),
        stateRef.create({ releaseId, phase: 'provider-usage-ready' }),
      ]);
      try {
        const [lock, control, state] = await db.getAll(lockRef, controlRef, stateRef);
        let writes = 0, reads = 0;
        const firestore = {
          async runTransaction(callback, options) {
            if (options?.readOnly) {
              reads++;
              return db.runTransaction(callback, options);
            }
            assert.deepEqual(options, { maxAttempts: 1 });
            writes++;
            await db.runTransaction(tx => callback(
              outcome === 'missing' ? { get: tx.get.bind(tx), update() {} } : tx
            ), options);
            if (outcome === 'changed lock') await lockRef.update({ unrelatedWrite: true });
            if (outcome === 'changed authority') await stateRef.update({ unrelatedWrite: true });
            if (!patch || scenario === 'lost PATCH') throw Object.assign(new Error('Injected acknowledgement loss'), { code: 4 });
          },
        };
        const save = () => saveDispatchActivationCheckpoint({
          firestore, lockRef, controlRef, stateRef, immutableReceipt, operationId, bindingDigest,
          config: { releaseId, domains: ['publishing'] }, operatorPrincipal: { email: 'fixture@example.test' },
          ownedOperation: nativeSnapshotProof(lock),
          expectedAuthority: { control: nativeSnapshotProof(control), state: nativeSnapshotProof(state) },
          identityState: { ...planned, workerIntent, ...(patch && { stage: 'attempted' }) },
        });
        if (scenario === 'lost PATCH') {
          await assert.rejects(save, /Injected acknowledgement loss/);
          assert.equal((await lockRef.get()).get('cloudDispatchActivation.stage'), 'attempted');
        } else if (outcome === 'committed') {
          assertNativeSnapshot(await save(), await lockRef.get());
          assert.deepEqual((await lockRef.get()).get('cloudDispatchActivation.workerIntent'), workerIntent);
        } else {
          await assert.rejects(save, /RELEASE_NATIVE_AUTHORITY_CHANGED/);
        }
        assert.equal(writes, 1);
        assert.equal(reads, scenario === 'lost PATCH' ? 0 : 1);
        assert.equal((await immutableReceipt.get()).exists, false);
      } finally {
        await Promise.all([lockRef.delete(), controlRef.delete(), stateRef.delete()]);
      }
    }
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
