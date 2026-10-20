import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudRunIdentity } from './temporal-prepare-cloud-identity.mjs';
import { prepareCloudRunSecretAccess } from './temporal-prepare-secret-access.mjs';
import { prepareCloudRunFirestoreAccess } from './temporal-prepare-firestore-access.mjs';
import { prepareCloudRunRuntimeRole } from './temporal-prepare-runtime-role.mjs';
import { prepareCloudRunScalerAccess } from './temporal-prepare-scaler-access.mjs';
import { preparationIdentityEmail, renderPreparationWorkload } from './temporal-preparation-resources.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}
for (const kind of ['runner','event','scheduler']) test(`dispatch ${kind} creation is bound to its distinct source identity only`, async () => {
 const p = platform(); let saved, account, creates = 0;
 const options = { platform: p, role: 'dispatch', kind, creator: 'operator@example.test', evidenceDigest: 'e'.repeat(64), operationId: '11111111-2222-4333-8444-555555555555',
  save: async value => { saved = structuredClone(value); }, api: async (_url, method = 'GET', body) => {
   if (method === 'GET') { if (!account) throw Object.assign(new Error('absent'), { status: 404 }); return structuredClone(account); }
   assert.equal(saved.stage,'attempted'); creates++;
   account = { projectId: 'urm-app-staging', email: `${body.accountId}@urm-app-staging.iam.gserviceaccount.com`, uniqueId: '123456789012345678901', ...body.serviceAccount }; return structuredClone(account);
  } };
 const value = await prepareCloudRunIdentity(options);
 assert.equal(value.account.email, preparationIdentityEmail(p,'dispatch',kind)); assert.equal(creates,1);
 assert.equal(new Set(['runner','event','scheduler'].map(k => preparationIdentityEmail(p,'dispatch',k))).size,3);
 await prepareCloudRunIdentity({ ...options, saved }); assert.equal(creates,1);
});
for (const [role,kind] of [['dispatch','scaler'],['controls','event'],['controls','scheduler'],['__proto__','runner'],['dispatch','constructor']])
 test(`denies identity ${role}/${kind}`, () => { assert.throws(() => preparationIdentityEmail(platform(),role,kind)); });
