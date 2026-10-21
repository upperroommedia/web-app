import {validateCompletedControlsPromotionReceipt} from './temporal-promotion-receipt.mjs';
import {verifySearchPromotionPredecessor} from './temporal-promotion-predecessor.mjs';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { verifyControlsPromotionResources,verifySearchPromotionResources } from './temporal-bootstrap-pool.mjs';

const fail=()=>{throw new Error('CLOUD_RUN_CONTROLS_PROMOTION_UNCONFIRMED');};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
function fresh(p,role){
  if(p?.role!==role||!digest.test(p.protectionSHA256??'')||!digest.test(p.protectedWorkSHA256??'')||
    !digest.test(p.computeInventorySHA256??'')||!digest.test(p.peerRoutingSHA256??'')||!digest.test(p.bundleSHA256??'')||
    !Number.isFinite(Date.parse(p.observedAt??''))||Math.abs(Date.now()-Date.parse(p.observedAt))>5000)fail();
}
/** Fixed controls-first promotion; never scales, retires, rolls back or opens admission. */
async function promote(o,expectedRole){
  const {platform,role,operationId,releaseId,evidenceDigest,bindingDigest,receipts,settings,client,
    before,after,save,authorizeMutation}=o;
  const b=platform.roleBindings.find(x=>x.role===expectedRole),namespace=platform.temporalNamespace;
  if(role!==expectedRole||!['controls','search'].includes(expectedRole)||!uuid.test(operationId??'')||!uuid.test(releaseId??'')||!digest.test(evidenceDigest??'')||!digest.test(bindingDigest??'')||
    client.options.namespace!==namespace||!Array.isArray(client.connection.options?.interceptors)||client.connection.options.interceptors.length||
    client.connection.options?.channelArgs?.['grpc.enable_retries']!==0||[before,after,save,authorizeMutation].some(x=>typeof x!=='function'))fail();
  const plan={schemaVersion:1,operationId,operationBindingDigest:bindingDigest,releaseId,evidenceDigest,role,namespace,
    deploymentName:b.deploymentName,buildId:b.buildId,image:b.image,
    receiptsSHA256:proofDigest(receipts),settingsSHA256:proofDigest(settings)};
  let state=o.saved;
  const put=async next=>{await save(next);state=next;};
  const resources=async()=>{
    const {controlsPromotion,...ownReceipts}=receipts;
    if(role==='controls'&&controlsPromotion!==undefined)fail();
    const owned=await (role==='controls'?verifyControlsPromotionResources:verifySearchPromotionResources)({...o,receipts:ownReceipts,saved:undefined,observeProtection:before,observeRegistration:async()=>fail()});
    return role==='search'?{...owned,predecessor:await verifySearchPromotionPredecessor(o)}:owned;
  };
  const readTarget=()=>client.connection.withDeadline(Date.now()+5000,()=>client.connection.workflowService
    .describeWorkerDeployment({namespace,deploymentName:b.deploymentName}));
  try{
    if(state&&(!isDeepStrictEqual(state.plan,plan)||!['planned','attempted','acknowledged','completed','rejected'].includes(state.stage)))fail();
    if(!state)await put({plan,stage:'planned'});
    if(state.stage==='rejected')fail();
    if(state.stage==='planned'){
      const owned=await resources(),proof=await before(),target=await readTarget();fresh(proof,role);
      const token=target.conflictToken;
      const routing=target.workerDeploymentInfo?.routingConfig;
      if(!(token instanceof Uint8Array)||!token.length||token.length>4096||
        routing?.currentDeploymentVersion||routing?.rampingDeploymentVersion||Number(routing?.rampingVersionPercentage??0)!==0)fail();
      const request={namespace,deploymentName:b.deploymentName,buildId:b.buildId,
        conflictTokenBase64:Buffer.from(token).toString('base64'),identity:`urm-${role}-promotion-${operationId}`};
      await put({plan,stage:'attempted',attemptedAt:new Date().toISOString(),request,proof,resources:owned});
      const repeated=await resources(),atSend=await before(),current=await readTarget();
      fresh(proof,role);fresh(atSend,role);
      if(!isDeepStrictEqual(repeated,owned)||atSend.protectionSHA256!==proof.protectionSHA256||
        atSend.computeInventorySHA256!==proof.computeInventorySHA256||
        Buffer.from(current.conflictToken??[]).toString('base64')!==request.conflictTokenBase64)fail();
      await authorizeMutation();fresh(proof,role);fresh(atSend,role);
      // Source-owned connection disables SDK/gRPC retry layers. Exactly one call;
      // an unknown result is retained for GET-only reconciliation, never resent.
      let ack;
      try{
        ack=await client.connection.withDeadline(Date.now()+5000,()=>client.connection.workflowService
          .setWorkerDeploymentCurrentVersion({namespace,deploymentName:b.deploymentName,buildId:b.buildId,
            conflictToken:Buffer.from(request.conflictTokenBase64,'base64'),identity:request.identity}));
      }catch(error){
        if([3,5,6,7,9,11,12,16].includes(error?.code)){await put({...state,stage:'rejected',rejectedCode:error.code});fail();}
      }
      if(ack){
        if(!(ack.conflictToken instanceof Uint8Array)||!ack.conflictToken.length)fail();
        await put({...state,stage:'acknowledged',acknowledgement:{conflictTokenBase64:Buffer.from(ack.conflictToken).toString('base64')}});
      }
    }
    if(!state.proof||!state.resources||!Number.isFinite(Date.parse(state.attemptedAt??''))||
      ['protectionSHA256','protectedWorkSHA256','computeInventorySHA256','peerRoutingSHA256','bundleSHA256'].some(key=>!digest.test(state.proof[key]??''))||
      !isDeepStrictEqual(state.request,{namespace,deploymentName:b.deploymentName,buildId:b.buildId,
        conflictTokenBase64:state.request?.conflictTokenBase64,identity:`urm-${role}-promotion-${operationId}`})||
      typeof state.request.conflictTokenBase64!=='string'||!state.request.conflictTokenBase64||
      Buffer.from(state.request.conflictTokenBase64,'base64').toString('base64')!==state.request.conflictTokenBase64)fail();
    if(!isDeepStrictEqual(await resources(),state.resources))fail();
    const observed=await after();fresh(observed,role);
    if(observed.protectedWorkSHA256!==state.proof.protectedWorkSHA256||
      observed.peerRoutingSHA256!==state.proof.peerRoutingSHA256||observed.bundleSHA256!==state.proof.bundleSHA256)fail();
    const target=await readTarget(),routing=target.workerDeploymentInfo?.routingConfig;
    if(routing?.currentDeploymentVersion?.deploymentName!==b.deploymentName||routing.currentDeploymentVersion.buildId!==b.buildId||
      routing.rampingDeploymentVersion||Number(routing.rampingVersionPercentage??0)!==0)fail();
    if(state.acknowledgement&&Buffer.from(target.conflictToken??[]).toString('base64')!==state.acknowledgement.conflictTokenBase64)fail();
    if(state.stage==='completed'){
      if(proofDigest(state.observed.queueRouting)!==proofDigest(observed.queueRouting))fail();
      return state;
    }
    await authorizeMutation();fresh(observed,role);
    const completed={...state,stage:'completed',observed,verifiedAt:new Date().toISOString(),
      outcome:state.stage==='acknowledged'?'native-acknowledgement-and-readback':'desired-routing-observed-after-unknown-ack',
      scope:`${role}-only routing observation; unknown ACK not causal; no admission/ownership/WCI/retirement or readiness advance`};
    if(role==='controls')validateCompletedControlsPromotionReceipt({receipt:{operationId,releaseId,bindingDigest,identityState:completed},platform,releaseId,evidenceDigest});
    await put(completed);
    return state;
  }catch{return fail();}
}

export const promoteCloudRunControls=o=>promote(o,'controls');
export const promoteCloudRunSearch=o=>promote(o,'search');
