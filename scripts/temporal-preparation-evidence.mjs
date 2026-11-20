import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { applicationStages } from './validate-application.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';

const fail = () => { throw new Error('CLOUD_RUN_PREPARATION_EVIDENCE_UNCONFIRMED'); };
const sha = value => createHash('sha256').update(value).digest('hex');
/** Read hash-bound private producer receipts; content and underlying SDK errors never escape. */
export async function readPreparationReceipt(path, expectedSHA256) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path) || !/^[a-f0-9]{64}$/.test(expectedSHA256 ?? '')) fail();
  let handle;
  try {
    handle = await open(await realpath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size < 1 || file.size > 4 * 1024 * 1024) fail();
    const buffer = Buffer.alloc(file.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size || sha(buffer.subarray(0, bytesRead)) !== expectedSHA256) fail();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return fail(); }
  finally { await handle?.close(); }
}

/** Fixed repository only. The live release entry never accepts an injected GitHub reader. */
export function readPreparationGithub(path) {
  if (!/^\/(?:actions\/(?:runs\/[1-9][0-9]*|artifacts\/[1-9][0-9]*(?:\/zip)?)|git\/commits\/[a-f0-9]{40})$/.test(path)) fail();
  try {
    const archive = path.endsWith('/zip');
    const output = execFileSync('gh', ['api', `repos/upperroommedia/web-app${path}`], {
      encoding: archive ? undefined : 'utf8', timeout: 60000,
      maxBuffer: archive ? 32 * 1024 * 1024 : 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return archive ? output : JSON.parse(output);
  } catch { return fail(); }
}

/** Join the existing root-produced full-CI/tree and uploaded-source/image receipts
 * to fresh authenticated GitHub/CloudBuild metadata. This is metadata provenance,
 * not SLSA or an independent compiled-byte attestation. No remote mutation occurs.
 */
export async function verifyPreparationEvidence({
  path, digest, platform, binding, google, github = readPreparationGithub, signedPullRequestBase,
}) {
  validateCloudRunReleasePlatform(platform);
  try {
    const proof = await readPreparationReceipt(path, digest);
    if (Object.keys(proof).sort().join(',') !== 'ci,image,schemaVersion' || proof.schemaVersion !== 1 ||
      Object.keys(proof.ci ?? {}).sort().join(',') !== 'path,sha256' ||
      Object.keys(proof.image ?? {}).sort().join(',') !== 'path,sha256' || typeof google !== 'function') fail();
    const ci = await readPreparationReceipt(proof.ci.path, proof.ci.sha256);
    const image = await readPreparationReceipt(proof.image.path, proof.image.sha256);
    const commit = platform.workerBuildId;
    if (binding.runtimeCommit !== commit || ci.head !== commit || image.commit !== commit ||
      ci.sourceTree !== ci.mergeTree || ci.sourceTree !== image.tree ||
      !/^[a-f0-9]{40}$/.test(ci.sourceTree ?? '') || !/^[a-f0-9]{40}$/.test(ci.mergeRef ?? '') ||
      !Number.isSafeInteger(ci.ciRun) || ci.ciRun < 1 || !Number.isSafeInteger(ci.artifactId) || ci.artifactId < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(ci.artifactArchiveDigest ?? '') || ci.applicationStages !== 19 ||
      image.image !== platform.workerImage || !/^[a-f0-9-]{36}$/.test(image.buildId ?? '')) fail();
    const run = await github(`/actions/runs/${ci.ciRun}`);
    const artifact = await github(`/actions/artifacts/${ci.artifactId}`);
    const head = await github(`/git/commits/${commit}`);
    const merge = await github(`/git/commits/${ci.mergeRef}`);
    if (run.id !== ci.ciRun || run.head_sha !== commit || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.path !== '.github/workflows/temporal-application-validation.yml' || run.repository?.full_name !== 'upperroommedia/web-app' ||
      artifact.id !== ci.artifactId || artifact.expired !== false || artifact.digest !== ci.artifactArchiveDigest ||
      artifact.workflow_run?.id !== ci.ciRun || artifact.workflow_run?.head_sha !== commit ||
      head.sha !== commit || head.tree?.sha !== ci.sourceTree || merge.sha !== ci.mergeRef || merge.tree?.sha !== ci.sourceTree ||
      merge.parents?.length !== 2 || merge.parents[1]?.sha !== commit ||
      !Array.isArray(ci.parents) || ci.parents.some((parent, i) => parent !== merge.parents[i]?.sha) || ci.parents.length !== 2) fail();
    if (signedPullRequestBase !== undefined &&
      (head.verification?.verified !== true || run.event !== 'pull_request' || merge.parents[0].sha !== signedPullRequestBase))
      fail();
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      artifact.name !== `application-validation-${ci.ciRun}-${run.run_attempt}`) fail();
    const zip = await github(`/actions/artifacts/${ci.artifactId}/zip`);
    if (!Buffer.isBuffer(zip) || zip.length > 32 * 1024 * 1024 || `sha256:${sha(zip)}` !== artifact.digest) fail();
    const summaries = JSON.parse(execFileSync('python3', ['-c', `
import io,json,zipfile,sys
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
if len(z.infolist())>16: raise ValueError('archive bound')
result={}
for expected in ['application-summary.json','temporal-worker-summary.json']:
 entries=[i for i in z.infolist() if i.filename.split('/')[-1]==expected]
 if len(entries)!=1 or entries[0].file_size>4194304: raise ValueError('summary bound')
 result[expected]=json.loads(z.read(entries[0]))
print(json.dumps(result))
`], { input: zip, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
    const application = summaries['application-summary.json'], worker = summaries['temporal-worker-summary.json'];
    if (application.schemaVersion !== 1 || application.passed !== true || application.source?.commit !== ci.mergeRef ||
      application.source?.tree !== ci.sourceTree || application.source?.trackedDiffSha256 !== sha('') ||
      !Array.isArray(application.stages) || application.stages.length !== 19 ||
      application.stages.some((stage, i) => stage.id !== applicationStages()[i]?.id) ||
      application.stages.some(stage => stage.status !== 'passed' ||
        !Array.isArray(stage.commands) || stage.commands.length !== applicationStages()[application.stages.indexOf(stage)].commands.length ||
        stage.commands.some(command => command.code !== 0 || command.signal !== null)) ||
      worker.schemaVersion !== 1 || worker.passed !== true || !Array.isArray(worker.filters) || worker.filters.length ||
      !Array.isArray(worker.suites) || worker.suites.length < 48 ||
      worker.suites.some(suite => suite.status !== 'passed' || suite.exitCode !== 0)) fail();

    // Every retained producer input remains byte-bound. A passed flag alone grants nothing.
    const inputs = Object.entries(image.inputs ?? {});
    if (inputs.length !== 4) fail();
    const loaded = [];
    for (const [inputPath, inputSHA] of inputs) loaded.push(await readPreparationReceipt(inputPath, inputSHA));
    const upload = loaded.find(input => input.buildId === image.buildId && input.source && input.archiveSha256 && input.regularFilesVerified);
    const recipe = loaded.find(input => Array.isArray(input.steps) && Array.isArray(input.images));
    if (!upload || upload.commit !== commit || upload.tree !== ci.sourceTree || !recipe ||
      upload.source.bucket !== 'urm-app-staging_cloudbuild' || !/^[1-9][0-9]{0,19}$/.test(upload.source.generation ?? '') ||
      !/^source\/[A-Za-z0-9._-]+\.tgz$/.test(upload.source.object ?? '')) fail();
    const name = `projects/urm-app-staging/locations/us-central1/builds/${image.buildId}`;
    const nativeBuild = await google(`https://cloudbuild.googleapis.com/v1/${name}`);
    const expectedDigest = platform.workerImage.split('@')[1];
    if (nativeBuild.id !== image.buildId || nativeBuild.projectId !== 'urm-app-staging' || nativeBuild.status !== 'SUCCESS' ||
      nativeBuild.substitutions?._BUILD_ID !== commit || nativeBuild.substitutions?._IMAGE !== `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker:${commit}` ||
      ['bucket', 'object', 'generation'].some(key => nativeBuild.sourceProvenance?.resolvedStorageSource?.[key] !== upload.source[key]) ||
      !nativeBuild.results?.images?.some(result => result.digest === expectedDigest &&
        result.name === `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker:${commit}`)) fail();
    const sourceURI = `gs://${upload.source.bucket}/${upload.source.object}#${upload.source.generation}`;
    const nativeSourceSHA = nativeBuild.sourceProvenance?.fileHashes?.[sourceURI]?.fileHash?.find(item => item.type === 'SHA256')?.value;
    if (typeof nativeSourceSHA !== 'string' || Buffer.from(nativeSourceSHA, 'base64url').toString('hex') !== upload.archiveSha256) fail();
    // Only the reviewed two substitutions may expand the saved pinned recipe.
    const expanded = JSON.parse(JSON.stringify(recipe.steps).replace(/\$\{(_BUILD_ID|_IMAGE)\}/g,
      (_, key) => nativeBuild.substitutions[key]));
    if (nativeBuild.steps?.some(step => Object.keys(step).some(key =>
      !['name', 'args', 'env', 'status', 'timing', 'pullTiming'].includes(key))) ||
      JSON.stringify(nativeBuild.steps?.map(({ name, args, env }) => ({ name, args, env }))) !==
      JSON.stringify(expanded.map(({ name, args, env }) => ({ name, args, env })))) fail();
    return { schemaVersion: 1, commit, tree: ci.sourceTree, image: platform.workerImage, ciRun: ci.ciRun,
      artifactId: ci.artifactId, artifactDigest: ci.artifactArchiveDigest, nativeBuild: name,
      inputDigest: digest, verifiedAt: new Date().toISOString(),
      scope: 'native metadata joined to hash-bound root-produced source/CI receipts; not SLSA or runtime readiness' };
  } catch { return fail(); }
}
