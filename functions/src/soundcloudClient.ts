/**
 * SoundCloud API client for upload, update, and delete of tracks.
 * Uses OAuth 2.1 access token (Authorization: OAuth <token>).
 *
 * Secrets (Option A): Store SOUNDCLOUD_ACCESS_TOKEN in Firebase Secret Manager.
 * Obtain via one-time SoundCloud OAuth Authorization Code flow.
 */

import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import { Bucket } from '@google-cloud/storage';

const SOUNDCLOUD_API_BASE = 'https://api.soundcloud.com';

function authHeaders(accessToken: string): Record<string, string> {
  return {
    'Authorization': `OAuth ${accessToken}`,
    'Accept': 'application/json; charset=utf-8',
  };
}

export interface UploadTrackParams {
  bucket: Bucket;
  audioStoragePath: string;
  imageStoragePath?: string;
  title: string;
  tags: string[];
  description: string;
}

/**
 * SoundCloud tag_list is space-separated. Multi-word tags are often quoted.
 */
function formatTagList(tags: string[]): string {
  return tags.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
}

/**
 * Upload a track to SoundCloud. Downloads audio (and optional image) from
 * Firebase Storage, then POSTs multipart/form-data to SoundCloud.
 */
export async function uploadTrack(
  accessToken: string,
  params: UploadTrackParams
): Promise<string> {
  const [audioBuf] = await params.bucket.file(params.audioStoragePath).download();
  const form = new FormData();
  form.append('track[title]', params.title);
  form.append('track[asset_data]', audioBuf, {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('track[tag_list]', formatTagList(params.tags));
  form.append('track[description]', params.description);

  if (params.imageStoragePath) {
    const [imgBuf] = await params.bucket.file(params.imageStoragePath).download();
    form.append('track[artwork_data]', imgBuf, {
      filename: 'artwork.jpg',
      contentType: 'image/jpeg',
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

  const id = resp.data?.id ?? resp.data?.id_str;
  if (id == null) {
    throw new Error('SoundCloud upload response missing track id');
  }
  return String(id);
}

export interface UpdateTrackParams {
  title?: string;
  description?: string;
  tags?: string[];
  imageStoragePath?: string;
  bucket?: Bucket;
}

/**
 * Update track metadata. Uses JSON body when no image; uses multipart when
 * imageStoragePath and bucket are provided.
 */
export async function updateTrack(
  accessToken: string,
  trackId: string,
  params: UpdateTrackParams
): Promise<void> {
  const hasArtwork = params.imageStoragePath && params.bucket;
  if (hasArtwork) {
    const form = new FormData();
    if (params.title != null) form.append('track[title]', params.title);
    if (params.description != null) form.append('track[description]', params.description);
    if (params.tags != null) form.append('track[tag_list]', formatTagList(params.tags));
    const [imgBuf] = await params.bucket!.file(params.imageStoragePath!).download();
    form.append('track[artwork_data]', imgBuf, {
      filename: 'artwork.jpg',
      contentType: 'image/jpeg',
    });
    await axios.put(`${SOUNDCLOUD_API_BASE}/tracks/${trackId}`, form, {
      headers: {
        ...authHeaders(accessToken),
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } else {
    const body: Record<string, unknown> = {};
    if (params.title != null) body.title = params.title;
    if (params.description != null) body.description = params.description;
    if (params.tags != null) body.tag_list = formatTagList(params.tags);
    await axios.put(`${SOUNDCLOUD_API_BASE}/tracks/${trackId}`, { track: body }, {
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': 'application/json',
      },
    });
  }
}

/**
 * Delete a track by id.
 */
export async function deleteTrack(accessToken: string, trackId: string): Promise<void> {
  await axios.delete(`${SOUNDCLOUD_API_BASE}/tracks/${trackId}`, {
    headers: authHeaders(accessToken),
  });
}

/**
 * Re-export for callers that need to map SoundCloud API errors.
 */
export { AxiosError };
