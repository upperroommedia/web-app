import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnedPoolOperationReceipts } from './temporal-preparation-checkpoint.mjs';
import { bootstrapStopCloudRunControlsPool as cycle } from './temporal-bootstrap-pool.mjs';
import { controlsBootstrapFixture as fixture } from './tests/fixtures/controls-bootstrap.mjs';
test('one start/owned stop, original immutable activation before observation; completed resume is GET-only', async () => {
  const f = fixture(),
    observe = f.options.observeRegistration;
  f.options.observeRegistration = async () => {
    assert.equal(f.saved.activationState.stage, 'completed');
    assert.equal(f.pool.scaling.manualInstanceCount, 1);
    return observe();
  };
  const r = await cycle(f.options);
  assert.equal(r.stage, 'completed');
  assert.equal(r.observation.status, 'confirmed');
  assert.equal(r.start.pool.uid, r.stop.pool.uid);
  assert.equal(r.stop.pool.desiredManualInstanceCount, 0);
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'PATCH').map((c) => c.request.scaling.manualInstanceCount),
    [1, 0]
  );
  await cycle({ ...f.options, saved: f.saved });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
test('native registration failure still stops the same unused owned pool and retains failure', async () => {
  const f = fixture();
  f.options.observeRegistration = async () => {
    throw new Error('unconfirmed');
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.saved.stage, 'completed');
  assert.equal(f.saved.observation.status, 'unconfirmed');
  assert.equal(f.pool.scaling.manualInstanceCount, 0);
  await assert.rejects(cycle({ ...f.options, saved: f.saved }));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
for (const key of ['runnerScaler', 'scalerTrust', 'poolAccess', 'firestore', 'projectAccess', 'storageAccess'])
  test(`changed ${key} receipt cannot authorize start`, async () => {
    const f = fixture();
    f.options.receipts[key].identityState.plan.grants = [];
    await assert.rejects(cycle(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
for (const key of ['start', 'stop'])
  test(`${key} unknown accepted ACK is GET-only on resume`, async () => {
    const f = fixture(),
      api = f.options.api;
    let injected = false;
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (args[1] === 'PATCH' && args[2].scaling.manualInstanceCount === (key === 'start' ? 1 : 0) && !injected) {
        injected = true;
        throw new Error('lost');
      }
      return r;
    };
    const r = await cycle(f.options);
    assert.equal(r[key].outcome, 'desired-count-observed-after-unknown-ack');
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
  });
test('checkpoint ACK loss before native PATCH never resends and remains fenced', async () => {
  const f = fixture(),
    save = f.options.save;
  f.options.save = async (s) => {
    await save(s);
    if (s.start?.stage === 'attempted') throw new Error('lost');
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  f.options.save = save;
  await assert.rejects(cycle({ ...f.options, saved: f.saved }));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
});
test('checkpoint ACK loss after native LRO resumes only the saved operation', async () => {
  const f = fixture(),
    save = f.options.save;
  let failed = false;
  f.options.save = async (s) => {
    await save(s);
    if (s.start?.stage === 'acknowledged' && !failed) {
      failed = true;
      throw new Error('lost');
    }
  };
  await assert.rejects(cycle(f.options));
  f.options.save = save;
  await cycle({ ...f.options, saved: f.saved });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
});
test('post-checkpoint protection drift prevents scaling', async () => {
  const f = fixture(),
    observe = f.options.observeProtection;
  let count = 0;
  f.options.observeProtection = async () => ({
    ...(await observe()),
    protectionSHA256: (++count === 1 ? 'd' : 'b').repeat(64),
  });
  await assert.rejects(cycle(f.options));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
});
test('current candidate/protected work refuses stop and retains active ownership fence', async () => {
  const f = fixture(),
    observe = f.options.observeProtection;
  f.options.observeRegistration = async () => {
    throw new Error('native work appeared');
  };
  f.options.observeProtection = async () => {
    if (f.saved.observation) throw new Error('candidate no longer safe');
    return observe();
  };
  await assert.rejects(cycle(f.options));
  assert.equal(f.saved.stage, 'stopping');
  assert.equal(f.pool.scaling.manualInstanceCount, 1);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
});
for (const bad of ['uid', 'generation', 'revision', 'secret', 'role', 'db', 'bucket', 'policy'])
  test(`fresh native ${bad} mismatch stops before mutation`, async () => {
    const f = fixture(),
      api = f.options.api;
    if (bad === 'uid') f.pool.uid = 'replacement';
    if (bad === 'generation') {
      f.pool.generation = '2';
      f.pool.observedGeneration = '2';
    }
    if (bad === 'revision') {
      f.pool.latestCreatedRevision += 'x';
      f.pool.latestReadyRevision += 'x';
    }
    if (bad === 'db') f.database.uid = 'replacement';
    if (bad === 'bucket') f.bucket.timeCreated = '2026-02-01T00:00:00Z';
    if (bad === 'role') for (const r of f.roles.values()) r.includedPermissions.push('extra');
    if (bad === 'policy') f.policies.get('projects/urm-app-staging').bindings = [];
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (bad === 'secret' && args[0].includes('/versions/')) r.state = 'DISABLED';
      return r;
    };
    await assert.rejects(cycle(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  });

// Controlled Cloud identities/receipts only. No native Cloud Run attestation.
const { activateCloudRunControlsPool: retain, stopCloudRunControlsActivation: abort } = await import(
  './temporal-bootstrap-pool.mjs'
);
const { randomUUID } = await import('node:crypto');
async function afterCycle() {
  const f = fixture(),
    result = await cycle(f.options);
  f.options.receipts.bootstrapCycle = {
    operationId: f.options.operationId,
    releaseId: f.options.releaseId,
    identityState: structuredClone(result),
  };
  f.options.operationId = randomUUID();
  return f;
}
async function afterRetain() {
  const f = await afterCycle(),
    result = await retain(f.options);
  f.options.receipts.activation = {
    operationId: f.options.operationId,
    releaseId: f.options.releaseId,
    identityState: structuredClone(result),
  };
  f.options.operationId = randomUUID();
  return f;
}
test('kept activation starts only from exact completed-cycle origin and leaves desired one without routing promotion', async () => {
  const f = await afterCycle(),
    r = await retain(f.options);
  assert.equal(r.disposition, 'retained');
  assert.equal(r.stop, undefined);
  assert.equal(r.start.pool.generation, '4');
  assert.equal(r.plan.origin.generation, '3');
  assert.equal(f.pool.scaling.manualInstanceCount, 1);
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'PATCH').map((c) => c.request.scaling.manualInstanceCount),
    [1, 0, 1]
  );
  const original = structuredClone(r);
  await retain({ ...f.options, saved: r });
  assert.deepEqual(f.saved, original);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 3);
});
test('a separately guarded unused activation stop consumes exact kept receipt and does no start', async () => {
  const f = await afterRetain();
  f.options.observeRegistration = async () => {
    throw new Error('stop must not launch/observe new work');
  };
  const r = await abort(f.options);
  assert.equal(r.disposition, 'stopped');
  assert.equal(r.start, undefined);
  assert.equal(r.stop.pool.generation, '5');
  await abort({ ...f.options, saved: r });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 4);
});
for (const bad of [
  'absent-cycle',
  'failed-cycle',
  'cycle-plan',
  'cycle-start',
  'cycle-stop',
  'cycle-observation',
  'origin-etag',
  'origin-generation',
  'extra-manifest',
])
  test(`kept activation denies ${bad} without another PATCH`, async () => {
    const f = await afterCycle(),
      r = f.options.receipts.bootstrapCycle;
    if (bad === 'absent-cycle') delete f.options.receipts.bootstrapCycle;
    if (bad === 'failed-cycle') r.identityState.stage = 'attempted';
    if (bad === 'cycle-plan') r.identityState.plan.receiptsSHA256 = 'f'.repeat(64);
    if (bad === 'cycle-start') r.identityState.start.plan.origin.uid = 'foreign';
    if (bad === 'cycle-stop') r.identityState.stop.plan.target = 1;
    if (bad === 'cycle-observation') r.identityState.observation.status = 'unconfirmed';
    if (bad === 'origin-etag') f.pool.etag = 'changed';
    if (bad === 'origin-generation') {
      f.pool.generation = '4';
      f.pool.observedGeneration = '4';
    }
    if (bad === 'extra-manifest') f.options.receipts.extra = {};
    await assert.rejects(retain(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 2);
  });
for (const bad of [
  'not-retained',
  'activation-plan',
  'activation-origin',
  'activation-start',
  'activation-observation',
  'activation-replaced',
])
  test(`separate stop denies ${bad} without PATCH`, async () => {
    const f = await afterRetain(),
      r = f.options.receipts.activation;
    if (bad === 'not-retained') r.identityState.disposition = 'stopped';
    if (bad === 'activation-plan') r.identityState.plan.receiptsSHA256 = 'f'.repeat(64);
    if (bad === 'activation-origin') r.identityState.plan.origin.uid = 'replacement';
    if (bad === 'activation-start') r.identityState.activationState.pool.generation = '3';
    if (bad === 'activation-observation') r.identityState.observation.status = 'unconfirmed';
    if (bad === 'activation-replaced') f.pool.uid = 'replacement';
    await assert.rejects(abort(f.options));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 3);
  });
test('retained activation never claims success after failed native observation; same parent stops', async () => {
  const f = await afterCycle();
  f.options.observeRegistration = async () => {
    throw new Error('not verified');
  };
  await assert.rejects(retain(f.options));
  assert.equal(f.saved.disposition, 'stopped');
  assert.equal(f.saved.observation.status, 'unconfirmed');
  assert.equal(f.pool.scaling.manualInstanceCount, 0);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 4);
  await assert.rejects(retain({ ...f.options, saved: f.saved }));
});
test('fresh retained registration failure cleans up even after initial confirmed observation', async () => {
  const f = await afterCycle(),
    original = f.options.observeRegistration;
  let calls = 0;
  f.options.observeRegistration = async () => {
    if (++calls === 2) throw new Error('final observation failed');
    return original();
  };
  await assert.rejects(retain(f.options));
  assert.equal(f.saved.retentionFailed, true);
  assert.equal(f.saved.disposition, 'stopped');
  assert.equal(f.pool.scaling.manualInstanceCount, 0);
});
for (const mode of ['retain', 'abort'])
  test(`${mode} unknown accepted scaling ACK is GET-only with original pool identity`, async () => {
    const f = mode === 'retain' ? await afterCycle() : await afterRetain(),
      api = f.options.api;
    let injected = false;
    f.options.api = async (...args) => {
      const r = await api(...args);
      if (args[1] === 'PATCH' && !injected) {
        injected = true;
        throw new Error('lost');
      }
      return r;
    };
    const r = await (mode === 'retain' ? retain : abort)(f.options);
    assert.match(r[mode === 'retain' ? 'start' : 'stop'].outcome, /unknown-ack/);
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, mode === 'retain' ? 3 : 4);
  });
test('unknown retained completion checkpoint ACK cannot trigger cleanup or another start', async () => {
  const f = await afterCycle(),
    save = f.options.save;
  f.options.save = async (state) => {
    await save(state);
    if (state.disposition === 'retained') throw new Error('unknown checkpoint');
  };
  await assert.rejects(retain(f.options));
  assert.equal(f.pool.scaling.manualInstanceCount, 1);
  const count = f.calls.filter((c) => c.method === 'PATCH').length;
  f.options.save = save;
  await retain({ ...f.options, saved: f.saved });
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, count);
});
test('a newly current/protected candidate cannot be separately stopped', async () => {
  const f = await afterRetain();
  f.options.observeProtection = async () => {
    throw new Error('candidate current or work active');
  };
  await assert.rejects(abort(f.options));
  assert.equal(f.pool.scaling.manualInstanceCount, 1);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 3);
});
for (const mode of ['retain', 'abort'])
  for (const status of [403, 409])
    test(`${mode} known ${status} rejection cannot become desired observation or resend`, async () => {
      const f = mode === 'retain' ? await afterCycle() : await afterRetain(),
        api = f.options.api;
      let attempts = 0;
      f.options.api = async (...args) => {
        if (args[1] === 'PATCH') {
          attempts++;
          await args[3]();
          throw Object.assign(new Error('denied'), { status });
        }
        return api(...args);
      };
      await assert.rejects((mode === 'retain' ? retain : abort)(f.options));
      assert.equal(f.saved[mode === 'retain' ? 'start' : 'stop'].stage, 'rejected');
      await assert.rejects((mode === 'retain' ? retain : abort)({ ...f.options, saved: f.saved }));
      assert.equal(attempts, 1);
    });
