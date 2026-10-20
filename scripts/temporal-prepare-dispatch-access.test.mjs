import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { prepareCloudRunDispatchAccess } from './temporal-prepare-dispatch-access.mjs';
const buildId = 'a'.repeat(40),
  image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function profile() {
  const workerRoles = ['orchestration', 'controls', 'email', 'search'];
  return {
    schemaVersion: 1,
    environment: 'staging',
    workerHosting: 'cloud-run',
    connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging',
    firebaseResources: {
      storageBucket: 'urm-app-staging.firebasestorage.app',
      imagesBucket: 'urm-app-staging-images',
      databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
    },
    temporalNamespace: 'urm-app-staging.qwejt',
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
    cloudAddress: 'us-central1.gcp.api.temporal.io:7233',
    cloudReplicaRegions: [],
    cloudEvidence: '/private/tmp/cloud-evidence.json',
    workerBuildId: buildId,
    workerImage: image,
    workerRoles,
    dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-api-key',
    operatorApiKeySHA256: 'c'.repeat(64),
    dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '7' },
    roleBindings: workerRoles.map((role) => ({
      projectId: 'urm-app-staging',
      region: 'us-central1',
      namespace: 'urm-app-staging.qwejt',
      buildId,
      role,
      ...serverlessResourceNames(buildId, role),
      image,
      maxInstances: 1,
      stabilizationSeconds: 180,
    })),
  };
}

