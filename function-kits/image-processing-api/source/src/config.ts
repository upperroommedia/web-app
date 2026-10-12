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

import { defineString } from 'firebase-functions/params';

const bucket = defineString('CLOUD_STORAGE_BUCKET');
const corsOrigins = defineString('CORS_ORIGIN_ALLOW_LIST', { default: '*' });
const hostname = defineString('HOSTNAME', { default: '' });

// Resolve parameters at request time, never during deployment discovery.
export const extensionConfiguration = {
  get bucket() { return bucket.value(); },
  get corsAllowList() { return corsOrigins.value().split(',').map(s => s.trim()); },
  get hostname() { return hostname.value() || null; },
};

export const imageLimits = { pixels: 40_000_000, dimension: 16_384, bytes: 20 * 1024 * 1024, operations: 32 };