test('a retained receipt missing its final immutable registration cannot authorize separate stop', async () => {
  const f = await afterRetain();
  delete f.options.receipts.activation.identityState.retainedRegistration;
  await assert.rejects(abort(f.options));
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 3);
});
test('late credential acquisition cannot bypass immediate pre-send protected-work authorization', async () => {
  const f = await afterCycle(),
    api = f.options.api,
    observe = f.options.observeProtection;
  let changed = false,
    writes = 0;
  f.options.observeProtection = async () => {
    if (changed) throw Object.assign(new Error('protected read denied'), { status: 403 });
    return observe();
  };
  f.options.api = async (...args) => {
    if (args[1] === 'PATCH') {
      // The actual controller transport obtains credentials before this callback.
      changed = true;
      await args[3]();
      writes++;
    }
    return api(...args);
  };
  await assert.rejects(retain(f.options));
  assert.equal(writes, 0);
  assert.equal(f.pool.scaling.manualInstanceCount, 0);
  assert.equal(f.saved.start.stage, 'attempted');
});
test('post-credential namespace inventory drift cannot reuse the saved compute observation', async () => {
  const f = await afterCycle(),
    api = f.options.api,
    observe = f.options.observeProtection;
  let changed = false,
    writes = 0;
  f.options.observeProtection = async () => {
    const p = await observe();
    if (changed) p.computeInventorySHA256 = '1'.repeat(64);
    return p;
  };
  f.options.api = async (...args) => {
    if (args[1] === 'PATCH') {
      changed = true;
      await args[3]();
      writes++;
    }
    return api(...args);
  };
  await assert.rejects(retain(f.options));
  assert.equal(writes, 0);
});

