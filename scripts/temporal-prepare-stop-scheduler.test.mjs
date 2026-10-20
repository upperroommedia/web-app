import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { prepareStopCloudRunScheduler } from './temporal-prepare-stop-scheduler.mjs';
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
 if(url.startsWith('https://cloudresourcemanager.')) { assert.equal(method,'POST'); assert.deepEqual(body,{options:{requestedPolicyVersion:3}}); return { version: 3, etag: 'native-project', auditConfigs: [{service:'eventarc.googleapis.com',auditLogConfigs:[{logType:'DATA_WRITE'}]}], bindings: ['eventarc','cloudscheduler','pubsub'].map(s => ({ role: `roles/${s}.serviceAgent`, members: [`serviceAccount:service-251680231116@gcp-sa-${s}.iam.gserviceaccount.com`] })) }; }
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

async function cycleFixture() {
 const f=fixture(), service=await prepareCloudRunDispatchService(f.options), p=f.options.platform;
 const receipt=(kind,id)=>({releaseId:f.options.releaseId,identityState:{stage:'completed',plan:{kind,role:'dispatch',buildId,email:p.dispatch[`${kind}ServiceAccount`],evidenceDigest:f.options.evidenceDigest},account:{email:p.dispatch[`${kind}ServiceAccount`],uniqueId:id,description:'owned'}}});
 const eventReceipt=receipt('event','12345678901234567891'),schedulerReceipt=receipt('scheduler','12345678901234567892');
 let saved, immutable, job, creates=0, pauses=0; const calls=[];
 const options={...f.options,operationId:'33333333-2222-4333-8444-555555555555',creator:'operator@example.test',
 runnerReceipt:f.options.identityReceipt,eventReceipt,schedulerReceipt,
 serviceReceipt:{releaseId:f.options.releaseId,operationId:service.plan.operationId,identityState:service},
 save:async value=>{saved=structuredClone(value);if(value.creationState){const r={operationId:options.operationId,releaseId:options.releaseId,operatorPrincipal:{email:options.creator},identityState:value.creationState};if(immutable)assert.deepEqual(immutable,r);else immutable=structuredClone(r);}},
 readCreationReceipt:async()=>structuredClone(immutable),
 api:async(url,method='GET',body)=>{
 calls.push([url,method]);
 for(const r of [eventReceipt,schedulerReceipt])if(url.endsWith(`/serviceAccounts/${r.identityState.account.email}`))return{projectId:'urm-app-staging',...r.identityState.account};
 if(url.startsWith('https://cloudresourcemanager.')){const policy=await f.options.api(url,method,body);policy.bindings.push({role:'roles/eventarc.eventReceiver',members:[`serviceAccount:${p.dispatch.eventServiceAccount}`]});return policy;}
 if(url.startsWith('https://run.googleapis.com/')&&url.includes(':getIamPolicy'))return{etag:'callers',bindings:[{role:'roles/run.invoker',members:[p.dispatch.eventServiceAccount,p.dispatch.schedulerServiceAccount].map(x=>`serviceAccount:${x}`)}]};
 if(url.startsWith('https://cloudscheduler.googleapis.com/')){
 if(url.endsWith('/jobs')){assert.equal(saved.stage,'attempted');assert.equal(method,'POST');creates++;job={...structuredClone(body),state:'ENABLED',userUpdateTime:new Date().toISOString()};return structuredClone(job);}
 if(url.endsWith(':pause')){assert.ok(immutable);assert.equal(saved.stopState.stage,'attempted');assert.equal(saved.stage,'stopping');assert.equal(method,'POST');assert.equal(body,undefined);pauses++;job.state='PAUSED';return structuredClone(job);}
 if(!job)throw Object.assign(new Error('absent'),{status:404});return structuredClone(job);
 }
 if(url.startsWith('https://logging.googleapis.com/')){assert.equal(method,'POST');return{entries:[auditEntry()]};}
 return f.options.api(url,method,body);
 }};
 const auditEntry=()=>({insertId:'native-insert',timestamp:saved.attemptedAt,logName:'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Factivity',protoPayload:{serviceName:'cloudscheduler.googleapis.com',methodName:'google.cloud.scheduler.v1.CloudScheduler.CreateJob',authenticationInfo:{principalEmail:options.creator},resourceName:'projects/urm-app-staging/locations/us-central1',request:{parent:'projects/urm-app-staging/locations/us-central1',job:structuredClone(saved.plan.creation.body)},response:structuredClone(job)}});
 return{options,f,calls,auditEntry,get saved(){return saved;},get creates(){return creates;},get pauses(){return pauses;},get job(){return job;},get immutable(){return immutable;}};
}
test('same owned cycle saves creation receipt before pause and completed resume is GET-only',async()=>{
 const f=await cycleFixture();const result=await prepareStopCloudRunScheduler(f.options);assert.equal(result.stage,'completed');assert.equal(f.job.state,'PAUSED');assert.equal(f.creates,1);assert.equal(f.pauses,1);
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown create ACK requires exact native causal audit then same-operation pause',async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');return r;};
 await prepareStopCloudRunScheduler(f.options);assert.ok(f.immutable.identityState.audit.auditSHA256);assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown create with missing audit remains fenced and later recovery never recreates',async()=>{
 const f=await cycleFixture(),api=f.options.api;let missing=true;
 f.options.api=async(...a)=>{if(a[0].startsWith('https://logging.')&&missing)return{entries:[]};const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'attempted');assert.equal(f.pauses,0);missing=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
