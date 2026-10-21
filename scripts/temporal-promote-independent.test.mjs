import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {controlsBootstrapFixture} from './tests/fixtures/controls-bootstrap.mjs';
import * as pools from './temporal-bootstrap-pool.mjs';
import * as promotions from './temporal-promote-controls.mjs';
import {independentPromotionPredecessor as previous} from './temporal-promotion-roles.mjs';
const cap=r=>r[0].toUpperCase()+r.slice(1);
/** Controlled producer shape only. Actual native predecessor production is tested separately. */
function receipt(platform,role,releaseId,evidenceDigest){
 const b=platform.roleBindings.find(x=>x.role===role),id=randomUUID(),stamp=new Date().toISOString(),bindingDigest='c'.repeat(64);
 const own='e'.repeat(64),full=previous[role]?'f'.repeat(64):own,predecessor=previous[role]?'a'.repeat(64):null;
 const proof={role,buildId:b.buildId,namespace:platform.temporalNamespace,observedAt:stamp,protectionSHA256:'a'.repeat(64),protectedWorkSHA256:'b'.repeat(64),computeInventorySHA256:'c'.repeat(64),peerRoutingSHA256:'d'.repeat(64),bundleSHA256:'e'.repeat(64),queueRouting:{current:{deploymentName:'urm-worker-staging',buildId:'old'}}};
 const resources={role,buildId:b.buildId,receiptsSHA256:own,pool:{name:`projects/${b.projectId}/locations/${b.region}/workerPools/${b.poolName}`,uid:'owned',generation:'4',revision:'owned-revision',desiredManualInstanceCount:1},access:{runnerUniqueId:'11111111111111111111',scalerUniqueId:'22222222222222222222'},...(previous[role]?{predecessor:{role:previous[role],receiptSHA256:predecessor}}:{})};
 return {operationId:id,releaseId,bindingDigest,identityState:{stage:'completed',attemptedAt:stamp,verifiedAt:stamp,outcome:'native-acknowledgement-and-readback',acknowledgement:{conflictTokenBase64:Buffer.from('after').toString('base64')},
  plan:{schemaVersion:1,operationId:id,operationBindingDigest:bindingDigest,releaseId,evidenceDigest,role,namespace:platform.temporalNamespace,deploymentName:b.deploymentName,buildId:b.buildId,image:b.image,receiptsSHA256:full,ownReceiptsSHA256:own,predecessorReceiptSHA256:predecessor,settingsSHA256:'e'.repeat(64)},
  request:{namespace:platform.temporalNamespace,deploymentName:b.deploymentName,buildId:b.buildId,identity:`urm-${role}-promotion-${id}`,conflictTokenBase64:Buffer.from('before').toString('base64')},resources,proof,
  observed:{...structuredClone(proof),queueRouting:{current:{deploymentName:b.deploymentName,buildId:b.buildId},pollers:[{identity:'owned',deploymentOptions:{deploymentName:b.deploymentName,buildId:b.buildId}}]}}}};
}
async function fixture(role){
 const f=controlsBootstrapFixture(role);
 for(const [key,run] of [['bootstrapCycle',pools[`bootstrapStopCloudRun${cap(role)}Pool`]],['activation',pools[`activateCloudRun${cap(role)}Pool`]]]){
  const identityState=await run(f.options);f.options.receipts[key]={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(identityState)};f.options.operationId=randomUUID();
 }
 const prev=previous[role],b=f.options.platform.roleBindings.find(x=>x.role===role),pb=f.options.platform.roleBindings.find(x=>x.role===prev);
 const predecessor=receipt(f.options.platform,prev,f.options.releaseId,f.options.evidenceDigest);f.options.receipts[`${prev}Promotion`]=predecessor;
 let state,target=null,token=Buffer.from('before'),calls=0;
 const service={describeWorkerDeployment:async({deploymentName})=>({conflictToken:token,workerDeploymentInfo:{name:deploymentName,routingConfig:{...(deploymentName!==b.deploymentName?{currentDeploymentVersion:{deploymentName,buildId:f.options.platform.roleBindings.find(x=>x.deploymentName===deploymentName).buildId}}:target?{currentDeploymentVersion:target}:{})}}}),
  describeWorkerDeploymentVersion:async({deploymentVersion})=>({workerDeploymentVersionInfo:{deploymentVersion,taskQueueInfos:[{name:`urm-${f.options.platform.roleBindings.find(x=>x.deploymentName===deploymentVersion.deploymentName).role}`,type:2}]}}),
  describeTaskQueue:async({taskQueue})=>{const q=f.options.platform.roleBindings.find(x=>`urm-${x.role}`===taskQueue.name);return {versioningInfo:{currentDeploymentVersion:{deploymentName:q.deploymentName,buildId:q.buildId}},pollers:[{identity:'owned',deploymentOptions:{deploymentName:q.deploymentName,buildId:q.buildId}}]};},
  setWorkerDeploymentCurrentVersion:async request=>{assert.equal(state.stage,'attempted');assert.equal(request.deploymentName,b.deploymentName);calls++;target={deploymentName:b.deploymentName,buildId:b.buildId};token=Buffer.from('after');return {conflictToken:token};}};
 const proof=()=>({role,buildId:b.buildId,namespace:f.options.platform.temporalNamespace,observedAt:new Date().toISOString(),protectionSHA256:'a'.repeat(64),protectedWorkSHA256:'b'.repeat(64),computeInventorySHA256:'c'.repeat(64),peerRoutingSHA256:'d'.repeat(64),bundleSHA256:'e'.repeat(64),queueRouting:{current:target??{deploymentName:'urm-worker-staging',buildId:'old'},pollers:[{identity:'owned',deploymentOptions:{deploymentName:b.deploymentName,buildId:b.buildId}}]}});
 const options={...f.options,client:{options:{namespace:f.options.platform.temporalNamespace},connection:{options:{interceptors:[],channelArgs:{'grpc.enable_retries':0}},workflowService:service,withDeadline:(_d,fn)=>fn()}},before:async()=>proof(),after:async()=>proof(),authorizeMutation:async()=>{},save:async s=>{state=structuredClone(s);}};
 return {f,options,service,predecessor,run:promotions[`promoteCloudRun${cap(role)}`],get state(){return state;},get calls(){return calls;}};
}
for(const role of ['email','images']){
 test(`${role} own resource-safe promotion consumes exact completed/native predecessor and resumes GET-only`,async()=>{
  const x=await fixture(role),api=x.options.api;
  x.options.api=async(...args)=>{if(args[0].includes('cloudquotas.googleapis.com'))throw new Error('No new allocation');return api(...args);};
  const result=await x.run(x.options);assert.equal(result.stage,'completed');assert.equal(x.calls,1);assert.equal(result.resources.predecessor.role,previous[role]);
  await x.run({...x.options,saved:result});assert.equal(x.calls,1);assert.equal(x.f.pool.scaling.manualInstanceCount,1);
  if(role==='email')assert.equal(x.f.calls.some(x=>x.url.includes('storage.googleapis.com')),false);
 });
 for(const bad of ['ancestor-drift','role','missing-predecessor','missing-intent','foreign-binding','wrong-predecessor','native-extra-queue','native-ramp','native-no-poller','pool','secret','bucket'])test(`${role} promotion fences ${bad}`,async()=>{
  const x=await fixture(role);
  if(bad==='ancestor-drift'){const fn=x.service.describeWorkerDeployment;x.service.describeWorkerDeployment=async req=>{const r=await fn(req);if(req.deploymentName===x.options.platform.roleBindings.find(b=>b.role==='controls').deploymentName)r.workerDeploymentInfo.routingConfig.currentDeploymentVersion={deploymentName:req.deploymentName,buildId:'drifted'};return r;};}
  if(bad==='role')x.options.role='orchestration';
  if(bad==='missing-predecessor')delete x.options.receipts[`${previous[role]}Promotion`];
  if(bad==='missing-intent')delete x.predecessor.identityState.request;
  if(bad==='foreign-binding')x.predecessor.identityState.plan.operationBindingDigest='f'.repeat(64);
  if(bad==='wrong-predecessor')x.predecessor.identityState.plan.role='controls';
  if(bad==='native-extra-queue'){const fn=x.service.describeWorkerDeploymentVersion;x.service.describeWorkerDeploymentVersion=async req=>{const r=await fn(req);r.workerDeploymentVersionInfo.taskQueueInfos.push({name:`urm-${previous[role]}`,type:1});return r;};}
  if(bad==='native-ramp'){const fn=x.service.describeWorkerDeployment;x.service.describeWorkerDeployment=async req=>{const r=await fn(req);r.workerDeploymentInfo.routingConfig.rampingVersionPercentage=1;return r;};}
  if(bad==='native-no-poller')x.service.describeTaskQueue=async()=>({});
  if(bad==='pool')x.f.pool.uid='replacement';
  if(bad==='secret'){const fn=x.options.api;x.options.api=async(...a)=>{const r=await fn(...a);if(a[0].includes('/versions/'))r.state='DISABLED';return r;};}
  if(bad==='bucket'){
   if(role==='email')x.options.receipts.storageRole={};else x.f.bucket.timeCreated='2020-01-01T00:00:00Z';
  }
  await assert.rejects(x.run(x.options));assert.equal(x.calls,0);assert.equal(x.f.pool.scaling.manualInstanceCount,1);
 });
}

test('media core and canonical adapter deny before credentials or operations until native capacity is connected',async()=>{
 const {runCloudRunMediaPromotion}=await import('./temporal-release-cloud-run.mjs');
 const options=new Proxy({},{get(){throw new Error('No access before capacity fence');}});
 for(const run of [promotions.promoteCloudRunMedia,runCloudRunMediaPromotion])await assert.rejects(run(options),/CLOUD_RUN_MEDIA_NATIVE_CAPACITY_PROOF_REQUIRED/);
});