const {bootstrapStopCloudRunOrchestrationPool:orchestrationCycle,activateCloudRunOrchestrationPool:orchestrationRetain,stopCloudRunOrchestrationActivation:orchestrationAbort}=await import('./temporal-bootstrap-pool.mjs');
async function orchestrationAfterCycle(){
 const f=fixture('orchestration'),r=await orchestrationCycle(f.options);
 f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(r)};
 f.options.operationId=randomUUID();return f;
}
test('orchestration uses its own exact source secrets/permissions and stays noncurrent through cycle, retention and unused stop',async()=>{
 const f=await orchestrationAfterCycle(),kept=await orchestrationRetain(f.options);
 assert.equal(kept.disposition,'retained');assert.equal(kept.plan.role,'orchestration');
 assert.deepEqual(f.options.settings.runtimeSecrets.map(x=>x.name),['RUNTIME_ALERT_RECIPIENTS','ADMIN_BASE_URL']);
 assert.ok(f.options.receipts.projectRole.identityState.nativeRole.includedPermissions.includes('firebaseauth.users.update'));
 assert.deepEqual(f.options.receipts.storageRole.identityState.nativeRole.includedPermissions,['storage.objects.create','storage.objects.delete','storage.objects.get']);
 assert.equal(f.calls.some(c=>/setWorkerDeployment|compute-config/.test(c.url)),false);
 f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();
 const stopped=await orchestrationAbort(f.options);assert.equal(stopped.stop.pool.desiredManualInstanceCount,0);
 assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>c.request.scaling.manualInstanceCount),[1,0,1,0]);
});
for(const bad of ['runner','projectRole','storageAccess','settings','secret-policy'])test(`orchestration denies ${bad} without another start`,async()=>{
 const f=await orchestrationAfterCycle(),control=fixture(),api=f.options.api;
 if(['runner','projectRole','storageAccess'].includes(bad))f.options.receipts[bad]=control.options.receipts[bad];
 if(bad==='settings')f.options.settings.runtimeSecrets=[];
 f.options.api=async(...args)=>{const r=await api(...args);if(bad==='secret-policy'&&args[0].includes('ADMIN_BASE_URL:getIamPolicy'))r.bindings=[];return r;};
 await assert.rejects(orchestrationRetain(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
for(const [role,run] of [['orchestration',cycle],['controls',orchestrationCycle]])test(`${role} cannot choose another role's bootstrap wrapper`,async()=>{
 const f=fixture(role);await assert.rejects(run(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});
test('orchestration observer failure cleans up under its same parent; protected work prevents unused stop',async()=>{
 const f=await orchestrationAfterCycle();f.options.observeRegistration=async()=>{throw new Error('unknown');};
 await assert.rejects(orchestrationRetain(f.options));assert.equal(f.pool.scaling.manualInstanceCount,0);assert.equal(f.saved.disposition,'stopped');
 const g=await orchestrationAfterCycle(),kept=await orchestrationRetain(g.options);
 g.options.receipts.activation={operationId:g.options.operationId,releaseId:g.options.releaseId,identityState:structuredClone(kept)};g.options.operationId=randomUUID();
 g.options.observeProtection=async()=>{throw new Error('candidate current/working');};await assert.rejects(orchestrationAbort(g.options));assert.equal(g.pool.scaling.manualInstanceCount,1);
});

const {bootstrapStopCloudRunSearchPool:searchCycle,activateCloudRunSearchPool:searchRetain,stopCloudRunSearchActivation:searchAbort}=await import('./temporal-bootstrap-pool.mjs');
async function searchAfterCycle(){const f=fixture('search'),r=await searchCycle(f.options);f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(r)};f.options.operationId=randomUUID();return f;}
test('search consumes nine own receipts, exact numeric config, project-only Auth read and no bucket authority',async()=>{
 const f=await searchAfterCycle(),kept=await searchRetain(f.options);
 assert.equal(kept.disposition,'retained');assert.equal(Object.keys(f.options.receipts).length,10);
 assert.deepEqual(f.options.receipts.projectRole.identityState.nativeRole.includedPermissions,['firebaseauth.users.get']);
 assert.deepEqual(f.options.settings.runtimeSecrets,[{name:'TEMPORAL_SEARCH_CONFIG_JSON',secret:'TEMPORAL_SEARCH_CONFIG',version:'2'}]);
 assert.equal(f.options.receipts.storageRole,undefined);assert.equal(f.calls.some(c=>c.url.includes('storage.googleapis.com')),false);
 f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();
 await searchAbort(f.options);assert.equal(f.pool.scaling.manualInstanceCount,0);
 assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>c.request.scaling.manualInstanceCount),[1,0,1,0]);
});
for(const bad of ['extra-storage','runner','projectRole','settings','secret-policy'])test(`search ${bad} is fenced before another PATCH`,async()=>{
 const f=await searchAfterCycle(),control=fixture(),api=f.options.api;
 if(bad==='extra-storage')f.options.receipts.storageRole=control.options.receipts.storageRole;
 if(['runner','projectRole'].includes(bad))f.options.receipts[bad]=control.options.receipts[bad];
 if(bad==='settings')f.options.settings.runtimeSecrets=[];
 f.options.api=async(...args)=>{const r=await api(...args);if(bad==='secret-policy'&&args[0].includes('TEMPORAL_SEARCH_CONFIG:getIamPolicy'))r.bindings=[];return r;};
 await assert.rejects(searchRetain(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('search unknown start ACK resumes GET-only; current/working retained candidate is never zeroed',async()=>{
 const f=await searchAfterCycle(),api=f.options.api;let drop=true;
 f.options.api=async(...args)=>{const r=await api(...args);if(args[1]==='PATCH'&&drop){drop=false;throw new Error('lost ACK');}return r;};
 const recovered=await searchRetain(f.options);assert.equal(recovered.disposition,'retained');const n=f.calls.filter(c=>c.method==='PATCH').length;
 await searchRetain({...f.options,saved:f.saved});assert.equal(f.calls.filter(c=>c.method==='PATCH').length,n);
 const kept=f.saved;f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();
 f.options.observeProtection=async()=>{throw new Error('working');};await assert.rejects(searchAbort(f.options));assert.equal(f.pool.scaling.manualInstanceCount,1);
});
for(const run of [cycle,orchestrationCycle])test('search cannot select another fixed role wrapper',async()=>{const f=fixture('search');await assert.rejects(run(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);});

const {bootstrapStopCloudRunEmailPool:emailCycle,activateCloudRunEmailPool:emailRetain,stopCloudRunEmailActivation:emailAbort}=await import('./temporal-bootstrap-pool.mjs');
async function emailAfterCycle(){const f=fixture('email'),r=await emailCycle(f.options);f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(r)};f.options.operationId=randomUUID();return f;}
test('email nine own receipts include enabled numeric mounted egress metadata and no storage authority or transport call',async()=>{
 const f=await emailAfterCycle(),kept=await emailRetain(f.options);
 assert.equal(kept.disposition,'retained');assert.equal(Object.keys(f.options.receipts).length,10);
 assert.deepEqual(f.options.receipts.projectRole.identityState.nativeRole.includedPermissions,['firebaseauth.users.get']);
 const body=f.options.receipts.pool.identityState.plan.body;
 assert.deepEqual(body.template.volumes.find(v=>v.name==='email-egress').secret.items,[{version:'2',path:'egress.json'}]);
 assert.equal(body.template.containers[0].env.find(v=>v.name==='EMAIL_EGRESS_DESCRIPTOR_PATH').value,'/run/email/egress.json');
 assert.ok(f.calls.some(c=>c.url.includes('TEMPORAL_EMAIL_EGRESS_DESCRIPTOR/versions/2')));
 assert.equal(f.calls.some(c=>/storage.googleapis.com|:access|smtp|nodemailer/.test(c.url)),false);
 f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();
 await emailAbort(f.options);assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>c.request.scaling.manualInstanceCount),[1,0,1,0]);
});
for(const bad of ['storage','projectRole','settings','egress-disabled','egress-accessor'])test(`email ${bad} denies before another start`,async()=>{
 const f=await emailAfterCycle(),control=fixture(),api=f.options.api;
 if(bad==='storage')f.options.receipts.storageAccess=control.options.receipts.storageAccess;
 if(bad==='projectRole')f.options.receipts.projectRole=control.options.receipts.projectRole;
 if(bad==='settings')f.options.settings.emailEgressVersion='latest';
 f.options.api=async(...args)=>{const r=await api(...args);if(args[0].includes('TEMPORAL_EMAIL_EGRESS_DESCRIPTOR')){if(bad==='egress-disabled'&&args[0].includes('/versions/'))r.state='DISABLED';if(bad==='egress-accessor'&&args[0].includes(':getIamPolicy'))r.bindings=[];}return r;};
 await assert.rejects(emailRetain(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('email observer failure stops same parent but uncertain/working retained activation stays fenced',async()=>{
 const f=await emailAfterCycle();f.options.observeRegistration=async()=>{throw new Error('unknown');};await assert.rejects(emailRetain(f.options));assert.equal(f.pool.scaling.manualInstanceCount,0);assert.equal(f.saved.disposition,'stopped');
 const g=await emailAfterCycle(),kept=await emailRetain(g.options);g.options.receipts.activation={operationId:g.options.operationId,releaseId:g.options.releaseId,identityState:structuredClone(kept)};g.options.operationId=randomUUID();g.options.observeProtection=async()=>{throw new Error('working');};await assert.rejects(emailAbort(g.options));assert.equal(g.pool.scaling.manualInstanceCount,1);
});
for(const run of [cycle,orchestrationCycle,searchCycle])test('email cannot choose another source role wrapper',async()=>{const f=fixture('email');await assert.rejects(run(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);});

const {bootstrapStopCloudRunImagesPool:imagesCycle,activateCloudRunImagesPool:imagesRetain,stopCloudRunImagesActivation:imagesAbort}=await import('./temporal-bootstrap-pool.mjs');
async function imagesAfterCycle(){const f=fixture('images'),r=await imagesCycle(f.options);f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(r)};f.options.operationId=randomUUID();return f;}
test('images joins its own bucket/grants and preserves the exact pre-existing public-read baseline without writes',async()=>{
 const f=await imagesAfterCycle(),kept=await imagesRetain(f.options);
 assert.equal(kept.disposition,'retained');assert.equal(Object.keys(f.options.receipts).length,12);
 assert.equal(f.options.receipts.storageAccess.identityState.plan.resource,'projects/_/buckets/urm-app-staging-images');
 assert.deepEqual(f.options.receipts.storageRole.identityState.nativeRole.includedPermissions,['storage.objects.delete','storage.objects.get','storage.objects.update']);
 assert.equal(f.calls.some(c=>c.url.includes('/b/urm-app-staging.firebasestorage.app')),false);
 assert.equal(f.calls.some(c=>['PUT','POST'].includes(c.method)&&/setIamPolicy|storage.googleapis.com/.test(c.url)),false);
 f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();await imagesAbort(f.options);
 assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>c.request.scaling.manualInstanceCount),[1,0,1,0]);
});
for(const bad of ['audio-receipt','bucket-recreated','bucket-project','envelope','public-write','public-authenticated','public-conditional','project-public'])test(`images ${bad} blocks before another PATCH`,async()=>{
 const f=await imagesAfterCycle(),api=f.options.api;
 if(bad==='audio-receipt')f.options.receipts.storageAccess=fixture().options.receipts.storageAccess;
 f.options.api=async(...args)=>{const r=await api(...args);
  if(args[0].includes('/b/urm-app-staging-images?fields=')){if(bad==='bucket-recreated')r.timeCreated='2026-02-01T00:00:00Z';if(bad==='bucket-project')r.projectNumber='123';}
  if(args[0].includes('/b/urm-app-staging-images/iam?')){
   if(bad==='envelope')r.resourceId='projects/_/buckets/urm-app-staging.firebasestorage.app';
   const baseline=r.bindings.find(b=>b.members.includes('allUsers'));
   if(bad==='public-write')baseline.role='roles/storage.objectAdmin';
   if(bad==='public-authenticated')baseline.members=['allAuthenticatedUsers'];
   if(bad==='public-conditional'){r.version=3;baseline.condition={title:'x',expression:'true'};}
  }
  if(bad==='project-public'&&args[0].includes('cloudresourcemanager')&&args[0].includes(':getIamPolicy'))r.bindings.push({role:'roles/storage.objectViewer',members:['allUsers']});
  return r;
 };
 await assert.rejects(imagesRetain(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('read-only direct-policy verifier cannot turn the baseline public member into a requested grant',async()=>{
 const {verifyPreparedDirectPolicyGrant}=await import('./temporal-preparation-iam.mjs');
 const grant={role:'roles/storage.objectViewer',members:['allUsers']},policy={version:1,etag:'e',bindings:[grant]};
 assert.throws(()=>verifyPreparedDirectPolicyGrant(policy,grant,'projects/_/buckets/urm-app-staging-images'));
});
const {bootstrapStopCloudRunMediaPool:mediaCycle,activateCloudRunMediaPool:mediaRetain,stopCloudRunMediaActivation:mediaAbort}=await import('./temporal-bootstrap-pool.mjs');
async function mediaAfterCycle(){const f=fixture('media'),r=await mediaCycle(f.options);f.options.receipts.bootstrapCycle={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(r)};f.options.operationId=randomUUID();return f;}
test('media quota read loss after start cannot strand same-parent unused cleanup',async()=>{
 const f=fixture('media'),api=f.options.api,observe=f.options.observeRegistration;let quotaLost=false;
 f.options.observeRegistration=async()=>{quotaLost=true;return observe();};
 f.options.api=async(...args)=>{if(quotaLost&&args[0].includes('cloudquotas.googleapis.com'))throw new Error('quota unavailable');return api(...args);};
 try{await mediaCycle(f.options);}catch{}
 assert.equal(f.pool.scaling.manualInstanceCount,0);assert.equal(f.saved.stop.stage,'completed');
});

test('media exact budgets and original quota proof survive cycle/retention/unused stop without quota writes',async()=>{
 const f=await mediaAfterCycle(),kept=await mediaRetain(f.options),body=f.options.receipts.pool.identityState.plan.body;
 assert.equal(kept.disposition,'retained');assert.equal(Object.keys(f.options.receipts).length,12);
 assert.deepEqual(body.template.containers[0].resources.limits,{cpu:'2',memory:'4Gi'});assert.deepEqual(body.template.volumes.find(v=>v.name==='scratch').emptyDir,{medium:'DISK',sizeLimit:'100Gi'});
 const env=Object.fromEntries(body.template.containers[0].env.map(v=>[v.name,v.value]));assert.equal(env.TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES,String(64*2**30));assert.equal(env.TEMPORAL_MEDIA_DISK_HEADROOM_BYTES,String(16*2**30));
 assert.equal(kept.start.protection.mediaDiskQuota.components.length,2);
 f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();
 const api=f.options.api;f.options.api=async(...args)=>{if(args[0].includes('cloudquotas.googleapis.com'))throw new Error('quota unavailable during deallocation');return api(...args);};
 await mediaAbort(f.options);assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>c.request.scaling.manualInstanceCount),[1,0,1,0]);
 assert.equal(f.calls.some(c=>c.url.includes('cloudquotas')&&c.method!=='GET'),false);
});
for(const bad of ['missing-original','quota-small','credential-drift','credential-late'])test(`media allocation ${bad} denies before PATCH`,async()=>{
 const f=await mediaAfterCycle(),api=f.options.api;let credential=false;const now=Date.now;
 if(bad==='missing-original')delete f.options.receipts.pool.identityState.prerequisites.mediaDiskQuota;
 f.options.api=async(...args)=>{if(args[1]==='PATCH'){credential=true;if(bad==='credential-late')Date.now=()=>now()+6000;}const r=await api(...args);if(args[0].includes('cloudquotas')&&(bad==='quota-small'||credential&&bad==='credential-drift'))r.dimensionsInfos[0].details.value=bad==='quota-small'?'10737418240':'214748364800';return r;};
 try{await assert.rejects(mediaRetain(f.options));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);}finally{Date.now=now;}
});
test('media active candidate cannot be stopped even when quota reads are unavailable',async()=>{
 const f=await mediaAfterCycle(),kept=await mediaRetain(f.options);f.options.receipts.activation={operationId:f.options.operationId,releaseId:f.options.releaseId,identityState:structuredClone(kept)};f.options.operationId=randomUUID();f.options.observeProtection=async()=>{throw new Error('working');};await assert.rejects(mediaAbort(f.options));assert.equal(f.pool.scaling.manualInstanceCount,1);
});


test('native pool operation ancestors must remain the same immutable records', async () => {
  const prefixes = { pool: 'temporalCloudPoolPreparation', cycle: 'temporalCloudMediaBootstrapCycle' };
  const ids = { pool: 'pool-id', cycle: 'cycle-id' };
  const releaseId = 'release-id';
  const makeStamp = (seconds) => ({
    seconds,
    nanoseconds: 0,
    toDate: () => new Date(seconds * 1000),
    isEqual: (other) => other?.seconds === seconds,
  });
  const poolPath = `_control/${prefixes.pool}-${ids.pool}`;
  const cyclePath = `_control/${prefixes.cycle}-${ids.cycle}`;
  const rows = new Map([
    [poolPath, { data: { operationId: ids.pool, releaseId }, createdAt: 1, updatedAt: 1 }],
    [cyclePath, { data: { operationId: ids.cycle, releaseId }, createdAt: 2, updatedAt: 2 }],
  ]);
  const firestore = {
    doc: (path) => ({ path }),
    runTransaction: (run, options) => {
      assert.deepEqual(options, { readOnly: true });
      return run({
        get: async ({ path }) => {
          const row = rows.get(path);
          return {
            exists: Boolean(row),
            get: (key) => row.data[key],
            data: () => structuredClone(row.data),
            createTime: makeStamp(row.createdAt),
            updateTime: makeStamp(row.updatedAt),
          };
        },
      });
    },
  };
  const read = () => readOwnedPoolOperationReceipts(firestore, prefixes, ids, releaseId);
  const parent = await read();
  assert.deepEqual(parent.receipts.cycle, { operationId: ids.cycle, releaseId });
  await parent.assertCurrent();

  const original = rows.get(cyclePath);
  rows.set(cyclePath, { ...original, updatedAt: 3 });
  await assert.rejects(read, /OWNED_BOOTSTRAP_RECEIPT_REQUIRED/);
  rows.set(cyclePath, { ...original, createdAt: 4, updatedAt: 4 });
  await assert.rejects(parent.assertCurrent, /RELEASE_NATIVE_AUTHORITY_CHANGED/);
  rows.set(cyclePath, { ...original, data: { ...original.data, releaseId: 'another-release' } });
  await assert.rejects(read, /OWNED_BOOTSTRAP_RECEIPT_REQUIRED/);
});
