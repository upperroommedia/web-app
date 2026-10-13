import axios, { AxiosRequestConfig } from 'axios';
import { logger } from 'firebase-functions';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  ImageSizeType,
  ImageSizes,
  ImageType,
  // resizeType,
  // supportedContentTypes
} from '@upperroom/shared/types/Image';
import { HttpsError } from 'firebase-functions/v2/https';
// import { FirestoreDataConverter } from '@google-cloud/firestore';
// import { modifyImage, ResizedImageResult } from './resize-image';
import fs from 'fs';
import os from 'os';
import { mkdtemp, rm } from 'fs/promises';
import path from 'path';
import computeMetadataForImage from './computeMetadataForImage';
import { firestoreAdminImagesConverter } from './firestoreDataConverter';
import { getFirebaseImagesBucket } from '@upperroom/shared/shared/firebaseProjectConfig';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { ensureFirebaseDownloadUrl } from './storageDownloadUrl';
import handleError from './handleError';
import { assertLegacyAdmissionAllowed } from './temporal/releaseControl';
import { enqueueSystemImage } from './temporal/images/admission';
import { assertProviderMutationTransportAllowed } from './temporal/publishing/providerTransportPolicy';
import { createHash } from 'node:crypto';
// import { resize } from 'imagemagick';

// const adminImageConvertor = {
//   toFirestore(image: ImageType): FirebaseFirestore.DocumentData {
//     return image;
//   },
//   fromFirestore(snapshot: FirebaseFirestore.QueryDocumentSnapshot): ImageType {
//     return snapshot.data() as ImageType;
//   },
// };

const uploadImageToSubsplash = async (
  name: string,
  originalFile: string,
  imageType: ImageSizeType,
  contentType: string
): Promise<string> => {
  //add resized image references to firestore image data
  assertProviderMutationTransportAllowed('subsplash');
  logger.log('Getting subsplash info for new image upload');
  const bearerToken = await authenticateSubsplash();
  const requestData = {
    app_key: '9XTSHD',
    content_type: contentType,
    title: name,
    type: imageType,
  };
  const config = createAxiosConfig('https://core.subsplash.com/files/v1/images', bearerToken, 'POST', requestData);
  // contains s3 presigned url
  const subsplashResponse = (await axios({ ...config, maxRedirects: 0 })).data;
  if (!subsplashResponse.id) {
    throw new Error('No id was returned from subsplash');
  }
  // subsplash id of new image
  const id = subsplashResponse.id as string;
  const uploadURL = subsplashResponse._links?.presigned_upload_url?.href as string | undefined;
  if (!uploadURL) {
    throw new Error('No upload link was returned from subsplash');
  }
  logger.log('Subsplash Upload Response:', subsplashResponse);
  const file = fs.readFileSync(originalFile);
  //upload data to s3 signedUrl
  const uploadConfig: AxiosRequestConfig = {
    url: uploadURL,
    method: 'PUT',
    maxRedirects: 0,
    data: file,
    headers: {
      'Content-Type': contentType,
      Origin: 'https://dashboard.subsplash.com',
      'x-amz-acl': 'public-read',
    },
  };
  // logger.log('Axios config', uploadConfig);
  assertProviderMutationTransportAllowed('subsplash');
  await axios({ ...uploadConfig, timeout: 120_000 });

  return id;
};

