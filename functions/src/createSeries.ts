import {getDurablePublishingJobId,isDurablePublishingOperation,beginProviderMutationPlan,getPublishingMutationOperation,prepareProviderMutationPlanCommit} from './temporal/publishing/durableOperationContext';
/**
 * Firebase callable function to create a new media series
 */

import type {SubsplashSeries} from './types/SubsplashSeries';
import {acknowledgedProjectionDigest} from './temporal/publishing/criticalAcknowledgedRepair';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, Transaction, type Firestore } from 'firebase-admin/firestore';
import { authenticateSubsplash } from './subsplashUtils';
import {
  createSubsplashSeries,
  getSeriesSubtitleFromPublishedCount,
  patchSeriesMetadata,
} from './helpers/seriesHelpers';
import { repairMismatchedSubsplashImageRefs,type SubsplashPublishImageRef } from './helpers/subsplashImageRefs';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import {
  executeProviderCreate,
  providerReceiptId,
  providerPayloadFingerprint,
  readProviderReceipt,
} from './temporal/publishing/providerReceipts';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

const firestoreDB = firebaseAdmin.firestore();

const toSubsplashSeriesImageRefs = (
  images: Array<Pick<NonNullable<CreateSeriesInputType['images']>[number], 'id' | 'type' | 'subsplashId'>>
): Array<{ id: string; type: string }> =>
  images
    .map((image) => {
      const remoteImageId = image.subsplashId || image.id;
      if (!remoteImageId) {
        return undefined;
      }

      return {
        id: remoteImageId,
        type: image.type,
      };
    })
    .filter((image): image is { id: string; type: string } => image !== undefined);

export interface CreateSeriesInputType {
  title: string;
  summary?: string;
  ownerId: string; // User ID who owns the series
  firestoreId?: string; // Optional existing Firestore series ID to sync
  skipSubsplash?: boolean; // If true, only create in Firestore (for upload time)
  operationKey?: string;
  images?: Array<{
    // Optional images for the series
    id: string;
    type: string;
    downloadLink: string;
    name?: string;
    subsplashId?: string;
  }>;
}

export interface CreateSeriesOutputType {
  status: 'success' | 'error';
  firestoreId?: string;
  subsplashId?: string;
  slug?: string;
  error?: string;
}

const createSeries = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateSeriesInputType>): Promise<CreateSeriesOutputType> =>{
logger.log('createSeries');
const userRole = request.auth?.token.role;
if (!userRole) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"createSeries",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
return createSeriesDomain(request.data, userRole);
});
}
);