function fixture() {
 const p=profile(), runner=p.dispatch.runnerServiceAccount;
 const operationId='11111111-2222-4333-8444-555555555555',releaseId='22222222-2222-4333-8444-555555555555',evidenceDigest='e'.repeat(64);
 const op='projects/urm-app-staging/locations/us-central1/operations/create-service';
 let saved,service,revision,posts=0; const calls=[];
 const options={platform:p,role:'dispatch',settings:{apiKeyVersion:'7',runtimeSecrets:[]},operationId,releaseId,evidenceDigest,
 identityReceipt:{releaseId,identityState:{stage:'completed',plan:{kind:'runner',role:'dispatch',buildId,email:runner,evidenceDigest},account:{email:runner,uniqueId:'12345678901234567890',description:'owned'}}},
 save:async value=>{saved=structuredClone(value);},api:async(url,method='GET',body)=>{
 calls.push([url,method]);
 if(url.startsWith('https://cloudresourcemanager.')) { assert.equal(method,'POST'); assert.deepEqual(body,{options:{requestedPolicyVersion:3}}); return { version: 3, etag: 'native-project', bindings: ['eventarc','cloudscheduler','pubsub'].map(s => ({ role: `roles/${s}.serviceAgent`, members: [`serviceAccount:service-251680231116@gcp-sa-${s}.iam.gserviceaccount.com`] })) }; }
 if(url.includes('iam.googleapis.com/'))return {projectId:'urm-app-staging',email:runner,uniqueId:'12345678901234567890',description:'owned'};
 if(url.includes('secretmanager')&&url.includes(':getIamPolicy'))return{etag:'secret',bindings:[{role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:${runner}`]}]};
 if(url.includes('secretmanager'))return{name:'projects/urm-app-staging/secrets/TEMPORAL_DISPATCH_API_KEY/versions/7',state:'ENABLED'};
 if(url.includes(':getIamPolicy'))return{etag:'empty',bindings:[]};
 if(method==='POST'){
 assert.equal(saved.stage,'attempted');posts++;
 service={...structuredClone(body),uid:'service-uid',etag:'service-etag',generation:'1',observedGeneration:'1',terminalCondition:{state:'CONDITION_SUCCEEDED'},
 latestCreatedRevision:`${body.name}/revisions/${p.dispatch.serviceId}-00001-abc`,latestReadyRevision:`${body.name}/revisions/${p.dispatch.serviceId}-00001-abc`,
 uri:`https://${p.dispatch.serviceId}-251680231116.us-central1.run.app`};
 service.trafficStatuses=[{revision:service.latestReadyRevision,percent:100}];
 revision={...structuredClone(service.template),name:service.latestReadyRevision,uid:'revision-uid',etag:'rev-etag',generation:'1',observedGeneration:'1',conditions:[{type:'Ready',state:'CONDITION_SUCCEEDED'}]};
 return{name:op};
 }
 if(url.endsWith(op))return{name:op,done:true,response:structuredClone(service)};
 if(revision&&url.endsWith(revision.name))return structuredClone(revision);
 if(service&&url.endsWith(service.name))return structuredClone(service);
 throw Object.assign(new Error('absent'),{status:404});
 }};
 return{options,calls,get saved(){return saved;},get service(){return service;},get revision(){return revision;},get posts(){return posts;}};
}

async function accessFixture(surface='service-invokers') {
 const f=fixture(),service=await prepareCloudRunDispatchService(f.options),p=f.options.platform;
 const receipt=(kind,uniqueId)=>({releaseId:f.options.releaseId,identityState:{stage:'completed',plan:{kind,role:'dispatch',buildId,email:p.dispatch[kind==='event'?'eventServiceAccount':'schedulerServiceAccount'],evidenceDigest:f.options.evidenceDigest},account:{email:p.dispatch[kind==='event'?'eventServiceAccount':'schedulerServiceAccount'],uniqueId,description:'owned-caller'}}});
 const eventReceipt=receipt('event','12345678901234567891'),schedulerReceipt=receipt('scheduler','12345678901234567892');
 let saved,posts=0,policy={version:3,etag:'original',auditConfigs:[{service:'allServices',auditLogConfigs:[{logType:'ADMIN_READ'}]}],bindings:[]};
 const calls=[];
 const options={...f.options,operationId:'33333333-2222-4333-8444-555555555555',surface,
 runnerReceipt:f.options.identityReceipt,eventReceipt,schedulerReceipt,
 serviceReceipt:{releaseId:f.options.releaseId,operationId:service.plan.operationId,identityState:service},
 save:async value=>{saved=structuredClone(value);},api:async(url,method='GET',body)=>{
 calls.push([url,method]);
 for(const r of [eventReceipt,schedulerReceipt])if(url===`https://iam.googleapis.com/v1/projects/urm-app-staging/serviceAccounts/${r.identityState.account.email}`)
 return{projectId:'urm-app-staging',...r.identityState.account};
 if(url.includes(':getIamPolicy')&&!url.includes('secretmanager'))return structuredClone(policy);
 if(url.includes(':setIamPolicy')){assert.equal(saved.stage,'attempted');posts++;assert.equal(body.policy.etag,'original');policy={...structuredClone(body.policy),etag:'new'};return structuredClone(policy);}
 return f.options.api(url,method,body);
 }};
 return{options,f,calls,get saved(){return saved;},get posts(){return posts;},get policy(){return policy;}};
}
for(const surface of ['event-receiver','service-invokers'])test(`fixed ${surface} grant remains bound to disabled service and original three identities`,async()=>{
 const f=await accessFixture(surface),value=await prepareCloudRunDispatchAccess(f.options);
 assert.equal(f.posts,1);assert.equal(value.stage,'completed');
 const grant=value.plan.grants[0];assert.equal(grant.role,surface==='event-receiver'?'roles/eventarc.eventReceiver':'roles/run.invoker');
 assert.deepEqual(grant.members,surface==='event-receiver'?[`serviceAccount:${f.options.platform.dispatch.eventServiceAccount}`]:[f.options.platform.dispatch.eventServiceAccount,f.options.platform.dispatch.schedulerServiceAccount].map(email=>`serviceAccount:${email}`));
 assert.equal(value.plan.resource,surface==='event-receiver'?'projects/urm-app-staging':f.options.platform.dispatch.service);
 assert.equal(f.policy.auditConfigs[0].service,'allServices');
 await prepareCloudRunDispatchAccess({...f.options,saved:f.saved});assert.equal(f.posts,1);
 assert.equal(f.calls.some(([url,method])=>/compute-config|:access|impersonate|eventarc.googleapis|cloudscheduler.googleapis/.test(url)||method==='PATCH'),false);
});
for(const bad of ['runner-kind','event-kind','scheduler-kind','same-native-uid','foreign-service','service-generation','enabled','surface','source-body'])test(`caller preparation denies ${bad} before policy write`,async()=>{
 const f=await accessFixture();
 if(bad==='runner-kind')f.options.runnerReceipt.identityState.plan.kind='event';
 if(bad==='event-kind')f.options.eventReceipt.identityState.plan.kind='runner';
 if(bad==='scheduler-kind')f.options.schedulerReceipt.identityState.plan.kind='event';
 if(bad==='same-native-uid')f.options.schedulerReceipt.identityState.account.uniqueId=f.options.eventReceipt.identityState.account.uniqueId;
 if(bad==='foreign-service')f.options.serviceReceipt.identityState.service.uid='replacement';
 if(bad==='service-generation')f.options.serviceReceipt.identityState.service.generation='99';
 if(bad==='source-body')f.options.serviceReceipt.identityState.plan.body.template.containers[0].image='foreign';
 if(bad==='enabled'){
 f.f.service.template.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';
 f.f.revision.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';}
 if(bad==='surface')f.options.surface='service-agent';
 await assert.rejects(prepareCloudRunDispatchAccess(f.options));assert.equal(f.posts,0);
});
for(const surface of ['event-receiver','service-invokers'])test(`${surface} lost policy ACK reconciles GET-only without a second write`,async()=>{
 const f=await accessFixture(surface),api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);if(args[0].includes(':setIamPolicy'))throw new Error('lost');return value;};
 const result=await prepareCloudRunDispatchAccess(f.options);assert.equal(result.outcome,'desired-policy-observed-after-unconfirmed-write');
 await prepareCloudRunDispatchAccess({...f.options,saved:f.saved});assert.equal(f.posts,1);
});
test('definite policy rejection remains rejected and cannot be converted to observation or resent',async()=>{
 const f=await accessFixture(),api=f.options.api;let attempts=0;
 f.options.api=async(...args)=>{if(args[0].includes(':setIamPolicy')){attempts++;throw Object.assign(new Error('rejected'),{status:409});}return api(...args);};
 await assert.rejects(prepareCloudRunDispatchAccess(f.options));assert.equal(f.saved.stage,'rejected');
 await assert.rejects(prepareCloudRunDispatchAccess({...f.options,saved:f.saved}));assert.equal(attempts,1);
});
for(const bad of ['event-disabled','scheduler-uid','service-enabled','surface-swap'])test(`completed caller resume denies ${bad} without writing`,async()=>{
 const f=await accessFixture();await prepareCloudRunDispatchAccess(f.options);const api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);
 if(bad==='event-disabled'&&args[0].endsWith(f.options.platform.dispatch.eventServiceAccount))value.disabled=true;
 if(bad==='scheduler-uid'&&args[0].endsWith(f.options.platform.dispatch.schedulerServiceAccount))value.uniqueId='12345678901234567899';
 return value;};
 if(bad==='service-enabled')f.f.revision.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';
 if(bad==='surface-swap')f.options.surface='event-receiver';
 await assert.rejects(prepareCloudRunDispatchAccess({...f.options,saved:f.saved}));assert.equal(f.posts,1);
});

for(const surface of ['event-receiver','service-invokers'])test(`${surface} uses its native API requested-policy-version envelope`,async()=>{
 const f=await accessFixture(surface),api=f.options.api;
 f.options.api=async(url,method='GET',body)=>{
 if(url.includes(':getIamPolicy')&&!url.includes('secretmanager')){
 if(surface==='event-receiver'){assert.equal(url,'https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:getIamPolicy');assert.equal(method,'POST');assert.deepEqual(body,{options:{requestedPolicyVersion:3}});}
 else{assert.equal(url,`https://run.googleapis.com/v2/${f.options.platform.dispatch.service}:getIamPolicy?options.requestedPolicyVersion=3`);assert.equal(method,'GET');assert.equal(body,undefined);}
 }return api(url,method,body);};
 await prepareCloudRunDispatchAccess(f.options);assert.equal(f.posts,1);
});
