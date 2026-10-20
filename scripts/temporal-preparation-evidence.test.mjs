import test from 'node:test';
import { applicationStages } from './validate-application.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyPreparationEvidence, readPreparationReceipt } from './temporal-preparation-evidence.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const buildId = 'a'.repeat(40), image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`;
function platform() {
  const workerRoles = ['orchestration', 'controls'];
  return { schemaVersion: 1, environment: 'staging', workerHosting: 'cloud-run', connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging', firebaseResources: { storageBucket: 'urm-app-staging.firebasestorage.app', imagesBucket: 'urm-app-staging-images', databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/' },
    temporalNamespace: 'urm-app-staging.qwejt', cloudAccountId: 'qwejt', cloudProvider: 'gcp', cloudRegion: 'us-central1', cloudAddress: 'us-central1.gcp.api.temporal.io:7233', cloudReplicaRegions: [], cloudEvidence: '/private/tmp/native-namespace', workerBuildId: buildId, workerImage: image, workerRoles, dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key', operatorApiKeySHA256: 'c'.repeat(64), dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map(role => ({ projectId: 'urm-app-staging', region: 'us-central1', namespace: 'urm-app-staging.qwejt', buildId, role, ...serverlessResourceNames(buildId, role), image, maxInstances: 1, stabilizationSeconds: 180 })) };
}

async function evidenceFixture(t, change = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'preparation-evidence-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const p = platform(), tree = 'd'.repeat(40), mergeRef = 'e'.repeat(40), base = 'f'.repeat(40);
  const build = '11111111-2222-4333-8444-555555555555';
  const application = { schemaVersion: 1, passed: true, source: { commit: mergeRef, tree, trackedDiffSha256: sha('') },
    stages: applicationStages().map(stage => ({ id: stage.id, status: 'passed', commands: stage.commands.map(() => ({ code: 0, signal: null })) })) };
  const worker = { schemaVersion: 1, passed: true, filters: [], suites: Array.from({ length: 48 }, (_, i) => ({ path: `suite-${i}`, status: 'passed', exitCode: 0 })) };
  const scenario = { application, worker };
  change(scenario);
  const zip = execFileSync('python3', ['-c', `import io,json,zipfile,sys
x=json.load(sys.stdin); b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('application-summary.json',json.dumps(x['application']))
 z.writestr('temporal-worker-summary.json',json.dumps(x['worker']))
