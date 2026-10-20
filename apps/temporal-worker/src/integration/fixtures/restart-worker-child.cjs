// Owned native SDK process fixture. No Firebase, provider clients or credentials.
const { NativeConnection, Worker, Runtime, DefaultLogger } = require('@temporalio/worker');
const { randomUUID } = require('node:crypto');
const { statSync, realpathSync } = require('node:fs');
Runtime.install({ shutdownSignals: [], logger: new DefaultLogger('ERROR', () => undefined) });
let connection, worker, running, started = false;
const instanceId = randomUUID();
const send = value => { if (process.connected) process.send(value); };
const fail = () => { send({type:'error'}); process.exitCode = 1; };
process.once('message', async message => {
  try {
    if (started || !message || Object.keys(message).sort().join(',') !== 'address,buildId,bundle,namespace,type' || message.type !== 'start' ||
      !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(message.address) || message.namespace !== 'default' ||
      !/^[a-f0-9]{40}$/.test(message.buildId) || realpathSync(message.bundle) !== message.bundle) throw new Error();
    const file = statSync(message.bundle);
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600) throw new Error();
    started = true;
    connection = await NativeConnection.connect({address:message.address});
    const identity = `owned-restart-${process.pid}-${instanceId}`;
    worker = await Worker.create({connection, namespace:message.namespace, taskQueue:'urm-orchestration',
      workflowBundle:{codePath:message.bundle}, activities:{}, identity,
      workerDeploymentOptions:{version:{deploymentName:'urm-worker-staging',buildId:message.buildId},useWorkerVersioning:true,defaultVersioningBehavior:'PINNED'},
      shutdownGraceTime:'2 seconds',shutdownForceTime:'5 seconds'});
    running = worker.run();
    void running.catch(fail);
    const deadline = Date.now()+10000;
    while(worker.getStatus().runState !== 'RUNNING') {
      if(Date.now()>=deadline) throw new Error();
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    send({type:'ready',pid:process.pid,instanceId,identity});
  } catch { fail(); }
});
process.on('message', async message => {
  if(message?.type !== 'stop' || Object.keys(message).length !== 1) return;
  try {
    if(worker?.getStatus().runState === 'RUNNING') worker.shutdown();
    await running;
    await connection?.close();
    await Runtime.instance().shutdown();
    process.disconnect();
  } catch { fail(); }
});
