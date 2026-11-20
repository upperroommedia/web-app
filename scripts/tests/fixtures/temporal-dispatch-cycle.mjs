import assert from 'node:assert/strict';
import { serverlessResourceNames } from '../../temporal-serverless-platform.mjs';
import { dispatchResourceNames } from '../../temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from '../../temporal-prepare-dispatch-service.mjs';
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

export function dispatchServiceFixture() {
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
 assert.equal(request.origin, 'https://run.googleapis.com');
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

export async function cycleFixture() {
 const f=dispatchServiceFixture(), service=await prepareCloudRunDispatchService(f.options), p=f.options.platform;
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
