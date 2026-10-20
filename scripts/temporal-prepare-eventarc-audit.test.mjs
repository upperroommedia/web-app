import test from 'node:test';
import assert from 'node:assert/strict';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { prepareCloudRunEventarcAudit } from './temporal-prepare-eventarc-audit.mjs';
import { addEventarcWriteAudit, requireEventarcWriteAudit } from './temporal-eventarc-audit-policy.mjs';
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

function auditFixture() {
 const f=fixture();let saved,writes=0;
 let policy={version:3,etag:'original',bindings:[{role:'roles/viewer',members:['user:existing@example.test']}],auditConfigs:[{service:'storage.googleapis.com',auditLogConfigs:[{logType:'DATA_READ',exemptedMembers:['user:other@example.test']}]}]};
 const options={...f.options,save:async value=>{saved=structuredClone(value);},api:async(url,method='GET',body)=>{
 if(url.includes('cloudresourcemanager')&&url.endsWith(':getIamPolicy')){assert.equal(method,'POST');assert.deepEqual(body,{options:{requestedPolicyVersion:3}});return structuredClone(policy);}
 if(url.includes('cloudresourcemanager')&&url.endsWith(':setIamPolicy')){assert.equal(method,'POST');assert.equal(saved.stage,'attempted');assert.equal(body.updateMask,'auditConfigs,etag');assert.equal(body.policy.etag,'original');assert.deepEqual(body.policy.bindings,policy.bindings);writes++;policy={...structuredClone(body.policy),etag:'new'};return structuredClone(policy);}
 return f.options.api(url,method,body);
 }};
 return{options,f,get saved(){return saved;},get writes(){return writes;},get policy(){return policy;},set policy(value){policy=value;}};
}
test('adds only missing Eventarc DATA_WRITE audit config while preserving all bindings and unrelated audit/exemptions',async()=>{
 const f=auditFixture(),original=structuredClone(f.policy);const result=await prepareCloudRunEventarcAudit(f.options);
 assert.equal(f.writes,1);assert.equal(result.stage,'completed');assert.deepEqual(f.policy.bindings,original.bindings);assert.deepEqual(f.policy.auditConfigs[0],original.auditConfigs[0]);
 assert.deepEqual(f.policy.auditConfigs[1],{service:'eventarc.googleapis.com',auditLogConfigs:[{logType:'DATA_WRITE'}]});
 await prepareCloudRunEventarcAudit({...f.options,saved:f.saved});assert.equal(f.writes,1);
});
for(const service of ['allServices','eventarc.googleapis.com'])test(`existing unexempted ${service} DATA_WRITE requires no mutation`,async()=>{
 const f=auditFixture();f.policy.auditConfigs.push({service,auditLogConfigs:[{logType:'DATA_WRITE'}]});
 const result=await prepareCloudRunEventarcAudit(f.options);assert.equal(f.writes,0);assert.equal(result.outcome,'observed-existing-direct-policy');
});
for(const service of ['allServices','eventarc.googleapis.com'])test(`${service} DATA_WRITE exemptions remain unchanged and fail closed`,async()=>{
 const f=auditFixture();f.policy.auditConfigs.push({service,auditLogConfigs:[{logType:'DATA_WRITE',exemptedMembers:['user:operator@example.test']}]});
 const before=structuredClone(f.policy);await assert.rejects(prepareCloudRunEventarcAudit(f.options));assert.equal(f.writes,0);assert.deepEqual(f.policy,before);
});
test('unexempted specific config cannot hide an applicable allServices exemption',()=>{
 const policy={auditConfigs:[{service:'allServices',auditLogConfigs:[{logType:'DATA_WRITE',exemptedMembers:['user:other@example.test']}]},{service:'eventarc.googleapis.com',auditLogConfigs:[{logType:'DATA_WRITE'}]}]};
 assert.throws(()=>requireEventarcWriteAudit(policy));assert.throws(()=>addEventarcWriteAudit(policy));
});
test('lost policy ACK permits exact whole-policy observation only, without resend or causal claim',async()=>{
 const f=auditFixture(),api=f.options.api;f.options.api=async(...args)=>{const value=await api(...args);if(args[0].endsWith(':setIamPolicy'))throw new Error('unknown');return value;};
 const result=await prepareCloudRunEventarcAudit(f.options);assert.equal(result.outcome,'desired-policy-observed-after-unconfirmed-write');
 await prepareCloudRunEventarcAudit({...f.options,saved:f.saved});assert.equal(f.writes,1);
});
test('definite rejection remains rejected even if policy later matches',async()=>{
 const f=auditFixture(),api=f.options.api;let attempts=0;f.options.api=async(...args)=>{if(args[0].endsWith(':setIamPolicy')){attempts++;throw Object.assign(new Error('conflict'),{status:409});}return api(...args);};
 await assert.rejects(prepareCloudRunEventarcAudit(f.options));assert.equal(f.saved.stage,'rejected');f.policy=addEventarcWriteAudit(f.policy);
 await assert.rejects(prepareCloudRunEventarcAudit({...f.options,saved:f.saved}));assert.equal(attempts,1);
});
for(const bad of ['worker-role','runner','existing-service','public-policy'])test(`denies ${bad} before audit mutation`,async()=>{
 const f=auditFixture(),api=f.options.api;
 if(bad==='worker-role')f.options.role='controls';
 if(bad==='runner')f.options.identityReceipt.identityState.plan.kind='event';
 if(bad==='public-policy')f.policy.bindings.push({role:'roles/viewer',members:['allUsers']});
 f.options.api=async(...args)=>bad==='existing-service'&&args[0].startsWith('https://run.')?{name:'existing'}:api(...args);
 await assert.rejects(prepareCloudRunEventarcAudit(f.options));assert.equal(f.writes,0);
});
test('whole-policy drift cannot be adopted after an unknown acknowledgement',async()=>{
 const f=auditFixture(),api=f.options.api;let changed=false;
 f.options.api=async(...args)=>{const value=await api(...args);if(args[0].endsWith(':setIamPolicy')){changed=true;throw new Error('unknown');}if(changed&&args[0].endsWith(':getIamPolicy'))value.bindings[0].members.push('user:unrelated@example.test');return value;};
 await assert.rejects(prepareCloudRunEventarcAudit(f.options));assert.equal(f.saved.stage,'attempted');
 await assert.rejects(prepareCloudRunEventarcAudit({...f.options,saved:f.saved}));assert.equal(f.writes,1);
});
