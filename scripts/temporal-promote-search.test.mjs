import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {controlsBootstrapFixture} from './tests/fixtures/controls-bootstrap.mjs';
import {bootstrapStopCloudRunSearchPool,activateCloudRunSearchPool} from './temporal-bootstrap-pool.mjs';
import {promoteCloudRunSearch} from './temporal-promote-controls.mjs';
import {proofDigest} from './temporal-release-runtime.mjs';

async function fixture(){
 const f=controlsBootstrapFixture('search');
 for(const [key,run] of [['bootstrapCycle',bootstrapStopCloudRunSearchPool],['activation',activateCloudRunSearchPool]]){
  const identityState=await run(f.options);f.options.receipts[key]={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(identityState)};f.options.operationId=randomUUID();
 }
 const c=f.options.platform.roleBindings.find(x=>x.role==='controls'),b=f.options.platform.roleBindings.find(x=>x.role==='search');
 const bindingDigest='d'.repeat(64),id=randomUUID();
 const predecessor={operationId:id,releaseId:f.options.releaseId,bindingDigest,identityState:{stage:'completed',outcome:'native-acknowledgement-and-readback',
  plan:{schemaVersion:1,operationId:id,releaseId:f.options.releaseId,evidenceDigest:f.options.evidenceDigest,role:'controls',namespace:f.options.platform.temporalNamespace,deploymentName:c.deploymentName,buildId:c.buildId,image:c.image,receiptsSHA256:'e'.repeat(64),settingsSHA256:'f'.repeat(64)},
  request:{namespace:f.options.platform.temporalNamespace,deploymentName:c.deploymentName,buildId:c.buildId,identity:`urm-controls-promotion-${id}`}}};
 const stamp=new Date().toISOString(),state=predecessor.identityState;
 state.plan.operationBindingDigest=bindingDigest;
 state.attemptedAt=stamp;state.verifiedAt=stamp;state.request.conflictTokenBase64=Buffer.from('before').toString('base64');state.acknowledgement={conflictTokenBase64:Buffer.from('after').toString('base64')};
 state.resources={role:'controls',buildId:c.buildId,receiptsSHA256:state.plan.receiptsSHA256,pool:{name:`projects/${c.projectId}/locations/${c.region}/workerPools/${c.poolName}`,uid:'owned-controls-pool',generation:'4',revision:'owned-controls-revision',desiredManualInstanceCount:1},access:{runnerUniqueId:'11111111111111111111',scalerUniqueId:'22222222222222222222'}};
 state.proof={role:'controls',buildId:c.buildId,namespace:f.options.platform.temporalNamespace,observedAt:stamp,protectionSHA256:'a'.repeat(64),protectedWorkSHA256:'b'.repeat(64),computeInventorySHA256:'c'.repeat(64),peerRoutingSHA256:'d'.repeat(64),bundleSHA256:'e'.repeat(64),queueRouting:{current:{deploymentName:'urm-worker-staging',buildId:'old'}}};
 state.observed={...structuredClone(state.proof),queueRouting:{current:{deploymentName:c.deploymentName,buildId:c.buildId},pollers:[{identity:'owned-controls',deploymentOptions:{deploymentName:c.deploymentName,buildId:c.buildId}}]}};
 f.options.receipts.controlsPromotion=predecessor;
 let saved,target=null,token=Buffer.from('before'),calls=0;
 const service={
  describeWorkerDeployment:async({deploymentName})=>({conflictToken:token,workerDeploymentInfo:{name:deploymentName,routingConfig:{...(deploymentName===c.deploymentName?{currentDeploymentVersion:{deploymentName,buildId:c.buildId}}:target?{currentDeploymentVersion:target}:{})}}}),
  describeWorkerDeploymentVersion:async()=>({workerDeploymentVersionInfo:{deploymentVersion:{deploymentName:c.deploymentName,buildId:c.buildId},taskQueueInfos:[{name:'urm-controls',type:2}]}}),
  describeTaskQueue:async()=>({versioningInfo:{currentDeploymentVersion:{deploymentName:c.deploymentName,buildId:c.buildId}},pollers:[{identity:'owned-controls',deploymentOptions:{deploymentName:c.deploymentName,buildId:c.buildId}}]}),
  setWorkerDeploymentCurrentVersion:async request=>{assert.equal(saved.stage,'attempted');assert.equal(request.deploymentName,b.deploymentName);calls++;target={deploymentName:b.deploymentName,buildId:b.buildId};token=Buffer.from('after');return {conflictToken:token};},
 };
 const proof=()=>({role:'search',buildId:b.buildId,namespace:f.options.platform.temporalNamespace,observedAt:new Date().toISOString(),protectionSHA256:'a'.repeat(64),protectedWorkSHA256:'b'.repeat(64),computeInventorySHA256:'c'.repeat(64),peerRoutingSHA256:'d'.repeat(64),bundleSHA256:'e'.repeat(64),queueRouting:{current:target}});
 const options={...f.options,bindingDigest,client:{options:{namespace:f.options.platform.temporalNamespace},connection:{options:{interceptors:[],channelArgs:{'grpc.enable_retries':0}},workflowService:service,withDeadline:(_d,fn)=>fn()}},before:async()=>proof(),after:async()=>proof(),authorizeMutation:async()=>{},save:async s=>{saved=structuredClone(s);}};
 return {f,options,service,predecessor,get saved(){return saved;},get calls(){return calls;}};
}
test('search promotion requires own receipts plus completed owned controls/current native predecessor and resumes GET-only',async()=>{
 const x=await fixture(),result=await promoteCloudRunSearch(x.options);
 assert.equal(result.stage,'completed');assert.equal(result.plan.role,'search');assert.equal(x.calls,1);
 assert.equal(x.f.calls.some(c=>c.url.includes('storage.googleapis.com')),false);
 await promoteCloudRunSearch({...x.options,saved:result});assert.equal(x.calls,1);
});
test('controls and search have distinct own operation bindings',async()=>{
 const x=await fixture(),identity={operatorCommit:'a'.repeat(40),runtimeCommit:'b'.repeat(40),releaseId:x.options.releaseId};
 const producer=proofDigest({...identity,cloudIdentityPreparation:{role:'controls',settings:'controls-settings',runnerOperationId:x.predecessor.operationId,receiptsDigest:x.predecessor.identityState.plan.receiptsSHA256}});
 const consumer=proofDigest({...identity,cloudIdentityPreparation:{role:'search',settings:'search-settings',runnerOperationId:x.options.receipts.runner.operationId,receiptsDigest:proofDigest(x.options.receipts)}});
 assert.notEqual(producer,consumer);x.options.bindingDigest=consumer;x.predecessor.bindingDigest=producer;x.predecessor.identityState.plan.operationBindingDigest=producer;
 await promoteCloudRunSearch(x.options);assert.equal(x.calls,1);
});
test('current controls routing cannot replace missing original producer evidence',async()=>{
 const x=await fixture();delete x.predecessor.identityState.proof;delete x.predecessor.identityState.request.conflictTokenBase64;
 await assert.rejects(promoteCloudRunSearch(x.options));assert.equal(x.calls,0);
});
for(const key of ['proof','resources','observed','attemptedAt','verifiedAt','acknowledgement'])test(`search denies a completed producer missing ${key}`,async()=>{
 const x=await fixture();delete x.predecessor.identityState[key];await assert.rejects(promoteCloudRunSearch(x.options));assert.equal(x.calls,0);
});
for(const bad of ['missing','binding','release','role','image','unfinished','native-not-current','native-extra-queue','native-no-poller','predecessor-drift','storage-receipt'])test(`search promotion fences ${bad}`,async()=>{
 const x=await fixture();
 if(bad==='missing')delete x.options.receipts.controlsPromotion;
 if(bad==='binding')x.predecessor.bindingDigest='f'.repeat(64);
 if(bad==='release')x.predecessor.releaseId=randomUUID();
 if(bad==='role')x.predecessor.identityState.plan.role='search';
 if(bad==='image')x.predecessor.identityState.plan.image+='foreign';
 if(bad==='unfinished')x.predecessor.identityState.stage='attempted';
 if(bad==='native-not-current'){const fn=x.service.describeWorkerDeployment;x.service.describeWorkerDeployment=async req=>{const r=await fn(req);delete r.workerDeploymentInfo.routingConfig.currentDeploymentVersion;return r;};}
 if(bad==='native-extra-queue'){const fn=x.service.describeWorkerDeploymentVersion;x.service.describeWorkerDeploymentVersion=async()=>{const r=await fn();r.workerDeploymentVersionInfo.taskQueueInfos.push({name:'urm-controls',type:1});return r;};}
 if(bad==='native-no-poller')x.service.describeTaskQueue=async()=>({});
 if(bad==='predecessor-drift'){const fn=x.service.describeWorkerDeployment;let n=0;x.service.describeWorkerDeployment=async req=>{const r=await fn(req);if(req.deploymentName.includes('controls')&&++n>1)r.workerDeploymentInfo.routingConfig.rampingVersionPercentage=1;return r;};}
 if(bad==='storage-receipt')x.options.receipts.storageRole={};
 await assert.rejects(promoteCloudRunSearch(x.options));assert.equal(x.calls,0);assert.equal(x.f.pool.scaling.manualInstanceCount,1);
});
