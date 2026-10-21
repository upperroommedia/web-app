import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonical } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('IMMUTABLE_IMAGE_REPLAY_UNCONFIRMED');
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/,
  uuid = /^[a-f0-9-]{36}$/;
const imagePattern = /^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/;
// Executed inside the exact image, never as an application worker. No user code/path is interpolated.
export const imageReplayRunner = String.raw`
(async()=>{
 const fs=require('node:fs'), crypto=require('node:crypto');
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 const path='/workspace/apps/temporal-worker/lib/workflow-bundle.js';
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let bytes;try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size<1||s.size>64*1024*1024)throw Error();bytes=fs.readFileSync(fd);if(bytes.length!==s.size)throw Error();}finally{fs.closeSync(fd);}
 const code=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 const buildFile=fs.openSync('/etc/temporal-worker-build-id',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let buildId;try{const s=fs.fstatSync(buildFile);if(!s.isFile()||s.size>128)throw Error();buildId=fs.readFileSync(buildFile,'utf8').trim();}finally{fs.closeSync(buildFile);}
 if(!/^[a-f0-9]{40}$/.test(buildId))throw Error();
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>21*1024*1024)throw Error();chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(Object.keys(input).sort().join(',')!=='buildId,historyJSON,historyJSONSHA256,historySHA256,kind,runId,workflowId'||input.buildId!==buildId||
    !['inspect','replay'].includes(input.kind)||typeof input.historyJSON!=='string'||hash(input.historyJSON)!==input.historyJSONSHA256||!/^[a-f0-9]{64}$/.test(input.historySHA256))throw Error();
 if(input.kind==='replay'){
   if(typeof input.runId!=='string'||!/^[a-f0-9-]{36}$/.test(input.runId)||typeof input.workflowId!=='string'||!input.workflowId.length||input.workflowId.length>1000)throw Error();
   const {Worker,Runtime,DefaultLogger}=require('/workspace/apps/temporal-worker/node_modules/@temporalio/worker');
   Runtime.install({shutdownSignals:[],logger:new DefaultLogger('ERROR',()=>undefined)});
   const {historyFromJSON}=require('/workspace/apps/temporal-worker/node_modules/@temporalio/common/lib/proto-utils');
   try{await Worker.runReplayHistory({workflowBundle:{code}},historyFromJSON(JSON.parse(input.historyJSON)),input.workflowId);}
   finally{await Runtime.instance().shutdown();}
 }else if(input.historyJSON!==''||input.workflowId!==''||input.runId!=='')throw Error();
 process.stdout.write(JSON.stringify({schemaVersion:1,buildId,bundleSHA256:hash(bytes),historySHA256:input.historySHA256,historyJSONSHA256:input.historyJSONSHA256,kind:input.kind,workflowId:input.workflowId,runId:input.runId}));
})().then(()=>process.exit(0),()=>{process.stderr.write('IMAGE_REPLAY_FAILED');process.exit(1);});
`;
export const imageReplayRunnerSHA256 = sha(imageReplayRunner);

/** CLI completion is awaited; killing the CLI is not container termination proof. */
async function docker(args, input = '', timeout = 10000, configDirectory) {
  // Never inherit a remote Docker context or send private histories to another daemon.
  const socket = await realpath('/var/run/docker.sock');
  const metadata = await lstat(socket);
  if (!metadata.isSocket() || ![0, process.getuid()].includes(metadata.uid) || metadata.mode & 0o002) fail();
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      ['--config', configDirectory, '--host', `unix://${socket}`, ...args],
      {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 128 * 1024,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout,
          stderr,
        })
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const imageFormat =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}';
const containerFormat =
  '{"Id":{{json .Id}},"Image":{{json .Image}},"Created":{{json .Created}},"Name":{{json .Name}},"Config":{{json .Config}},"HostConfig":{{json .HostConfig}},"Mounts":{{json .Mounts}},"State":{{json .State}}}';
