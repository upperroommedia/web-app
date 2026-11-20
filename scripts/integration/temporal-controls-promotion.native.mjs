import * as poolOperations from '../temporal-bootstrap-pool.mjs';
import * as promotionOperations from '../temporal-promote-controls.mjs';
import * as promotionObservations from '../temporal-bootstrap-observations.mjs';
import * as promotionCheckpoints from '../temporal-preparation-checkpoint.mjs';
import {independentPromotionRoles,independentPromotionPredecessor} from '../temporal-promotion-roles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {controlsBootstrapFixture} from '../tests/fixtures/controls-bootstrap.mjs';
import {nativeSnapshotProof} from '../temporal-release-runtime.mjs';
const require=createRequire(new URL('../../package.json',import.meta.url));
require('ts-node').register({skipProject:true,transpileOnly:true,compilerOptions:{module:'CommonJS',target:'ES2022',esModuleInterop:true,moduleResolution:'node'}});
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getFirestore}=require('firebase-admin/firestore');
const {Connection,Client}=require('@temporalio/client');
const {Runtime,DefaultLogger,Worker,bundleWorkflowCode}=require('@temporalio/worker');
const {createLocalTestEnvironment}=require(fileURLToPath(new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts',import.meta.url)));
const {msToTs}=require('@temporalio/common/lib/time');
const config=require(fileURLToPath(new URL('../../firebase.test.json',import.meta.url)));
Runtime.install({logger:new DefaultLogger('ERROR',()=>undefined)});
const bounded=(p,ms=10000)=>{let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned promotion fixture deadline')),ms);})]).finally(()=>clearTimeout(timer));};
for(const role of independentPromotionRoles.filter(r=>r!=='media'))for(const drift of ['none','control','state'])test(`native ${role} promotion and original replay / authority ${drift}`,async()=>{
 if(process.env.FIRESTORE_EMULATOR_HOST!==`127.0.0.1:${config.emulators.firestore.port}`)throw new Error('Dedicated test emulator required');
 const prepare=async(r,releaseId)=>{
  const f=controlsBootstrapFixture(r,{releaseId});
  for(const [name,run] of [['bootstrapCycle',poolOperations[`bootstrapStopCloudRun${cap(r)}Pool`]],['activation',poolOperations[`activateCloudRun${cap(r)}Pool`]]]){
   const identityState=await run(f.options);f.options.receipts[name]={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(identityState)};f.options.operationId=randomUUID();
  }return f;
 };
 const f=await prepare(role),chain=independentPromotionRoles.slice(0,independentPromotionRoles.indexOf(role)),fixtures={};
 for(const r of chain)fixtures[r]=await prepare(r,f.options.releaseId);
 const env=await createLocalTestEnvironment({server:{executable:{type:'cached-download',version:'v1.9.1'}}});
 const app=initializeApp({projectId:'urm-app-staging'},`promotion-${randomUUID()}`),db=getFirestore(app);
 const workers=[],failures=[];let connection,original,ownedOperation,attempts=0,drifted=false;
 const operationId=f.options.operationId,releaseId=f.options.releaseId,bindingDigest='d'.repeat(64),platform=f.options.platform;
 const lockRef=db.doc('_control/temporalReleaseOperation'),controlRef=db.doc('_control/temporalRelease'),stateRef=db.doc('_control/temporalReleaseState'),immutableReceipt=db.doc(`_control/temporalCloud${cap(role)}Promotion-${operationId}`),allReceipts=[immutableReceipt];
 const namespace=platform.temporalNamespace,old={deploymentName:'urm-worker-staging',buildId:'old-native-fixture'};
 const rpc=fn=>bounded(connection.withDeadline(Date.now()+5000,fn),6000);
 try{
  connection=await bounded(Connection.connect({address:env.connection.options.address,interceptors:[],channelArgs:{'grpc.enable_retries':0},connectTimeout:5000}));
  const client=new Client({connection,namespace}),service=connection.workflowService;
  await rpc(()=>service.registerNamespace({namespace,workflowExecutionRetentionPeriod:msToTs(86400000)}));
  await controlRef.create({releaseId,admission:'paused',domains:Object.fromEntries(configureDomains().map(d=>[d,{admission:'paused'}]))});
  await stateRef.create({releaseId,phase:'provider-usage-ready'});
  await lockRef.create({operationId,releaseId,bindingDigest,action:'promote-cloud-run-controls'});
  ownedOperation=nativeSnapshotProof(await lockRef.get());
  const expectedAuthority={control:nativeSnapshotProof(await controlRef.get()),state:nativeSnapshotProof(await stateRef.get())};
  const workflowsPath=fileURLToPath(new URL('../../apps/temporal-worker/src/workflows/verification/index.ts',import.meta.url));
  const bundle=await bounded(bundleWorkflowCode({workflowsPath,logger:new DefaultLogger('ERROR',()=>undefined)}),30000);
  const launch=async(queue,version,workflow)=>{
   const worker=await Worker.create({connection:env.nativeConnection,namespace,taskQueue:queue,...(workflow?{workflowsPath}:{}),activities:{neverCalled:async()=>{throw new Error('Unexpected Activity');}},workerDeploymentOptions:{version,useWorkerVersioning:true,defaultVersioningBehavior:'PINNED'},shutdownGraceTime:'2 seconds',shutdownForceTime:'5 seconds'});
   const done=worker.run();void done.catch(e=>failures.push(e));workers.push({worker,done});
   const end=Date.now()+15000;
   while(Date.now()<end){try{const info=await rpc(()=>service.describeWorkerDeploymentVersion({namespace,deploymentVersion:version}));if(info.workerDeploymentVersionInfo?.taskQueueInfos?.some(q=>q.name===queue&&q.type===(workflow?1:2)))return;}catch(e){if(e.code!==5)throw e;}await new Promise(r=>setTimeout(r,50));}throw new Error('Registration absent');
  };
  const oldQueue=`old-${operationId}`;
  await launch(oldQueue,old,true);
  for(const r of [...chain,role]){const binding=platform.roleBindings.find(x=>x.role===r);await launch(`urm-${r}`,old,false);await launch(`urm-${r}`,{deploymentName:binding.deploymentName,buildId:binding.buildId},false);}
  const oldDescription=await rpc(()=>service.describeWorkerDeployment({namespace,deploymentName:old.deploymentName}));
  await rpc(()=>service.setWorkerDeploymentCurrentVersion({namespace,deploymentName:old.deploymentName,buildId:old.buildId,conflictToken:oldDescription.conflictToken,identity:'owned-fixture-old-current'}));
  original=await rpc(()=>client.workflow.start('WorkerRestartProbe',{workflowId:`original-${operationId}`,taskQueue:oldQueue,versioningOverride:{pinnedTo:old},workflowExecutionTimeout:'2 minutes'}));
  const originalStatus=await rpc(()=>original.query('workerRestartProbe.status'));
  const nativeSet=service.setWorkerDeploymentCurrentVersion.bind(service);
  service.setWorkerDeploymentCurrentVersion=async request=>{
   attempts++;const r=cap(platform.roleBindings.find(b=>b.deploymentName===request.deploymentName).role);assert.equal((await lockRef.get()).get(`cloud${r}Promotion.stage`),'attempted');return nativeSet(request);
  };
  const replayed=new Set();
  const replayHistory=async(history)=>{const digest=createHash('sha256').update(JSON.stringify(history)).digest('hex');if(!replayed.has(digest)){await bounded(Worker.runReplayHistory({workflowBundle:bundle},history),20000);replayed.add(digest);}};
  const makeOptions=async(fixture,r,receipt,injectDrift)=>{
   const activeId=fixture.options.operationId,bindingDigest=({controls:'c',search:'d',email:'e',images:'f',media:'a'}[r]).repeat(64);
   await lockRef.set({operationId:activeId,releaseId,bindingDigest,action:`promote-cloud-run-${r}`});ownedOperation=nativeSnapshotProof(await lockRef.get());
   const observation={client,firestore:db,platform,role:r,operationId:activeId,releaseId,bindingDigest,expectedAuthority,bundleSHA256:createHash('sha256').update(bundle.code).digest('hex'),replayHistory};
   const authority=()=>({firestore:db,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config:{releaseId,domains:configureDomains()},operationId:activeId,bindingDigest});
   const checkpoint=promotionCheckpoints[`save${cap(r)}PromotionCheckpoint`],authorize=promotionCheckpoints[`assert${cap(r)}PromotionAuthority`];
   return {authority,checkpoint,options:{...fixture.options,bindingDigest,client,before:()=>promotionObservations[`observe${cap(r)}PromotionBefore`](observation),after:()=>promotionObservations[`observe${cap(r)}PromotionAfter`](observation),authorizeMutation:()=>authorize(authority()),save:async identityState=>{ownedOperation=await checkpoint({...authority(),immutableReceipt:receipt,operatorPrincipal:{fixture:true},identityState});if(injectDrift&&drift!=='none'&&!drifted&&identityState.stage==='attempted'){drifted=true;await (drift==='control'?controlRef:stateRef).update({changedAtCredentialBoundary:true});}}}};
  };
  let predecessorReceipt;
  for(const r of chain){
   const current=fixtures[r],previous=independentPromotionPredecessor[r];
   if(previous)current.options.receipts[`${previous}Promotion`]=predecessorReceipt;
   const receipt=db.doc(`_control/temporalCloud${cap(r)}Promotion-${current.options.operationId}`);allReceipts.push(receipt);
   const setup=await makeOptions(current,r,receipt,false);await promotionOperations[`promoteCloudRun${cap(r)}`](setup.options);assert.equal(attempts,1);
   predecessorReceipt=(await receipt.get()).data();attempts=0;
  }
  if(chain.length)f.options.receipts[`${independentPromotionPredecessor[role]}Promotion`]=predecessorReceipt;
  const {options,authority,checkpoint}=await makeOptions(f,role,immutableReceipt,true);
  const run=promotionOperations[`promoteCloudRun${cap(role)}`],authorize=promotionCheckpoints[`assert${cap(role)}PromotionAuthority`],field=`cloud${cap(role)}Promotion`;
  if(drift!=='none'){
   await assert.rejects(run(options));
   const saved=(await lockRef.get()).get(field);
   assert.equal(saved.stage,'attempted');assert.equal(attempts,0);assert.equal((await immutableReceipt.get()).exists,false);
   await assert.rejects(authorize(authority()));
   await assert.rejects(run({...options,saved}));assert.equal(attempts,0);
   assert.deepEqual(await rpc(()=>original.query('workerRestartProbe.status')),originalStatus);
   return;
  }
  const result=await run(options);
  assert.equal(result.stage,'completed');assert.equal(attempts,1);assert.equal(result.proof.protectedRunCount,1);assert.equal(replayed.size,1);
  const receipt=await immutableReceipt.get();assert.equal(receipt.get('identityState.stage'),'completed');
  await assert.rejects(checkpoint({...authority(),immutableReceipt,operatorPrincipal:{fixture:true},identityState:{...result,stage:'attempted'}}));
  const changed=structuredClone(result);changed.request.identity='foreign';
  await assert.rejects(checkpoint({...authority(),immutableReceipt,operatorPrincipal:{fixture:true},identityState:changed}));
  await run({...options,saved:result});assert.equal(attempts,1);
  assert.deepEqual(await rpc(()=>original.query('workerRestartProbe.status')),originalStatus);
  await rpc(()=>original.signal('workerRestartProbe.release'));await rpc(()=>original.result());
  const history=await rpc(()=>original.fetchHistory());assert.equal(history.events.filter(e=>e.workflowExecutionStartedEventAttributes).length,1);
  assert.equal(history.events.some(e=>e.activityTaskScheduledEventAttributes),false);
 }catch(e){failures.unshift(e);}
 finally{
  if(original)try{await rpc(()=>original.signal('workerRestartProbe.release'));}catch(e){if(e.name!=='WorkflowNotFoundError')failures.push(e);}
  for(const {worker} of workers)try{if(worker.getStatus().runState==='RUNNING')worker.shutdown();}catch(e){failures.push(e);}
  try{const settled=await bounded(Promise.allSettled(workers.map(w=>w.done)),15000);failures.push(...settled.flatMap(x=>x.status==='rejected'?[x.reason]:[]));}catch(e){failures.push(e);}
  for(const ref of [...allReceipts,lockRef,controlRef,stateRef])try{await bounded(ref.delete());}catch(e){failures.push(e);}
  try{await bounded(deleteApp(app));}catch(e){failures.push(e);}
  try{await bounded(connection?.close()??Promise.resolve());}catch(e){failures.push(e);}
  try{await env.teardown();}catch(e){failures.push(e);}
  if(failures.length)throw new AggregateError(failures.map((e,i)=>new Error(`Owned promotion fixture failure ${i+1}; native code ${Number.isInteger(e?.code)&&e.code>=0&&e.code<=16?e.code:'unavailable'}`)),'Native controls promotion fixture failed');
 }
});
function configureDomains(){return ['media','publishing','images','emails','accounts','bundles','search'];}

function cap(r){return r[0].toUpperCase()+r.slice(1);}
