import { Reference } from "firebase-admin/database";
import { CancelToken } from "./CancelToken";
import { Bucket, File } from "@google-cloud/storage";
import { CustomMetadata } from "./types";
import { convertStringToMilliseconds, createTempFile } from "./utils";
import { logger } from "firebase-functions/v2";
import { writeFileSync } from "fs";
import { HttpsError } from "firebase-functions/v2/https";

const mergeFiles = async (
    ffmpeg: typeof import('fluent-ffmpeg'),
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

  export default mergeFiles;