sys.stdout.buffer.write(b.getvalue())`], { input: JSON.stringify(scenario) });
  const ci = { head: buildId, sourceTree: tree, mergeTree: tree, mergeRef, parents: [base, buildId], ciRun: 123, artifactId: 456, applicationStages: 19, artifactArchiveDigest: `sha256:${sha(zip)}` };
  const run = { id: 123, head_sha: buildId, status: 'completed', conclusion: 'success', path: '.github/workflows/temporal-application-validation.yml', repository: { full_name: 'upperroommedia/web-app' }, run_attempt: 1 };
  const artifact = { id: 456, expired: false, digest: ci.artifactArchiveDigest, workflow_run: { id: 123, head_sha: buildId }, name: 'application-validation-123-1' };
  const source = { bucket: 'urm-app-staging_cloudbuild', object: 'source/example.tgz', generation: '12345' };
  const upload = { buildId: build, commit: buildId, tree, source, archiveSha256: '1'.repeat(64), regularFilesVerified: 2195 };
  const recipe = { steps: [{ name: 'gcr.io/cloud-builders/docker', args: ['build', '--build-arg', 'TEMPORAL_IMAGE_BUILD_ID=${_BUILD_ID}', '-t', '${_IMAGE}', '.'] }], images: ['${_IMAGE}'] };
  const tag = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker:${buildId}`;
  const native = { id: build, projectId: 'urm-app-staging', status: 'SUCCESS', substitutions: { _BUILD_ID: buildId, _IMAGE: tag },
    sourceProvenance: { resolvedStorageSource: source, fileHashes: { [`gs://${source.bucket}/${source.object}#${source.generation}`]: { fileHash: [{ type: 'SHA256', value: Buffer.from(upload.archiveSha256, 'hex').toString('base64url') }] } } },
    results: { images: [{ name: tag, digest: p.workerImage.split('@')[1] }] },
    steps: [{ name: recipe.steps[0].name, args: ['build', '--build-arg', `TEMPORAL_IMAGE_BUILD_ID=${buildId}`, '-t', tag, '.'], status: 'SUCCESS' }] };
  const save = async (name, data) => { const path = join(directory, name), bytes = JSON.stringify(data); await writeFile(path, bytes, { mode: 0o600 }); return { path, sha256: sha(bytes) }; };
  const inputs = {};
  for (const [i, value] of [upload, recipe, { sourceReceipt: true }, { observation: true }].entries()) {
    const file = await save(`input-${i}`, value); inputs[file.path] = file.sha256;
  }
  const imageReceipt = { commit: buildId, tree, buildId: build, image: p.workerImage, inputs };
  const proof = { schemaVersion: 1, ci: await save('ci', ci), image: await save('image', imageReceipt) };
  const file = await save('proof', proof), calls = [];
  const records = { '/actions/runs/123': run, '/actions/artifacts/456': artifact, '/actions/artifacts/456/zip': zip,
    [`/git/commits/${buildId}`]: { sha: buildId, tree: { sha: tree } }, [`/git/commits/${mergeRef}`]: { sha: mergeRef, tree: { sha: tree }, parents: [{ sha: base }, { sha: buildId }] } };
  return { directory, proof, file, records, native, options: { path: file.path, digest: file.sha256, platform: p, binding: { runtimeCommit: buildId },
    github: async path => { calls.push(path); return records[path]; }, google: async url => { calls.push(url); return native; } }, calls };
}
test('joins actual bounded ZIP bytes, exact tested merge, source archive and expanded native build recipe', async t => {
  const f = await evidenceFixture(t);
  const result = await verifyPreparationEvidence(f.options);
  assert.equal(result.commit, buildId);
  assert.match(result.scope, /not SLSA or runtime readiness/);
  assert.equal(f.calls.filter(x => x.endsWith('/zip')).length, 1);
});
for (const mutation of ['failed-stage', 'nonzero-command', 'filtered-worker', 'failed-worker', 'duplicate-stage', 'missing-commands'])
  test(`rejects summary ${mutation} even when outer receipts and archive hash agree`, async t => {
    const f = await evidenceFixture(t, ({ application, worker }) => {
      if (mutation === 'failed-stage') application.stages[0].status = 'failed';
      if (mutation === 'nonzero-command') application.stages[0].commands[0].code = 1;
      if (mutation === 'filtered-worker') worker.filters = ['subset'];
      if (mutation === 'failed-worker') worker.suites[0].exitCode = 1;
      if (mutation === 'missing-commands') application.stages[0].commands = [];
      if (mutation === 'duplicate-stage') application.stages[1].id = application.stages[0].id;
    });
    await assert.rejects(verifyPreparationEvidence(f.options), /EVIDENCE_UNCONFIRMED/);
  });
for (const mutation of ['zip-bytes', 'run-head', 'merge-parent', 'expired', 'source-generation', 'source-hash', 'image-digest', 'recipe'])
  test(`rejects native ${mutation} mismatch without any mutation API`, async t => {
    const f = await evidenceFixture(t);
    if (mutation === 'zip-bytes') f.records['/actions/artifacts/456/zip'] = Buffer.from('wrong');
    if (mutation === 'run-head') f.records['/actions/runs/123'].head_sha = '0'.repeat(40);
    if (mutation === 'merge-parent') f.records[`/git/commits/${'e'.repeat(40)}`].parents[1].sha = '0'.repeat(40);
    if (mutation === 'expired') f.records['/actions/artifacts/456'].expired = true;
    if (mutation === 'source-generation') f.native.sourceProvenance.resolvedStorageSource = { ...f.native.sourceProvenance.resolvedStorageSource, generation: '999' };
    if (mutation === 'source-hash') f.native.sourceProvenance.fileHashes = {};
    if (mutation === 'image-digest') f.native.results.images[0].digest = `sha256:${'0'.repeat(64)}`;
    if (mutation === 'recipe') f.native.steps[0].args.push('--unreviewed');
    await assert.rejects(verifyPreparationEvidence(f.options), /EVIDENCE_UNCONFIRMED/);
  });
test('private evidence rejects altered bytes, world-readable receipts and missing nested producer inputs', async t => {
  const f = await evidenceFixture(t);
  await assert.rejects(readPreparationReceipt(f.file.path, '0'.repeat(64)));
  await chmod(f.file.path, 0o644);
  await assert.rejects(verifyPreparationEvidence(f.options));
  await chmod(f.file.path, 0o600);
  const image = JSON.parse(await (await import('node:fs/promises')).readFile(f.proof.image.path));
  await rm(Object.keys(image.inputs)[0]);
  await assert.rejects(verifyPreparationEvidence(f.options));
});
