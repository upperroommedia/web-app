import type { Bucket } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { MEDIA_ARTIFACTS, mediaArtifactId } from '@upperroom/orchestration/media-artifacts';

interface PlaybackInput {
  sermonId: string;
  generation: string;
}

const unavailable = () => new HttpsError('failed-precondition', 'The published audio is no longer available.');
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';

/** Select only the current sermon generation. Streaming and seeking go straight
 * to Storage, with the selected generation included in the signed request. */
export async function resolvePinnedAudioPlayback(
  request: Pick<CallableRequest<PlaybackInput>, 'auth' | 'data'>,
  firestore: Firestore,
  bucket: Bucket,
  projectId: string | undefined
) {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in to play the published audio.');
  const { sermonId, generation } = request.data ?? {};
  if (
    typeof sermonId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(sermonId) ||
    typeof generation !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(generation)
  )
    throw new HttpsError('invalid-argument', 'Invalid audio selection.');

  if (projectId !== 'urm-app-staging' || bucket.name !== 'urm-app-staging.firebasestorage.app') throw unavailable();
  const sermonRef = firestore.collection('sermons').doc(sermonId);
  const select = () =>
    firestore.runTransaction(
      async (tx) => {
        const sermon = await tx.get(sermonRef);
        if (!sermon.exists || (!canUserRolePublish(auth.token.role) && sermon.get('uploaderId') !== auth.uid))
          throw new HttpsError('permission-denied', 'You do not have permission to play this audio.');
        const path: unknown = sermon.get('audioArtifacts.finalPath');
        const jobId: unknown = sermon.get('audioArtifacts.jobId');
        const version: unknown = sermon.get('audioArtifacts.requestVersion');
        if (
          sermon.get('audioArtifacts.finalGeneration') !== generation ||
          typeof jobId !== 'string' ||
          !jobId ||
          typeof version !== 'string' ||
          !/^[a-f0-9]{16}$/.test(version) ||
          typeof path !== 'string' ||
          !new RegExp(`^workflow-audio/${sermonId}/${version}/(?:processed|final)-${uuid}\\.mp3$`).test(path)
        )
          throw unavailable();
        const artifact = await tx.get(firestore.collection(MEDIA_ARTIFACTS).doc(mediaArtifactId(projectId, path)));
        if (
          !artifact.exists ||
          artifact.get('projectId') !== projectId ||
          artifact.get('sermonId') !== sermonId ||
          artifact.get('path') !== path ||
          artifact.get('ownerJobId') !== jobId ||
          artifact.get('status') !== 'retained' ||
          artifact.get('generation') !== generation
        )
          throw unavailable();
        return path;
      },
      { readOnly: true }
    );

  const path = await select();
  try {
    // FileOptions.generation is converted to a JS number by the SDK. Keep
    // the exact decimal string in the signature's query parameters instead.
    const file = bucket.file(path);
    const [metadata] = await file.getMetadata();
    if (
      metadata.generation !== generation ||
      metadata.name !== path ||
      metadata.bucket !== bucket.name ||
      metadata.contentType !== 'audio/mpeg'
    )
      throw unavailable();
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 2 * 60 * 60 * 1000,
      queryParams: { generation },
    });
    if ((await select()) !== path) throw unavailable();
    return { url };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw unavailable();
  }
}

export default onCall({ invoker: 'public' }, (request: CallableRequest<PlaybackInput>) =>
  resolvePinnedAudioPlayback(
    request,
    firebaseAdmin.firestore(),
    firebaseAdmin.storage().bucket(),
    firebaseAdmin.app().options.projectId
  )
);
