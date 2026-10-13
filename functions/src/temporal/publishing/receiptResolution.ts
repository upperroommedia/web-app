import axios from 'axios';
import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import {
  ProviderReceipt,
  ProviderAdoptionAudit,
  providerPayloadFingerprint,
  providerReceiptId,
  readProviderReceipt,
  resolveProviderReceipt,
} from './providerReceipts';

const refuse: (message: string) => never = (message) => {
  throw new HttpsError('failed-precondition', message);
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : refuse('The provider returned an invalid resource.');
const resourceId = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) refuse(`The verified resource has a different ${label}.`);
};
const priorAudioId = async (receipt: ProviderReceipt): Promise<string> => {
  const audio = await readProviderReceipt(providerReceiptId(receipt.operationKey, 'subsplash-audio'));
  if (!audio || audio.state !== 'confirmed' || typeof audio.result !== 'string')
    refuse('The audio receipt must be verified before adopting this resource.');
  return audio.result as string;
};

/** Fetch a known ID, verify ownership/intent associations, then return the exact original stage result shape. */
export const verifyPublishingRemoteResource = async (
  receipt: ProviderReceipt,
  remoteId: string,
  options: { inspectOnly?: boolean } = {}
): Promise<unknown> => {
  const payload = record(receipt.intentPayload);
  if (providerPayloadFingerprint(payload) !== receipt.fingerprint)
    refuse('The immutable receipt intent is unavailable or invalid.');
  if (receipt.step === 'soundcloud-track') {
    return runWithSoundCloudAccessToken(async (token) => {
      const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
      const account = record((await axios.get('https://api.soundcloud.com/me', { headers, timeout: 30000 })).data);
      const track = record(
        (
          await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(remoteId)}`, {
            headers,
            timeout: 30000,
          })
        ).data
      );
      const identifiers = [track.urn, track.id, track.id_str].map(resourceId);
      if (!identifiers.includes(remoteId)) refuse('SoundCloud returned a different track ID.');
      const owner = record(track.user);
      const accountIdentifiers = [account.urn, account.id, account.id_str].map(resourceId).filter(Boolean);
      if (
        ![owner.urn, owner.id, owner.id_str]
          .map(resourceId)
          .filter(Boolean)
          .some((id) => accountIdentifiers.includes(id))
      )
        refuse('The track does not belong to the connected SoundCloud account.');
      equal(track.title, payload.title, 'track title');
      equal(track.description ?? '', payload.description ?? '', 'track description');
      const trackIdentifier = resourceId(track.urn) || resourceId(track.id_str) || resourceId(track.id);
      return {
        trackIdentifier,
        ...(typeof track.permalink_url === 'string' && track.permalink_url.trim()
          ? { permalinkUrl: track.permalink_url.trim() }
          : {}),
      };
    });
  }
  const paths: Record<string, string> = {
    'subsplash-audio': 'files/v1/audios',
    'subsplash-transcode': 'transcoder/v1/jobs',
    'subsplash-media-item': 'media/v1/media-items',
    'subsplash-series': 'media/v1/media-series',
    'image-create': 'files/v1/images',
    'list-create': 'builder/v1/lists',
    'overflow-list-create': 'builder/v1/lists',
    'speaker-tag-create': 'tags/v1/tags',
  };
  const path = paths[receipt.step];
  if (!path) refuse('This provider creation stage does not support verified adoption.');
  const token = await authenticateSubsplash();
  const remote = record(
    (
      await axios({
        ...createAxiosConfig(`https://core.subsplash.com/${path}/${encodeURIComponent(remoteId)}`, token, 'GET'),
        timeout: 30000,
      })
    ).data
  );
  equal(remote.id, remoteId, 'resource ID');
  equal(remote.app_key, '9XTSHD', 'Subsplash application');
  if (receipt.step === 'image-create') {
    const image = record(payload.image);
    equal(remote.type, image.type, 'image type');
    equal(remote.content_type, payload.contentType, 'image content type');
    const expectedTitle =
      image.name ||
      (typeof image.downloadLink === 'string' ? image.downloadLink.split('/').pop() : undefined) ||
      'Repaired image';
    equal(remote.title, expectedTitle, 'image title');
    if (options.inspectOnly) return { id: remoteId };
    const slot = record(record(remote._links).presigned_upload_url);
    if (typeof slot.href !== 'string') refuse('The provider did not return a resumable upload slot.');
    let upload: URL;
    try {
      upload = new URL(slot.href);
    } catch {
      return refuse('The provider returned an invalid upload slot.');
    }
    if (upload.protocol !== 'https:' || upload.username || upload.password)
      refuse('The provider returned an unsafe upload slot.');
    // Use only a fresh slot returned by the authenticated GET, never the lost POST URL.
    const expiry = upload.searchParams.get('Expires');
    const signedAt = upload.searchParams.get('X-Amz-Date');
    const signedFor = upload.searchParams.get('X-Amz-Expires');
    let expiresAt = expiry && /^\d+$/.test(expiry) ? Number(expiry) * 1000 : NaN;
    if (signedAt && signedFor && /^\d{8}T\d{6}Z$/.test(signedAt) && /^\d+$/.test(signedFor)) {
      const iso = `${signedAt.slice(0, 4)}-${signedAt.slice(4, 6)}-${signedAt.slice(6, 8)}T${signedAt.slice(
        9,
        11
      )}:${signedAt.slice(11, 13)}:${signedAt.slice(13, 15)}Z`;
      expiresAt = Date.parse(iso) + Number(signedFor) * 1000;
    }
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60000)
      refuse(
        'The provider upload slot is expired or cannot be verified. Obtain a fresh slot from provider support before adoption.'
      );
    return { id: remoteId, type: remote.type, _links: { presigned_upload_url: { href: slot.href } } };
  }
  if (receipt.step === 'list-create' || receipt.step === 'overflow-list-create') {
    equal(remote.title, payload.title, 'list title');
    equal(remote.type, payload.type, 'list type');
    if (payload.subtitle !== undefined) equal(remote.subtitle, payload.subtitle, 'list subtitle');
    if (payload.status !== undefined) equal(remote.status, payload.status, 'list status');
    const expectedImages =
      payload._embedded && typeof payload._embedded === 'object'
        ? (payload._embedded as Record<string, unknown>).images
        : undefined;
    if (Array.isArray(expectedImages)) {
      const actualImages = record(remote._embedded).images;
      if (!Array.isArray(actualImages)) refuse('The list image associations are unavailable.');
      const identities = (images: unknown[]) =>
        images
          .map((item) => {
            const image = record(item);
            return `${image.id}:${image.type}`;
          })
          .sort();
      equal(
        JSON.stringify(identities(actualImages)),
        JSON.stringify(identities(expectedImages)),
        'list image associations'
      );
    }
    if (receipt.step === 'list-create') return { listId: remoteId };
    // Overflow callers consume the full builder list result and use its row URL/counts.
    for (const field of ['list_rows_count', 'max_item_count'])
      if (typeof remote[field] !== 'number' || !Number.isFinite(remote[field])) refuse(`The list is missing ${field}.`);
    if (typeof record(record(remote._links)['list-rows']).href !== 'string')
      refuse('The list row association is unavailable.');
    return remote;
  }
  if (receipt.step === 'speaker-tag-create') {
    equal(remote.type, 'speaker', 'tag type');
    equal(remote.title, payload.title, 'speaker title');
    equal(remote.short_description ?? '', payload.shortDescription ?? '', 'speaker short description');
    equal(remote.description ?? '', payload.description ?? '', 'speaker description');
    const image = record(payload.squareImage);
    const association = record(record(remote._embedded)['square-image']);
    equal(association.id, image.subsplashId || image.id, 'speaker image association');
    equal(association.type, image.type, 'speaker image type');
    return { tagId: remoteId };
  }
  if (receipt.step === 'subsplash-audio') {
    equal(remote.title, payload.audioTitle, 'audio title');
    return remoteId;
  }
  if (receipt.step === 'subsplash-transcode') {
    equal(remote.file_name, payload.audioUrl, 'transcoding source');
    equal(record(record(remote._embedded).audio).id, await priorAudioId(receipt), 'audio association');
    if (typeof remote.status !== 'string') refuse('The transcoding job does not contain a valid status.');
    return remote;
  }
  equal(
    remote.title,
    typeof payload.title === 'string' && receipt.step === 'subsplash-series' ? payload.title.trim() : payload.title,
    'title'
  );
  if (receipt.step === 'subsplash-media-item') {
    equal(record(record(remote._embedded).audio).id, await priorAudioId(receipt), 'audio association');
    return remote;
  }
  // Series projection consumes these fields after adoption, so never confirm an incomplete shape.
  for (const field of ['slug', 'short_code', 'status'])
    if (typeof remote[field] !== 'string') refuse(`The series is missing ${field}.`);
  for (const field of ['media_items_count', 'published_media_items_count', 'position'])
    if (typeof remote[field] !== 'number' || !Number.isFinite(remote[field])) refuse(`The series is missing ${field}.`);
  return remote;
};

