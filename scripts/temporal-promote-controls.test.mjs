import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {controlsBootstrapFixture} from './tests/fixtures/controls-bootstrap.mjs';
import {bootstrapStopCloudRunControlsPool,activateCloudRunControlsPool} from './temporal-bootstrap-pool.mjs';
import {promoteCloudRunControls} from './temporal-promote-controls.mjs';

async function fixture(){
 const f=controlsBootstrapFixture();
 for(const [key,run] of [['bootstrapCycle',bootstrapStopCloudRunControlsPool],['activation',activateCloudRunControlsPool]]){
  const value=await run(f.options);
  f.options.receipts[key]={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(value)};
  f.options.operationId=randomUUID();
 }
 const binding=f.options.platform.roleBindings.find(b=>b.role==='controls');
 let target=null,token=Buffer.from('before'),state,attempts=0;
 const snapshots=[];
 const proof=()=>({role:'controls',buildId:binding.buildId,namespace:f.options.platform.temporalNamespace,
  protectionSHA256:'a'.repeat(64),protectedWorkSHA256:'b'.repeat(64),computeInventorySHA256:'c'.repeat(64),
  peerRoutingSHA256:'d'.repeat(64),bundleSHA256:'e'.repeat(64),observedAt:new Date().toISOString(),
  queueRouting:{current:target}});
 const service={
  describeWorkerDeployment:async()=>({conflictToken:token,workerDeploymentInfo:{routingConfig:{...(target?{currentDeploymentVersion:target}:{})}}}),
  setWorkerDeploymentCurrentVersion:async request=>{
   assert.equal(state.stage,'attempted');assert.deepEqual(Buffer.from(state.request.conflictTokenBase64,'base64'),request.conflictToken);
   assert.equal(request.ignoreMissingTaskQueues,undefined);assert.equal(request.allowNoPollers,undefined);
   attempts++;target={deploymentName:binding.deploymentName,buildId:binding.buildId};token=Buffer.from('after');return {conflictToken:token};
  },
 };
 const options={...f.options,client:{options:{namespace:f.options.platform.temporalNamespace},connection:{
  options:{interceptors:[],channelArgs:{'grpc.enable_retries':0}},workflowService:service,withDeadline:(_end,fn)=>fn()}},
  before:async()=>proof(),after:async()=>({...proof(),protectionSHA256:'f'.repeat(64)}),authorizeMutation:async()=>{},
  save:async next=>{state=structuredClone(next);snapshots.push(state);}};
 return {f,options,service,snapshots,get state(){return state;},get attempts(){return attempts;}};
}
test('controls-only exact retained-chain promotion saves intent before one CAS and completed resume reads only',async()=>{
 const x=await fixture(),result=await promoteCloudRunControls(x.options);
 assert.equal(result.stage,'completed');assert.equal(result.outcome,'native-acknowledgement-and-readback');assert.equal(x.attempts,1);
 assert.equal(x.f.pool.scaling.manualInstanceCount,1);assert.equal(x.f.calls.filter(x=>x.method==='PATCH').length,3);
 await promoteCloudRunControls({...x.options,saved:result});assert.equal(x.attempts,1);
});
test('lost mutation ACK reconciles desired native routing without resend or causal claim',async()=>{
 const x=await fixture(),native=x.service.setWorkerDeploymentCurrentVersion;
 x.service.setWorkerDeploymentCurrentVersion=async request=>{await native(request);throw Object.assign(new Error('controlled lost ACK'),{code:14});};
 const result=await promoteCloudRunControls(x.options);
 assert.equal(result.outcome,'desired-routing-observed-after-unknown-ack');assert.equal(x.attempts,1);
 await promoteCloudRunControls({...x.options,saved:result});assert.equal(x.attempts,1);
});
test('attempt persisted but no accepted routing remains fenced and never resends on resume',async()=>{
 const x=await fixture();x.options.authorizeMutation=async()=>{throw new Error('authority changed');};
 await assert.rejects(promoteCloudRunControls(x.options));assert.equal(x.state.stage,'attempted');assert.equal(x.attempts,0);
 await assert.rejects(promoteCloudRunControls({...x.options,saved:x.state}));assert.equal(x.attempts,0);
});
test('native rejection remains rejected and never resends',async()=>{
 const x=await fixture();let count=0;
 x.service.setWorkerDeploymentCurrentVersion=async()=>{count++;throw Object.assign(new Error('native conflict'),{code:9});};
 await assert.rejects(promoteCloudRunControls(x.options));assert.equal(x.state.stage,'rejected');assert.equal(count,1);
 await assert.rejects(promoteCloudRunControls({...x.options,saved:x.state}));assert.equal(count,1);
});
test('definite native NOT_FOUND cannot adopt independently appearing desired routing',async()=>{
 const x=await fixture(),appear=x.service.setWorkerDeploymentCurrentVersion;
 x.service.setWorkerDeploymentCurrentVersion=async request=>{await appear(request);throw Object.assign(new Error('controlled definitive NOT_FOUND'),{code:5});};
 await assert.rejects(promoteCloudRunControls(x.options));
 assert.equal(x.state.stage,'rejected');
 await assert.rejects(promoteCloudRunControls({...x.options,saved:x.state}));assert.equal(x.attempts,1);
});
for(const bad of ['role','activation','pool','grants','retry','channel-retry','work-drift','late-authority','post-work-drift','post-peer-drift']){
 test(`controls promotion fences ${bad}`,async()=>{
  const x=await fixture();
  if(bad==='role')x.options.role='orchestration';
  if(bad==='activation')x.options.receipts.activation.identityState.disposition='stopped';
  if(bad==='pool')x.f.pool.uid='replacement';
  if(bad==='grants')x.f.policies.get('projects/urm-app-staging').bindings=[];
  if(bad==='retry')x.options.client.connection.options.interceptors=[()=>{}];
  if(bad==='channel-retry')x.options.client.connection.options.channelArgs['grpc.enable_retries']=1;
  if(bad==='work-drift'){const before=x.options.before;let n=0;x.options.before=async()=>({...await before(),protectionSHA256:(++n===1?'a':'f').repeat(64)});}
  if(bad==='late-authority'){const before=x.options.before;x.options.before=async()=>({...await before(),observedAt:new Date(Date.now()-6000).toISOString()});}
  if(bad==='post-work-drift'){const after=x.options.after;x.options.after=async()=>({...await after(),protectedWorkSHA256:'f'.repeat(64)});}
  if(bad==='post-peer-drift'){const after=x.options.after;x.options.after=async()=>({...await after(),peerRoutingSHA256:'f'.repeat(64)});}
  await assert.rejects(promoteCloudRunControls(x.options));assert.equal(x.attempts,bad.startsWith('post-')?1:0);
  assert.equal(x.f.pool.scaling.manualInstanceCount,1);
 });
}
