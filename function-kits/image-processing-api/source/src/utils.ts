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

import * as superstruct from 'superstruct';
import * as axios from 'axios';
import sharp from 'sharp';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { imageLimits } from './config';

import express from 'express';

import { AssertionError } from 'assert';

/**
 * Keys in sharp file metadata that contain buffers. Used for
 * excluding from logging.
 */
export const fileMetadataBufferKeys = ['xmp', 'iptc', 'exif', 'icc'];

export function coerceStringToInt<T>(
  struct: superstruct.Struct<T>,
): superstruct.Struct<T> {
  return superstruct.coerce(struct, superstruct.string(), value => {
    // Keys without values are converted to 'true' to function as flags.
    // Return the 'true' value instead of trying to parseInt so that
    // validation error output is more helpful.
    if (value == 'true') return value;
    return parseInt(value, 10);
  });
}

export function coerceStringToFloat<T>(
  struct: superstruct.Struct<T>,
): superstruct.Struct<T> {
  return superstruct.coerce(struct, superstruct.string(), value => {
    // Keys without values are converted to 'true' to function as flags.
    // Return the 'true' value instead of trying to parseInt so that
    // validation error output is more helpful.
    if (value == 'true') return value;
    return parseFloat(value);
  });
}

export function coerceStringToBoolean(): superstruct.Struct<boolean, null> {
  return superstruct.coerce(
    superstruct.boolean(),
    superstruct.string(),
    value => {
      if (value === 'false') return false;
      if (value === '0') return false;
      if (value === 'true') return true;
      if (value === '1') return true;
      // Return the original value if unable to parse.
      // This will cause boolean validation to fail (correctly).
      return value;
    },
  );
}

export function coerceStringToArray<T>(
  struct: superstruct.Struct<T>,
): superstruct.Struct<T> {
  return superstruct.coerce(struct, superstruct.string(), value => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  });
}

export function omitUndefinedValues<T extends Record<string, unknown>>(
  object: T,
): T {
  Object.keys(object).forEach(key =>
    object[key] === undefined ? delete object[key] : {},
  );
  return object;
}

export function omitKeys<T>(object: T, keys: string[]): T {
  const output = Object.assign({}, object);
  for (let i = 0; i < keys.length; i++) {
    delete output[keys[i]];
  }
  return output;
}

export function omitKey<T>(object: T, key: string): T {
  return omitKeys<T>(object, [key]);
}

export function hasOwnProperty(target: unknown, property: string): boolean {
  return Object.hasOwnProperty.call(target, property);
}

export function expressAsyncHandlerWrapper(
  handler: express.RequestHandler,
): express.RequestHandler {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function isPublicAddress(address: string): boolean {
  // DNS resolution is validated on the actual socket lookup, preventing DNS rebinding.
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Permit only global unicast IPv6 (2000::/3); reject mapped IPv4 and local ranges.
    return /^[23][0-9a-f]{3}:/.test(normalized);
  }
  return false;
}

const publicAgent = new https.Agent({ keepAlive: true, lookup: (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '', 4);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('Image source must resolve to a public address.'), '', 4);
    }
    const result = addresses.find(a => !options.family || a.family === options.family) || addresses[0];
    if ((options as { all?: boolean }).all) return (callback as Function)(null, addresses);
    callback(null, result.address, result.family);
  });
} });

export async function isImageFileType(buffer: Buffer): Promise<boolean> {
  try { await sharp(buffer, { limitInputPixels: imageLimits.pixels }).metadata(); return true; }
  catch { return false; }
}

export async function fetchImageBufferFromUrl(url: string, redirects = 0): Promise<Buffer> {
  const source = new URL(url);
  const emulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const isEmulator = !!emulator && source.host === emulator && source.protocol === 'http:';
  if ((!isEmulator && source.protocol !== 'https:') || source.username || source.password) {
    throw new AssertionError({ message: 'Image sources must use HTTPS without URL credentials.' });
  }
  if (!isEmulator && isIP(source.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(source.hostname.replace(/^\[|\]$/g, ''))) {
    throw new AssertionError({ message: 'Image source must resolve to a public address.' });
  }
  try {
    const response = await axios.default.get(source.href, {
      responseType: 'arraybuffer', timeout: 10_000, maxContentLength: imageLimits.bytes,
      maxBodyLength: imageLimits.bytes, maxRedirects: 0, httpsAgent: publicAgent,
      // Ignore environment proxy variables so the validated lookup cannot be bypassed.
      proxy: false, validateStatus: () => true,
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= 3) throw new Error('Too many source redirects.');
      return fetchImageBufferFromUrl(new URL(response.headers.location, source).href, redirects + 1);
    }
    if (response.status !== 200 || !await isImageFileType(response.data)) {
      throw new Error(`Invalid image response (status ${response.status}).`);
    }
    return response.data;
  } catch (error) {
    throw new AssertionError({ message: `Unable to fetch image: ${(error as Error).message}` });
  }
}
