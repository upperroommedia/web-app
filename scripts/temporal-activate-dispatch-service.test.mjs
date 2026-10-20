import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { activateCloudRunDispatchService } from './temporal-activate-dispatch-service.mjs';
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
 if(url.includes('secretmanager'))return{name:'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/7',state:'ENABLED'};
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

async function activationFixture() {
  const f=await accessFixture(),p=f.options.platform,api=f.options.api;
  let saved,patches=0,probes=0,starts=0;
  const calls=[];
  const options={...f.options,operationId:'44444444-2222-4333-8444-555555555555',artifactDirectory:'/private/tmp/controlled-activation',
    save:async value=>{saved=structuredClone(value);},
    probe:async ({savedIntent,recordIntent})=>{
      probes++;
      const intent=savedIntent??{schemaVersion:1,workflowId:'fixture-readiness',nonce:'fixture-nonce',createdAt:new Date().toISOString(),
        bindings:p.roleBindings.map(({projectId,region,namespace,role,buildId,poolName,deploymentName,runnerServiceAccount,image})=>({projectId,region,namespace,role,buildId,poolName,deploymentName,runnerServiceAccount,image}))};
      if(!savedIntent){await recordIntent(intent);starts++;}
      assert.deepEqual(saved.workerIntent,intent);
      return {schemaVersion:1,scope:'observed-role-execution-and-declared-pool-identity',workflowId:intent.workflowId,
        runId:'55555555-2222-4333-8444-555555555555',verifiedAt:new Date().toISOString(),historyDigest:'f'.repeat(64),roles:p.roleBindings.map(b=>({role:b.role}))};
    },
    api:async (url,method='GET',body)=>{
      calls.push([url,method,body]);
      if(url.startsWith('https://cloudresourcemanager.'))return {version:3,etag:'project',auditConfigs:[{service:'eventarc.googleapis.com',auditLogConfigs:[{logType:'DATA_WRITE'}]}],bindings:[
        ...['eventarc','cloudscheduler','pubsub'].map(s=>({role:`roles/${s}.serviceAgent`,members:[`serviceAccount:service-251680231116@gcp-sa-${s}.iam.gserviceaccount.com`]})),
        {role:'roles/eventarc.eventReceiver',members:[`serviceAccount:${p.dispatch.eventServiceAccount}`]}]};
      if(url.startsWith('https://run.')&&url.includes(':getIamPolicy'))return {etag:'invokers',bindings:[{role:'roles/run.invoker',members:[p.dispatch.eventServiceAccount,p.dispatch.schedulerServiceAccount].map(e=>`serviceAccount:${e}`)}]};
      if(method==='PATCH'){
        assert.equal(saved.stage,'attempted');assert.equal(saved.proof.workflowId,saved.workerIntent.workflowId);
        assert.equal(body.etag,'service-etag');patches++;
        const service=f.f.service,revision=f.f.revision;
        Object.assign(service,structuredClone(body),{etag:'enabled-etag',generation:'2',observedGeneration:'2'});
        service.latestCreatedRevision=service.latestReadyRevision=`${body.name}/revisions/${p.dispatch.serviceId}-00002-abc`;
        service.trafficStatuses=[{revision:service.latestReadyRevision,percent:100}];
        Object.assign(revision,structuredClone(body.template),{name:service.latestReadyRevision,uid:'enabled-revision'});
        return{name:'projects/urm-app-staging/locations/us-central1/operations/activate'};
      }
      if(url.endsWith('/operations/activate'))return{name:'projects/urm-app-staging/locations/us-central1/operations/activate',done:true,response:structuredClone(f.f.service)};
      return api(url,method,body);
    }};
  return{options,f,calls,get saved(){return saved;},get patches(){return patches;},get probes(){return probes;},get starts(){return starts;}};
}
test('native intent is durable before probe and one conditional PATCH joins original owned service and new revision',async()=>{
  const f=await activationFixture(),result=await activateCloudRunDispatchService(f.options);
  assert.equal(result.stage,'completed');assert.equal(f.patches,1);assert.equal(f.starts,1);
  assert.equal(result.service.admission,'enabled');
  assert.equal(f.calls.filter(([,m])=>m==='PATCH').length,1);
  assert.equal(f.calls.some(([u,m])=>m==='POST'&&!u.startsWith('https://cloudresourcemanager.')),false);
  await activateCloudRunDispatchService({...f.options,saved:f.saved});assert.equal(f.patches,1);assert.equal(f.probes,1);
});
test('unknown PATCH acknowledgement reads exact enabled configuration without resend or causal claim',async()=>{
  const f=await activationFixture(),api=f.options.api;
  f.options.api=async(...args)=>{const value=await api(...args);if(args[1]==='PATCH')throw new Error('lost');return value;};
  await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.saved.stage,'attempted');
  const result=await activateCloudRunDispatchService({...f.options,saved:f.saved});
  assert.equal(result.outcome,'enabled-config-observed-after-unconfirmed-write');assert.equal(f.patches,1);assert.equal(f.probes,1);
});
test('known LRO resumes without another probe or PATCH after save acknowledgement uncertainty',async()=>{
  const f=await activationFixture(),save=f.options.save;
  f.options.save=async value=>{await save(value);if(value.stage==='acknowledged')throw new Error('lost save');};
  await assert.rejects(activateCloudRunDispatchService(f.options));f.options.save=save;
  await activateCloudRunDispatchService({...f.options,saved:f.saved});assert.equal(f.patches,1);assert.equal(f.probes,1);
});
test('unknown native probe start resumes only the same saved intent',async()=>{
  const f=await activationFixture(),probe=f.options.probe;
  f.options.probe=async o=>{await probe(o);throw new Error('lost native start acknowledgement');};
  await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.patches,0);assert.equal(f.starts,1);
  f.options.probe=probe;await activateCloudRunDispatchService({...f.options,saved:f.saved});assert.equal(f.starts,1);assert.equal(f.patches,1);
});
for(const status of [403,409])test(`definite PATCH HTTP${status} remains rejected across resume`,async()=>{
  const f=await activationFixture(),api=f.options.api;
  f.options.api=async(...a)=>{if(a[1]==='PATCH')throw Object.assign(new Error('rejected'),{status});return api(...a);};
  await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.saved.stage,'rejected');
  const count=f.calls.length;await assert.rejects(activateCloudRunDispatchService({...f.options,saved:f.saved}));assert.equal(f.calls.length,count);
});
for(const bad of ['missing-intent','null-intent','foreign-bindings','stale-intent','missing-proof','foreign-proof','wake','invokers','secret','runner'])test(`activation denies ${bad} before mutation`,async()=>{
  const f=await activationFixture(),api=f.options.api,probe=f.options.probe;
  f.options.probe=async o=>{
    if(bad==='missing-intent')return {schemaVersion:1};
    const result=await probe(o);
    if(bad==='missing-proof')return null;
    if(bad==='foreign-proof')result.workflowId='foreign';
    return result;
  };
  if(['null-intent','foreign-bindings','stale-intent'].includes(bad)){
    const save=f.options.save;f.options.save=async v=>{await save(v);if(v.workerIntent)throw new Error('stop after intent');};
    await assert.rejects(activateCloudRunDispatchService(f.options));f.options.save=save;
    const state=structuredClone(f.saved);
    if(bad==='null-intent')state.workerIntent=null;
    if(bad==='foreign-bindings')state.workerIntent.bindings=[];
    if(bad==='stale-intent')state.workerIntent.createdAt='2020-01-01T00:00:00Z';
    f.options.saved=state;
  }
  f.options.api=async(...a)=>{
    if(bad==='wake'&&a[0].startsWith('https://eventarc.'))return {name:'preexisting'};
    const value=await api(...a);
    if(bad==='invokers'&&a[0].startsWith('https://run.')&&a[0].includes(':getIamPolicy'))value.bindings[0].members.push('allUsers');
    if(bad==='secret'&&a[0].includes('secretmanager')&&a[0].includes('/versions/'))value.state='DISABLED';
    if(bad==='runner'&&a[0].includes('iam.googleapis')&&a[0].includes(f.options.platform.dispatch.runnerServiceAccount))value.uniqueId='99999999999999999999';
    return value;
  };
  await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.patches,0);
});

