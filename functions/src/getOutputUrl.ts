import { logger } from 'firebase-functions/v2';
import { GetSignedUrlConfig } from '@google-cloud/storage';
import { PROCESSED_SERMONS_BUCKET } from '@upperroom/shared/constants/storage_constants';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';

const getOutputUrl = async (fileBucket: string, fileName: string, transcodeTo: string): Promise<string> => {
  logger.log('Get Output Url with Parameters:', fileBucket, fileName, transcodeTo);
  // These options will allow temporary uploading of the file with outgoing
  // Content-types tried:
  // application/octet-stream
  // audio/mpeg
  // audio/mp4
  // application/mp4
  // and leaving it empty
  const outputOptions: GetSignedUrlConfig = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    // contentType: tried all of the above
  };
  const [outputUrl] = await firebaseAdmin
    .storage()
    .bucket(fileBucket)
    .file(`${PROCESSED_SERMONS_BUCKET}/${fileName}.${transcodeTo}`)
    .getSignedUrl(outputOptions);
  logger.log('OutputUrl:', outputUrl);
  return outputUrl;
};

export default getOutputUrl;
