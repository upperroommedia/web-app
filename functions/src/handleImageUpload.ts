import axios, { AxiosRequestConfig } from 'axios';
import { logger } from 'firebase-functions';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import {
  ImageSizeType,
  ImageSizes,
  ImageType,
  // resizeType,
  // supportedContentTypes
} from '../../types/Image';
import { HttpsError } from 'firebase-functions/v2/https';
// import { FirestoreDataConverter } from '@google-cloud/firestore';
// import { modifyImage, ResizedImageResult } from './resize-image';
import fs from 'fs';
import os from 'os';
import { mkdirp } from 'mkdirp';
import path from 'path';
import computeMetadataForImage from './computeMetadataForImage';
import { firestoreAdminImagesConverter } from './firestoreDataConverter';
// import { resize } from 'imagemagick';

// const adminImageConvertor = {
//   toFirestore(image: ImageType): FirebaseFirestore.DocumentData {
//     return image;
//   },
//   fromFirestore(snapshot: FirebaseFirestore.QueryDocumentSnapshot): ImageType {
//     return snapshot.data() as ImageType;
//   },
// };

const uploadImageToSubsplash = async (name: string, originalFile: string): Promise<string> => {
  //add resized image references to firestore image data
  logger.log('Getting subsplash info for new image upload');
  const bearerToken = await authenticateSubsplash();
  const requestData = {
    app_key: '9XTSHD',
    content_type: 'image/jpeg',
    title: name,
    type: 'square',
  };
  const config = createAxiosConfig('https://core.subsplash.com/files/v1/images', bearerToken, 'POST', requestData);
  logger.log('config', config);
  // contains s3 presigned url
  const subsplashResponse = (await axios(config)).data;
  logger.log('subsplashResponse', subsplashResponse);
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
    data: file,
    headers: {
      'Content-Type': 'image/jpeg',
      Origin: 'https://dashboard.subsplash.com',
      'x-amz-acl': 'public-read',
    },
  };
  // logger.log('Axios config', uploadConfig);
  axios(uploadConfig)
    .then((response) => logger.log(response.statusText))
    .catch((err) => logger.log('Axios Error', err));

  return id;
};

const handleImageUpload = onObjectFinalized(
  {
    bucket: 'urm-app-images',
    timeoutSeconds: 300,
    memory: '1GiB',
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const imageName = object.name.split('/').pop();
    if (!imageName) {
      throw new HttpsError('invalid-argument', 'Image name is not valid');
    }
    logger.log('ImageName', imageName);
    logger.log('Data', object);

    let originalFile = '';
    try {
      originalFile = path.join(os.tmpdir(), filePath);
      const tempLocalDir = path.dirname(originalFile);
      const bucket = firebaseAdmin.storage().bucket(object.bucket);

      // Create the temp directory where the storage file will be downloaded.
      logger.log(`Creating temporary directory: '${tempLocalDir}'`);
      await mkdirp(tempLocalDir);
      logger.log(`Created temporary directory: '${tempLocalDir}'`);

      // Download file from bucket.
      const remoteFile = bucket.file(filePath);
      logger.log(`Downloading image file: '${filePath}'`);
      await remoteFile.download({ destination: originalFile });
      logger.log(`Downloaded image file: '${filePath}' to '${originalFile}'`);

      // uploading to subsplash
      logger.log('uploading to subsplash');
      const subsplashImageId = await uploadImageToSubsplash(imageName, originalFile);

      // uploading to firestore
      const publicUrl = bucket.file(object.name).publicUrl();
      const computedImageMetadata = await computeMetadataForImage(publicUrl);
      const image: ImageType = {
        ...computedImageMetadata,
        id: subsplashImageId,
        subsplashId: subsplashImageId,
        size: 'original',
        type: metadata.type as ImageSizeType,
        downloadLink: publicUrl,
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
      return logger.error(e);
    } finally {
      if (originalFile) {
        logger.log(`Deleting temporary original file: '${originalFile}'`);
        fs.unlinkSync(originalFile);
        logger.log(`Deleted temporary original file: '${originalFile}'`);
      }
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
