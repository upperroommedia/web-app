import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../types/User';
import speech, { protos } from '@google-cloud/speech';

const speechClient = new speech.v2.SpeechClient({
  projectId: 'urm-app',
  apiEndpoint: 'us-central1-speech.googleapis.com',
});
export interface TranscribeInputType {
  test?: string;
}
export type TranscribeOutputType = { name: string };

// Your local audio file to transcribe
const audioFilePath = 'gs://urm-app.appspot.com/processed-sermons/9d7357d9-2f06-404f-b43d-e9ca7b866557';
// 'gs://urm-app.appspot.com/processed-sermons/b8ba64d6-ae8c-4a35-871d-d4c0f9be5d29';
// Full recognizer resource name
const recognizer = 'projects/urm-app/locations/us-central1/recognizers/_';
// The output path of the transcription result.
const workspace = 'gs://urm-app.appspot.com/transcripts';

const recognitionConfig: protos.google.cloud.speech.v2.IRecognitionConfig = {
  autoDecodingConfig: {},
  model: 'chirp_2',
  languageCodes: ['en-US', 'ar-EG', 'el-GR', 'iw-IL'],
  features: {
    enableAutomaticPunctuation: true,
  },
};

const transcribe = onCall(async (request: CallableRequest<TranscribeInputType>): Promise<TranscribeOutputType> => {
  logger.log('transcribe');

  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const audioFiles: protos.google.cloud.speech.v2.IBatchRecognizeFileMetadata[] = [{ uri: audioFilePath }];
  const outputPath: protos.google.cloud.speech.v2.IRecognitionOutputConfig = {
    gcsOutputConfig: {
      uri: workspace,
    },
  };

  const transcriptionRequest: protos.google.cloud.speech.v2.IBatchRecognizeRequest = {
    recognizer: recognizer,
    config: recognitionConfig,
    files: audioFiles,
    recognitionOutputConfig: outputPath,
    processingStrategy: 'DYNAMIC_BATCHING',
  };
  logger.debug(transcriptionRequest);

  const [response] = await speechClient.batchRecognize(transcriptionRequest);
  logger.debug(response);
  if (!response.name) {
    throw new HttpsError('internal', 'no name was found in the response');
  }
  return {
    name: response.name,
  };
});

export default transcribe;
