import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobeStatic } from 'ffprobe-static';
import path from 'path';
import os from 'os';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { unlink, readdir, stat } from 'fs/promises';
import { File, Bucket } from '@google-cloud/storage';
import axios, { AxiosError, isAxiosError } from 'axios';
import { Sermon, sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Database, Reference } from 'firebase-admin/database';
import { exec } from 'node:child_process';
import { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { Request, onTaskDispatched } from 'firebase-functions/v2/tasks';


export type AddIntroOutroInputType = {
  storageFilePath: string,
  startTime: number,
  endTime: number,
  introUrl?: string,
  outroUrl?: string
}


type filePaths = {
  INTRO?: string;
  OUTRO?: string;
};

type CustomMetadata = { duration: number, title?: string, introUrl?: string; outroUrl?: string }

class CancelToken {
  private shouldCancel = false;

  cancel = () => {
    this.shouldCancel = true;
  }

  get isCancellationRequested() {
    return this.shouldCancel;
  }
}

if (!ffmpegStatic) {
  logger.error('ffmpeg-static not found');
} else {
  logger.log('ffmpeg-static found', ffmpegStatic);
  ffmpeg.setFfmpegPath(ffmpegStatic);
  logger.log('ffprobe-static found', ffprobeStatic);
  ffmpeg.setFfprobePath(ffprobeStatic);
}

const logMemoryUsage = async (message: string) => {
  const memoryUsage = process.memoryUsage();
  const tempDir = os.tmpdir();
  const files = await readdir(tempDir);
  let totalSize = 0;

  for (const file of files) {
    const filePath = path.join(tempDir, file);
    const fileStats = await stat(filePath);
    totalSize += fileStats.size;
  }
  const memoryUsageInMB = {
    rss: (memoryUsage.rss / (1024 * 1024)).toFixed(2), // Resident Set Size
    heapTotal: (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2), // Total size of the allocated heap
    heapUsed: (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2), // Actual memory used
    external: (memoryUsage.external / (1024 * 1024)).toFixed(2), // Memory used by C++ objects bound to JavaScript objects
    tempDir: (totalSize / (1024 * 1024)).toFixed(2), // Memory used by the tempDir in MB
  };

  console.log(message, memoryUsageInMB);
};

const createTempFile = (fileName: string, tempFiles: Set<string>) => {
  try {
    if (!existsSync(os.tmpdir())) {
      mkdirSync(os.tmpdir());
    }
    const filePath = path.join(os.tmpdir(), fileName);
    tempFiles.add(filePath);
    return filePath;
  } catch (err) {
    throw new Error(`Error creating temp file: ${err}`);
  }
};
const convertStringToMilliseconds = (timeStr: string): number => {
  // '10:20:30:500'  Example time string
  if (!timeStr) {
    return 0;
  }
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  if (!secondsAndMilliseconds) {
    return 0;
  }
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  return (parseInt(hours) * 60 * 60 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(milliseconds);
};

function secondsToTimeFormat(durationSeconds: number) {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds - hours * 3600) / 60);
  const seconds = durationSeconds - hours * 3600 - minutes * 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toFixed(3)
    .padStart(6, '0')}`;
}

const trimAndTranscode = (
  cancelToken: CancelToken,
  contentFile: File,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  startTime?: number,
  duration?: number
): Promise<string> => {
  const tmpFilePath = createTempFile(path.basename('temp-transcoded-file.mp3'), tempFiles);
  const proc = ffmpeg().format('mp3').input(contentFile.createReadStream());
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc
    .audioCodec('libmp3lame')
    .audioFilters(['dynaudnorm=g=21:m=40:c=1:b=1', 'afftdn', 'pan=stereo|c0<c0+c1|c1<c0+c1']) // Dynamiaclly adjust volume and remove background noise and balance left right audio
    .audioBitrate(128)
    .audioChannels(2)
    .audioFrequency(44100);
  let totalTimeMillis: number;
  let previousPercent = -1;
  return new Promise((resolve, reject) => {
    proc
      .on('start', function (commandLine) {
        logger.log('Trim And Transcode Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
        logger.log('Finished Trim and Transcode');
        resolve(tmpFilePath);
      })
      .on('error', (err) => {
        logger.error('Trim and Transcode Error:', err);
        reject(err);
      })
      .on('codecData', (data) => {
        // HERE YOU GET THE TOTAL TIME
        console.log('Total duration: ' + data.duration);
        totalTimeMillis = convertStringToMilliseconds(data.duration);
      })
      .on('progress', async (progress) => {
        if (cancelToken.isCancellationRequested) {
          logger.log('Cancellation requested, killing ffmpeg process');
          proc.kill('SIGTERM'); // this sends a termination signal to the process
          reject(new HttpsError('aborted', 'Trim and Transcode operation was cancelled'));
        }
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        const calculatedDuration = duration
          ? duration * 1000
          : startTime
            ? totalTimeMillis - startTime * 1000
            : totalTimeMillis;
        const percent = Math.round(Math.max(0, ((timeMillis * 0.95) / calculatedDuration) * 100)); // go to 95% to leave room for the time it takes to Merge the files
        if (percent !== previousPercent) {
          previousPercent = percent;
          logger.log('Trim and Transcode Progress:', percent);
          realtimeDBRef.set(percent);
        }
      })
      .saveToFile(tmpFilePath);
  });
};

const mergeFiles = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  filePaths: string[],
  outputFilePath: string,
  durationSeconds: number,
  tempFiles: Set<string>,
  realtimeDBref: Reference,
  customMetadata: CustomMetadata,
): Promise<File> => {
  const listFileName = createTempFile('list.txt', tempFiles);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title ? `inline; filename="${customMetadata.title}.mp3"` : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({ contentType: 'audio/mpeg', metadata: { contentDisposition, metadata: customMetadata}});

  // ffmpeg -f concat -i mylist.txt -c copy output
  const filePathsForTxt = filePaths.map((filePath) => `file '${filePath}'`);
  const fileNames = filePathsForTxt.join('\n');

  logger.log('fileNames', fileNames);

  writeFileSync(listFileName, fileNames);

  const merge = ffmpeg();
  let previousScaledPercent = -1;
  return new Promise((resolve, reject) => {
    merge
      .input(listFileName)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .outputFormat('mp3')
      .on('start', function (commandLine) {
        realtimeDBref.set(98);
        logger.log('MergeFiles Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('progress', async function (progress) {
        if (cancelToken.isCancellationRequested) {
          logger.log('Cancellation requested, killing ffmpeg process');
          merge.kill('SIGTERM'); // this sends a termination signal to the process
          reject(new HttpsError('aborted', 'Merge operation was cancelled'));
        }
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        const durationMillis = durationSeconds * 1000;
        const percent = Math.round(Math.max(0, ((timeMillis) / durationMillis) * 100));
        // percent is a number between 0 - 100 but we want to scale it to be from 95 - 100
        const scaledPercent = Math.round(percent * 0.05 + 95);
        if (scaledPercent !== previousScaledPercent) {
          previousScaledPercent = scaledPercent;
          logger.log('MergeFiles Progress:', scaledPercent);
          realtimeDBref.set(scaledPercent);
        }
      })
      .on('end', async function () {
        realtimeDBref.set(98);
        resolve(outputFile);
      })
      .on('error', function (err) {
        logger.log('MergeFiles Error:', err);
        return reject(err);
      })
      .pipe(writeStream);
  });
};

const uploadSermon = async (
  inputFilePath: string,
  destinationFilePath: string,
  bucket: Bucket,
  customMetadata: CustomMetadata,
) => {
  logger.log('custom metadata', customMetadata);
  const contentDisposition = customMetadata.title ? `inline; filename="${customMetadata.title}.mp3"` : 'inline; filename="untitled.mp3"';
  await bucket.upload(inputFilePath, { destination: destinationFilePath });
  await bucket.file(destinationFilePath).setMetadata({ contentType: 'audio/mpeg', contentDisposition, metadata: customMetadata });
};

const getDurationSeconds = (filePath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      }
      resolve(metadata.format.duration || 0);
    });
  });
};

async function downloadFile(fileUrl: string, outputLocationPath: string): Promise<void> {
  const writer = createWriteStream(outputLocationPath);

  return axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  }).then((response) => {
    //ensure that the user can call `then()` only when the file has
    //been downloaded entirely.

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      let error: unknown = null;
      writer.on('error', (err: unknown) => {
        error = err;
        writer.close();
        reject(err);
      });
      writer.on('close', () => {
        if (!error) {
          resolve();
        }
        //no need to call the reject here, as it will have been called in the
        //'error' stream;
      });
    });
  });
}

const downloadFiles = async (bucket: Bucket, filePaths: filePaths, tempFiles: Set<string>): Promise<filePaths> => {
  const tempFilePaths: filePaths = { INTRO: undefined, OUTRO: undefined };
  const promises: Promise<unknown>[] = [];
  // get key and value of filePaths
  for (const [key, filePath] of Object.entries(filePaths) as [keyof filePaths, string | undefined][]) {
    if (filePath) {
      tempFilePaths[key] = createTempFile(path.basename(filePath).split('?')[0], tempFiles);
      promises.push(downloadFile(filePath, tempFilePaths[key] as string));
      logger.log(`Downloading ${filePath} to ${tempFilePaths[key]}`);
    }
  }
  await Promise.all(promises);
  return tempFilePaths;
};

async function executeWithTimout<T>(asyncFunc: () => Promise<T>, cancelFunc: () => void, delay: number): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      cancelFunc();
      reject(new HttpsError('deadline-exceeded', `Timeout of ${timeoutSeconds} seconds exceeded`));
    }, delay);
  });

  return Promise.race([asyncFunc(), timeoutPromise]);
}

const mainFunction = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  realtimeDB: Database,
  db: Firestore,
  filePath: string,
  docRef: DocumentReference<Sermon>,
  sermonStatus: sermonStatus,
  startTime: number,
  duration: number,
  introUrl?: string,
  outroUrl?: string,
): Promise<void> => {
  const fileName = path.basename(filePath);
  exec(`${ffmpegStatic} -version`, (err, stdout) => {
    if (err) {
      logger.error('FFMPEG not installed', err);
    } else {
      logger.log('FFMPEG version', stdout);
    }
  });
  await logMemoryUsage('Initial Memory Usage:');
  const tempFiles = new Set<string>();
  // the document may not exist yet, if it deosnt wait 5 seconds and try again do this for a max of 3 times before throwing an error
  const maxTries = 3;
  let currentTry = 0;
  let docFound = false;
  let title = 'untitled';
  while (currentTry < maxTries) {
    logger.log(`Checking if document exists attempt: ${currentTry + 1}/${maxTries}`);
    const doc = await docRef.get();

    if (doc.exists) {
      docFound = true;
      title = doc.data()?.title || 'No title found';
      break;
    }
    logger.log(`No document exists attempt: ${currentTry + 1}/${maxTries}`);

    currentTry++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  logger.log("Out of while loop")
  if (!docFound) {
    throw new HttpsError('not-found', `Sermon Document ${fileName} Not Found`);
  }

  try {
    if (cancelToken.isCancellationRequested) return;
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Getting Data',
      },
    });
    const audioFilesToMerge: filePaths = { INTRO: undefined, OUTRO: undefined };
    const customMetadata: CustomMetadata = {duration, title};
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
    const tempFilePaths = await downloadFiles(bucket, audioFilesToMerge, tempFiles);
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Trimming and Transcoding',
      },
    });
    const trimAndTranscodePath = await trimAndTranscode(
      cancelToken,
      bucket.file(filePath),
      tempFiles,
      realtimeDB.ref(`addIntroOutro/${fileName}`),
      startTime,
      duration
    );
    await uploadSermon(trimAndTranscodePath, `processed-sermons/${fileName}`, bucket, customMetadata);
    const originalAudioMetadata = await bucket.file(filePath).getMetadata()
    const trimAndTranscodeMetadata = await  bucket.file(`processed-sermons/${fileName}`).getMetadata()
    logger.log('Original Audio Metadata', JSON.stringify(originalAudioMetadata))
    logger.log('Trim and Transcode Metadata', JSON.stringify(trimAndTranscodeMetadata))
    await logMemoryUsage('Memory Usage after trim and transcode:');
    //create merge array in order INTRO, CONTENT, OUTRO
    const filePathsArray: string[] = [];
    if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
    filePathsArray.push(trimAndTranscodePath);
    if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

    // use reduce to sum up all the durations of the files from filepaths
    const durationSeconds = (
      await Promise.all(filePathsArray.map(async (path) => await getDurationSeconds(path)))
    ).reduce((accumulator, currentValue) => accumulator + currentValue, 0);

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
      logger.log('Merging audio files', JSON.stringify(tempFilePaths));
      const outputFileName = `intro_outro-${fileName}`;
      const outputFilePath = `intro-outro-sermons/${path.basename(fileName)}`;
      //merge files
      logger.log('Merging files', filePathsArray, 'to', outputFileName, '...');
      const mergedOutputFile = await mergeFiles(
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
    logger.log('Deleting original audio file', filePath);
    await bucket.file(filePath).delete();
    logger.log('Original audio file deleted');

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
      await logMemoryUsage('Final Memory Usage:');
    } catch (err) {
      logger.warn('Error when deleting temporary files', err);
    }
  }
};



const timeoutSeconds = 1800; // 30 minutes

const addintrooutrotaskhandler = onTaskDispatched(
  {
    timeoutSeconds: timeoutSeconds,
    memory: '1GiB',
    cpu: 1,
    concurrency: 1,
    retryConfig: {
      maxAttempts: 2,
      minBackoffSeconds: 10,
    },
  },
  async (request: Request<AddIntroOutroInputType>): Promise<void> => {
    const timeoutMillis = (timeoutSeconds - 30) * 1000 // 30s less than timeoutSeconds
    // set timeout to 30 seconds less than timeoutSeconds then throw error if it takes longer than that
    const data = request.data;
    if (!data.storageFilePath || data.startTime === undefined || data.startTime === null || data.endTime === null || data.endTime === undefined) {
      const errorMessage = "Data must contain storageFilePath (string), startTime (number), and endTime (number) properties || optionally introUrl (string) and outroUrl (string)"
      logger.error('Invalid Argument', errorMessage);
      throw new HttpsError('invalid-argument', errorMessage)
    }
    logger.log('storageFilePath', data.storageFilePath);
    if (!data.storageFilePath.startsWith('sermons/') || data.storageFilePath.endsWith('sermon/')) {
      // Not a sermon
      return logger.log('Not a sermon');
    }


    const bucket = firebaseAdmin.storage().bucket();
    const realtimeDB = firebaseAdmin.database();
    const db = firebaseAdmin.firestore();
    const fileName = path.basename(data.storageFilePath);
    const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(fileName);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };
    try {
      const cancelToken = new CancelToken();
      await executeWithTimout(() => mainFunction(
        cancelToken,
        bucket,
        realtimeDB,
        db,
        data.storageFilePath,
        docRef,
        sermonStatus,
        data.startTime,
        data.endTime,
        data.introUrl,
        data.outroUrl,
      ),
        cancelToken.cancel,
        timeoutMillis)
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
    }
  });

export default addintrooutrotaskhandler;