function accessFixture(action = 'secret', kind = 'runner') {
 const p=platform(), releaseId='11111111-2222-4333-8444-555555555555', operationId='22222222-2222-4333-8444-555555555555', evidenceDigest='c'.repeat(64);
 const runner = preparationIdentityEmail(p,'dispatch',kind);
 const identityReceipt = { releaseId, identityState: { stage: 'completed', plan: { kind, role:'dispatch',buildId,email:runner,evidenceDigest }, account:{email:runner,uniqueId:'123456789012345678901',description:'owned-dispatch'} } };
 let saved, policy={version:1,etag:'original',bindings:[]}, writes=0; const resources=[];
 const options={ platform:p,role:'dispatch',settings:{apiKeyVersion:'2',runtimeSecrets:[]},secret:'TEMPORAL_DISPATCH_API_KEY',operationId,releaseId,evidenceDigest,identityReceipt,
  save:async value=>{saved=structuredClone(value);},api:async(url,method='GET',body)=>{
   resources.push(url);
   if(url.includes(':getIamPolicy'))return structuredClone(policy);
   if(url.includes(':setIamPolicy')){assert.equal(saved.stage,'attempted');writes++;policy={...structuredClone(body.policy),etag:'new'};return structuredClone(policy);}
   if(url.includes('/serviceAccounts/'))return {projectId:'urm-app-staging',...identityReceipt.identityState.account};
   if(url.startsWith('https://secretmanager.'))return {name:'projects/urm-app-staging/secrets/TEMPORAL_DISPATCH_API_KEY/versions/2',state:'ENABLED'};
   if(url.startsWith('https://firestore.'))return {name:'projects/urm-app-staging/databases/(default)',uid:'native-default',type:'FIRESTORE_NATIVE',locationId:'us-central1'};
   if(url.startsWith('https://run.'))throw Object.assign(new Error('absent'),{status:404});
   throw new Error('Unexpected API');
  }};
 return {options,resources,run:()=>action==='secret'?prepareCloudRunSecretAccess(options):prepareCloudRunFirestoreAccess(options),get saved(){return saved;},get writes(){return writes;}};
}
for(const action of ['secret','firestore']) test(`dispatch runner ${action} grant checks SERVICE absence and preserves source workload binding`,async()=>{
 const f=accessFixture(action);await f.run();assert.equal(f.writes,1);
 assert.deepEqual(f.saved.plan.workload,{type:'service',name:platform().dispatch.service});
 assert.equal(f.resources.some(url=>url.includes('/workerPools/')),false);
 assert.equal(f.resources.filter(url=>url===`https://run.googleapis.com/v2/${platform().dispatch.service}`).length,2);
 const g=f.saved.plan.grants[0];assert.deepEqual(g.members,[`serviceAccount:${platform().dispatch.runnerServiceAccount}`]);
 if(action==='secret')assert.equal(g.role,'roles/secretmanager.secretAccessor');
 else assert.equal(g.condition.expression,'resource.name=="projects/urm-app-staging/databases/(default)"');
});
for(const action of ['secret','firestore'])for(const kind of ['event','scheduler'])test(`${kind} identity cannot receive dispatch runner ${action} permission`,async()=>{
 const f=accessFixture(action,kind);await assert.rejects(f.run());assert.equal(f.writes,0);
});
for(const bad of ['version','extra-secret','extra-key','missing-array'])test(`dispatch rejects ${bad} settings before any permission write`,async()=>{
 const f=accessFixture();
 if(bad==='version')f.options.settings.apiKeyVersion='3';
 if(bad==='extra-secret')f.options.settings.runtimeSecrets=[{name:'SUBSPLASH_PASSWORD',secret:'SUBSPLASH_PASSWORD',version:'2'}];
 if(bad==='extra-key')f.options.settings.emailEgressVersion='2';
 if(bad==='missing-array')delete f.options.settings.runtimeSecrets;
 await assert.rejects(f.run());assert.equal(f.writes,0);
});
test('dispatch cannot choose worker key or provider secret instead of its rendered key',async()=>{
 const f=accessFixture();f.options.secret='TEMPORAL_WORKER_API_KEY';await assert.rejects(f.run());assert.equal(f.writes,0);
});
for(const action of ['secret','firestore'])test(`existing dispatch service denies fresh ${action} grant`,async()=>{
 const f=accessFixture(action),api=f.options.api;
 f.options.api=async(...args)=>args[0].startsWith('https://run.')?{name:platform().dispatch.service}:api(...args);
 await assert.rejects(f.run());assert.equal(f.writes,0);
});
test('saved permission cannot switch from dispatch service to polling worker identity',async()=>{
 const f=accessFixture();await f.run();const saved=structuredClone(f.saved);saved.plan.workload={type:'worker-pool',name:'foreign'};
 await assert.rejects(prepareCloudRunSecretAccess({...f.options,saved}));assert.equal(f.writes,1);
});
test('dispatch has no custom runtime-role or scaler preparation surface',async()=>{
 const f=accessFixture();await assert.rejects(prepareCloudRunRuntimeRole({...f.options,surface:'project'}));
 await assert.rejects(prepareCloudRunScalerAccess({...f.options,surface:'scaler-trust'}));assert.equal(f.writes,0);
});
test('dispatch renderer keeps credentials to one numeric dedicated key and retains min0/private service',()=>{
 const w=renderPreparationWorkload(platform(),'dispatch',{apiKeyVersion:'2',runtimeSecrets:[]});
 assert.equal(w.type,'service');assert.equal(w.body.invokerIamDisabled,false);assert.equal(w.body.scaling.minInstanceCount,0);
 assert.deepEqual(w.body.template.volumes[0].secret.items,[{version:'2',path:'api-key'}]);
});