for (const bad of ['missing-intent', 'missing-proof', 'wrong-original-run', 'wrong-workflow']) test(`post-attempt resume denies ${bad} without completion`, async()=>{
 const f=await activationFixture(),api=f.options.api;
 f.options.api=async(...a)=>{const value=await api(...a);if(a[1]==='PATCH')throw new Error('lost');return value;};
 await assert.rejects(activateCloudRunDispatchService(f.options));
 const saved=structuredClone(f.saved);
 if(bad==='missing-intent')delete saved.workerIntent;
 if(bad==='missing-proof')delete saved.proof;
 if(bad==='wrong-original-run')saved.proof.runId='bad';
 if(bad==='wrong-workflow')saved.proof.workflowId='foreign';
 await assert.rejects(activateCloudRunDispatchService({...f.options,saved}));assert.equal(f.patches,1);
});
test('probe authorization expiring during final prerequisite reads fences the attempted operation before PATCH',async()=>{
 const f=await activationFixture(),api=f.options.api,now=Date.now;
 try {
  f.options.api=async(...a)=>{const value=await api(...a);if(f.saved?.stage==='attempted')Date.now=()=>now()+610001;return value;};
  await assert.rejects(activateCloudRunDispatchService(f.options));
  assert.equal(f.saved.stage,'attempted');assert.equal(f.patches,0);
 } finally {Date.now=now;}
});