for(const status of [403,409])test(`definite create ${status} is never reconciled or resent`,async()=>{
 const f=await cycleFixture(),api=f.options.api;let n=0;f.options.api=async(...a)=>{if(a[0].endsWith('/jobs')&&a[1]==='POST'){n++;throw Object.assign(new Error('reject'),{status});}return api(...a);};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'rejected');await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved:f.saved}));assert.equal(n,1);
});
test('unknown immutable creation checkpoint never authorizes pause or another create that turn',async()=>{
 const f=await cycleFixture(),save=f.options.save;let lost=true;f.options.save=async s=>{await save(s);if(s.stage==='created'&&lost)throw new Error('lostcheckpoint');};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,1);assert.equal(f.pauses,0);lost=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('missing actual immutable creation receipt prevents pause',async()=>{
 const f=await cycleFixture();f.options.readCreationReceipt=async()=>undefined;
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'created');assert.equal(f.pauses,0);
});
test('expired planned window forbids creation while delayed attempted recovery still pauses',async()=>{
 const f=await cycleFixture(),save=f.options.save;f.options.save=async s=>{await save(s);if(s.stage==='planned')throw new Error('stop');};await assert.rejects(prepareStopCloudRunScheduler(f.options));
 const saved=structuredClone(f.saved);saved.plan.openedAt=new Date(Date.now()-600000).toISOString();saved.plan.cleanupDueAt=new Date(Date.parse(saved.plan.openedAt)+300000).toISOString();
 await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved}));assert.equal(f.creates,0);
 f.options.save=save;const api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');if(a[0].startsWith('https://logging.'))return{entries:[]};return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));const pending=structuredClone(f.saved);pending.plan.openedAt=saved.plan.openedAt;pending.plan.cleanupDueAt=saved.plan.cleanupDueAt;
 f.options.api=api;await prepareStopCloudRunScheduler({...f.options,saved:pending});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
for(const bad of ['actor','request','response','resource','timestamp','class','delegation','status','ambiguous','pagination','redacted'])test(`strict scheduler causal audit rejects ${bad}`,async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');if(a[0].startsWith('https://logging.')){
 const e=r.entries[0],p=e.protoPayload;
 if(bad==='actor')p.authenticationInfo.principalEmail='foreign@example.test';if(bad==='request')p.request.job.schedule='*/2 * * * *';if(bad==='response')p.response.userUpdateTime='2000-01-01T00:00:00Z';if(bad==='resource')p.resourceName='projects/other/locations/us-central1';if(bad==='timestamp')e.timestamp='2000-01-01T00:00:00Z';if(bad==='class')e.logName=e.logName.replace('activity','data_access');if(bad==='delegation')p.authenticationInfo.serviceAccountDelegationInfo=[{}];if(bad==='status')p.status={code:7};if(bad==='ambiguous')r.entries.push(structuredClone(e));if(bad==='pagination')r.nextPageToken='more';if(bad==='redacted')delete p.request;return r;}return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,1);assert.equal(f.pauses,0);assert.equal(f.saved.stage,'attempted');
});
for(const missing of [true,false])test(`completed cycle rejects ${missing?'missing':'downgraded'} stop checkpoint before another pause`,async()=>{
 const f=await cycleFixture();await prepareStopCloudRunScheduler(f.options);f.job.state='ENABLED';const saved=structuredClone(f.saved);const api=f.options.api;let extraPause=0;f.options.api=async(...a)=>{if(a[0].endsWith(':pause'))extraPause++;return api(...a);};
 if(missing)delete saved.stopState;else saved.stopState.stage='planned';
 await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved}));assert.equal(f.creates,1);assert.equal(f.pauses,1);assert.equal(extraPause,0);
});
test('attempt checkpoint consuming creation window cannot issue CreateJob afterward',async()=>{
 const f=await cycleFixture(),save=f.options.save,now=Date.now;let shift=0;
 Date.now=()=>now()+shift;
 try{f.options.save=async s=>{await save(s);if(s.stage==='attempted')shift=600000;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'attempted');assert.equal(f.creates,0);assert.equal(f.pauses,0);
 }finally{Date.now=now;}
});
for(const bad of ['managed-agent','audit','public-invoker','caller-uid'])test(`cycle rejects ${bad} before creating wake`,async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);
 if(a[0].startsWith('https://cloudresourcemanager.')){if(bad==='managed-agent')r.bindings=r.bindings.filter(x=>x.role!=='roles/cloudscheduler.serviceAgent');if(bad==='audit')delete r.auditConfigs;}
 if(bad==='public-invoker'&&a[0].startsWith('https://run.googleapis.com/')&&a[0].includes(':getIamPolicy'))r.bindings[0].members.push('allUsers');
 if(bad==='caller-uid'&&a[0].endsWith(`/serviceAccounts/${f.options.platform.dispatch.schedulerServiceAccount}`))r.uniqueId='12345678901234567899';
 return r;};await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,0);assert.equal(f.pauses,0);
});
test('nested unknown pause ACK reconciles original PAUSED with no second mutation',async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith(':pause'))throw new Error('lost');return r;};
 const result=await prepareStopCloudRunScheduler(f.options);assert.equal(result.stopState.outcome,'stopped-observed-after-unknown-acknowledgement');assert.equal(f.pauses,1);
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown nested stop checkpoint ACK retains same parent and resumes GET-only',async()=>{
 const f=await cycleFixture(),save=f.options.save;let unknown=true;
 f.options.save=async s=>{await save(s);if(s.stage==='stopping'&&s.stopState?.stage==='acknowledged'&&unknown)throw new Error('lost checkpoint');};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'stopping');assert.equal(f.saved.stopState.stage,'acknowledged');assert.equal(f.pauses,1);unknown=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
