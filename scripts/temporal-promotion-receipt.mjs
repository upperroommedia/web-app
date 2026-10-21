import {isDeepStrictEqual} from 'node:util';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const token=x=>typeof x==='string'&&x.length>0&&x.length<=5464&&Buffer.from(x,'base64').length<=4096&&Buffer.from(x,'base64').toString('base64')===x;
const fail=()=>{throw new Error('COMPLETED_CONTROLS_PROMOTION_EVIDENCE_REQUIRED');};
/** Producer and consumers share this structural certificate check. Native routing
 * is checked separately; current state cannot manufacture an original intent. */
export function validateCompletedControlsPromotionReceipt({receipt:r,platform,releaseId,evidenceDigest}){
 const s=r?.identityState,p=s?.plan,b=platform.roleBindings.find(x=>x.role==='controls'),old=platform.roleBindings.find(x=>x.role==='orchestration');
 if(!r||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.operationId??'')||r.releaseId!==releaseId||!hash(r.bindingDigest)||
  s?.stage!=='completed'||p?.schemaVersion!==1||p.operationId!==r.operationId||p.operationBindingDigest!==r.bindingDigest||p.releaseId!==releaseId||p.evidenceDigest!==evidenceDigest||p.role!=='controls'||
  p.namespace!==platform.temporalNamespace||p.deploymentName!==b.deploymentName||p.buildId!==b.buildId||p.image!==b.image||!hash(p.settingsSHA256)||!hash(p.receiptsSHA256)||
  !token(s.request?.conflictTokenBase64)||!isDeepStrictEqual(s.request,{namespace:p.namespace,deploymentName:p.deploymentName,buildId:p.buildId,conflictTokenBase64:s.request.conflictTokenBase64,identity:`urm-controls-promotion-${r.operationId}`}))fail();
 const attempt=Date.parse(s.attemptedAt??''),done=Date.parse(s.verifiedAt??''),pre=s.proof,post=s.observed;
 if(!Number.isFinite(attempt)||!Number.isFinite(done)||done<attempt||!pre||!post)fail();
 for(const proof of [pre,post]){
  if(proof.role!=='controls'||proof.buildId!==b.buildId||proof.namespace!==p.namespace||!Number.isFinite(Date.parse(proof.observedAt??''))||
   ['protectionSHA256','protectedWorkSHA256','computeInventorySHA256','peerRoutingSHA256','bundleSHA256'].some(k=>!hash(proof[k])))fail();
 }
 if(Date.parse(pre.observedAt)>attempt||attempt-Date.parse(pre.observedAt)>5000||Date.parse(post.observedAt)<attempt||Date.parse(post.observedAt)>done||
  ['protectedWorkSHA256','peerRoutingSHA256','bundleSHA256'].some(k=>pre[k]!==post[k])||
  pre.queueRouting?.current?.deploymentName!==old.deploymentName||!pre.queueRouting.current.buildId||pre.queueRouting.current.buildId===b.buildId||
  post.queueRouting?.current?.deploymentName!==b.deploymentName||post.queueRouting.current.buildId!==b.buildId||
  !Array.isArray(post.queueRouting.pollers)||!post.queueRouting.pollers.length||post.queueRouting.pollers.some(x=>typeof x.identity!=='string'||!x.identity||x.deploymentOptions?.deploymentName!==b.deploymentName||x.deploymentOptions.buildId!==b.buildId))fail();
 const resources=s.resources,pool=resources?.pool;
 if(resources?.role!=='controls'||resources.buildId!==b.buildId||resources.receiptsSHA256!==p.receiptsSHA256||
  pool?.name!==`projects/${b.projectId}/locations/${b.region}/workerPools/${b.poolName}`||typeof pool.uid!=='string'||!pool.uid||pool.desiredManualInstanceCount!==1||
  !/^[1-9][0-9]*$/.test(String(pool.generation??''))||typeof pool.revision!=='string'||!pool.revision||
  !/^[0-9]{6,32}$/.test(resources.access?.runnerUniqueId??'')||!/^[0-9]{6,32}$/.test(resources.access?.scalerUniqueId??''))fail();
 if(s.outcome==='native-acknowledgement-and-readback'?!token(s.acknowledgement?.conflictTokenBase64):s.outcome!=='desired-routing-observed-after-unknown-ack'||s.acknowledgement!==undefined)fail();
 return s;
}