export const createSeriesDomain = async (
  data: CreateSeriesInputType,
  userRole: unknown,
  options?: { commitCurrent: (write: (transaction: Transaction) => Promise<void>) => Promise<void> }
): Promise<CreateSeriesOutputType> => {
  const commitCurrent =
    options?.commitCurrent ??
    ((write: (transaction: Transaction) => Promise<void>) => firestoreDB.runTransaction(write));
  if (userRole !== 'admin' && userRole !== 'publisher' && userRole !== 'uploader' && userRole !== 'user') {
    throw new HttpsError('permission-denied', 'A valid application role is required.');
  }
  const { title, summary, ownerId, skipSubsplash, images, operationKey } = data;
  const firestoreId = data.firestoreId?.trim();
  const suppliedOperationKey = operationKey?.trim();
  const stableFirestoreId =
    firestoreId || (suppliedOperationKey ? providerReceiptId(suppliedOperationKey, 'local-series') : undefined);
  const seriesRef = stableFirestoreId
    ? firestoreDB.collection('series').doc(stableFirestoreId)
    : firestoreDB.collection('series').doc();

  // Validation
  if (!title || !title.trim()) {
    throw new HttpsError('invalid-argument', 'Title is required and cannot be empty.');
  }
  if (!ownerId || !ownerId.trim()) {
    throw new HttpsError('invalid-argument', 'ownerId is required.');
  }

  const normalizedOperationKey = operationKey?.trim() || `create-series:${seriesRef.id}`;
  const receiptPayload = { ...data, firestoreId: seriesRef.id };
  const durableJobId=getDurablePublishingJobId();
  const creationState=durableJobId?firestoreDB.collection('temporalPublishingSeriesCreationState').doc(providerReceiptId(durableJobId,seriesRef.id)):undefined;
  const priorReceipt = await readProviderReceipt(providerReceiptId(normalizedOperationKey, 'subsplash-series'));
  if (priorReceipt && priorReceipt.fingerprint !== providerPayloadFingerprint(receiptPayload)) {
    throw new HttpsError('failed-precondition', 'An operation key cannot be reused with different series content.', {
      reason: 'PROVIDER_PAYLOAD_CHANGED',
    });
  }

  try {
    return await withSubsplashLocks(
      // The Firestore ID is the only stable identity before Subsplash has
      // created the remote series. Locking on it prevents concurrent item
      // publishes from each creating their own remote series.
      [`series:${seriesRef.id}`],
      async () => {
        // Re-read after acquiring the lock. A caller that waited for an
        // earlier create must reuse its result instead of acting on the
        // empty subsplashId observed before the wait.
        const existingSeriesDoc = await seriesRef.get();
        const existingSeriesData = existingSeriesDoc.data();
        const existingSubsplashId =
          typeof existingSeriesData?.subsplashId === 'string' ? existingSeriesData.subsplashId.trim() : '';

        const staged=creationState?(await creationState.get()).data():undefined;
        if (existingSubsplashId && (!isDurablePublishingOperation() || staged?.state!=='preparing' || staged?.remoteId!==existingSubsplashId || staged?.payloadFingerprint!==providerPayloadFingerprint(receiptPayload))) {
          logger.log(
            `Series already exists in Subsplash: Firestore ID=${seriesRef.id}, Subsplash ID=${existingSubsplashId}`
          );
          return {
            status: 'success',
            firestoreId: seriesRef.id,
            subsplashId: existingSubsplashId,
            ...(typeof existingSeriesData?.slug === 'string' && existingSeriesData.slug
              ? { slug: existingSeriesData.slug }
              : {}),
          };
        }

        const existingSeriesImages = existingSeriesDoc.exists
          ? (existingSeriesData?.images as CreateSeriesInputType['images'] | undefined)
          : undefined;
        const inputImages = images?.filter((image) => Boolean(image?.id && image?.type)) || [];
        const imagesToPersist = inputImages.length > 0 ? inputImages : existingSeriesImages || [];
        const initialSubtitle = getSeriesSubtitleFromPublishedCount(0);

        // If skipSubsplash is true, only create in Firestore (for upload time)
        if (skipSubsplash) {
          const firestoreData: Record<string, unknown> = {
            id: seriesRef.id,
            name: title.trim(),
            subtitle: initialSubtitle,
            images: imagesToPersist,
            itemCount: 0,
            publishedItemCount: 0,
            status: 'draft',
            subsplashId: '', // Empty until published
            ownerId: ownerId.trim(),
            updatedAt: FieldValue.serverTimestamp(),
          };
          if (!existingSeriesDoc.exists) {
            firestoreData.createdAt = FieldValue.serverTimestamp();
          } else {
            // A durable create replay must not reset membership projections that
            // changed after the first local create completed.
            for (const field of ['itemCount', 'publishedItemCount', 'subtitle', 'status']) {
              delete firestoreData[field];
            }
          }

          // Only add optional fields if they have values
          if (summary?.trim()) {
            firestoreData.summary = summary.trim();
          }

          await commitCurrent(async (transaction) => {
            transaction.set(seriesRef, firestoreData, { merge: existingSeriesDoc.exists });
          });

          logger.log(`Created local series: Firestore ID=${seriesRef.id} (no Subsplash sync)`);

          return {
            status: 'success',
            firestoreId: seriesRef.id,
            subsplashId: '', // Not yet created in Subsplash
          };
        }

        // Full creation with Subsplash sync (requires publish permissions)
        if (!canUserRolePublish(userRole)) {
          throw new HttpsError('permission-denied', 'Publishing to Subsplash requires publish permissions.');
        }

        // Authenticate with Subsplash
        const token = await authenticateSubsplash();
        const repairedImagesToPersist =
          staged?.schemaVersion===2&&Array.isArray(staged.images)?staged.images as NonNullable<CreateSeriesInputType['images']>:imagesToPersist.length > 0
            ? await repairMismatchedSubsplashImageRefs(imagesToPersist, token, normalizedOperationKey)
            : imagesToPersist;

        const publishedAt=durableJobId?new Date(Number((await firestoreDB.collection('durableJobs').doc(durableJobId).get()).get('createdAt'))).toISOString():new Date().toISOString();
        const rawCheckpoint={schemaVersion:2 as const,projectId:firebaseAdmin.app().options.projectId!,jobId:durableJobId??normalizedOperationKey,seriesId:seriesRef.id,operationKey:normalizedOperationKey,payloadFingerprint:providerPayloadFingerprint({...data,firestoreId:seriesRef.id,operationKey:normalizedOperationKey}),images:repairedImagesToPersist,originalExists:existingSeriesDoc.exists,originalDocumentDigest:acknowledgedProjectionDigest(existingSeriesData??null),publishedAt};
        let tailCheckpoint:SeriesCreateTailCheckpoint={...rawCheckpoint,checkpointDigest:acknowledgedProjectionDigest(rawCheckpoint)};
        if(creationState)await commitCurrent(async tx=>{const previous=await tx.get(creationState),current=await tx.get(seriesRef);if(previous.exists){tailCheckpoint=previous.data() as SeriesCreateTailCheckpoint;validateSeriesCreateTailCheckpoint(tailCheckpoint,{...data,firestoreId:seriesRef.id,operationKey:normalizedOperationKey});return;}if(acknowledgedProjectionDigest(current.data()??null)!==rawCheckpoint.originalDocumentDigest)throw new HttpsError('failed-precondition','Series source changed before provider creation.');tx.create(creationState!,{...tailCheckpoint,state:'captured'});});
        // Create series in Subsplash
        const syncedSubsplashSeries = await executeProviderCreate({
          operationKey: normalizedOperationKey,
          step: 'subsplash-series',
          payload: receiptPayload,
          execute: async () => {
            const result = await createSubsplashSeries(title.trim(), token, {
              subtitle: initialSubtitle,
              summary: summary?.trim(),
            });
            if (typeof result?.id !== 'string' || !result.id.trim()) throw new Error('Missing remote series ID');
            return result;
          },
        });
        return completeConfirmedSeriesCreate({...data,firestoreId:seriesRef.id,operationKey:normalizedOperationKey},syncedSubsplashSeries,{token,checkpoint:tailCheckpoint,commitCurrent});
      },
      {
        operationKey: normalizedOperationKey,
      }
    );
  } catch (err) {
    throw handleError(err);
  }
};

