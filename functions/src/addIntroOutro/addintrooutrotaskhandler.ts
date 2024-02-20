import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import path from 'path';
import { unlink } from 'fs/promises';
import { Bucket } from '@google-cloud/storage';
import { AxiosError, isAxiosError } from 'axios';
import { Sermon, sermonStatus, sermonStatusType, uploadStatus } from '../../../types/SermonTypes';
import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Database } from 'firebase-admin/database';
import { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { Request, onTaskDispatched } from 'firebase-functions/v2/tasks';
import { CustomMetadata, AddIntroOutroInputType, FilePaths, AudioSource } from './types';
import { CancelToken } from './CancelToken';
import {
  logMemoryUsage,
  secondsToTimeFormat,
  loadStaticFFMPEG,
  downloadFiles,
  getDurationSeconds,
  executeWithTimout,
  createTempFile,
  validateAddIntroOutroData,
  getAudioSource,
} from './utils';
import { TIMEOUT_SECONDS } from './consts';
import trimAndTranscode from './trimAndTranscode';
import mergeFiles from './mergeFiles';
import { PROCESSED_SERMONS_BUCKET } from '../../../constants/storage_constants';
import trim from './trim';
// import http from 'http';

// These will remain constant between function invocations
const ffmpeg = loadStaticFFMPEG();
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

const mainFunction = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  realtimeDB: Database,
  db: Firestore,
  audioSource: AudioSource,
  docRef: DocumentReference<Sermon>,
  sermonStatus: sermonStatus,
  startTime: number,
  duration: number,
  deleteOriginal?: boolean,
  skipTranscode?: boolean,
  introUrl?: string,
  outroUrl?: string
): Promise<void> => {
  const fileName = audioSource.id;
  await logMemoryUsage('Initial Memory Usage:');
  const tempFiles = new Set<string>();
  // the document may not exist yet, if it deosnt wait 5 seconds and try again do this for a max of 3 times before throwing an error
  const maxTries = 3;
  let currentTry = 0;
  let docFound = false;
  let existingStatus = sermonStatus;
  let title = 'untitled';
  while (currentTry < maxTries) {
    logger.log(`Checking if document exists attempt: ${currentTry + 1}/${maxTries}`);
    const doc = await docRef.get();

    if (doc.exists) {
      docFound = true;
      title = doc.data()?.title || 'No title found';
      existingStatus = doc.data()?.status || sermonStatus;
      break;
    }
    logger.log(`No document exists attempt: ${currentTry + 1}/${maxTries}`);

    currentTry++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  logger.log('Out of while loop');
  if (!docFound) {
    throw new HttpsError('not-found', `Sermon Document ${fileName} Not Found`);
  }

  try {
    if (cancelToken.isCancellationRequested) return;
    await docRef.update({
      status: {
        ...existingStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Getting Data',
      },
    });
    const processedStoragePath = `${PROCESSED_SERMONS_BUCKET}/${fileName}`;
    const audioFilesToMerge: FilePaths = { INTRO: undefined, OUTRO: undefined };
    const customMetadata: CustomMetadata = { duration, title };
    if (introUrl) {
      audioFilesToMerge.INTRO = introUrl;
      customMetadata.introUrl = introUrl;
    }
    if (outroUrl) {
      audioFilesToMerge.OUTRO = outroUrl;
      customMetadata.outroUrl = outroUrl;
    }
    logger.log('Audio File Download Paths', JSON.stringify(audioFilesToMerge));
    if (cancelToken.isCancellationRequested) return;
    const trimMessage = skipTranscode
      ? 'Trimming'
      : audioSource.type === 'StorageFilePath'
      ? 'Trimming and Transcoding'
      : 'Downloading YouTube Audio';
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: trimMessage,
      },
    });
    if (skipTranscode) {
      if (audioSource.type !== 'StorageFilePath') {
        throw new HttpsError(
          'invalid-argument',
          'Audio source must be a file from processed-sermons in order to trim without transcoding'
        );
      }
      await trim(
        ffmpeg,
        cancelToken,
        bucket,
        audioSource.source,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata,
        startTime,
        duration
      );
    } else {
      await trimAndTranscode(
        ffmpeg,
        cancelToken,
        bucket,
        audioSource,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        docRef,
        sermonStatus,
        customMetadata,
        startTime,
        duration
      );
    }

    // download processed audio for merging
    const processedFilePath = createTempFile(`processed-${fileName}`, tempFiles);
    logger.log('Downloading processed audio to', processedFilePath);
    const [tempFilePaths] = await Promise.all([
      await downloadFiles(bucket, audioFilesToMerge, tempFiles),
      await bucket.file(processedStoragePath).download({ destination: processedFilePath }),
    ]);
    logger.log('Successfully downloaded processed audio');
    //create merge array in order INTRO, CONTENT, OUTRO
    const filePathsArray: string[] = [];
    if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
    filePathsArray.push(processedFilePath);
    if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

    // use reduce to sum up all the durations of the files from filepaths
    const durationSeconds = (
      await Promise.all(
        [tempFilePaths.INTRO, tempFilePaths.OUTRO].map(async (path) => (path ? await getDurationSeconds(path) : 0))
      )
    ).reduce((accumulator, currentValue) => accumulator + currentValue, duration);

    customMetadata.duration = durationSeconds;
    logger.log('Total Duration', secondsToTimeFormat(durationSeconds));

    // if there is an intro or outro, merge the files
    if (filePathsArray.length > 1) {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Adding Intro and Outro',
        },
      });
      const outputFileName = `intro_outro-${fileName}`;
      const outputFilePath = `intro-outro-sermons/${path.basename(fileName)}`;
      //merge files
      logger.log('Merging files', filePathsArray, 'to', outputFileName, '...');
      const mergedOutputFile = await mergeFiles(
        ffmpeg,
        cancelToken,
        bucket,
        filePathsArray,
        outputFilePath,
        durationSeconds,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata
      );
      logger.log('MergedFiles saved to', mergedOutputFile.name);
      await logMemoryUsage('Memory Usage after merge:');
    } else {
      logger.log('No intro or outro, skipping merge');
    }
    if (cancelToken.isCancellationRequested) return;
    logger.log('Updating status to PROCESSED');
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSED,
      },
      durationSeconds: durationSeconds,
    });

    if (cancelToken.isCancellationRequested) return;
    realtimeDB.ref(`addIntroOutro/${fileName}`).set(100);

    // delete original audio file
    if (cancelToken.isCancellationRequested) return;
    if (audioSource.type === 'StorageFilePath') {
      const [originalFileExists] = await bucket.file(audioSource.source).exists();
      if (originalFileExists && deleteOriginal) {
        logger.log('Deleting original audio file', audioSource.source);
        await bucket.file(audioSource.source).delete();
        logger.log('Original audio file deleted');
      }
    }

    logger.log('Files have been merged succesfully');
  } finally {
    await realtimeDB.ref(`addIntroOutro/${fileName}`).remove();
    const promises: Promise<void>[] = [];
    tempFiles.forEach((file) => {
      logger.log('Deleting temp file', file);
      promises.push(unlink(file));
    });
    try {
      await Promise.all(promises);
      logger.log('All temp files deleted');
    } catch (err) {
      logger.error('Error when deleting temporary files', err);
    }
  }
};

