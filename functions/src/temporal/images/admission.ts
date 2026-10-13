import { createHash } from 'node:crypto';
import type { Storage } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import type { ImageIntent } from './types';

/** Derive provider identity from the canonical record, never trust browser IDs. */
export async function normalizeImageAdmission(input: {
  kind: 'image.ingest' | 'image.delete';
  entityId: string;
  requestId: string;
  payload: Record<string, unknown>;
  actorUid: string;
  imagesBucket: string;
  firestore: Firestore;
  storage: Storage;
}): Promise<ImageIntent> {
  if (input.kind === 'image.delete') {
    const snapshot = await input.firestore.collection('images').doc(input.entityId).get();
    if (!snapshot.exists) throw new Error('Image no longer exists');
    const image = snapshot.data()!;
    if (!image.source?.generation)
      throw new Error('Legacy image must have its source generation reconciled before deletion');
    const allocation = image.durableJobId
      ? (await input.firestore.collection('temporalImageReceipts').doc(image.durableJobId).get()).data()
      : undefined;
    const providerAccount =
      allocation?.remoteId === image.subsplashId && allocation?.providerAccount?.appKey === '9XTSHD'
        ? allocation.providerAccount
        : undefined;
    return {
      operation: 'delete',
      imageId: snapshot.id,
      source: image.source,
      ...(providerAccount ? { providerAccount } : {}),
      name: image.name,
      type: image.type,
      ...(image.subsplashId ? { remoteId: image.subsplashId } : {}),
    };
  }
  const sourcePath = `durable-image-sources/${input.actorUid}/${input.requestId}/source`;
  if (
    input.payload.sourcePath !== sourcePath ||
    typeof input.payload.sourceGeneration !== 'string' ||
    !/^\d+$/.test(input.payload.sourceGeneration)
  )
    throw new Error('Invalid image upload source');
  if (!['square', 'wide', 'banner'].includes(String(input.payload.type))) throw new Error('Invalid image type');
  if (typeof input.payload.name !== 'string' || input.payload.name.length > 256 || !input.payload.name)
    throw new Error('Invalid image name');
  const file = input.storage
    .bucket(input.imagesBucket)
    .file(sourcePath, { generation: input.payload.sourceGeneration });
  const [metadata] = await file.getMetadata();
  if (
    metadata.metadata?.ownerUID !== input.actorUid ||
    metadata.metadata?.durableRequestId !== input.requestId ||
    String(metadata.generation) !== input.payload.sourceGeneration ||
    metadata.contentType !== input.payload.contentType ||
    !/^image\/(jpeg|png|webp|gif|tiff)$/.test(String(metadata.contentType)) ||
    Number(metadata.size) > 25 * 1024 * 1024
  )
    throw new Error('Image source ownership or content is invalid');
  const imageId = createHash('sha256').update(`${input.actorUid}:${input.requestId}`).digest('hex');
  return {
    operation: 'ingest',
    imageId,
    name: input.payload.name,
    type: input.payload.type as ImageIntent['type'],
    source: {
      bucket: input.imagesBucket,
      path: sourcePath,
      generation: input.payload.sourceGeneration,
      contentType: String(metadata.contentType),
    },
  };
}

/** Trusted event entrypoint only; callable clients cannot choose this system actor. */
export async function enqueueSystemImage(input: {
  firestore: Firestore;
  projectId: string;
  eventId: string;
  intent: ImageIntent;
}): Promise<void> {
  const { enqueueSystemJob } = await import('../bridge');
  const kind = input.intent.operation === 'ingest' ? 'image.ingest' : 'image.delete';
  const entity = { type: 'image' as const, id: input.intent.imageId };
  const jobId = createHash('sha256')
    .update(JSON.stringify([input.projectId, input.eventId, kind, entity]))
    .digest('hex');
  await enqueueSystemJob({
    kind,
    entity,
    payload: { ...input.intent },
    eventId: input.eventId,
    dispatch: {
      workflowId: `image:${input.projectId}:${jobId}`,
      workflowType: input.intent.operation === 'ingest' ? 'ImageIngest' : 'ImageDelete',
      taskQueue: 'urm-images',
    },
  });
}
