/*
 * Copyright (c) 2016-present Invertase Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this library except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AssertionError } from 'assert';

import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';

import * as functions from 'firebase-functions';
import { onRequest } from 'firebase-functions/https';
import { defineString } from 'firebase-functions/params';
import { migratedGlobalOptions } from './migration-options';

const regionParam = defineString('FUNCTION_DEFAULT_REGION', { default: process.env.LOCATION || 'us-central1' });
functions.setGlobalOptions({ ...migratedGlobalOptions(process.env), region: regionParam });
import helmet from 'helmet';
import { StructError } from 'superstruct';

import {
  applyValidatedOperation,
  asValidatedOperations,
  jsonAsValidatedOperations,
} from './operations';
import {
  expressAsyncHandlerWrapper,
  fileMetadataBufferKeys,
  omitKeys,
} from './utils';
import { Operation, ValidatedOperation } from './types';
import { extensionConfiguration, imageLimits } from './config';
import sharp, { Sharp, Metadata } from 'sharp';

async function processImageRequest(
  validatedOperations: ValidatedOperation[],
  res: Response,
): Promise<void> {
  if (validatedOperations.length < 2 || validatedOperations.length > imageLimits.operations) {
    throw new AssertionError({ message: `Provide between 2 and ${imageLimits.operations} operations.` });
  }
  const firstOperation = validatedOperations[0];
  const lastOperation = validatedOperations[validatedOperations.length - 1];

  // Ensure input is the first operation.
  if (firstOperation.operation != 'input') {
    throw new AssertionError({
      message: `An input operation must be the first operation.`,
    });
  }

  // Ensure output is the last operation.
  if (lastOperation.operation != 'output') {
    throw new AssertionError({
      message: `An output operation must be the last operation.`,
    });
  }

  // Apply operations.
  let instance: Sharp | null = null;
  for (let i = 0; i < validatedOperations.length; i++) {
    const validatedOperation = validatedOperations[i];
    instance = await applyValidatedOperation(instance, validatedOperation);
  }

  const finalFileMetadata = omitKeys(
    await (instance as Sharp).metadata(),
    fileMetadataBufferKeys,
  );

  if (lastOperation.options.debug == true) {
    res.json({
      operations: validatedOperations,
      metadata: finalFileMetadata,
    });
    return;
  }

  const output = await (instance as Sharp).toBuffer({
    resolveWithObject: true,
  });
  const { data, info } = output;
  if (data.length > imageLimits.bytes) throw new AssertionError({ message: 'Output image exceeds the size limit.' });

  functions.logger.debug('Processed image request.', { operations: validatedOperations.map(op => op.operation), bytes: data.length });

  const headers = {
    'Content-Type': `image/${info.format}`,
    'Content-Length': Buffer.byteLength(data),
    'Content-Disposition': `inline; filename=image.${info.format}`,
    'Cache-control': 'public, max-age=3600, s-maxage=86400', // 1 Year
  };

  // Attach output information as response headers.
  Object.entries(info).forEach(entry => {
    headers[`ext-output-info-${entry[0].toLowerCase()}`] = `${entry[1]}`;
  });

  // Attach sharp metadata as response headers.
  Object.entries(finalFileMetadata).forEach(entry => {
    headers[`ext-metadata-${entry[0].toLowerCase()}`] = `${entry[1]}`;
  });

  res.writeHead(200, headers);
  res.end(data);
}

export const app = express();
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(
  cors({
    origin(origin, callback) {
      const allowed = extensionConfiguration.corsAllowList;
      callback(null, !origin || allowed.includes('*') || allowed.includes(origin));
    },
    methods: ['GET', 'POST', 'HEAD'],
  }),
);

app.get(
  '/process',
  expressAsyncHandlerWrapper(async (req, res, next) => {
    const operationsString = req.query.operations;
    if (typeof operationsString !== 'string') {
      throw new AssertionError({ message: 'Provide one operations query parameter.' });
    }
    if (!operationsString || !operationsString.length) {
      return next(
        new AssertionError({
          message: `An 'operations' query parameter - a json array of operations to perform - converted to a json string and url encoded.`,
        }),
      );
    }
    let operations: Operation[] = [];
    try {
      operations = JSON.parse(operationsString);
      if (!Array.isArray(operations) || operations.some(op => !op || typeof op !== "object")) {
        throw new Error("Operations must be an array of objects.");
      }
    } catch (e) {
      return next(
        new AssertionError({
          message: `Invalid operations JSON string. ${e.message}`,
        }),
      );
    }

    const validatedOperations: ValidatedOperation[] =
      jsonAsValidatedOperations(operations);
    await processImageRequest(validatedOperations, res);
  }),
);

app.get(
  /^\/process\/.+/,
  expressAsyncHandlerWrapper(async (req, res, next) => {
    const operationsString = req.url.replace('/process/', '');
    if (!operationsString || !operationsString.length) {
      return next();
    }
    const validatedOperations: ValidatedOperation[] =
      asValidatedOperations(operationsString);
    await processImageRequest(validatedOperations, res);
  }),
);

// Express requires the function to have 4 arguments for a handler
// to be treated as an error handler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(function handleError(error: Error, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof StructError || error instanceof AssertionError) {
    functions.logger.warn(error.message, {
      path: req.path,
    });
    res.status(400).send(error.message);
  } else {
    functions.logger.error(
      'An error occurred processing a request, please report this issue to the GitHub ' +
        'repository for this extension and include this log entry with your report (omit any ' +
        'sensitive data).',
      {
        path: req.path,
        error: {
          message: error.message,
          stack: error.stack,
        },
      },
    );
    res
      .status(500)
      .send('A server error occurred. See server logs for more information.');
  }
});

app.use(function notFoundHandler(_req, res) {
  res.status(404).send('Not Found');
});

// Sharp allocates native memory per request; use modest concurrency rather than v2's default 80.
export const handler = onRequest({ invoker: 'public' }, app);
