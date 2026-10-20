import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) });
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned restart fixture deadline')),ms);})]).finally(()=>clearTimeout(timer));
}
interface OwnedWorker {
  child: ChildProcess;
  exit: Promise<{code:number|null;signal:NodeJS.Signals|null}>;
  ready: Promise<{pid:number;instanceId:string;identity:string}>;
}
function launch(address: string, bundle: string, buildId: string): OwnedWorker {
  const child=fork(resolve(__dirname,'fixtures/restart-worker-child.cjs'),[],{
    detached:true,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],
    env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',NODE_ENV:'test'},
  });
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  void exit.catch(()=>undefined);
  const ready=new Promise<{pid:number;instanceId:string;identity:string}>((resolve,reject)=>{
    child.on('message',(message:unknown)=>{
      if(!message||typeof message!=='object') return;
      const m=message as Record<string,unknown>;
      if(m.type==='error') return reject(new Error('Owned native worker failed'));
      if(m.type!=='ready'||Object.keys(m).sort().join(',')!=='identity,instanceId,pid,type'||m.pid!==child.pid||
        typeof m.instanceId!=='string'||!/^[a-f0-9-]{36}$/.test(m.instanceId)||m.identity!==`owned-restart-${child.pid}-${m.instanceId}`)
        return reject(new Error('Owned native worker identity mismatch'));
      resolve({pid:m.pid as number,instanceId:m.instanceId,identity:m.identity as string});
    });
    void exit.then(()=>reject(new Error('Owned native worker exited')),reject);
  });
  void ready.catch(()=>undefined);
  child.send({type:'start',address,namespace:'default',bundle,buildId},error=>{if(error) child.kill('SIGKILL');});
  return {child,exit,ready};
}
async function groupAbsent(worker: OwnedWorker) {
  const end=Date.now()+2000;
  while(Date.now()<end) {
    try {process.kill(-worker.child.pid!,0);} catch(error) {if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Owned native worker left a descendant');
}

test('a real SIGKILL and fresh OS worker replay the same pinned original probe run',async()=>{
  const owned:OwnedWorker[]=[];
  let environment:Awaited<ReturnType<typeof createLocalTestEnvironment>>|undefined, directory:string|undefined, primary:unknown;
  try {
    environment=await createLocalTestEnvironment();
    directory=await realpath(await mkdtemp(join(tmpdir(),'urm-native-restart-')));
    const code=await bundleWorkflowCode({workflowsPath:require.resolve('../workflows/verification')});
    const bundle=join(directory,'probe.js'), file=await open(bundle,'wx',0o600);
    try {await file.writeFile(code.code);await file.sync();} finally {await file.close();}
    const buildId='7'.repeat(40), workflowId=`native-process-restart-${randomUUID()}`;
    const first=launch(environment.address,bundle,buildId);owned.push(first);
    const before=await bounded(first.ready,30000);
    // RUNNING is a local SDK state; wait for actual native queue registration before the sole START.
    await bounded((async()=>{
      while(true) {
        try {
          const observed=await environment!.connection.withDeadline(Date.now()+5000,()=>environment!.connection.workflowService.describeWorkerDeploymentVersion({namespace:'default',deploymentVersion:{deploymentName:'urm-worker-staging',buildId}}));
          if(observed.workerDeploymentVersionInfo?.taskQueueInfos?.some(q=>q.name==='urm-orchestration'&&q.type===1)) return;
        } catch(error) {if((error as {code?:number}).code!==5)throw error;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
    })(),15000);
    const handle=await environment.client.connection.withDeadline(Date.now()+15000,()=>environment!.client.workflow.start('WorkerRestartProbe',{
      workflowId,taskQueue:'urm-orchestration',args:[],workflowExecutionTimeout:'2 minutes',
      workflowIdReusePolicy:'REJECT_DUPLICATE',workflowIdConflictPolicy:'FAIL',
      versioningOverride:{pinnedTo:{deploymentName:'urm-worker-staging',buildId}},
    }));
    const original=await environment.client.connection.withDeadline(Date.now()+15000,()=>handle.query('workerRestartProbe.status'));
    expect(original).toEqual({state:'waiting',runId:handle.firstExecutionRunId});
    const initial=await environment.client.connection.withDeadline(Date.now()+10000,()=>handle.fetchHistory());
    expect(initial.events?.some(e=>e.workflowTaskStartedEventAttributes?.identity===before.identity)).toBe(true);
    first.child.kill('SIGKILL');
    expect(await bounded(first.exit,10000)).toEqual({code:null,signal:'SIGKILL'});
    await groupAbsent(first);
    const second=launch(environment.address,bundle,buildId);owned.push(second);
    const after=await bounded(second.ready,30000);
    expect(after.pid).not.toBe(before.pid);expect(after.instanceId).not.toBe(before.instanceId);
    expect(await environment.client.connection.withDeadline(Date.now()+15000,()=>handle.query('workerRestartProbe.status'))).toEqual(original);
    await environment.client.connection.withDeadline(Date.now()+15000,()=>handle.signal('workerRestartProbe.release'));
    expect(await bounded(handle.result(),15000)).toEqual({completed:true});
    expect((await environment.client.connection.withDeadline(Date.now()+10000,()=>handle.describe())).runId).toBe(handle.firstExecutionRunId);
    const history=await environment.client.connection.withDeadline(Date.now()+10000,()=>handle.fetchHistory());
    expect(history.events?.filter(e=>e.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.filter(e=>e.workflowExecutionCompletedEventAttributes)).toHaveLength(1);
    expect(history.events?.some(e=>e.workflowTaskStartedEventAttributes?.identity===after.identity)).toBe(true);
    expect(history.events?.some(e=>e.activityTaskScheduledEventAttributes||e.startChildWorkflowExecutionInitiatedEventAttributes||e.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    const started=history.events?.[0]?.workflowExecutionStartedEventAttributes;
    expect(started?.firstExecutionRunId).toBe(handle.firstExecutionRunId);
    expect(started?.originalExecutionRunId).toBe(handle.firstExecutionRunId);
    expect(started?.versioningOverride?.pinned?.version).toEqual({deploymentName:'urm-worker-staging',buildId});
    await bounded(Worker.runReplayHistory({workflowBundle:code},JSON.parse(historyToJSON(history))),15000);
    second.child.send({type:'stop'});
    expect(await bounded(second.exit,15000)).toEqual({code:0,signal:null});
    await groupAbsent(second);
  } catch(error) {primary=error;}
  finally {
    const failures:unknown[]=primary?[primary]:[];
    for(const worker of owned) {
      try {
        if(worker.child.exitCode===null&&worker.child.signalCode===null) worker.child.kill('SIGKILL');
        await bounded(worker.exit.catch(()=>undefined),10000);await groupAbsent(worker);
      } catch(error) {failures.push(error);}
    }
    try {await environment?.teardown();} catch(error) {failures.push(error);}
    try {if(directory)await rm(directory,{recursive:true,force:true});} catch(error) {failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Native process recovery fixture failed');
  }
});
