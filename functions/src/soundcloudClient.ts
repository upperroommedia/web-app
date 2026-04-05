/**
 * SoundCloud API client for upload, update, and delete of tracks.
 * Uses OAuth 2.1 access token (Authorization: OAuth <token>).
 *
 * OAuth access tokens are managed by the SoundCloud auth helpers, which store
 * refresh state server-side and refresh access tokens automatically.
 */

import axios, { AxiosError, isAxiosError } from 'axios';
import FormData from 'form-data';
import { Bucket } from '@google-cloud/storage';
import { createSoundCloudReconnectRequiredError } from './soundcloudAuthErrors';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `OAuth ${accessToken}`,
    Accept: 'application/json; charset=utf-8',
  };
}

export interface UploadTrackParams {
  bucket: Bucket;
  audioStoragePath: string;
  imageSource?: string;
  title: string;
  tags: string[];
  description: string;
}

type SoundCloudTrackResponse = {
  urn?: string;
  id?: string | number;
  id_str?: string;
  permalink_url?: string;
};

export interface SoundCloudTrackResult {
  trackIdentifier: string;
  permalinkUrl?: string;
}

export const normalizeSoundCloudApiError = (error: unknown): never => {
  if (isAxiosError(error) && error.response?.status === 401) {
    throw createSoundCloudReconnectRequiredError(
      'SoundCloud authorization is missing or expired. Reconnect SoundCloud from Admin > Advanced and try again.'
    );
  }

  throw error;
};

function encodeTrackIdentifier(trackIdentifier: string): string {
  return encodeURIComponent(trackIdentifier);
}

function getTrackIdentifier(track: SoundCloudTrackResponse | undefined): string | null {
  if (!track) {
    return null;
  }

  if (typeof track.urn === 'string' && track.urn.trim().length > 0) {
    return track.urn.trim();
  }

  if (typeof track.id_str === 'string' && track.id_str.trim().length > 0) {
    return track.id_str.trim();
  }

  if (typeof track.id === 'number') {
    return String(track.id);
  }

  if (typeof track.id === 'string' && track.id.trim().length > 0) {
    return track.id.trim();
  }

  return null;
}

/**
 * SoundCloud tag_list is space-separated. Multi-word tags are often quoted.
 */
function formatTagList(tags: string[]): string {
  return tags.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
}

type MultipartStreamSource = {
  stream: Readable;
  filename: string;
  contentType: string;
  knownLength?: number;
};

const parseKnownLength = (rawValue: unknown): number | undefined => {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
    return rawValue;
  }

  if (typeof rawValue !== 'string') {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const inferFilenameFromPath = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const candidate = basename(trimmed);
  return candidate.length > 0 ? candidate : fallback;
};

const inferFilenameFromUrl = (source: string, fallback: string): string => {
  try {
    const url = new URL(source);
    const candidate = basename(decodeURIComponent(url.pathname));
    return candidate.length > 0 ? candidate : fallback;
  } catch {
    return fallback;
  }
};

const inferImageContentTypeFromFilename = (filename: string): string => {
  const extension = extname(filename).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
    default:
      return 'image/jpeg';
  }
};

async function createBucketStreamSource(
  bucket: Bucket,
  storagePath: string,
  fallbackFilename: string,
  fallbackContentType: string
): Promise<MultipartStreamSource> {
  const file = bucket.file(storagePath);
  const [metadata] = await file.getMetadata();
  const filename = inferFilenameFromPath(storagePath, fallbackFilename);
  return {
    stream: file.createReadStream(),
    filename,
    contentType: metadata.contentType || fallbackContentType,
    knownLength: parseKnownLength(metadata.size),
  };
}

async function createImageSourceStream(bucket: Bucket, source: string): Promise<MultipartStreamSource> {
  if (/^https?:\/\//i.test(source)) {
    const response = await axios.get<Readable>(source, { responseType: 'stream' });
    const filename = inferFilenameFromUrl(source, 'artwork.jpg');
    return {
      stream: response.data,
      filename,
      contentType:
        (typeof response.headers['content-type'] === 'string' && response.headers['content-type']) ||
        inferImageContentTypeFromFilename(filename),
      knownLength: parseKnownLength(response.headers['content-length']),
    };
  }

  return createBucketStreamSource(bucket, source, 'artwork.jpg', inferImageContentTypeFromFilename(source));
}

