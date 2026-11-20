import { assertTraditionalRetirementWorkIdle, readReleaseCandidateWork, readTraditionalRetirementWork } from './temporal-retirement-work.mjs';
import {assertImageReplayReceipt} from './temporal-image-replay.mjs';
import { proofDigest, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
const fail = () => {
  throw new Error('CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const version = (x) => (x?.updateTime ? `${x.updateTime.seconds}:${x.updateTime.nanoseconds}` : fail());
const actions={
 media:['bootstrap-stop-cloud-run-media','activate-cloud-run-media-pool','stop-cloud-run-media-activation'],
 images:['bootstrap-stop-cloud-run-images','activate-cloud-run-images-pool','stop-cloud-run-images-activation'],
 email:['bootstrap-stop-cloud-run-email','activate-cloud-run-email-pool','stop-cloud-run-email-activation'],
 search:['bootstrap-stop-cloud-run-search','activate-cloud-run-search-pool','stop-cloud-run-search-activation'],
 controls:['bootstrap-stop-cloud-run-controls','activate-cloud-run-controls-pool','stop-cloud-run-controls-activation'],
 orchestration:['bootstrap-stop-cloud-run-orchestration','activate-cloud-run-orchestration-pool','stop-cloud-run-orchestration-activation'],
};
function queueInventory(role,infos,complete=false){
 if(!Object.hasOwn(actions,role)||infos!==undefined&&!Array.isArray(infos))fail();
 const expected=role==='orchestration'?[1,2]:[2],seen=new Set();
 for(const q of infos??[]){
  if(q?.name!==`urm-${role}`||!expected.includes(q.type)||seen.has(q.type))fail();seen.add(q.type);
 }
 const result=[...seen].sort().map(type=>({name:`urm-${role}`,type}));
 return complete&&result.length!==expected.length?undefined:result;
}
/** Native observations under a still-paused original operation. Conservative:
 * any pending Activity, unversioned open run, active provider session/lock or
 * unresolved dispatch lease stops bootstrap. Never settles or edits old work.
 */
async function observeProtection(o, transition, expectedRole) {
  const { client, firestore: db, platform, role, operationId, bindingDigest, expectedAuthority, releaseId } = o;
  if (
    !Object.hasOwn(actions,role) ||
    (transition && (role!==expectedRole||!['controls','search','email','images','media'].includes(expectedRole)||typeof o.replayHistory!=='function'||!/^[a-f0-9]{64}$/.test(o.bundleSHA256??''))) ||
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    client.options.namespace !== platform.temporalNamespace
  )
    fail();
  const binding = platform.roleBindings.find((x) => x.role === role),
    service = client.connection.workflowService,
    namespace = platform.temporalNamespace;
  const deadline = Date.now() + 60000;
  const rpc = (fn) => client.connection.withDeadline(Math.min(deadline, Date.now() + 5000), fn);
  // Read-only calls may settle late; a timeout never permits a subsequent write.
  const read = async (fn) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('BOOTSTRAP_READ_TIMEOUT')),
            Math.max(1, Math.min(5000, deadline - Date.now()))
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const scan = async () => {
    const { docs, protectedWork } = await read(() =>
      db.runTransaction(async (tx) => {
        const [docs, work, candidateWork] = await Promise.all([
          Promise.all([
            '_control/temporalReleaseOperation',
            '_control/temporalRelease',
            '_control/temporalReleaseState',
          ].map((path) => tx.get(db.doc(path)))),
          readTraditionalRetirementWork(db, tx),
          readReleaseCandidateWork(db, tx, binding.buildId),
        ]);
        if (candidateWork.length) fail();
        return { docs, protectedWork: assertTraditionalRetirementWorkIdle(work) };
      }, { readOnly: true })
    );
    const [p, c, s] = docs;
    assertNativeSnapshot(expectedAuthority.control, c);
    assertNativeSnapshot(expectedAuthority.state, s);
    if (
      p.get('operationId') !== operationId ||
      p.get('bindingDigest') !== bindingDigest ||
      p.get('releaseId') !== releaseId ||
      !(transition ? p.get('action')===`promote-cloud-run-${expectedRole}` : actions[role].includes(p.get('action'))) ||
      c.get('releaseId') !== releaseId ||
      s.get('releaseId') !== releaseId ||
      c.get('admission') !== 'paused' ||
      s.get('phase') !== 'provider-usage-ready' ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => c.get(`domains.${d}.admission`) !== 'paused'
      )
    )
      fail();
    const workflows = [],
      seen = new Set(),
      tokens = new Set();
    let nextPageToken;
    do {
      if (Date.now() >= deadline || workflows.length > 500) fail();
      const page = await rpc(() =>
        service.listWorkflowExecutions({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
          ...(nextPageToken ? { nextPageToken } : {}),
        })
      );
      if (page.executions !== undefined && !Array.isArray(page.executions)) fail();
      for (const entry of page.executions ?? []) {
        const e = entry.execution;
        if (typeof e?.workflowId !== 'string' || !e.workflowId || !uuid.test(e.runId ?? '') || seen.has(e.runId))
          fail();
        seen.add(e.runId);
        const report = await rpc(() => service.describeWorkflowExecution({ namespace, execution: e })),
          info = report.workflowExecutionInfo,
          v = info?.versioningInfo;
        const pinned = v?.versioningOverride?.pinned;
        const deployed = pinned?.version ?? v?.deploymentVersion;
        if (
          info?.execution?.workflowId !== e.workflowId ||
          info.execution.runId !== e.runId ||
          info.status !== 1 ||
          (v?.versioningOverride && !pinned) ||
          (pinned ? pinned.behavior !== 1 : v?.behavior !== 1) ||
          !deployed?.deploymentName ||
          !deployed.buildId ||
          deployed.buildId === binding.buildId ||
          report.pendingActivities?.length ||
          report.pendingNexusOperations?.length
        )
          fail();
        const found = await rpc(() =>
          service.describeWorkerDeploymentVersion({ namespace, deploymentVersion: deployed })
        );
        if (
          found.workerDeploymentVersionInfo?.deploymentVersion?.deploymentName !== deployed.deploymentName ||
          found.workerDeploymentVersionInfo.deploymentVersion.buildId !== deployed.buildId ||
          !found.workerDeploymentVersionInfo.taskQueueInfos?.some((q) => q.name === info.taskQueue && q.type === 1)
        )
          fail();
        let replay;
        if(transition){
          const events=[],historyTokens=new Set();let cursor;
          do{
            if(Date.now()>=deadline||events.length>100000)fail();
            const page=await rpc(()=>service.getWorkflowExecutionHistory({namespace,execution:e,maximumPageSize:1000,...(cursor?{nextPageToken:cursor}:{})}));
            if(!Array.isArray(page.history?.events)||!page.history.events.length)fail();
            for(const event of page.history.events){
              if(BigInt(event.eventId?.toString()??'0')!==BigInt(events.length+1))fail();
              events.push(event);
            }
            if(page.nextPageToken!=null&&!(page.nextPageToken instanceof Uint8Array)&&!(Array.isArray(page.nextPageToken)&&!page.nextPageToken.length))fail();
            cursor=page.nextPageToken?.length?page.nextPageToken:undefined;
            if(cursor){const token=Buffer.from(cursor).toString('base64');if(historyTokens.has(token)||historyTokens.size>=100)fail();historyTokens.add(token);}
          }while(cursor);
          if(BigInt(info.historyLength?.toString()??'0')!==BigInt(events.length))fail();
          const history={events};
          if(Buffer.byteLength(JSON.stringify(history))>20*1024*1024)fail();
          const imageReplay=await o.replayHistory(history,e.workflowId,e.runId);
          if(o.imageReplayProof) assertImageReplayReceipt(imageReplay,{
            image:platform.workerImage,buildId:platform.workerBuildId,operationId,bindingDigest,
            evidenceDigest:o.evidenceDigest,bundleSHA256:o.bundleSHA256,
            historySHA256:proofDigest(history),workflowId:e.workflowId,runId:e.runId,
            imageId:o.imageReplayProof.imageId,platform:o.imageReplayProof.platform});
          if(Date.now()>=deadline)fail();
          replay={historySHA256:proofDigest(history),head:String(events.length),bundleSHA256:o.bundleSHA256,...(o.imageReplayProof?{imageReplay}:{})};
        }
        workflows.push({ executionSHA256: proofDigest(e), version: deployed, queue: info.taskQueue,...(replay?{replay}:{}) });
      }
      if (
        page.nextPageToken != null &&
        !(page.nextPageToken instanceof Uint8Array) &&
        !(Array.isArray(page.nextPageToken) && !page.nextPageToken.length)
      )
        fail();
      nextPageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      if (nextPageToken) {
        const t = Buffer.from(nextPageToken).toString('base64');
        if (tokens.has(t) || tokens.size > 10) fail();
        tokens.add(t);
      }
    } while (nextPageToken);
    let candidateQueues=[];
    try{
      const candidate=await rpc(()=>service.describeWorkerDeploymentVersion({namespace,deploymentVersion:{deploymentName:binding.deploymentName,buildId:binding.buildId}}));
      const info=candidate.workerDeploymentVersionInfo;
      if(info?.deploymentVersion?.deploymentName!==binding.deploymentName||info.deploymentVersion.buildId!==binding.buildId)fail();
      candidateQueues=queueInventory(role,info.taskQueueInfos);
    }catch(error){if(error?.code!==5)throw error;}
    let routing = null;
    try {
      const report = await rpc(() =>
        service.describeWorkerDeployment({ namespace, deploymentName: binding.deploymentName })
      );
      routing = report.workerDeploymentInfo?.routingConfig ?? null;
      if (
        (transition==='after' ? routing?.currentDeploymentVersion?.deploymentName!==binding.deploymentName||routing?.currentDeploymentVersion?.buildId!==binding.buildId : routing?.currentDeploymentVersion?.buildId === binding.buildId) ||
        routing?.rampingDeploymentVersion?.buildId === binding.buildId ||
        Number(routing?.rampingVersionPercentage ?? 0) !== 0
      )
        fail();
    } catch (error) {
      if (transition || error?.code !== 5) throw error;
    }
    let queueRouting;
    if(transition){
      if(queueInventory(role,candidateQueues,true)===undefined)fail();
      const report=await rpc(()=>service.describeTaskQueue({namespace,taskQueue:{name:`urm-${role}`} ,taskQueueType:2,reportStats:true}));
      const q=report.versioningInfo,old=platform.roleBindings.find(b=>b.role==='orchestration');
      const current=q?.currentDeploymentVersion;
      if(!current?.deploymentName||!current.buildId||q.rampingDeploymentVersion||Number(q.rampingVersionPercentage??0)!==0||!Array.isArray(report.pollers))fail();
      if(transition==='before'?(current.deploymentName!==old.deploymentName||current.buildId===binding.buildId):(current.deploymentName!==binding.deploymentName||current.buildId!==binding.buildId))fail();
      const peer=await rpc(()=>service.describeWorkerDeployment({namespace,deploymentName:old.deploymentName}));
      const peerRouting=peer.workerDeploymentInfo?.routingConfig;
      if(!peerRouting?.currentDeploymentVersion?.buildId||peerRouting.currentDeploymentVersion.buildId===binding.buildId||peerRouting.rampingDeploymentVersion||Number(peerRouting.rampingVersionPercentage??0)!==0)fail();
      if(transition==='before'&&proofDigest(current)!==proofDigest(peerRouting.currentDeploymentVersion))fail();
      const pollers=report.pollers.filter(p=>p.deploymentOptions?.deploymentName===binding.deploymentName&&p.deploymentOptions.buildId===binding.buildId);
      if(!pollers.length||pollers.some(p=>typeof p.identity!=='string'||!p.identity))fail();
      queueRouting={current:{deploymentName:current.deploymentName,buildId:current.buildId},peerRoutingSHA256:proofDigest(peerRouting),pollers:pollers.map(p=>({identity:p.identity,deploymentOptions:{deploymentName:p.deploymentOptions.deploymentName,buildId:p.deploymentOptions.buildId}})).sort((a,b)=>a.identity.localeCompare(b.identity))};
    }
    return {
      controlVersion: version(c),
      stateVersion: version(s),
      workflows: workflows.sort((a, b) => a.executionSHA256.localeCompare(b.executionSHA256)),
      protectedWork,
      routing,
      candidateQueues,...(queueRouting?{queueRouting}:{}),
    };
  };
  try {
    const scanStartedAt = Date.now(),
      first = await scan(),
      second = await scan();
    const isolation = await observeNamespaceComputeIsolation(client, namespace);
    if (
      proofDigest(first) !== proofDigest(second) ||
      Date.now() >= deadline ||
      Date.now() - scanStartedAt > 5000 ||
      !Number.isFinite(Date.parse(isolation.observedAt)) ||
      Math.abs(Date.now() - Date.parse(isolation.observedAt)) > 5000
    )
      fail();
    return {
      schemaVersion: 1,
      namespace,
      role,
      buildId: binding.buildId,
      observedAt: new Date(scanStartedAt).toISOString(),
      computeObservedAt: isolation.observedAt,
      protectionSHA256: proofDigest(second),
      computeInventorySHA256: isolation.inventorySHA256,
      protectedRunCount: second.workflows.length,
      ...(transition?{protectedWorkSHA256:proofDigest({controlVersion:second.controlVersion,stateVersion:second.stateVersion,workflows:second.workflows,protectedWork:second.protectedWork}),peerRoutingSHA256:second.queueRouting.peerRoutingSHA256,queueRouting:second.queueRouting,bundleSHA256:o.bundleSHA256}:{}),
      scope:
        'two stable paused native/Firestore observations; conservative pending-work denial; not cross-API exclusion, old-version drainage or readiness',
    };
  } catch {
    return fail();
  }
}

export const observeBootstrapProtection=o=>observeProtection(o);
// Fixed source entrypoints: callers cannot turn bootstrap/stop into a current-role check.
export const observeControlsPromotionBefore=o=>observeProtection(o,'before','controls');
export const observeSearchPromotionBefore=o=>observeProtection(o,'before','search');
async function observePromotionAfter(o,role){
  if(o.role!==role)fail();
  const binding=o.platform.roleBindings.find(b=>b.role===role),end=Date.now()+15000;
  // SetCurrent's acknowledgement may precede matching's queue routing update.
  // Wait by GET only, then perform the complete protected-work/authority scan.
  while(Date.now()<end){
    const report=await o.client.connection.withDeadline(Math.min(end,Date.now()+5000),()=>o.client.connection.workflowService.describeTaskQueue({namespace:o.platform.temporalNamespace,taskQueue:{name:`urm-${role}`} ,taskQueueType:2}));
    const current=report.versioningInfo?.currentDeploymentVersion;
    if(current?.deploymentName===binding.deploymentName&&current.buildId===binding.buildId)return observeProtection(o,'after',role);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return fail();
}

export const observeControlsPromotionAfter=o=>observePromotionAfter(o,'controls');
export const observeSearchPromotionAfter=o=>observePromotionAfter(o,'search');

export async function observeBootstrapRegistration({ client, platform, role, expectedPoller }) {
  const b = platform.roleBindings.find((x) => x.role === role),
    namespace = platform.temporalNamespace,
    service = client.connection.workflowService;
  if (!Object.hasOwn(actions,role) || client.options.namespace !== namespace) fail();
  if (
    expectedPoller !== undefined &&
    (role !== 'media' || typeof expectedPoller !== 'string' ||
      !/^cloud-run-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(expectedPoller))
  )
    fail();
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const sampledAt = Date.now();
      const version = await client.connection.withDeadline(Math.min(end, Date.now() + 5000), () =>
        service.describeWorkerDeploymentVersion({
          namespace,
          deploymentVersion: { deploymentName: b.deploymentName, buildId: b.buildId },
        })
      );
      const report = await client.connection.withDeadline(Math.min(end, Date.now() + 5000), () =>
        service.describeWorkerDeployment({ namespace, deploymentName: b.deploymentName })
      );
      const v = version.workerDeploymentVersionInfo,
        r = report.workerDeploymentInfo?.routingConfig;
      const queues=queueInventory(role,v?.taskQueueInfos,true);
      if (
        v?.deploymentVersion?.deploymentName === b.deploymentName &&
        v.deploymentVersion.buildId === b.buildId &&
        queues &&
        r?.currentDeploymentVersion?.buildId !== b.buildId &&
        r?.rampingDeploymentVersion?.buildId !== b.buildId &&
        Number(r?.rampingVersionPercentage ?? 0) === 0
      ) {
        let poller;
        if (expectedPoller !== undefined) {
          const queueReport = await client.connection.withDeadline(Math.min(end, Date.now() + 5000), () =>
            service.describeTaskQueue({
              namespace,
              taskQueue: { name: 'urm-media', kind: 1 },
              taskQueueType: 2,
            })
          );
          const candidates = (queueReport.pollers ?? []).filter(
            (p) => p.deploymentOptions?.deploymentName === b.deploymentName || p.identity === expectedPoller
          );
          if (candidates.length) {
            if (Date.now() - sampledAt >= 5000) fail();
            const [p] = candidates;
            if (
              candidates.length !== 1 ||
              p.identity !== expectedPoller ||
              p.deploymentOptions?.deploymentName !== b.deploymentName ||
              p.deploymentOptions?.buildId !== b.buildId ||
              p.deploymentOptions?.workerVersioningMode !== 2
            )
              fail();
            poller = { identity: p.identity, deploymentName: b.deploymentName, buildId: b.buildId };
          }
        }
        if (expectedPoller === undefined || poller)
          return {
            schemaVersion: 1,
            role,
            buildId: b.buildId,
            observedAt: new Date(poller ? sampledAt : Date.now()).toISOString(),
            registrationSHA256: proofDigest(version),
            queues,
            routingSHA256: proofDigest(report),
            ...(poller ? { pollerSHA256: proofDigest(poller) } : {}),
            scope: poller
              ? 'native non-current role queue inventory and exact capacity process in the root Activity poller report'
              : 'native non-current exact role queue inventory only; no workflow start, promotion or readiness',
          };
      }
    } catch (error) {
      if (error?.code !== 5) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fail();
}

export const observeEmailPromotionBefore=o=>observeProtection(o,'before','email');
export const observeEmailPromotionAfter=o=>observePromotionAfter(o,'email');

export const observeImagesPromotionBefore=o=>observeProtection(o,'before','images');
export const observeImagesPromotionAfter=o=>observePromotionAfter(o,'images');

export const observeMediaPromotionBefore=o=>observeProtection(o,'before','media');
export const observeMediaPromotionAfter=o=>observePromotionAfter(o,'media');
