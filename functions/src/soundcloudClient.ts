import {assertSynchronousProviderMutationCompleted} from './temporal/publishing/providerMutationCompletion';
import {assertProviderMutationTransportAllowed} from './temporal/publishing/providerTransportPolicy';
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
import { getHtmlEdgeBlock } from './helpers/upstreamHttpErrors';
import { HttpsError } from 'firebase-functions/v2/https';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `OAuth ${accessToken}`,
    Accept: 'application/json; charset=utf-8',
  };
}

/** Stable original owner binding for a provider creation, independent of later OAuth reconnects. */
export const normalizeSoundCloudAccountId = (account: { urn?: unknown; id?: unknown; id_str?: unknown }): string => {
  const urn = typeof account.urn === 'string' ? /^soundcloud:users:([0-9]+)$/.exec(account.urn.trim())?.[1] : undefined;
  const numeric =
    urn ??
    (typeof account.id_str === 'string' && /^[0-9]+$/.test(account.id_str) ? account.id_str : undefined) ??
    (typeof account.id === 'number' && Number.isSafeInteger(account.id) && account.id >= 0
      ? String(account.id)
      : typeof account.id === 'string' && /^[0-9]+$/.test(account.id)
      ? account.id
      : undefined);
  if (!numeric) throw new Error('SoundCloud account response is missing a stable user identifier.');
  return `soundcloud:users:${numeric}`;
};
export const getAuthenticatedSoundCloudAccountId = async (accessToken: string): Promise<string> =>
  normalizeSoundCloudAccountId(
    (await axios.get(`${SOUNDCLOUD_API_BASE}/me`, { headers: authHeaders(accessToken), timeout: 30_000 })).data ?? {}
  );

export interface UploadTrackParams {
  bucket: Bucket;
  audioStoragePath: string;
  imageSource?: string;
  title: string;
  tags: string[];
  description: string;
  /** Authenticated provider metadata copied during an explicitly approved replacement. */
  providerMetadata?: Record<string, string | boolean | number>;
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
  if (getHtmlEdgeBlock(error)) {
    throw new HttpsError(
      'unavailable',
      'SoundCloud temporarily blocked the track request from our server. Please retry shortly.'
    );
  }
  if (isAxiosError(error) && error.response?.status === 401) {
    throw createSoundCloudReconnectRequiredError(
      'SoundCloud authorization is missing or expired. Reconnect SoundCloud from Admin > Advanced and try again.'
    );
  }

  throw error;
};

export const isSoundCloudTrackNotFoundError = (error: unknown): boolean =>
  isAxiosError(error) && error.response?.status === 404;

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
export function formatTagList(tags: string[]): string {
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

export const inferMultipartFilename = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const candidate = basename(trimmed);
  if (!candidate) {
    return fallback;
  }

  if (extname(candidate)) {
    return candidate;
  }

  const fallbackExtension = extname(fallback);
  return fallbackExtension ? `${candidate}${fallbackExtension}` : candidate;
};

const inferFilenameFromUrl = (source: string, fallback: string): string => {
  try {
    const url = new URL(source);
    return inferMultipartFilename(decodeURIComponent(url.pathname), fallback);
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
  const filename = inferMultipartFilename(storagePath, fallbackFilename);
  return {
    stream: file.createReadStream(),
    filename,
    contentType: metadata.contentType || fallbackContentType,
    knownLength: parseKnownLength(metadata.size),
  };
}

async function createImageSourceStream(bucket: Bucket, source: string): Promise<MultipartStreamSource> {
  if (/^https?:\/\//i.test(source)) {
    const response = await axios.get<Readable>(source, { responseType: 'stream', timeout: 60_000 });
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

/** Preparation performs only source reads. A provider creation receipt must wrap post(), not this function. */
export interface PreparedSoundCloudUpload {
  post(accessToken: string): Promise<SoundCloudTrackResult>;
  dispose(): void;
}
export async function prepareMultipartUpload(params: UploadTrackParams): Promise<PreparedSoundCloudUpload> {
  const streams: Readable[] = [];
  const form = new FormData();
  let disposed = false;
  let posted = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const stream of streams) stream.destroy();
    // FormData's delayed wrappers can keep source listeners alive after a cached receipt replay.
    form.destroy();
  };
  try {
    const audioSource = await createBucketStreamSource(
      params.bucket,
      params.audioStoragePath,
      'audio.mp3',
      'audio/mpeg'
    );
    streams.push(audioSource.stream);
    form.append('track[title]', params.title);
    form.append('track[asset_data]', audioSource.stream, {
      filename: audioSource.filename,
      contentType: audioSource.contentType,
      knownLength: audioSource.knownLength,
    });
    form.append('track[tag_list]', formatTagList(params.tags));
    form.append('track[description]', params.description);
    const preservable = [
      'sharing',
      'embeddable_by',
      'purchase_url',
      'genre',
      'label_name',
      'release',
      'release_date',
      'streamable',
      'downloadable',
      'license',
      'commentable',
      'reveal_stats',
      'reveal_comments',
      'isrc',
      'artist',
    ];
    for (const field of preservable) {
      const value = params.providerMetadata?.[field];
      if (value !== undefined) form.append(`track[${field}]`, String(value));
    }

    if (params.imageSource) {
      const imageSource = await createImageSourceStream(params.bucket, params.imageSource);
      streams.push(imageSource.stream);
      form.append('track[artwork_data]', imageSource.stream, {
        filename: imageSource.filename,
        contentType: imageSource.contentType,
        knownLength: imageSource.knownLength,
      });
    }

    return {
      dispose,
      async post(accessToken) {
        if (disposed || posted) throw new Error('A prepared SoundCloud upload can only be posted once.');
        posted = true;
        assertProviderMutationTransportAllowed('soundcloud');
        const resp = await axios.post(`${SOUNDCLOUD_API_BASE}/tracks`, form, {
          headers: {
            ...authHeaders(accessToken),
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 540_000,
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
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Backwards-compatible direct upload; every allocated source stream is closed on all outcomes. */
export async function uploadTrack(accessToken: string, params: UploadTrackParams): Promise<SoundCloudTrackResult> {
  const upload = await prepareMultipartUpload(params);
  try {
    return await upload.post(accessToken);
  } finally {
    upload.dispose();
  }
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
  assertProviderMutationTransportAllowed('soundcloud');
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
      timeout: 60_000,
      maxRedirects:0,
    });
    assertSynchronousProviderMutationCompleted(response);
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
        timeout: 60_000,
        maxRedirects:0,
      }
    );
    assertSynchronousProviderMutationCompleted(response);
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
export async function deleteTrack(accessToken: string, trackId: string, options?: { onResponse?: (response: { status: number }) => void }): Promise<void> {
  assertProviderMutationTransportAllowed('soundcloud');
  const response = await axios.delete(`${SOUNDCLOUD_API_BASE}/tracks/${encodeTrackIdentifier(trackId)}`, {
    headers: authHeaders(accessToken),
    timeout: 30_000,
    maxRedirects: 0,
  });
  assertSynchronousProviderMutationCompleted(response);
  options?.onResponse?.({ status: response.status });
}

/**
 * Re-export for callers that need to map SoundCloud API errors.
 */
export { AxiosError };