const addintrooutrotaskhandler = onTaskDispatched(
  {
    timeoutSeconds: TIMEOUT_SECONDS,
    memory: '1GiB',
    cpu: 1,
    concurrency: 1,
    retryConfig: {
      maxAttempts: 2,
    },
  },
  async (request: Request<AddIntroOutroInputType>): Promise<void> => {
    // Setting the `keepAlive` option to `true` keeps
    // connections open between function invocations
    // new http.Agent({ keepAlive: false });

    const timeoutMillis = (TIMEOUT_SECONDS - 30) * 1000; // 30s less than timeoutSeconds
    // set timeout to 30 seconds less than timeoutSeconds then throw error if it takes longer than that
    const data = request.data;

    // data checks
    if (!validateAddIntroOutroData(data)) {
      throw new HttpsError(
        'invalid-argument',
        `Invalid data: data must be an object with the following field: 
         id (string),
         startTime (number),
         duration (number),
         youtubeUrl (string) || storageFilePath (string),
         introUrl (string),
         outroUrl (string)`
      );
    }

    const audioSource = getAudioSource(data);
    const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(data.id);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };

    try {
      const cancelToken = new CancelToken();
      await executeWithTimout(
        () =>
          mainFunction(
            cancelToken,
            bucket,
            realtimeDB,
            db,
            audioSource,
            docRef,
            sermonStatus,
            data.startTime,
            data.duration,
            data.deleteOriginal,
            data.skipTranscode,
            data.introUrl,
            data.outroUrl
          ),
        cancelToken.cancel,
        timeoutMillis
      );
    } catch (e) {
      let message = 'Something Went Wrong';
      if (e instanceof HttpsError) {
        message = e.message;
      } else if (isAxiosError(e)) {
        const axiosError = e as AxiosError;
        message = axiosError.message;
      } else if (e instanceof Error) {
        message = e.message;
      }
      try {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.ERROR,
            message: message,
          },
        });
      } catch (_e) {
        logger.error('Error Updating Document with docRef', docRef.path);
      }
      logger.error('Error', e);
    } finally {
      await logMemoryUsage('Final Memory Usage:');
    }
  }
);

export default addintrooutrotaskhandler;