/** Authentication/resource authorization happens in the owning job control API before this call. */
export const resolvePublishingProviderReceipt = (options: {
  receiptId: string;
  remoteId?: string;
  actorUid: string;
  commandId?: string;
  cleanupOnly?: boolean;
  expectedJobRef?: { projectId: string; jobId: string };
  decision: 'adopt_existing_resource' | 'retain_existing_resource';
  duplicateRiskAcknowledged: true;
  evidenceReference: string;
  reason: string;
  assertCurrentInTransaction?: (transaction: Transaction) => Promise<void>;
  onResolutionCommit?: (transaction: Transaction) => Promise<void>;
}): Promise<void> => {
  if (
    !['adopt_existing_resource', 'retain_existing_resource'].includes(options.decision) ||
    options.duplicateRiskAcknowledged !== true ||
    !options.evidenceReference?.trim() ||
    !options.reason?.trim() ||
    options.evidenceReference.length > 1000 ||
    options.reason.length > 2000
  ) {
    throw new HttpsError(
      'invalid-argument',
      'Explicit intentional adoption, duplicate-risk acknowledgement, evidence reference and reason are required.'
    );
  }
  const adoptionAudit: ProviderAdoptionAudit = {
    decision: options.decision,
    duplicateRiskAcknowledged: true,
    evidenceReference: options.evidenceReference.trim(),
    reason: options.reason.trim(),
  };
  return resolveProviderReceipt({
    receiptId: options.receiptId,
    actorUid: options.actorUid,
    commandId: options.commandId,
    cleanupOnly: options.cleanupOnly,
    expectedJobRef: options.expectedJobRef,
    adoptionAudit,
    assertCurrentInTransaction: options.assertCurrentInTransaction,
    onResolutionCommit: options.onResolutionCommit,
    resolution: options.remoteId ? { type: 'adopt', remoteId: options.remoteId } : { type: 'prove_absence' },
    verifyRemoteResource: (receipt, id) =>
      verifyPublishingRemoteResource(receipt, id, { inspectOnly: options.cleanupOnly === true }),
    // Neither provider exposes authoritative operation-key lookup for these POSTs.
    verifyAuthoritativeAbsence: async () => false,
  });
};

