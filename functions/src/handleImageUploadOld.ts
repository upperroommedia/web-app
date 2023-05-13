// import axios, { AxiosRequestConfig } from 'axios';
// import { logger } from 'firebase-functions';
// import { onObjectFinalized } from 'firebase-functions/v2/storage';
// import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
// import { storage, firestore } from 'firebase-admin';
// import {
//   ImageType,
//   // resizeType,
//   // supportedContentTypes
// } from '../../types/Image';

// // import { FirestoreDataConverter } from '@google-cloud/firestore';
// // import { modifyImage, ResizedImageResult } from './resizeimage';
// import fs from 'fs';
// import os from 'os';
// import mkdirp from 'mkdirp';
// import path from 'path';
// // import { resize } from 'imagemagick';

// const adminImageConvertor = {
//   toFirestore(image: ImageType): FirebaseFirestore.DocumentData {
//     return image;
//   },
//   fromFirestore(snapshot: FirebaseFirestore.QueryDocumentSnapshot): ImageType {
//     return snapshot.data() as ImageType;
//   },
// };

// const handleImageUpload = onObjectFinalized(
//   {
//     bucket: 'urm-app-images',
//     timeoutSeconds: 300,
//     memory: '1GiB',
//   },
//   async (storageEvent): Promise<void> => {
//     const object = storageEvent.data;
//     const filePath = object.name ? object.name : '';
//     logger.log('Object Finalized', filePath);
//     // if (!filePath.startsWith('raw/') || filePath.endsWith('raw/')) {
//     //   return logger.log('Not a raw image');
//     // }
//     // if (!object.contentType) {
//     //   return logger.log('File has no Content-Type, no processing is required');
//     // }
//     // if (!object.contentType.startsWith('image/')) {
//     //   return logger.log(`File of type '${object.contentType}' is not an image, no processing is required`);
//     // }
//     // if (object.metadata && object.metadata.resizedImage === 'true') {
//     //   return logger.log('File is already a resized image, no processing is required');
//     // }
//     const fileName = path.basename(filePath);
//     logger.log('Data', object);

//     let originalFile = '';
//     try {
//       // const fileDir = path.dirname(filePath);
//       const fileExtension = path.extname(filePath);
//       const fileNameWithoutExtension = path.basename(filePath, fileExtension);
//       const docRef = firestore().collection('images').doc(fileNameWithoutExtension).withConverter(adminImageConvertor);
//       const imageData = (await docRef.get()).data();
//       logger.log(imageData);
//       if (!imageData) {
//         return logger.error(`No firestore reference was found for ${fileName}`);
//       }
//       // const croppedImage = imageData.images.find((image) => image.size === 'cropped');
//       // if (!croppedImage) {
//       // return logger.error('Could not find cropped image reference in firestore');
//       // }
//       originalFile = path.join(os.tmpdir(), filePath);
//       const tempLocalDir = path.dirname(originalFile);
//       const bucket = storage().bucket(object.bucket);

//       // Create the temp directory where the storage file will be downloaded.
//       logger.log(`Creating temporary directory: '${tempLocalDir}'`);
//       await mkdirp(tempLocalDir);
//       logger.log(`Created temporary directory: '${tempLocalDir}'`);

//       // Download file from bucket.
//       const remoteFile = bucket.file(filePath);
//       logger.log(`Downloading image file: '${filePath}'`);
//       await remoteFile.download({ destination: originalFile });
//       logger.log(`Downloaded image file: '${filePath}' to '${originalFile}'`);

//       // sizes to resize image to
//       // const sizes: resizeType[] = [
//       //   { width: 35, height: 35, sizeType: 'thumbnail' },
//       //   { width: 100, height: 100, sizeType: 'small' },
//       //   { width: 200, height: 200, sizeType: 'medium' },
//       //   { width: 300, height: 300, sizeType: 'large' },
//       // ];
//       // resize image
//       // const tasks: Promise<ResizedImageResult>[] = [];
//       // sizes.forEach((size) => {
//       //   tasks.push(
//       //     modifyImage({
//       //       bucket,
//       //       originalFile,
//       //       fileDir,
//       //       fileNameWithoutExtension,
//       //       fileExtension,
//       //       contentType: 'image/webp',
//       //       size: size,
//       //       objectMetadata: object,
//       //       format: 'webp',
//       //     })
//       //   );
//       // });

//       //add resized image references to firestore image data
//       logger.log('Getting subsplash info for new image upload');
//       const bearerToken = await authenticateSubsplash();
//       const requestData = {
//         app_key: '9XTSHD',
//         // TODO: uncomment
//         // content_type: object.contentType,
//         content_type: 'image/jpeg',
//         title: imageData.name,
//         type: 'square',
//       };
//       const config = createAxiosConfig('https://core.subsplash.com/files/v1/images', bearerToken, 'POST', requestData);
//       logger.log('config', config);
//       // contains s3 presigned url
//       const subsplashResponse = (await axios(config)).data;
//       logger.log('subsplashResponse', subsplashResponse);
//       if (!subsplashResponse.id) {
//         throw new Error('No id was returned from subsplash');
//       }
//       // subsplash id of new image
//       // const id = subsplashResponse.id as string;
//       const uploadURL = subsplashResponse._links?.presigned_upload_url?.href as string | undefined;
//       if (!uploadURL) {
//         throw new Error('No upload link was returned from subsplash');
//       }
//       logger.log('Subsplash Upload Response:', subsplashResponse);
//       const file = fs.readFileSync(originalFile);
//       //upload data to s3 signedUrl
//       const uploadConfig: AxiosRequestConfig = {
//         url: uploadURL,
//         method: 'PUT',
//         data: file,
//         headers: {
//           'Content-Type': 'image/jpeg',
//           Origin: 'https://dashboard.subsplash.com',
//           'x-amz-acl': 'public-read',
//         },
//       };
//       // logger.log('Axios config', uploadConfig);
//       axios(uploadConfig)
//         .then((response) => logger.log(response.statusText))
//         .catch((err) => logger.log('Axios Error', err));
//       // docRef.update({ subsplashId: id });
//     } catch (e) {
//       return logger.error(e);
//     } finally {
//       if (originalFile) {
//         logger.log(`Deleting temporary original file: '${originalFile}'`);
//         fs.unlinkSync(originalFile);
//         logger.log(`Deleted temporary original file: '${originalFile}'`);
//       }
//       // Delete the original file
//       // if (remoteFile) {
//       //   try {
//       //     logger.log(`Deleting original file from storage bucket: '${remoteFile}'`);
//       //     await remoteFile.delete();
//       //     logger.log(`Deleted original file from storage bucket: '${remoteFile}'`);
//       //   } catch (err) {
//       //     logger.warn("Error when deleting temporary files", err);
//       //   }
//       // }
//     }
//   }
// );

// export default handleImageUpload;