test('delayed unknown-ACK readback preserves the original valid authorization window without expiry or resend',async()=>{
 const f=await activationFixture(),api=f.options.api;
 f.options.api=async(...a)=>{const value=await api(...a);if(a[1]==='PATCH')throw new Error('lost');return value;};
 await assert.rejects(activateCloudRunDispatchService(f.options));
 const saved=structuredClone(f.saved),old=Date.now()-3600000;
 saved.workerIntent.createdAt=new Date(old).toISOString();saved.proof.verifiedAt=new Date(old+1000).toISOString();saved.attemptedAt=new Date(old+2000).toISOString();
 const result=await activateCloudRunDispatchService({...f.options,saved});assert.equal(result.stage,'completed');assert.equal(f.patches,1);assert.equal(f.probes,1);
});
for(const bad of ['replacement-uid','old-generation','missing-marker','wrong-operation','native-failure'])test(`native ${bad} denies initial completion and never causes a replacement PATCH`,async()=>{
 const f=await activationFixture(),api=f.options.api;
 f.options.api=async(...a)=>{
  const value=await api(...a);
  if(a[1]==='PATCH') {
   if(bad==='replacement-uid')f.f.f.service.uid='replacement';
   if(bad==='old-generation')f.f.f.service.generation=f.f.f.service.observedGeneration='1';
   if(bad==='missing-marker')f.f.f.service.annotations={};
   if(bad==='wrong-operation')value.name+='/unsupported';
  }
  if(bad==='native-failure'&&a[0].endsWith('/operations/activate'))value.error={code:13};
  return value;
 };
 await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.patches,1);
 if(bad==='wrong-operation') {
  const recovered=await activateCloudRunDispatchService({...f.options,saved:f.saved});
  assert.equal(recovered.outcome,'enabled-config-observed-after-unconfirmed-write');
 } else await assert.rejects(activateCloudRunDispatchService({...f.options,saved:f.saved}));
 assert.equal(f.patches,1);
});
test('uncertain attempted-checkpoint acknowledgement never permits the PATCH or resend',async()=>{
 const f=await activationFixture(),save=f.options.save;
 f.options.save=async value=>{await save(value);if(value.stage==='attempted')throw new Error('uncertain checkpoint');};
 await assert.rejects(activateCloudRunDispatchService(f.options));assert.equal(f.patches,0);
 f.options.save=save;await assert.rejects(activateCloudRunDispatchService({...f.options,saved:f.saved}));assert.equal(f.patches,0);assert.equal(f.starts,1);
});