/** Only for an original positive ACK selected privately by the coordinator.
 * An authenticated fixed-ID 404/410 proves absence of that known resource, never absence of an unknown POST. */
export const verifyAcknowledgedResourceAbsent = async (
  receipt: ProviderReceipt,
  remoteId: string
): Promise<boolean> => {
  if (!remoteId || remoteId.length > 256 || /[\s/?#]/.test(remoteId))
    refuse('A bounded original acknowledgement identity is required.');
  const payload = record(receipt.intentPayload);
  if (providerPayloadFingerprint(payload) !== receipt.fingerprint)
    refuse('The immutable original receipt intent is invalid.');
  const missing = (response: { status: number; data?: unknown }): boolean => {
    if (response.status === 404 || response.status === 410) {
      // Proxy/edge HTML is not an authoritative provider resource response.
      if (typeof response.data === 'string' && /<\s*(?:html|!doctype)/i.test(response.data))
        refuse('The provider returned an unverified edge response.');
      return true;
    }
    if (response.status >= 200 && response.status < 300) return false;
    return refuse('The provider did not authoritatively confirm fixed-resource absence.');
  };
  const validateStatus = (status: number) => (status >= 200 && status < 300) || status === 404 || status === 410;
  if (receipt.step === 'soundcloud-track') {
    const binding = receipt.providerAccount;
    if (binding?.provider !== 'soundcloud' || !/^soundcloud:users:[0-9]+$/.test(binding.account))
      refuse(
        'This legacy SoundCloud acknowledgement lacks its original account binding; absence cannot be proven safely.'
      );
    return runWithSoundCloudAccessToken(async (token) => {
      const { getAuthenticatedSoundCloudAccountId } = await import('../../soundcloudClient');
      const account = await getAuthenticatedSoundCloudAccountId(token);
      if (account !== binding.account)
        refuse('The connected SoundCloud account differs from the original provider claim.');
      return missing(
        await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(remoteId)}`, {
          headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
          timeout: 30_000,
          validateStatus,
        })
      );
    });
  }
  const paths: Record<string, string> = {
    'subsplash-audio': 'files/v1/audios',
    'subsplash-transcode': 'transcoder/v1/jobs',
    'subsplash-media-item': 'media/v1/media-items',
    'subsplash-series': 'media/v1/media-series',
    'image-create': 'files/v1/images',
    'list-create': 'builder/v1/lists',
    'overflow-list-create': 'builder/v1/lists',
    'speaker-tag-create': 'tags/v1/tags',
  };
  const path = paths[receipt.step];
  if (!path) refuse('This acknowledgement stage has no authenticated fixed-resource absence verifier.');
  if (
    receipt.providerAccount &&
    (receipt.providerAccount.provider !== 'subsplash' || receipt.providerAccount.account !== 'app:9XTSHD')
  )
    refuse('The original Subsplash application binding is incompatible.');
  // authenticateSubsplash obtains/caches OAuth tokens explicitly granted scope app:9XTSHD.
  const token = await authenticateSubsplash();
  return missing(
    await axios({
      ...createAxiosConfig(`https://core.subsplash.com/${path}/${encodeURIComponent(remoteId)}`, token, 'GET'),
      timeout: 30_000,
      validateStatus,
    })
  );
};
