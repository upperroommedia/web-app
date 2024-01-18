import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
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
import { sermonStatus, sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import { HttpsError } from 'firebase-functions/v2/https';
import { Reference } from 'firebase-admin/database';
import { exec } from 'node:child_process';

type filePaths = {
  INTRO: string | undefined;
  OUTRO: string | undefined;
};

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
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        const calculatedDuration = duration
          ? duration * 1000
          : startTime
          ? totalTimeMillis - startTime * 1000
          : totalTimeMillis;
        const percent = Math.round(Math.max(0, ((timeMillis * 0.96) / calculatedDuration) * 100)); // go to 96% to leave room for the time it takes to Merge the files
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
  bucket: Bucket,
  filePaths: string[],
  outputFilePath: string,
  durationSeconds: number,
  tempFiles: Set<string>,
  realtimeDBref: Reference
): Promise<File> => {
  const listFileName = createTempFile('list.txt', tempFiles);
  const outputFile = bucket.file(outputFilePath);
  const writeStream = outputFile.createWriteStream({ contentType: 'audio/mpeg' });

  // ffmpeg -f concat -i mylist.txt -c copy output
  const filePathsForTxt = filePaths.map((filePath) => `file '${filePath}'`);
  const fileNames = filePathsForTxt.join('\n');

  logger.log('fileNames', fileNames);

  writeFileSync(listFileName, fileNames);

  const merge = ffmpeg();

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
  customMetadata?: { [key: string]: string }
) => {
  logger.log('custom metadata', customMetadata);
  await bucket.upload(inputFilePath, { destination: destinationFilePath });
  await bucket.file(destinationFilePath).setMetadata({ contentType: 'audio/mpeg', metadata: customMetadata });
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

const addIntroOutro = onObjectFinalized(
  { timeoutSeconds: 540, memory: '1GiB', cpu: 1, concurrency: 1 },
  async (storageEvent): Promise<void> => {
    const data = storageEvent.data;
    const filePath = data.name ? data.name : '';
    logger.log('Object Finalized', filePath);
    if (!filePath.startsWith('sermons/') || filePath.endsWith('sermon/')) {
      // Not a sermon
      return logger.log('Not a sermon');
    }
    if (!data.mediaLink) {
      // This is not a media file
      return logger.log('Not a media file');
    }

    exec(`${ffmpegStatic} -version`, (err, stdout) => {
      if (err) {
        logger.error('FFMPEG not installed', err);
      } else {
        logger.log('FFMPEG version', stdout);
      }
    });
    await logMemoryUsage('Initial Memory Usage:');
    const bucket = firebaseAdmin.storage().bucket();
    const realtimeDB = firebaseAdmin.database();
    const db = firebaseAdmin.firestore();
    const fileName = path.basename(filePath);
    const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(fileName);
    const sermonStatus: sermonStatus = {
      subsplash: uploadStatus.NOT_UPLOADED,
      soundCloud: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PROCESSING,
    };
    const tempFiles = new Set<string>();
    // the document may not exist yet, if it deosnt wait 5 seconds and try again do this for a max of 3 times before throwing an error
    const maxTries = 3;
    let currentTry = 0;
    let docFound = false;
    while (currentTry < maxTries) {
      logger.log(`Checking if document exists attempt: ${currentTry + 1}/${maxTries}`);
      const doc = await docRef.get();
      if (doc.exists) {
        docFound = true;
        break;
      }
      currentTry++;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    if (!docFound) {
      throw new HttpsError('not-found', `Sermon Document ${fileName} Not Found`);
    }

    try {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Getting Data',
        },
      });
      logger.log(data.metadata);
      const audioFilesToMerge: filePaths = { INTRO: undefined, OUTRO: undefined };
      const customMetadata: { introUrl?: string; outroUrl?: string } = {};
      if (data.metadata?.introUrl) {
        audioFilesToMerge.INTRO = data.metadata.introUrl;
        customMetadata.introUrl = data.metadata.introUrl;
      }
      if (data.metadata?.outroUrl) {
        audioFilesToMerge.OUTRO = data.metadata.outroUrl;
        customMetadata.outroUrl = data.metadata.outroUrl;
      }
      logger.log('Audio File Download Paths', JSON.stringify(audioFilesToMerge));
      const tempFilePaths = await downloadFiles(bucket, audioFilesToMerge, tempFiles);
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Trimming and Transcoding',
        },
      });
      const trimAndTranscodePath = await trimAndTranscode(
        bucket.file(filePath),
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        parseFloat(data.metadata?.startTime || ''),
        parseFloat(data.metadata?.duration || '')
      );
      await uploadSermon(trimAndTranscodePath, `processed-sermons/${fileName}`, bucket, customMetadata);
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
          bucket,
          filePathsArray,
          outputFilePath,
          durationSeconds,
          tempFiles,
          realtimeDB.ref(`addIntroOutro/${fileName}`)
        );
        logger.log('MergedFiles saved to', mergedOutputFile.name);
        await logMemoryUsage('Memory Usage after merge:');
      }
      logger.log('Updating status to PROCESSED');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSED,
        },
        durationSeconds: durationSeconds,
      });
      realtimeDB.ref(`addIntroOutro/${fileName}`).set(100);
      await realtimeDB.ref(`addIntroOutro/${fileName}`).remove();

      // delete original audio file
      logger.log('Deleting original audio file', filePath);
      await bucket.file(filePath).delete();
      logger.log('Original audio file deleted');

      return logger.log('Files have been merged succesfully');
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
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message: message,
        },
      });
      return logger.error('Error', e);
    } finally {
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
  }
);

export default addIntroOutro;