/**
 * Upload a track to SoundCloud. Downloads audio (and optional image) from
 * Firebase Storage, then POSTs multipart/form-data to SoundCloud.
 */
export async function uploadTrack(accessToken: string, params: UploadTrackParams): Promise<SoundCloudTrackResult> {
  const audioSource = await createBucketStreamSource(
    params.bucket,
    params.audioStoragePath,
    'audio.mp3',
    'audio/mpeg'
  );
  const form = new FormData();
  form.append('track[title]', params.title);
  form.append('track[asset_data]', audioSource.stream, {
    filename: audioSource.filename,
    contentType: audioSource.contentType,
    knownLength: audioSource.knownLength,
  });
  form.append('track[tag_list]', formatTagList(params.tags));
  form.append('track[description]', params.description);

  if (params.imageSource) {
    const imageSource = await createImageSourceStream(params.bucket, params.imageSource);
    form.append('track[artwork_data]', imageSource.stream, {
      filename: imageSource.filename,
      contentType: imageSource.contentType,
      knownLength: imageSource.knownLength,
    });
  }

  const resp = await axios.post(`${SOUNDCLOUD_API_BASE}/tracks`, form, {
    headers: {
      ...authHeaders(accessToken),
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const trackIdentifier = getTrackIdentifier(resp.data);
  if (trackIdentifier == null) {
    throw new Error('SoundCloud upload response missing track identifier');
  }
  return {
    trackIdentifier,
    ...(typeof resp.data?.permalink_url === 'string' && resp.data.permalink_url.trim().length > 0
      ? { permalinkUrl: resp.data.permalink_url.trim() }
      : {}),
  };
}

export interface UpdateTrackParams {
  title?: string;
  description?: string;
  tags?: string[];
  imageSource?: string;
  bucket?: Bucket;
}

/**
 * Update track metadata. Uses JSON body when no image; uses multipart when
 * imageSource and bucket are provided.
 */
export async function updateTrack(
  accessToken: string,
  trackId: string,
  params: UpdateTrackParams
): Promise<SoundCloudTrackResult | undefined> {
  const trackIdentifier = trackId.trim();
  const hasArtwork = params.imageSource && params.bucket;
  if (hasArtwork) {
    const form = new FormData();
    if (params.title != null) form.append('track[title]', params.title);
    if (params.description != null) form.append('track[description]', params.description);
    if (params.tags != null) form.append('track[tag_list]', formatTagList(params.tags));
    const imageSource = await createImageSourceStream(params.bucket!, params.imageSource!);
    form.append('track[artwork_data]', imageSource.stream, {
      filename: imageSource.filename,
      contentType: imageSource.contentType,
      knownLength: imageSource.knownLength,
    });
    const response = await axios.put(`${SOUNDCLOUD_API_BASE}/tracks/${encodeTrackIdentifier(trackId)}`, form, {
      headers: {
        ...authHeaders(accessToken),
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return {
      trackIdentifier,
      ...(typeof response.data?.permalink_url === 'string' && response.data.permalink_url.trim().length > 0
        ? { permalinkUrl: response.data.permalink_url.trim() }
        : {}),
    };
  } else {
    const body: Record<string, unknown> = {};
    if (params.title != null) body.title = params.title;
    if (params.description != null) body.description = params.description;
    if (params.tags != null) body.tag_list = formatTagList(params.tags);
    const response = await axios.put(
      `${SOUNDCLOUD_API_BASE}/tracks/${encodeTrackIdentifier(trackId)}`,
      { track: body },
      {
        headers: {
          ...authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
      }
    );
    return {
      trackIdentifier,
      ...(typeof response.data?.permalink_url === 'string' && response.data.permalink_url.trim().length > 0
        ? { permalinkUrl: response.data.permalink_url.trim() }
        : {}),
    };
  }
}

/**
 * Delete a track by id.
 */
export async function deleteTrack(accessToken: string, trackId: string): Promise<void> {
  await axios.delete(`${SOUNDCLOUD_API_BASE}/tracks/${encodeTrackIdentifier(trackId)}`, {
    headers: authHeaders(accessToken),
  });
}

/**
 * Re-export for callers that need to map SoundCloud API errors.
 */
export { AxiosError };
