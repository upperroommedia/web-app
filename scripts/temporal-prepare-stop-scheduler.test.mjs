import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStopCloudRunScheduler } from './temporal-prepare-stop-scheduler.mjs';
import { cycleFixture } from './tests/fixtures/temporal-dispatch-cycle.mjs';
test('same owned cycle saves creation receipt before pause and completed resume is GET-only',async()=>{
 const f=await cycleFixture();const result=await prepareStopCloudRunScheduler(f.options);assert.equal(result.stage,'completed');assert.equal(f.job.state,'PAUSED');assert.equal(f.creates,1);assert.equal(f.pauses,1);
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown create ACK requires exact native causal audit then same-operation pause',async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');return r;};
 await prepareStopCloudRunScheduler(f.options);assert.ok(f.immutable.identityState.audit.auditSHA256);assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown create with missing audit remains fenced and later recovery never recreates',async()=>{
 const f=await cycleFixture(),api=f.options.api;let missing=true;
 f.options.api=async(...a)=>{if(a[0].startsWith('https://logging.')&&missing)return{entries:[]};const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'attempted');assert.equal(f.pauses,0);missing=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
for(const status of [403,409])test(`definite create ${status} is never reconciled or resent`,async()=>{
 const f=await cycleFixture(),api=f.options.api;let n=0;f.options.api=async(...a)=>{if(a[0].endsWith('/jobs')&&a[1]==='POST'){n++;throw Object.assign(new Error('reject'),{status});}return api(...a);};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'rejected');await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved:f.saved}));assert.equal(n,1);
});
test('unknown immutable creation checkpoint never authorizes pause or another create that turn',async()=>{
 const f=await cycleFixture(),save=f.options.save;let lost=true;f.options.save=async s=>{await save(s);if(s.stage==='created'&&lost)throw new Error('lostcheckpoint');};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,1);assert.equal(f.pauses,0);lost=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('missing actual immutable creation receipt prevents pause',async()=>{
 const f=await cycleFixture();f.options.readCreationReceipt=async()=>undefined;
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'created');assert.equal(f.pauses,0);
});
test('expired planned window forbids creation while delayed attempted recovery still pauses',async()=>{
 const f=await cycleFixture(),save=f.options.save;f.options.save=async s=>{await save(s);if(s.stage==='planned')throw new Error('stop');};await assert.rejects(prepareStopCloudRunScheduler(f.options));
 const saved=structuredClone(f.saved);saved.plan.openedAt=new Date(Date.now()-600000).toISOString();saved.plan.cleanupDueAt=new Date(Date.parse(saved.plan.openedAt)+300000).toISOString();
 await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved}));assert.equal(f.creates,0);
 f.options.save=save;const api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');if(a[0].startsWith('https://logging.'))return{entries:[]};return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));const pending=structuredClone(f.saved);pending.plan.openedAt=saved.plan.openedAt;pending.plan.cleanupDueAt=saved.plan.cleanupDueAt;
 f.options.api=api;await prepareStopCloudRunScheduler({...f.options,saved:pending});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
for(const bad of ['actor','request','response','resource','timestamp','class','delegation','status','ambiguous','pagination','redacted'])test(`strict scheduler causal audit rejects ${bad}`,async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith('/jobs')&&a[1]==='POST')throw new Error('lost');if(a[0].startsWith('https://logging.')){
 const e=r.entries[0],p=e.protoPayload;
 if(bad==='actor')p.authenticationInfo.principalEmail='foreign@example.test';if(bad==='request')p.request.job.schedule='*/2 * * * *';if(bad==='response')p.response.userUpdateTime='2000-01-01T00:00:00Z';if(bad==='resource')p.resourceName='projects/other/locations/us-central1';if(bad==='timestamp')e.timestamp='2000-01-01T00:00:00Z';if(bad==='class')e.logName=e.logName.replace('activity','data_access');if(bad==='delegation')p.authenticationInfo.serviceAccountDelegationInfo=[{}];if(bad==='status')p.status={code:7};if(bad==='ambiguous')r.entries.push(structuredClone(e));if(bad==='pagination')r.nextPageToken='more';if(bad==='redacted')delete p.request;return r;}return r;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,1);assert.equal(f.pauses,0);assert.equal(f.saved.stage,'attempted');
});
for(const missing of [true,false])test(`completed cycle rejects ${missing?'missing':'downgraded'} stop checkpoint before another pause`,async()=>{
 const f=await cycleFixture();await prepareStopCloudRunScheduler(f.options);f.job.state='ENABLED';const saved=structuredClone(f.saved);const api=f.options.api;let extraPause=0;f.options.api=async(...a)=>{if(a[0].endsWith(':pause'))extraPause++;return api(...a);};
 if(missing)delete saved.stopState;else saved.stopState.stage='planned';
 await assert.rejects(prepareStopCloudRunScheduler({...f.options,saved}));assert.equal(f.creates,1);assert.equal(f.pauses,1);assert.equal(extraPause,0);
});
test('attempt checkpoint consuming creation window cannot issue CreateJob afterward',async()=>{
 const f=await cycleFixture(),save=f.options.save,now=Date.now;let shift=0;
 Date.now=()=>now()+shift;
 try{f.options.save=async s=>{await save(s);if(s.stage==='attempted')shift=600000;};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'attempted');assert.equal(f.creates,0);assert.equal(f.pauses,0);
 }finally{Date.now=now;}
});
for(const bad of ['managed-agent','audit','public-invoker','caller-uid'])test(`cycle rejects ${bad} before creating wake`,async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);
 if(a[0].startsWith('https://cloudresourcemanager.')){if(bad==='managed-agent')r.bindings=r.bindings.filter(x=>x.role!=='roles/cloudscheduler.serviceAgent');if(bad==='audit')delete r.auditConfigs;}
 if(bad==='public-invoker'&&a[0].startsWith('https://run.googleapis.com/')&&a[0].includes(':getIamPolicy'))r.bindings[0].members.push('allUsers');
 if(bad==='caller-uid'&&a[0].endsWith(`/serviceAccounts/${f.options.platform.dispatch.schedulerServiceAccount}`))r.uniqueId='12345678901234567899';
 return r;};await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.creates,0);assert.equal(f.pauses,0);
});
test('nested unknown pause ACK reconciles original PAUSED with no second mutation',async()=>{
 const f=await cycleFixture(),api=f.options.api;f.options.api=async(...a)=>{const r=await api(...a);if(a[0].endsWith(':pause'))throw new Error('lost');return r;};
 const result=await prepareStopCloudRunScheduler(f.options);assert.equal(result.stopState.outcome,'stopped-observed-after-unknown-acknowledgement');assert.equal(f.pauses,1);
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
test('unknown nested stop checkpoint ACK retains same parent and resumes GET-only',async()=>{
 const f=await cycleFixture(),save=f.options.save;let unknown=true;
 f.options.save=async s=>{await save(s);if(s.stage==='stopping'&&s.stopState?.stage==='acknowledged'&&unknown)throw new Error('lost checkpoint');};
 await assert.rejects(prepareStopCloudRunScheduler(f.options));assert.equal(f.saved.stage,'stopping');assert.equal(f.saved.stopState.stage,'acknowledged');assert.equal(f.pauses,1);unknown=false;
 await prepareStopCloudRunScheduler({...f.options,saved:f.saved});assert.equal(f.creates,1);assert.equal(f.pauses,1);
});
