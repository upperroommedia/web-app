import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { verifyCloudRunDispatchConfiguration } from './temporal-release-dispatch.mjs';
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
 if(new URL(url).origin === 'https://iam.googleapis.com')return {projectId:'urm-app-staging',email:runner,uniqueId:'12345678901234567890',description:'owned'};
 if(url.includes('secretmanager')&&url.includes(':getIamPolicy'))return{etag:'secret',bindings:[{role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:${runner}`]}]};
 if(url.includes('secretmanager'))return{name:'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/7',state:'ENABLED'};
 if(url.includes(':getIamPolicy'))return{etag:'empty',bindings:[]};
 if(method==='POST'){
 assert.equal(saved.stage,'attempted');posts++;
 const request = new URL(url);
 const serviceId = request.searchParams.get('serviceId');
 const name = `${request.pathname.slice('/v2/'.length)}/${serviceId}`;
 assert.equal(request.pathname, '/v2/projects/urm-app-staging/locations/us-central1/services');
 assert.equal(serviceId, p.dispatch.serviceId);
 assert.equal(Object.hasOwn(body, 'name'), false, 'Services.CreateService rejects a name on the request body');
 assert.deepEqual({ name, ...body }, saved.plan.body);
 service={name,...structuredClone(body),uid:'service-uid',etag:'service-etag',generation:'1',observedGeneration:'1',terminalCondition:{state:'CONDITION_SUCCEEDED'},
 latestCreatedRevision:`${name}/revisions/${serviceId}-00001-abc`,latestReadyRevision:`${name}/revisions/${serviceId}-00001-abc`,
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
test('single native-LRO create produces an inert disabled service; completed resume never creates or activates',async()=>{
 const f=fixture();const value=await prepareCloudRunDispatchService(f.options);
 assert.equal(value.service.admission,'disabled');assert.equal(f.posts,1);
 assert.equal(f.service.template.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value,'disabled');
 await prepareCloudRunDispatchService({...f.options,saved:f.saved});assert.equal(f.posts,1);
 assert.equal(f.calls.some(([u,m])=>m==='PATCH'||/eventarc|scheduler|setIamPolicy|:access/.test(u)),false);
 await assert.rejects(verifyCloudRunDispatchConfiguration(f.options.platform,f.options.api));
});
test('lost create ACK stays fenced without name adoption or resend',async()=>{
 const f=fixture(),api=f.options.api;
 f.options.api=async(...args)=>{const result=await api(...args);if(args[1]==='POST' && args[0].startsWith('https://run.'))throw new Error('lost');return result;};
 await assert.rejects(prepareCloudRunDispatchService(f.options));const count=f.calls.length;
 await assert.rejects(prepareCloudRunDispatchService({...f.options,saved:f.saved}));
 assert.equal(f.posts,1);assert.equal(f.calls.length,count);
});
test('known LRO checkpoint can resume after acknowledged save uncertainty',async()=>{
 const f=fixture(),save=f.options.save;
 f.options.save=async value=>{await save(value);if(value.stage==='acknowledged')throw new Error('uncertain');};
 await assert.rejects(prepareCloudRunDispatchService(f.options));f.options.save=save;
 await prepareCloudRunDispatchService({...f.options,saved:f.saved});assert.equal(f.posts,1);
});
for(const bad of ['runner','secret','accessor','preexisting','attempt-save'])test(`before create denies ${bad}`,async()=>{
 const f=fixture(),api=f.options.api;
 if(bad==='runner')f.options.identityReceipt.identityState.plan.kind='event';
 if(bad==='attempt-save'){const save=f.options.save;f.options.save=async value=>{await save(value);if(value.stage==='attempted')throw new Error('uncertain');};}
 f.options.api=async(...args)=>{
 if(bad==='preexisting'&&args[0]===`https://run.googleapis.com/v2/${f.options.platform.dispatch.service}`)return{name:'existing'};
 const value=await api(...args);
 if(bad==='secret'&&args[0].includes('/versions/'))value.state='DISABLED';
 if(bad==='accessor'&&args[0].includes('secretmanager')&&args[0].includes('getIamPolicy'))value.bindings=[];
 return value;};
 await assert.rejects(prepareCloudRunDispatchService(f.options));assert.equal(f.posts,0);
});
for(const bad of ['enabled','revision-enabled','marker','uid-change','operation','failed','invokers'])test(`native ${bad} cannot complete or cause replacement create`,async()=>{
 const f=fixture(),api=f.options.api;
 f.options.api=async(...args)=>{
 const value=await api(...args);
 if(args[1]==='POST' && args[0].startsWith('https://run.')){
 if(bad==='enabled')f.service.template.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';
 if(bad==='revision-enabled')f.revision.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';
 if(bad==='marker')f.service.annotations={};
 if(bad==='operation')value.name+='/invalid';
 }
 if(bad==='uid-change'&&args[0]===`https://run.googleapis.com/v2/${f.options.platform.dispatch.service}`)value.uid='replacement';
 if(bad==='failed'&&args[0].includes('/operations/'))value.error={code:13};
 if(bad==='invokers'&&args[0].startsWith('https://run.')&&args[0].includes('getIamPolicy'))value.bindings=[{role:'roles/run.invoker',members:['allUsers']}];
 return value;};
 await assert.rejects(prepareCloudRunDispatchService(f.options));assert.equal(f.posts,1);
});

test('completed readback requires the original enabled runner, secret permission and empty direct invokers',async()=>{
 for(const bad of ['runner','accessor','invokers']){
 const f=fixture();await prepareCloudRunDispatchService(f.options);const api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);
 if(bad==='runner'&&new URL(args[0]).origin === 'https://iam.googleapis.com')value.disabled=true;
 if(bad==='accessor'&&args[0].includes('secretmanager')&&args[0].includes('getIamPolicy'))value.bindings=[];
 if(bad==='invokers'&&args[0].startsWith('https://run.')&&args[0].includes('getIamPolicy'))value.bindings=[{role:'roles/run.invoker',members:['allUsers']}];return value;};
 await assert.rejects(prepareCloudRunDispatchService({...f.options,saved:f.saved}));assert.equal(f.posts,1);
 }
});

for(const bad of ['missing-role','app-service-agent','conditional-agent','foreign-project'])test(`managed-agent ${bad} denies inert service create`,async()=>{
 const f=fixture(),api=f.options.api;f.options.api=async(...args)=>{const value=await api(...args);
 if(args[0].startsWith('https://cloudresourcemanager.')){
 if(bad==='missing-role')value.bindings.pop();
 if(bad==='app-service-agent')value.bindings[0].members=[`serviceAccount:${f.options.platform.dispatch.eventServiceAccount}`];
 if(bad==='conditional-agent')value.bindings[0].condition={title:'restricted',expression:'true'};
 if(bad==='foreign-project')value.bindings[0].members=['serviceAccount:service-123@gcp-sa-eventarc.iam.gserviceaccount.com'];
 }return value;};
 await assert.rejects(prepareCloudRunDispatchService(f.options));assert.equal(f.posts,0);
});
for(const bad of ['audit-disabled','applicable-audit-exemption'])test(`${bad} prevents service preparation before any create`,async()=>{
 const f=fixture(),api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);if(args[0].startsWith('https://cloudresourcemanager.')){
 if(bad==='audit-disabled')value.auditConfigs=[];
 else value.auditConfigs.push({service:'allServices',auditLogConfigs:[{logType:'DATA_WRITE',exemptedMembers:['user:other@example.test']}]});
 }return value;};
 await assert.rejects(prepareCloudRunDispatchService(f.options));assert.equal(f.posts,0);
});
