const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const audio = '../../../apps/process-audio/src';
const identity = require(`${audio}/temporal/hetzner-acquisition-identity.ts`);
const { getFFmpegPath } = require(`${audio}/utils.ts`);
const {
  claimNativeYouTubeRender,
  recordOwnedYouTubeRenderCandidate,
} = require(`${audio}/temporal/hetzner-render-claim.ts`);
const { readYouTubeRenderReceipt } = require(`${audio}/temporal/hetzner-render-receipt.ts`);
const { readYouTubeRenderArtifact, youtubeRenderOutput } = require(`${audio}/temporal/hetzner-render-output.ts`);
const { requireYouTubeRenderSlot, youtubeRenderSlot } = require(`${audio}/temporal/hetzner-render-slot.ts`);

module.exports = ({ db, auth, bucket }) => {
  // The only simulated surfaces are HTTP/OIDC, Hetzner process identity,
  // provider extraction and parent close. Activity, DB and bytes use real SDKs.
  const serviceAccount = `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`;
  const buildId = 'b'.repeat(40);
  const processId = process.pid;
  identity.inspectNativeYouTubeProcess = async (pid, build) => {
    assert.equal(pid, processId + 1);
    assert.equal(build, buildId);
    return {
      processId,
      buildId,
      bootId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pidNamespace: 'pid:[1234]',
      startTicks: '100',
    };
  };
  require(`${audio}/processYouTubeUrl.ts`).downloadYouTubeAudioToFile = async () => {
    throw Error('TEST_VENDOR_NETWORK_FORBIDDEN');
  };
  return (_project, { episodeId }) =>
    async (method, { ref, operationId }, signal) => {
      signal.throwIfAborted();
      const options = { firestore: db, auth, verifiedCallerEmail: serviceAccount, episodeId, ref };
      if (method === 'GET') {
        const receipt = await db.runTransaction((tx) => readYouTubeRenderReceipt(tx, options), { maxAttempts: 1 });
        return { status: receipt.kind, operationId };
      }
      assert.equal(method, 'POST');
      const parent = db.doc(`temporalYouTubeAcquisitions/${operationId}`);
      assert.equal((await parent.get()).get('renderClaim'), undefined);
      const start = await claimNativeYouTubeRender({
        ...options,
        processId: processId + 1,
        buildId,
        assertFresh: () => signal.throwIfAborted(),
      });
      assert.equal(start.launch, true);

      const paths = youtubeRenderOutput(ref, episodeId);
      const [raw] = await bucket.file(`sermons/${ref.sermonId}.wav`).download();
      const mp3 = execFileSync(getFFmpegPath(), ['-v', 'error', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], {
        input: raw,
        timeout: 5000,
      });
      const upload = async (path, bytes, contentType) =>
        bucket.file(path).save(bytes, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { metadata: paths.metadata, contentType },
        });
      await upload(paths.source, raw, 'application/octet-stream');
      await upload(paths.processed, mp3, 'audio/mpeg');
      const artifact = (stage) =>
        readYouTubeRenderArtifact({ bucket, ref, attemptId: episodeId, stage, duration: 1, signal });
      const [source, processed] = await Promise.all([artifact('source'), artifact('processed')]);
      await recordOwnedYouTubeRenderCandidate({
        ...options,
        claim: start.claim,
        candidate: { source, processed, final: processed },
        signal,
      });
      // A valid candidate with both objects present is still pending before CLOSE.
      const beforeClose = await db.runTransaction((tx) => readYouTubeRenderReceipt(tx, options), { maxAttempts: 1 });
      assert.equal(beforeClose.kind, 'running');
      await db.runTransaction(
        async (tx) => {
          const render = parent.collection('render');
          const candidate = await tx.get(render.doc('candidate'));
          const slot = await requireYouTubeRenderSlot(tx, db, youtubeRenderSlot(ref, episodeId));
          tx.delete(slot);
          tx.create(render.doc('close'), {
            schemaVersion: 1,
            ref,
            episodeId,
            owner: start.claim.owner,
            startedAt: start.claim.startedAt,
            close: { processId, exitCode: 0, exitSignal: null, outcome: 'completed', closedAt: Date.now() },
            ipcAttempted: true,
            candidateVersion: candidate.updateTime,
          });
        },
        { maxAttempts: 1 }
      );
      throw Error('CONTROLLED_RENDER_RESPONSE_LOST_AFTER_CLOSE');
    };
};
