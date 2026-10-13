import type { DurableJobRef } from '@upperroom/contracts/temporal';

export interface ImageIntent {
  providerAccount?: { appKey: '9XTSHD'; principalHash: string };
  operation: 'ingest' | 'delete' | 'reconcile';
  originalJobId?: string;
  sourceAcknowledgementId?: string;
  canonicalImageId?: string;
  imageId: string;
  source: { bucket: string; path: string; generation: string; contentType: string };
  name: string;
  type: 'square' | 'wide' | 'banner';
  remoteId?: string;
}

export function normalizeImageIntent(
  payload: Record<string, unknown>,
  operation: ImageIntent['operation']
): ImageIntent {
  const source = payload.source as ImageIntent['source'] | undefined;
  if (
    !source ||
    typeof source.bucket !== 'string' ||
    typeof source.path !== 'string' ||
    (!source.path.startsWith('speaker-images/') && !source.path.startsWith('durable-image-sources/')) ||
    source.path.includes('..') ||
    !/^\d+$/.test(source.generation) ||
    !/^image\/(jpeg|png|webp|gif|tiff)$/.test(source.contentType)
  )
    throw new Error('Invalid immutable image source');
  if (typeof payload.imageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.imageId))
    throw new Error('Invalid image identity');
  if (!['square', 'wide', 'banner'].includes(String(payload.type))) throw new Error('Invalid image dimensions');
  if (typeof payload.name !== 'string' || !payload.name || payload.name.length > 256)
    throw new Error('Invalid image name');
  return {
    operation,
    imageId: payload.imageId,
    source: { ...source },
    type: payload.type as ImageIntent['type'],
    name: payload.name,
    ...(typeof payload.remoteId === 'string' ? { remoteId: payload.remoteId } : {}),
  };
}

export interface ImageActivities {
  getImageDisposition(ref: DurableJobRef): Promise<'continue' | 'retained' | 'additional_review'>;
  prepareImage(ref: DurableJobRef): Promise<void>;
  allocateImage(ref: DurableJobRef): Promise<void>;
  uploadImageBytes(ref: DurableJobRef): Promise<void>;
  commitImage(ref: DurableJobRef): Promise<void>;
  deleteImageProviders(ref: DurableJobRef): Promise<void>;
  supersedeImage(ref: DurableJobRef): Promise<void>;
  reconcileImageReceipt(ref: DurableJobRef): Promise<'complete' | 'review'>;
  cancelImage(ref: DurableJobRef): Promise<void>;
  finishImage(
    ref: DurableJobRef,
    state: 'succeeded' | 'cancelled' | 'needs_attention' | 'superseded',
    failureCode?: string
  ): Promise<void>;
}