const decode = (result) => {
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 128 * 1024) fail();
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail();
  }
};
async function privateRead(path, cid = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await file.stat();
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & (cid ? 0o022 : 0o077) || s.size > (cid ? 65 : 128 * 1024))
      fail();
    if (cid) {
      await file.chmod(0o600);
      await file.sync();
    }
    return await file.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return fail();
  } finally {
    await file?.close();
  }
}
async function save(path, value) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Canonical caller supplies only its verified image/build/original operation bindings.
 * Transport injection is for isolated contract tests; descriptors cannot choose it.
 */
async function createObserver(options, transport) {
  const { image, buildId, operationId, bindingDigest, evidenceDigest } = options;
  if (
    !imagePattern.test(image ?? '') ||
    !/^[a-f0-9]{40}$/.test(buildId ?? '') ||
    !uuid.test(operationId ?? '') ||
    !hex.test(bindingDigest ?? '') ||
    !hex.test(evidenceDigest ?? '') ||
    typeof options.historyToJSON !== 'function'
  )
    fail();
  const root = join(await realpath(tmpdir()), `urm-image-replay-${operationId}`);
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail();
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail();
  const configDirectory = join(root, 'docker-config');
  try {
    await mkdir(configDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail();
  }
  const configStat = await lstat(configDirectory);
  if (
    !configStat.isDirectory() ||
    configStat.isSymbolicLink() ||
    configStat.uid !== process.getuid() ||
    configStat.mode & 0o077
  )
    fail();
  const configPath = join(configDirectory, 'config.json'),
    config = await privateRead(configPath);
  if (config === undefined) await save(configPath, { auths: {} });
  else if (config !== JSON.stringify({ auths: {} })) fail();
  transport ??= (args, input, timeout) => docker(args, input, timeout, configDirectory);
  const nativeImage = decode(await transport(['image', 'inspect', image, '--format', imageFormat]));
  if (
    !/^sha256:[a-f0-9]{64}$/.test(nativeImage.Id ?? '') ||
    !nativeImage.RepoDigests?.includes(image) ||
    nativeImage.Os !== 'linux' ||
    !['amd64', 'arm64'].includes(nativeImage.Architecture)
  )
    fail();
  const binding = {
    schemaVersion: 1,
    image,
    buildId,
    operationId,
    bindingDigest,
    evidenceDigest,
    imageId: nativeImage.Id,
    platform: `${nativeImage.Os}/${nativeImage.Architecture}`,
    runnerSHA256: imageReplayRunnerSHA256,
  };
  async function execute(kind, historyJSON = '', workflowId = '', runId = '', originalHistorySHA256 = sha('')) {
    if (Buffer.byteLength(historyJSON) > 20 * 1024 * 1024 || typeof workflowId !== 'string' || workflowId.length > 1000)
      fail();
    const deadline = Date.now() + 60000;
    const work = async (args, input = '', timeout = 10000) => {
      if (Date.now() >= deadline) fail();
      const result = await transport(args, input, Math.min(timeout, deadline - Date.now()));
      if (Date.now() >= deadline) fail();
      return result;
    };
    if (!hex.test(originalHistorySHA256)) fail();
    const historySHA256 = originalHistorySHA256,
      historyJSONSHA256 = sha(historyJSON),
      key = sha(JSON.stringify({ kind, historySHA256, historyJSONSHA256, workflowId, runId }));
    const path = (suffix) => join(root, `${key}.${suffix}`);
    if (kind === 'replay' && !uuid.test(runId)) fail();
    const plan = { ...binding, kind, historySHA256, historyJSONSHA256, workflowId, runId };
    let intent = await privateRead(path('intent'));
    if (intent === undefined) {
      intent = { plan, nonce: randomUUID(), createdAt: new Date().toISOString() };
      await save(path('intent'), intent);
    } else intent = JSON.parse(intent);
    if (!isDeepStrictEqual(intent.plan, plan) || !uuid.test(intent.nonce ?? '')) fail();
    const name = `urm-image-replay-${intent.nonce}`,
      labels = { 'urm.replay.operation': operationId, 'urm.replay.intent': sha(JSON.stringify(intent)) };
    const cidPath = path('cid');
    const inspect = async (id) => {
      const r = await transport(['container', 'inspect', id, '--format', containerFormat]);
      if (r.code === 1 && new RegExp(`No such (object|container): ${id}(\\s|$)`).test(r.stderr ?? '')) return undefined;
      const c = decode(r),
        h = c.HostConfig,
        config = c.Config;
      if (
        Date.parse(c.Created) > Date.now() + 5000 ||
        c.Id !== id ||
        c.Image !== nativeImage.Id ||
        c.Name !== `/${name}` ||
        !Number.isFinite(Date.parse(c.Created)) ||
        Date.parse(c.Created) < Date.parse(intent.createdAt) - 1000 ||
        config?.Image !== image ||
        config.User !== 'node' ||
        !isDeepStrictEqual(config.Entrypoint, ['node']) ||
        !isDeepStrictEqual(config.Cmd, ['-e', imageReplayRunner]) ||
        Object.entries(labels).some(([k, v]) => config.Labels?.[k] !== v) ||
        h?.NetworkMode !== 'none' ||
        h.ReadonlyRootfs !== true ||
        h.Privileged !== false ||
        !isDeepStrictEqual(h.CapDrop, ['ALL']) ||
        !h.SecurityOpt?.includes('no-new-privileges') ||
        h.Memory !== 1024 ** 3 ||
        h.NanoCpus !== 1e9 ||
        h.PidsLimit !== 128 ||
        !isDeepStrictEqual(h.Tmpfs, { '/tmp': 'rw,noexec,nosuid,size=67108864' }) ||
        c.Mounts?.length !== 0 ||
        (h.Binds?.length ?? 0) !== 0
      )
        fail();
      return c;
    };
    let id, output, primary;
    const cleanupSaved = async () => {
      const value = await privateRead(path('cleanup'));
      if (value === undefined) return false;
      if (!hex.test(id ?? '') || !isDeepStrictEqual(JSON.parse(value), { id, removed: true })) fail();
      return true;
    };
    const cleanup = async () => {
      if (!id) return; // Unknown create ACK without a saved CID is inert and fenced; never start/adopt by name.
      if (!hex.test(id)) fail();
      let c = await inspect(id);
      if (!c) {
        const created = await privateRead(path('created')),
          remove = await privateRead(path('remove-attempt'));
        if (created === undefined || remove === undefined) fail();
        const owned = JSON.parse(created);
        if (
          owned.id !== id ||
          !isDeepStrictEqual(owned.plan, plan) ||
          !Number.isFinite(Date.parse(owned.createdAt ?? '')) ||
          !isDeepStrictEqual(JSON.parse(remove), { id })
        )
          fail();
        await save(path('cleanup'), { id, removed: true });
        return;
      }
      if (c.State?.Running) {
        if ((await privateRead(path('kill-attempt'))) !== undefined) fail();
        await save(path('kill-attempt'), { id });
        await transport(['container', 'kill', id]);
        c = await inspect(id);
        if (!c || c.State?.Running !== false) fail();
      }
      if ((await privateRead(path('remove-attempt'))) !== undefined) fail();
      await save(path('remove-attempt'), { id });
      await transport(['container', 'rm', id]);
      if (await inspect(id)) fail();
      await save(path('cleanup'), { id, removed: true });
    };
    try {
      const savedCid = await privateRead(cidPath, true);
      if (savedCid !== undefined) id = savedCid.trim();
      if (!id) {
        // Intent already persisted before the one inert CREATE; never resend an unknown CREATE.
        if ((await privateRead(path('create-attempt'))) !== undefined) fail();
        await save(path('create-attempt'), { intentSHA256: sha(JSON.stringify(intent)) });
        const result = await work([
          'container',
          'create',
          '--pull',
          'never',
          '--interactive',
          '--name',
          name,
          '--cidfile',
          cidPath,
          '--network',
          'none',
          '--read-only',
          '--user',
          'node',
          '--entrypoint',
          'node',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '128',
          '--memory',
          '1g',
          '--cpus',
          '1',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=67108864',
          ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
          image,
          '-e',
          imageReplayRunner,
        ]);
        id = (await privateRead(cidPath, true))?.trim();
        if (!id || !hex.test(id) || result.code !== 0 || result.stdout.trim() !== id) fail();
      }
      if (!hex.test(id)) fail();
      const savedResult = await privateRead(path('result'));
      const savedCleanup = await cleanupSaved();
      if (savedResult !== undefined) {
        if (!savedCleanup) await cleanup();
        if (await inspect(id)) fail();
        output = JSON.parse(savedResult);
      } else {
        const c = await inspect(id);
        if (!c || c.State?.Status !== 'created' || (await privateRead(path('start-attempt'))) !== undefined) fail();
        await save(path('created'), { id, createdAt: c.Created, plan });
        await save(path('start-attempt'), { id });
        const result = await work(
          ['container', 'start', '--attach', '--interactive', id],
          JSON.stringify({ buildId, kind, workflowId, runId, historyJSON, historySHA256, historyJSONSHA256 }),
          30000
        );
        const stopped = await inspect(id);
        if (
          !stopped ||
          stopped.State?.Running !== false ||
          stopped.State?.ExitCode !== 0 ||
          stopped.State?.OOMKilled !== false
        )
          fail();
        const response = decode(result);
        if (
          Object.keys(response).sort().join(',') !==
            'buildId,bundleSHA256,historyJSONSHA256,historySHA256,kind,runId,schemaVersion,workflowId' ||
          response.schemaVersion !== 1 ||
          response.buildId !== buildId ||
          response.kind !== kind ||
          response.historySHA256 !== historySHA256 ||
          response.historyJSONSHA256 !== historyJSONSHA256 ||
          response.workflowId !== workflowId ||
          response.runId !== runId ||
          !hex.test(response.bundleSHA256 ?? '')
        )
          fail();
        output = { ...plan, containerId: id, containerCreatedAt: c.Created, bundleSHA256: response.bundleSHA256 };
        await save(path('result'), output);
      }
      if (
        !isDeepStrictEqual(Object.fromEntries(Object.keys(plan).map((k) => [k, output[k]])), plan) ||
        output.containerId !== id ||
        !hex.test(output.bundleSHA256 ?? '')
      )
        fail();
    } catch {
      primary = true;
    } finally {
      try {
        if (!(await cleanupSaved())) await cleanup();
      } catch {
        primary = true;
      }
    }
    if (primary || !output || !(await cleanupSaved())) fail();
    return { ...output, receiptSHA256: sha(JSON.stringify(canonical(output))), cleanupConfirmed: true };
  }
  const imageProof = await execute('inspect');
  return {
    bundleSHA256: imageProof.bundleSHA256,
    imageProof,
    replayHistory: async (history, workflowId, runId) => {
      let proof;
      try {
        const wire = options.historyToJSON(history);
        if (typeof wire !== 'string') fail();
        proof = await execute('replay', wire, workflowId, runId, sha(JSON.stringify(canonical(history))));
      } catch {
        return fail();
      }
      if (proof.bundleSHA256 !== imageProof.bundleSHA256) fail();
      return proof;
    },
  };
}

export async function createImageReplayObserver(options, transport) {
  try {
    return await createObserver(options, transport);
  } catch {
    return fail();
  }
}

export function assertImageReplayReceipt(receipt, expected) {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'replay' ||
    receipt.cleanupConfirmed !== true ||
    receipt.runnerSHA256 !== imageReplayRunnerSHA256 ||
    !hex.test(receipt.receiptSHA256 ?? '') ||
    !hex.test(receipt.historyJSONSHA256 ?? '') ||
    !hex.test(receipt.containerId ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId ?? '') ||
    !Number.isFinite(Date.parse(receipt.containerCreatedAt ?? '')) ||
    Object.entries(expected).some(([k, v]) => receipt[k] !== v)
  )
    fail();
  const { receiptSHA256, cleanupConfirmed, ...body } = receipt;
  if (sha(JSON.stringify(canonical(body))) !== receiptSHA256) fail();
  return receipt;
}