export interface SeriesCreateTailCheckpoint {
 schemaVersion:2;projectId:string;jobId:string;seriesId:string;operationKey:string;payloadFingerprint:string;
 images:SubsplashPublishImageRef[];originalExists:boolean;originalDocumentDigest:string;publishedAt:string;checkpointDigest:string;
}
const seriesTailResult=(series:SubsplashSeries)=>Object.fromEntries(['id','app_key','title','subtitle','slug','summary','media_items_count','published_media_items_count','status','short_code','position'].flatMap(key=>{const value=(series as unknown as Record<string,unknown>)[key];return value===undefined?[]:[[key,value]];}));
const seriesTailIdentity=(value:SeriesCreateTailCheckpoint)=>({schemaVersion:value.schemaVersion,projectId:value.projectId,jobId:value.jobId,seriesId:value.seriesId,operationKey:value.operationKey,payloadFingerprint:value.payloadFingerprint,images:value.images,originalExists:value.originalExists,originalDocumentDigest:value.originalDocumentDigest,publishedAt:value.publishedAt});
export function validateSeriesCreateTailCheckpoint(value:SeriesCreateTailCheckpoint,data:CreateSeriesInputType):void{
 if(value?.schemaVersion!==2||!value.jobId||!value.projectId||value.seriesId!==data.firestoreId||value.operationKey!==data.operationKey||value.payloadFingerprint!==providerPayloadFingerprint({...data,firestoreId:value.seriesId})||value.checkpointDigest!==acknowledgedProjectionDigest(seriesTailIdentity(value))||!Array.isArray(value.images)||!Number.isFinite(Date.parse(value.publishedAt)))throw new HttpsError('failed-precondition','The original series create checkpoint is unavailable or changed.');
}
/** Continues only the fixed post-create program; it never allocates or repairs images. */
export async function completeConfirmedSeriesCreate(data:CreateSeriesInputType,confirmed:SubsplashSeries,options:{token:string;checkpoint:SeriesCreateTailCheckpoint;commitCurrent:(write:(tx:Transaction)=>Promise<void>)=>Promise<void>;firestore?:Firestore}):Promise<CreateSeriesOutputType>{
 const {checkpoint,token,commitCurrent}=options,database=options.firestore??firestoreDB;
 validateSeriesCreateTailCheckpoint(checkpoint,data);
 const seriesRef=database.collection('series').doc(checkpoint.seriesId),creationState=isDurablePublishingOperation()?database.collection('temporalPublishingSeriesCreationState').doc(providerReceiptId(checkpoint.jobId,checkpoint.seriesId)):undefined,saved=creationState?await creationState.get():{exists:true,get:(_field:string):unknown=>undefined};
 if(creationState&&(!saved.exists||saved.get('checkpointDigest')!==checkpoint.checkpointDigest||getDurablePublishingJobId()!==checkpoint.jobId))throw new HttpsError('failed-precondition','The original series create scope changed.');
 if(!confirmed?.id||saved.get('remoteId')&&saved.get('remoteId')!==confirmed.id)throw new HttpsError('failed-precondition','Series provider identity changed.');
 if(creationState){const receipt=await readProviderReceipt(providerReceiptId(checkpoint.operationKey,'subsplash-series')),result=receipt?.result as {id?:unknown}|undefined;if(receipt?.state!=='confirmed'||receipt.projectId!==checkpoint.projectId||receipt.jobId!==checkpoint.jobId||receipt.operationKey!==checkpoint.operationKey||receipt.fingerprint!==checkpoint.payloadFingerprint||result?.id!==confirmed.id)throw new HttpsError('failed-precondition','Original series allocation proof changed.');}
 if(saved.get('state')==='completed'&&(await seriesRef.get()).get('subsplashId')!==confirmed.id)throw new HttpsError('failed-precondition','The completed series identity changed.');
 if(saved.get('state')==='completed')return {status:'success',firestoreId:seriesRef.id,subsplashId:confirmed.id,...(saved.get('publicationResult.slug')?{slug:saved.get('publicationResult.slug')}:{})};
 const title=data.title,ownerId=data.ownerId,durableJobId=checkpoint.jobId,receiptPayload={...data,firestoreId:seriesRef.id},initialSubtitle=getSeriesSubtitleFromPublishedCount(0),existingSeriesDoc={exists:checkpoint.originalExists};
 let synced=(saved.get('publicationConfirmed')?saved.get('publicationResult'):saved.get('imagesConfirmed')?saved.get('imagesResult'):confirmed) as SubsplashSeries;
 if(!synced||synced.id!==confirmed.id||synced.app_key!=='9XTSHD')throw new HttpsError('failed-precondition','The captured series stage result changed.');
        if (isDurablePublishingOperation() && saved.get('state')==='captured') {
          await commitCurrent(async transaction => {
            const current=await transaction.get(seriesRef);
            if(acknowledgedProjectionDigest(current.data()??null)!==checkpoint.originalDocumentDigest)throw new HttpsError('failed-precondition','Series source changed after the create checkpoint.');
            const bound=current.get('subsplashId');
            if(bound && bound!==synced.id)throw new HttpsError('failed-precondition','Series provider identity changed.');
            transaction.set(seriesRef,{id:seriesRef.id,name:title.trim(),subtitle:initialSubtitle,images:checkpoint.images,itemCount:current.get('itemCount')??0,publishedItemCount:current.get('publishedItemCount')??0,ownerId:ownerId.trim(),subsplashId:synced.id},{merge:true});
            if(creationState)transaction.set(creationState,{projectId:firebaseAdmin.app().options.projectId,jobId:durableJobId,seriesId:seriesRef.id,remoteId:synced.id,payloadFingerprint:providerPayloadFingerprint(receiptPayload),state:'preparing'},{merge:true});
          });

        }
          if(isDurablePublishingOperation())await beginProviderMutationPlan({operation:`series-create:${getDurablePublishingJobId()}:${seriesRef.id}`,resources:[{provider:'subsplash',account:'app:9XTSHD',resourceType:'series',resourceId:synced.id}]});
        if (checkpoint.images.length > 0 && !saved.get('imagesConfirmed')) {
          synced = await patchSeriesMetadata(
            synced.id,
            {
              images: toSubsplashSeriesImageRefs(checkpoint.images),
            },
            token,
            {canonicalPatch:{images:checkpoint.images}}
          );
          if(creationState)await commitCurrent(async tx=>{tx.update(creationState,{imagesConfirmed:true,imagesResult:seriesTailResult(synced)});});
        }
        if(!saved.get('publicationConfirmed'))synced = await patchSeriesMetadata(
          synced.id,
          {
            publishedAt: checkpoint.publishedAt,
          },
          token
        );
        if(creationState&&!saved.get('publicationConfirmed'))await commitCurrent(async tx=>{tx.update(creationState,{publicationConfirmed:true,publicationResult:seriesTailResult(synced)});});

        // Create Firestore document with Subsplash data
        const firestoreData: Record<string, unknown> = {
          id: seriesRef.id,
          name: synced.title,
          subtitle: synced.subtitle || initialSubtitle,
          images: checkpoint.images,
          itemCount: synced.media_items_count,
          publishedItemCount: synced.published_media_items_count,
          status: synced.status,
          subsplashId: synced.id,
          ownerId: ownerId.trim(),
          slug: synced.slug,
          shortCode: synced.short_code,
          position: synced.position,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (!existingSeriesDoc.exists) {
          firestoreData.createdAt = FieldValue.serverTimestamp();
        }

        // Only add optional fields if they have values (Firestore doesn't allow undefined)
        if (synced.summary) {
          firestoreData.summary = synced.summary;
        }

        const repairedImageWrites = checkpoint.images.filter(
          (image) => image.subsplashId && image.subsplashId !== image.id
        );
        await commitCurrent(async (transaction) => {
          const operation=getPublishingMutationOperation();
          const settlement=isDurablePublishingOperation()&&operation?await prepareProviderMutationPlanCommit(transaction,{operation}):undefined;
          if(settlement?.alreadyCommitted)return;
          transaction.set(seriesRef, firestoreData, { merge: existingSeriesDoc.exists || isDurablePublishingOperation() });
          for (const image of repairedImageWrites) {
            transaction.set(
              database.collection('images').doc(image.id),
              { subsplashId: image.subsplashId },
              { merge: true }
            );
          }
          if(creationState)transaction.update(creationState,{state:'completed'});
          settlement?.commit();
        });

        logger.log(`Created series: Firestore ID=${seriesRef.id}, Subsplash ID=${synced.id}`);

        return {
          status: 'success',
          firestoreId: seriesRef.id,
          subsplashId: synced.id,
          slug: synced.slug,
        };
}

export default createSeries;