const handleImageUpload = onObjectFinalized(
  {
    bucket: getFirebaseImagesBucket(),
    timeoutSeconds: 300,
    memory: '1GiB',
    retry: true,
    secrets: subsplashSecretsWithRuntimeAlerts,
  },
  async (storageEvent): Promise<void> => {
    const object = storageEvent.data;
    const filePath = object.name ? object.name : '';
    const metadata = object.metadata;
    logger.log(object);
    logger.log('Object Finalized', filePath);
    if (!filePath.startsWith('speaker-images/') || filePath.endsWith('speaker-images/')) {
      logger.log(filePath);
      return logger.log('This is a folder, not the image');
    }
    if (!object.contentType) {
      return logger.log('File has no Content-Type, no processing is required');
    }
    if (!object.name) {
      return logger.log('File has no name');
    }
    if (!object.contentType.startsWith('image/')) {
      return logger.log(`File of type '${object.contentType}' is not an image, no processing is required`);
    }
    if (!metadata) {
      return logger.log('No metadata found for image');
    }
    if (metadata.resizedImage === 'true') {
      return logger.log('File is already a resized image, no processing is required');
    }
    if (metadata.type && !ImageSizes.includes(metadata.type as ImageSizeType)) {
      return logger.log('File has no type');
    }

    const imageName = object.name.split('/').pop();
    if (!imageName) {
      throw new HttpsError('invalid-argument', 'Image name is not valid');
    }
    logger.log('ImageName', imageName);
    logger.log('Data', object);

    if (process.env.TASK_ORCHESTRATOR_IMAGES === 'temporal') {
      const projectId = firebaseAdmin.app().options.projectId ?? process.env.GCLOUD_PROJECT ?? '';
      await enqueueSystemImage({
        firestore: firebaseAdmin.firestore(),
        projectId,
        eventId: storageEvent.id,
        intent: {
          operation: 'ingest',
          imageId: createHash('sha256').update(`${object.bucket}:${filePath}:${object.generation}`).digest('hex'),
          source: {
            bucket: object.bucket,
            path: filePath,
            generation: String(object.generation),
            contentType: object.contentType,
          },
          name: imageName,
          type: metadata.type as ImageSizeType,
        },
      });
      return;
    }

    await assertLegacyAdmissionAllowed(firebaseAdmin.firestore(), 'images');
    let originalFile = '';
    let temporaryDirectory = '';
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'urm-image-'));
      originalFile = path.join(temporaryDirectory, 'source');
      const bucket = firebaseAdmin.storage().bucket(object.bucket);

      // Create the temp directory where the storage file will be downloaded.

      // Download file from bucket.
      const remoteFile = bucket.file(filePath, { generation: object.generation });
      logger.log(`Downloading image file: '${filePath}'`);
      await remoteFile.download({ destination: originalFile });
      logger.log(`Downloaded image file: '${filePath}' to '${originalFile}'`);

      const downloadUrl = await ensureFirebaseDownloadUrl(remoteFile);
      logger.log('uploading to subsplash');
      const imageType = metadata.type as ImageSizeType;
      const [subsplashImageId, computedImageMetadata] = await Promise.all([
        uploadImageToSubsplash(imageName, originalFile, imageType, object.contentType),
        computeMetadataForImage(originalFile),
      ]);

      // uploading to firestore
      const image: ImageType = {
        ...computedImageMetadata,
        id: subsplashImageId,
        subsplashId: subsplashImageId,
        size: 'original',
        type: imageType,
        downloadLink: downloadUrl,
        name: imageName,
        dateAddedMillis: new Date().getTime(),
      };
      logger.log('adding image with metadata to firestore', image);
      await firebaseAdmin
        .firestore()
        .collection('images')
        .withConverter(firestoreAdminImagesConverter)
        .doc(subsplashImageId)
        .set(image);
    } catch (e) {
      handleError(e, {
        alertCode: 'HANDLE_IMAGE_UPLOAD_RUNTIME_FAILURE',
        summary: 'handleImageUpload failed while processing a finalized storage object.',
        context: { functionName: 'handleImageUpload', filePath },
      });
      throw new Error('Image ingestion failed; retry required');
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      // Delete the original file
      // if (remoteFile) {
      //   try {
      //     logger.log(`Deleting original file from storage bucket: '${remoteFile}'`);
      //     await remoteFile.delete();
      //     logger.log(`Deleted original file from storage bucket: '${remoteFile}'`);
      //   } catch (err) {
      //     logger.warn("Error when deleting temporary files", err);
      //   }
      // }
    }
  }
);

export default handleImageUpload;
