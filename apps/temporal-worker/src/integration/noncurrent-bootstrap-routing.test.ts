import { randomUUID } from 'node:crypto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
Runtime.install({logger:new DefaultLogger('ERROR',()=>undefined)});

/** Actual LOCAL routing evidence only. A non-current version is not a general no-work fence. */
test('non-current pollers leave old and new unversioned Activities to legacy workers but execute explicit pinned work',async()=>{
  const environment=await createLocalTestEnvironment();
  const service=environment.connection.workflowService, namespace=environment.client.options.namespace, id=randomUUID();
  const workflowQueue=`legacy-workflow-${id}`, activityQueue=`bootstrap-activity-${id}`, pinnedQueue=`candidate-workflow-${id}`;
  const deploymentName=`bootstrap-${id}`,buildId='bootstrap-candidate';
  const workers:Array<{worker:Worker;done:Promise<void>}>=[],failures:unknown[]=[],calls:string[]=[];
  const bounded=<T>(work:Promise<T>,ms:number)=>{let timer:ReturnType<typeof setTimeout>;return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned bootstrap fixture deadline')),ms);})]).finally(()=>clearTimeout(timer));};
  const rpc=<T>(work:()=>Promise<T>)=>bounded(environment.connection.withDeadline(Date.now()+5000,work),6000);
  const until=async(check:()=>Promise<boolean>)=>{
    const end=Date.now()+15000;
    while(Date.now()<end){if(await rpc(check))return;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error('Native bootstrap routing did not settle');
  };
  const launch=async(taskQueue:string,workflow:boolean,versioned:boolean)=>{
    const identity=versioned?'candidate-versioned':'legacy-unversioned';
    const worker=await Worker.create({connection:environment.nativeConnection,namespace,taskQueue,identity,
      ...(workflow?{workflowsPath:require.resolve('../test-support/independent-activity-workflow')} : {}),
      activities:workflow?{}:{independentActivityMarker:async()=>{calls.push(identity);return identity;}},
      ...(versioned?{workerDeploymentOptions:{version:{deploymentName,buildId},useWorkerVersioning:true,defaultVersioningBehavior:'PINNED' as const}}:{}),
      shutdownGraceTime:'2 seconds',shutdownForceTime:'5 seconds'});
    const done=worker.run();void done.catch(error=>failures.push(error));workers.push({worker,done});
    if(versioned)await until(async()=>{
      try{return Boolean((await service.describeWorkerDeploymentVersion({namespace,deploymentVersion:{deploymentName,buildId}})).workerDeploymentVersionInfo?.taskQueueInfos?.some(q=>q.name===taskQueue&&q.type===(workflow?1:2)));}
      catch(error){if((error as {code?:number}).code===5)return false;throw error;}
    });
  };
  try {
    await launch(workflowQueue,true,false);
    const startUnversioned=async(label:string)=>rpc(()=>environment.client.workflow.start('independentActivityProbe',{
      workflowId:`unversioned-${label}-${id}`,taskQueue:workflowQueue,args:[activityQueue,false],workflowExecutionTimeout:'1 minute',
    }));
    const old=await startUnversioned('before');
    await until(async()=>Boolean((await old.fetchHistory()).events?.some(e=>e.activityTaskScheduledEventAttributes)));
    await launch(activityQueue,false,true); // register, deliberately never set current/ramping
    const current=await rpc(()=>service.describeWorkerDeployment({namespace,deploymentName}));
    expect(current.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId).not.toBe(buildId);
    const fresh=await startUnversioned('after');
    await until(async()=>Boolean((await fresh.fetchHistory()).events?.some(e=>e.activityTaskScheduledEventAttributes)));
    await new Promise(resolve=>setTimeout(resolve,2000));
    expect(calls).toEqual([]);
    for(const handle of [old,fresh])expect((await rpc(()=>handle.fetchHistory())).events?.some(e=>e.activityTaskStartedEventAttributes)).toBe(false);
    await launch(activityQueue,false,false);
    expect(await rpc(()=>old.result())).toBe('legacy-unversioned');expect(await rpc(()=>fresh.result())).toBe('legacy-unversioned');
    expect(calls).toEqual(['legacy-unversioned','legacy-unversioned']);
    await launch(pinnedQueue,true,true);
    const pinned=await rpc(()=>environment.client.workflow.start('independentActivityProbe',{
      workflowId:`explicit-pinned-${id}`,taskQueue:pinnedQueue,args:[activityQueue,false],workflowExecutionTimeout:'1 minute',
      versioningOverride:{pinnedTo:{deploymentName,buildId}},
    }));
    expect(await rpc(()=>pinned.result())).toBe('candidate-versioned');
    expect(calls).toEqual(['legacy-unversioned','legacy-unversioned','candidate-versioned']);
    expect((await rpc(()=>service.describeWorkerDeployment({namespace,deploymentName}))).workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId).not.toBe(buildId);
    for(const handle of [old,fresh,pinned]) {
      const history=await rpc(()=>handle.fetchHistory());
      expect(history.events?.filter(e=>e.workflowExecutionStartedEventAttributes)).toHaveLength(1);
      expect(history.events?.filter(e=>e.activityTaskScheduledEventAttributes)).toHaveLength(1);
      expect(history.events?.filter(e=>e.activityTaskStartedEventAttributes)).toHaveLength(1);
      expect(history.events?.filter(e=>e.activityTaskCompletedEventAttributes)).toHaveLength(1);
    }
    expect(failures).toEqual([]);
  } catch(error){failures.unshift(error);}
  finally {
    for(const {worker} of workers)try{if(worker.getStatus().runState==='RUNNING')worker.shutdown();}catch(error){failures.push(error);}
    try {const results=await bounded(Promise.allSettled(workers.map(w=>w.done)),15000);
      failures.push(...results.flatMap(r=>r.status==='rejected'?[r.reason]:[]));
    } catch(error){failures.push(error);} // Server cleanup below runs even if worker settlement stalls.
    try{await environment.teardown();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Native bootstrap routing fixture failed');
  }
});
