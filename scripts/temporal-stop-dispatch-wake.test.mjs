import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchServiceFixture } from './tests/fixtures/temporal-dispatch-cycle.mjs';
import { prepareCloudRunDispatchService } from './temporal-prepare-dispatch-service.mjs';
import { stopCloudRunDispatchWake } from './temporal-stop-dispatch-wake.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';

async function stopFixture(surface='outbox-trigger') {
 const f=dispatchServiceFixture(),service=await prepareCloudRunDispatchService(f.options);
 const serviceReceipt={releaseId:f.options.releaseId,operationId:service.plan.operationId,identityState:service};
 const creation=dispatchWakePlan({...f.options,operationId:'33333333-2222-4333-8444-555555555555',surface,runnerReceipt:f.options.identityReceipt,serviceReceipt});
 let resource=surface==='scheduler'?{...structuredClone(creation.body),state:'ENABLED',userUpdateTime:'2026-10-20T17:00:00Z'}:{...structuredClone(creation.body),uid:'owned-trigger-uid',etag:'etag+/='};
 const owned=surface==='scheduler'?{name:resource.name,userUpdateTime:resource.userUpdateTime}:{name:resource.name,uid:resource.uid,etag:resource.etag};
 const wakeReceipt={releaseId:f.options.releaseId,operationId:creation.operationId,identityState:{stage:'completed',plan:creation,resource:owned,
 ...(surface==='scheduler'?{acknowledgedResource:structuredClone(owned)}:{nativeOperation:'projects/urm-app-staging/locations/us-central1/operations/create-original'})}};
 let saved,writes=0;const calls=[];const op='projects/urm-app-staging/locations/us-central1/operations/delete-owned';
 const options={...f.options,operationId:'44444444-2222-4333-8444-555555555555',surface,runnerReceipt:f.options.identityReceipt,serviceReceipt,wakeReceipt,
 save:async value=>{saved=structuredClone(value);},api:async(url,method='GET',body)=>{
 calls.push([url,method]);
 if(url.endsWith(op))return{name:op,done:true,response:{}};
 if(url===`https://cloudscheduler.googleapis.com/v1/${creation.body.name}:pause`){assert.equal(method,'POST');assert.equal(body,undefined);assert.equal(saved.stage,'attempted');assert.equal(saved.plan.request.url,url);writes++;resource.state='PAUSED';return structuredClone(resource);}
 if(method==='DELETE'){assert.equal(saved.stage,'attempted');assert.equal(url,`https://eventarc.googleapis.com/v1/${creation.body.name}?etag=${encodeURIComponent(owned.etag)}`);assert.equal(body,undefined);writes++;resource=undefined;return{name:op};}
 if(url===`${surface==='scheduler'?'https://cloudscheduler.googleapis.com/v1/':'https://eventarc.googleapis.com/v1/'}${creation.body.name}`){if(!resource)throw Object.assign(new Error('absent'),{status:404});return structuredClone(resource);}
 return f.options.api(url,method,body);
 }};
 return{options,f,calls,get saved(){return saved;},get writes(){return writes;},get resource(){return resource;},set resource(value){resource=value;}};
}
for(const surface of ['outbox-trigger','commands-trigger','scheduler'])test(`stops only exact owned ${surface}, then completed resume is GET-only`,async()=>{
 const f=await stopFixture(surface),result=await stopCloudRunDispatchWake(f.options);assert.equal(result.stage,'completed');assert.equal(f.writes,1);
 await stopCloudRunDispatchWake({...f.options,saved:f.saved});assert.equal(f.writes,1);
 assert.equal(f.calls.some(([u,m])=>m==='PATCH'||/:resume|\/triggers\?|\/jobs$/.test(u)),false);
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} unknown stop ACK is observational without a second mutation`,async()=>{
 const f=await stopFixture(surface),api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);if(args[1]==='DELETE'||args[0].endsWith(':pause'))throw new Error('unknown');return value;};
 const result=await stopCloudRunDispatchWake(f.options);assert.equal(result.outcome,'stopped-observed-after-unknown-acknowledgement');assert.equal(f.writes,1);
 await stopCloudRunDispatchWake({...f.options,saved:f.saved});assert.equal(f.writes,1);
});
for(const bad of ['receipt-release','source-marker','missing-native-ack','replacement','service-enabled','missing-runner'])test(`denies ${bad} before any stop`,async()=>{
 const f=await stopFixture();
 if(bad==='receipt-release')f.options.wakeReceipt.releaseId='foreign';
 if(bad==='source-marker')f.options.wakeReceipt.identityState.plan.body.labels={};
 if(bad==='missing-native-ack')delete f.options.wakeReceipt.identityState.nativeOperation;
 if(bad==='replacement')f.resource.uid='replacement';
 if(bad==='service-enabled')f.f.revision.containers[0].env.find(x=>x.name==='TEMPORAL_DISPATCH_ADMISSION').value='enabled';
 if(bad==='missing-runner')f.options.runnerReceipt.identityState.stage='planned';
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.writes,0);
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} definite rejection remains fenced even when desired state later appears`,async()=>{
 const f=await stopFixture(surface),api=f.options.api;let attempts=0;
 f.options.api=async(...args)=>{if(args[1]==='DELETE'||args[0].endsWith(':pause')){attempts++;throw Object.assign(new Error('rejected'),{status:409});}return api(...args);};
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.saved.stage,'rejected');
 if(surface==='scheduler')f.resource.state='PAUSED';else f.resource=undefined;
 await assert.rejects(stopCloudRunDispatchWake({...f.options,saved:f.saved}));assert.equal(attempts,1);
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} completed readback rejects replacement or re-enabled job without stopping again`,async()=>{
 const f=await stopFixture(surface);await stopCloudRunDispatchWake(f.options);
 f.resource=surface==='scheduler'?{...f.resource,state:'ENABLED'}:{...f.options.wakeReceipt.identityState.plan.body,uid:'replacement',etag:'other'};
 await assert.rejects(stopCloudRunDispatchWake({...f.options,saved:f.saved}));assert.equal(f.writes,1);
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} uncertain attempted checkpoint cannot authorize a later mutation`,async()=>{
 const f=await stopFixture(surface),save=f.options.save;f.options.save=async value=>{await save(value);if(value.stage==='attempted')throw new Error('unknown checkpoint');};
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.writes,0);f.options.save=save;
 await assert.rejects(stopCloudRunDispatchWake({...f.options,saved:f.saved}));assert.equal(f.writes,0);
});
test('original already paused scheduler is observed without pause or new creation',async()=>{
 const f=await stopFixture('scheduler');f.resource.state='PAUSED';const result=await stopCloudRunDispatchWake(f.options);assert.equal(result.outcome,'observed-already-stopped');assert.equal(f.writes,0);
});
test('scheduler source, creation time and native ACK receipt are mandatory',async()=>{
 for(const bad of ['creation-time','schedule','marker','ack']){const f=await stopFixture('scheduler');
 if(bad==='creation-time')f.resource.userUpdateTime='2026-10-20T17:01:00Z';
 if(bad==='schedule')f.resource.schedule='0 * * * *';
 if(bad==='marker')f.resource.description='foreign';
 if(bad==='ack')delete f.options.wakeReceipt.identityState.acknowledgedResource;
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.writes,0);}
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} acknowledgement checkpoint uncertainty resumes without another stop`,async()=>{
 const f=await stopFixture(surface),save=f.options.save;
 f.options.save=async value=>{await save(value);if(value.stage==='acknowledged')throw new Error('unknown checkpoint');};
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.saved.stage,'acknowledged');assert.equal(f.writes,1);
 f.options.save=save;await stopCloudRunDispatchWake({...f.options,saved:f.saved});assert.equal(f.writes,1);
});
for(const surface of ['outbox-trigger','scheduler'])test(`${surface} unknown stop with unchanged resource stays fenced without resend`,async()=>{
 const f=await stopFixture(surface),api=f.options.api;let attempts=0;
 f.options.api=async(...args)=>{if(args[1]==='DELETE'||args[0].endsWith(':pause')){attempts++;throw new Error('unknown before effect');}return api(...args);};
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.saved.stage,'attempted');
 await assert.rejects(stopCloudRunDispatchWake({...f.options,saved:f.saved}));assert.equal(attempts,1);
});
test('native delete operation failure cannot be converted to a completed observation or resent',async()=>{
 const f=await stopFixture(),api=f.options.api;
 f.options.api=async(...args)=>{const value=await api(...args);if(args[0].includes('/operations/delete-owned'))value.error={code:13};return value;};
 await assert.rejects(stopCloudRunDispatchWake(f.options));assert.equal(f.saved.stage,'failed');
 await assert.rejects(stopCloudRunDispatchWake({...f.options,saved:f.saved}));assert.equal(f.writes,1);
});
