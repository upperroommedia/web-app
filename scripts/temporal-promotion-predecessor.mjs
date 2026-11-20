import {independentPromotionPredecessor,independentPromotionRoles} from './temporal-promotion-roles.mjs';
import {validateCompletedRolePromotionReceipt} from './temporal-promotion-receipt.mjs';
import {proofDigest} from './temporal-release-runtime.mjs';
const fail=()=>{throw new Error('CLOUD_RUN_CONTROLS_PREDECESSOR_UNCONFIRMED');};
/** A completed owned source operation plus fresh native routing, never name adoption. */
async function verifyPredecessor({platform,receipts,releaseId,evidenceDigest,client},role){
 const previous=independentPromotionPredecessor[role];if(!previous)fail();
 const r=receipts[`${previous}Promotion`];
 validateCompletedRolePromotionReceipt({receipt:r,platform,releaseId,evidenceDigest,role:previous});
 const namespace=platform.temporalNamespace,service=client.connection.workflowService;
 const rpc=fn=>client.connection.withDeadline(Date.now()+5000,fn);
 const prefix=[];
 for(const ancestor of independentPromotionRoles.slice(0,independentPromotionRoles.indexOf(role))){
 const b=platform.roleBindings.find(x=>x.role===ancestor);if(!b)fail();
 const deployment=await rpc(()=>service.describeWorkerDeployment({namespace,deploymentName:b.deploymentName}));
 const routing=deployment.workerDeploymentInfo?.routingConfig;
 const version=await rpc(()=>service.describeWorkerDeploymentVersion({namespace,deploymentVersion:{deploymentName:b.deploymentName,buildId:b.buildId}}));
 const info=version.workerDeploymentVersionInfo,queues=info?.taskQueueInfos;
 const queue=await rpc(()=>service.describeTaskQueue({namespace,taskQueue:{name:`urm-${ancestor}`},taskQueueType:2})),q=queue.versioningInfo;
 if(deployment.workerDeploymentInfo?.name!==b.deploymentName||routing?.currentDeploymentVersion?.deploymentName!==b.deploymentName||routing.currentDeploymentVersion.buildId!==b.buildId||
   routing.rampingDeploymentVersion||Number(routing.rampingVersionPercentage??0)!==0||
   info?.deploymentVersion?.deploymentName!==b.deploymentName||info.deploymentVersion.buildId!==b.buildId||!Array.isArray(queues)||queues.length!==1||queues[0].name!==`urm-${ancestor}`||queues[0].type!==2||
   q?.currentDeploymentVersion?.deploymentName!==b.deploymentName||q.currentDeploymentVersion.buildId!==b.buildId||q.rampingDeploymentVersion||Number(q.rampingVersionPercentage??0)!==0||
   !Array.isArray(queue.pollers)||!queue.pollers.some(x=>x.deploymentOptions?.deploymentName===b.deploymentName&&x.deploymentOptions.buildId===b.buildId&&typeof x.identity==='string'&&x.identity))fail();
 prefix.push({role:ancestor,deploymentName:b.deploymentName,buildId:b.buildId,routingSHA256:proofDigest(routing)});
 }
 const immediate=prefix.at(-1);
 return {...immediate,role:previous,receiptSHA256:proofDigest(r),prefixRoutingSHA256:proofDigest(prefix)};
}

export const verifySearchPromotionPredecessor=o=>verifyPredecessor(o,'search');

export const verifyEmailPromotionPredecessor=o=>verifyPredecessor(o,'email');

export const verifyImagesPromotionPredecessor=o=>verifyPredecessor(o,'images');

export const verifyMediaPromotionPredecessor=o=>verifyPredecessor(o,'media');
