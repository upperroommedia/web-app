import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStopCloudRunEventarc } from './temporal-prepare-stop-eventarc.mjs';
import { cycleFixture } from './tests/fixtures/temporal-dispatch-cycle.mjs';
async function fixture(surface='outbox-trigger') {
 const f=await cycleFixture();f.options.surface=surface;
 const baseApi=f.options.api,base='https://eventarc.googleapis.com/v1/',parent='projects/urm-app-staging/locations/us-central1';
 const createOp=`${parent}/operations/create-original`,stopOp=`${parent}/operations/delete-original`;
 let resource,creates=0,deletes=0,operation={name:createOp,done:true};const calls=[];
 const auditEntry=()=>({insertId:'native-eventarc-first',timestamp:f.saved.attemptedAt,
 logName:'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Fdata_access',operation:{id:createOp,producer:'eventarc.googleapis.com',first:true},
 protoPayload:{serviceName:'eventarc.googleapis.com',methodName:'google.cloud.eventarc.v1.Eventarc.CreateTrigger',authenticationInfo:{principalEmail:f.options.creator},resourceName:parent,
 request:{parent,triggerId:f.saved.plan.creation.body.name.split('/').at(-1),trigger:structuredClone(f.saved.plan.creation.body)},response:{name:createOp}}});
 f.options.api=async(url,method='GET',body)=>{
 calls.push([url,method]);
 if(url.startsWith('https://logging.')){assert.equal(method,'POST');assert.match(body.filter,/data_access/);return{entries:[auditEntry()]};}
 if(url===base+createOp){assert.equal(f.saved.stage,'acknowledged');return{...structuredClone(operation),response:structuredClone(resource)};}
 if(url===base+stopOp)return{name:stopOp,done:true,response:{}};
 if(url.startsWith(base)){
 if(method==='POST'){assert.equal(f.saved.stage,'attempted');assert.equal(url,`${base}${parent}/triggers?triggerId=${encodeURIComponent(body.name.split('/').at(-1))}`);creates++;
 resource={...structuredClone(body),uid:'trigger-original-uid',etag:'original+/=',createTime:new Date().toISOString()};return{name:createOp};}
 if(method==='DELETE'){assert.ok(f.immutable);assert.equal(f.saved.stage,'stopping');assert.equal(f.saved.stopState.stage,'attempted');assert.equal(url,`${base}${resource.name}?etag=${encodeURIComponent(resource.etag)}`);assert.equal(body,undefined);deletes++;resource=undefined;return{name:stopOp};}
 if(!resource)throw Object.assign(new Error('absent'),{status:404});return structuredClone(resource);
 }return baseApi(url,method,body);
 };
 return{...f,options:f.options,auditEntry,calls,createOp,operation,get saved(){return f.saved;},get resource(){return resource;},get creates(){return creates;},get deletes(){return deletes;}};
}
for(const surface of ['outbox-trigger','commands-trigger'])test(`${surface} same-operation native LRO receipt then conditional stop and GET-only completed readback`,async()=>{
 const f=await fixture(surface);const r=await prepareStopCloudRunEventarc(f.options);assert.equal(r.stage,'completed');assert.equal(r.creationState.nativeOperation,f.createOp);assert.equal(f.creates,1);assert.equal(f.deletes,1);assert.equal(f.resource,undefined);
 await prepareStopCloudRunEventarc({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
test('unknown create ACK recovers exact Data Access FIRST native LRO, saves before polling and never resends',async()=>{
 const f=await fixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[1]==='POST'&&a[0].includes('/triggers?'))throw new Error('lost');return r;};
 const r=await prepareStopCloudRunEventarc(f.options);assert.ok(r.creationState.audit.auditSHA256);assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
test('unknown create missing evidence stays attempted, late causal recovery deletes without recreation',async()=>{
 const f=await fixture(),api=f.options.api;let missing=true;
 f.options.api=async(...a)=>{if(a[0].startsWith('https://logging.')&&missing)return{entries:[]};const r=await api(...a);if(a[1]==='POST'&&a[0].includes('/triggers?'))throw new Error('lost');return r;};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.saved.stage,'attempted');assert.equal(f.deletes,0);
 const saved=structuredClone(f.saved);saved.plan.openedAt=new Date(Date.now()-900000).toISOString();saved.plan.cleanupDueAt=new Date(Date.parse(saved.plan.openedAt)+300000).toISOString();missing=false;
 await prepareStopCloudRunEventarc({...f.options,saved});assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
test('uncertain recovered-LRO checkpoint ends turn, saved acknowledgement resumes GET-only',async()=>{
 const f=await fixture(),api=f.options.api,save=f.options.save;let lost=true;
 f.options.api=async(...a)=>{const r=await api(...a);if(a[1]==='POST'&&a[0].includes('/triggers?'))throw new Error('lost');return r;};
 f.options.save=async s=>{await save(s);if(s.stage==='acknowledged'&&lost)throw new Error('checkpoint lost');};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.saved.stage,'acknowledged');assert.equal(f.deletes,0);lost=false;
 await prepareStopCloudRunEventarc({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
for(const bad of ['actor','producer','operation-id','resource','request','validate-only','marker','response','redacted','timestamp','ambiguous','pagination','delegated','class','not-first'])test(`unknown Eventarc create rejects unsupported ${bad} evidence`,async()=>{
 const f=await fixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[1]==='POST'&&a[0].includes('/triggers?'))throw new Error('lost');if(a[0].startsWith('https://logging.')){
 const e=r.entries[0],p=e.protoPayload;
 if(bad==='actor')p.authenticationInfo.principalEmail='foreign@example.test';if(bad==='producer')e.operation.producer='other.googleapis.com';if(bad==='operation-id')e.operation.id=f.createOp+'other';if(bad==='resource')p.resourceName='projects/foreign';if(bad==='request')p.request.triggerId='wrong';if(bad==='validate-only')p.request.validateOnly=true;if(bad==='marker')p.request.trigger.labels['urm-preparation']='foreign';if(bad==='response')p.response.name='projects/foreign/locations/us-central1/operations/other';if(bad==='redacted')delete p.request;if(bad==='timestamp')e.timestamp='2000-01-01T00:00:00Z';if(bad==='ambiguous')r.entries.push(structuredClone(e));if(bad==='pagination')r.nextPageToken='more';if(bad==='delegated')p.authenticationInfo.serviceAccountDelegationInfo={};if(bad==='class')e.logName=e.logName.replace('data_access','activity');if(bad==='not-first')e.operation.first=false;
 }return r;};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.creates,1);assert.equal(f.deletes,0);assert.equal(f.saved.stage,'attempted');
});
test('native create LRO failure remains failed, without creation receipt, deletion or retry',async()=>{
 const f=await fixture();f.operation.error={code:7,message:'controlled fixture failure'};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.saved.stage,'failed');assert.equal(f.deletes,0);await assert.rejects(prepareStopCloudRunEventarc({...f.options,saved:f.saved}));assert.equal(f.creates,1);
});
test('native LRO response/current UID mismatch prevents receipt and deletion',async()=>{
 const f=await fixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith(f.createOp))r.response.uid='foreign';return r;};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.saved.stage,'acknowledged');assert.equal(f.deletes,0);
});
test('unknown conditional DELETE ACK observes absence with no second DELETE',async()=>{
 const f=await fixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[1]==='DELETE')throw new Error('lost');return r;};
 const r=await prepareStopCloudRunEventarc(f.options);assert.equal(r.stopState.outcome,'stopped-observed-after-unknown-acknowledgement');assert.equal(f.deletes,1);
});
test('resume cannot switch source Eventarc surface or become Scheduler',async()=>{
 const f=await fixture(),save=f.options.save;f.options.save=async s=>{await save(s);if(s.stage==='planned')throw new Error('stop');};await assert.rejects(prepareStopCloudRunEventarc(f.options));
 for(const surface of ['scheduler','commands-trigger'])await assert.rejects(prepareStopCloudRunEventarc({...f.options,surface,saved:f.saved}));assert.equal(f.creates,0);
});
test('combined FIRST/LAST entry still requires complete causal Operation envelope',async()=>{
 const f=await fixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[1]==='POST'&&a[0].includes('/triggers?'))throw new Error('lost');if(a[0].startsWith('https://logging.'))r.entries[0].operation.last=true;return r;};
 await prepareStopCloudRunEventarc(f.options);assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
test('unknown native create ACK checkpoint cannot poll or delete in that turn',async()=>{
 const f=await fixture(),save=f.options.save;let unknown=true;
 f.options.save=async s=>{await save(s);if(s.stage==='acknowledged'&&unknown)throw new Error('unknown checkpoint');};
 await assert.rejects(prepareStopCloudRunEventarc(f.options));assert.equal(f.saved.stage,'acknowledged');assert.equal(f.deletes,0);assert.equal(f.calls.some(([u])=>u.endsWith(f.createOp)),false);unknown=false;
 await prepareStopCloudRunEventarc({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.deletes,1);
});
