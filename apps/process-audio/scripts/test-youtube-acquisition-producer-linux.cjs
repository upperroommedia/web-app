// Operator-run native Linux proof using an EXISTING local image, no image pull,
// credentials, network, cloud changes, package install or persistent container.
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir, userInfo } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const ts = require('typescript');
const root = resolve(__dirname, '..');
const source = readFileSync(join(root, 'src/temporal/hetzner-acquisition-producer.ts'), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'yt-native-producer-proof-'));
const fixture = String.raw`
const {startNativeYouTubeProducer}=require('./producer.cjs');
const {spawn}=require('node:child_process');
const {mkdtempSync,existsSync,chmodSync}=require('node:fs');
const assert=require('node:assert/strict');
const path=mkdtempSync('/scratch/attempt-');
const mode=process.argv[2];
async function run(){
 if(mode==='unsupported-kernel'){
  await assert.rejects(startNativeYouTubeProducer({binary:process.execPath,args:['-e',"require('node:fs').writeFileSync('never','bad')"],directory:path}));
  assert.equal(existsSync(path+'/never'),false);return;
 }
 if(mode==='private-permissions'){
  chmodSync(path,0o777);
  await assert.rejects(startNativeYouTubeProducer({binary:process.execPath,args:['-e','process.exit(0)'],directory:path}));return;
 }
 if(mode==='foreign-session'){
  await assert.rejects(startNativeYouTubeProducer({binary:process.execPath,args:['-e','process.exit(0)'],directory:path}));return;
 }
 if(mode==='unbounded-filesystem'){
  await assert.rejects(startNativeYouTubeProducer({binary:process.execPath,args:['-e','process.exit(0)'],directory:'/suite'}));return;
 }
 if(mode==='leftover'){
  const old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const oldClosed=new Promise(resolve=>old.once('close',resolve));
  await new Promise(resolve=>old.once('spawn',resolve));
  await assert.rejects(startNativeYouTubeProducer({binary:process.execPath,args:['-e',"require('node:fs').writeFileSync('never','bad')"],directory:path}));
  await oldClosed;assert.equal(existsSync(path+'/never'),false);return;
 }
 let code="process.stdout.write(Buffer.alloc(65536,42))";
 if(mode==='bounded-diagnostics') code="process.stderr.write(Buffer.alloc(100000,120));process.exitCode=3";
 if(mode==='failure') code="process.stderr.write('PRIVATE_FIXTURE_DIAGNOSTIC');process.stdout.write('partial');process.exitCode=3";
 if(mode==='leaked-descendant') code="const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});c.once('spawn',()=>process.exit(0))";
 if(mode==='cancel') code="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
 const producer=await startNativeYouTubeProducer({binary:process.execPath,args:['-e',code],directory:path});
 const chunks=[];const reading=(async()=>{for await(const chunk of producer.output) chunks.push(chunk);})();
 if(mode==='cancel'){await new Promise(resolve=>setTimeout(resolve,150));await producer.drain();}
 const status=await producer.completion;await reading;await producer.drain();
 if(mode==='success'){assert.equal(status,'succeeded');assert.deepEqual(Buffer.concat(chunks),Buffer.alloc(65536,42));}
 else assert.equal(status,'failed');
 if(mode==='failure') assert.equal(producer.diagnostic(),'PRIVATE_FIXTURE_DIAGNOSTIC');
 if(mode==='bounded-diagnostics') assert.equal(producer.diagnostic(),undefined);
}
run().then(()=>process.exit(0),e=>{process.stderr.write(String(e.stack));process.exit(2);});
`;
const runner = String.raw`
const {spawn}=require('node:child_process');
(async()=>{
 for(const mode of process.argv.length>2 ? process.argv.slice(2) : ['success','failure','leaked-descendant','cancel','leftover','unbounded-filesystem','foreign-session','private-permissions','bounded-diagnostics']){
  const child=spawn(process.execPath,['/suite/fixture.cjs',mode],{detached:mode!=='foreign-session',stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(0,8192);});
  const code=await new Promise(resolve=>child.once('close',resolve));
  if(code!==0)throw new Error('Native scenario failed: '+mode+' '+errors);
  process.stdout.write(mode+':PASS\n');
 }
})().catch(e=>{process.stderr.write(e.message);process.exitCode=1;});
`;
const selected = process.argv.slice(2);
const allowed = [
  'success',
  'failure',
  'leaked-descendant',
  'cancel',
  'leftover',
  'unbounded-filesystem',
  'foreign-session',
  'private-permissions',
  'bounded-diagnostics',
  'unsupported-kernel',
];
if (selected.some((value) => !allowed.includes(value))) throw new Error('Unknown native fixture scenario');
const containerName = 'urm-yt-native-proof-' + randomUUID();
try {
  writeFileSync(
    join(directory, 'producer.cjs'),
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
      .outputText,
    { mode: 0o600 }
  );
  writeFileSync(join(directory, 'fixture.cjs'), fixture, { mode: 0o600 });
  writeFileSync(join(directory, 'runner.cjs'), runner, { mode: 0o600 });
  const { uid, gid } = userInfo();
  const image = process.env.YOUTUBE_NATIVE_TEST_IMAGE || 'process-audio-server:latest';
  const inspect = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}} {{.Architecture}}'], {
    encoding: 'utf8',
  });
  if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64} (amd64|arm64)$/.test(inspect.stdout.trim()))
    throw new Error('Existing local image unavailable');
  const [imageId, architecture] = inspect.stdout.trim().split(' ');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--name',
      containerName,
      '--rm',
      '--platform=linux/' + architecture,
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--pids-limit=64',
      '--memory=512m',
      `--user=${uid}:${gid}`,
      `--tmpfs=/scratch:rw,size=256m,uid=${uid},gid=${gid},mode=0700`,
      '--mount',
      `type=bind,src=${directory},dst=/suite,readonly`,
      '--entrypoint=/usr/local/bin/node',
      imageId,
      '/suite/runner.cjs',
      ...selected,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 65536 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native Linux fixture failed: ' + result.stderr);
  process.stdout.write(result.stdout);
  process.stdout.write(
    JSON.stringify({
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      imageId,
      proof: 'local Linux native process + bounded tmpfs only; not provider/staging readiness',
    }) + '\n'
  );
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore', timeout: 10000 });
  rmSync(directory, { recursive: true, force: true });
}
