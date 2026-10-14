import { createHash, randomUUID } from 'node:crypto';
import {
  inspectStageAsset,
  probeStageAsset,
  resolveStageAsset,
  writeSandboxAllocation,
  copyStageAssetToSandbox,
} from './assets';
import { runSandboxOperation, SandboxStoreProfile, SandboxTransaction, assertSandboxAssetPreparation } from './store';
import {
  SandboxAssetEvidence,
  SandboxFaultPlan,
  SandboxHttpError,
  SandboxRequest,
  SandboxRequestContext,
  SandboxResource,
  SandboxResponse,
  StageAssetRef,
} from './types';
export type { StageAssetRef, SandboxRequestContext } from './types';
const APP = '9XTSHD';
const ROUTES: Record<string, string> = {
  '/files/v1/audios': 'audios',
  '/files/v1/images': 'images',
  '/transcoder/v1/jobs': 'jobs',
  '/media/v1/media-items': 'media-items',
  '/media/v1/media-series': 'media-series',
  '/builder/v1/lists': 'lists',
  '/builder/v1/list-rows': 'list-rows',
  '/tags/v1/tags': 'tags',
  '/tags/v1/taggings': 'taggings',
};
const FAMILY_RELATIONS: Record<string, string> = {
  audio: 'audios',
  images: 'images',
  image: 'images',
  'media-item': 'media-items',
  'media-series': 'media-series',
  'source-list': 'lists',
  list: 'lists',
  tag: 'tags',
};
const response = (data: unknown, status = 200): SandboxResponse => ({
  status,
  data,
  headers: { 'x-urm-provider-mode': 'sandbox' },
});
function object(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    if (value.length > 512 * 1024) throw new SandboxHttpError(413, 'Payload too large');
    value = JSON.parse(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new SandboxHttpError(400, 'Provider JSON object required');
  const serialized = JSON.stringify(value);
  if (serialized.length > 512 * 1024) throw new SandboxHttpError(413, 'Payload too large');
  return JSON.parse(serialized);
}
export function parseSandboxRoute(request: SandboxRequest): {
  url: URL;
  family: string;
  id?: string;
  streams: boolean;
  method: string;
} {
  let url: URL;
  try {
    url = new URL(request.url.trim());
  } catch {
    throw new SandboxHttpError(400, 'Invalid provider URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    /%2f|%5c/i.test(url.pathname)
  )
    throw new SandboxHttpError(400, 'Invalid provider URL');
  const method = request.method.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method))
    throw new SandboxHttpError(405, 'Unsupported sandbox method');
  if (request.params)
    for (const [key, value] of Object.entries(request.params)) {
      if (url.searchParams.has(key) || !['string', 'number', 'boolean'].includes(typeof value))
        throw new SandboxHttpError(400, 'Ambiguous query parameters');
      url.searchParams.set(key, String(value));
    }
  let family: string | undefined,
    id: string | undefined,
    streams = false;
  if (request.provider === 'subsplash' && url.hostname === 'core.subsplash.com') {
    for (const [base, candidate] of Object.entries(ROUTES)) {
      if (url.pathname === base) family = candidate;
      else if (url.pathname.startsWith(base + '/') && url.pathname.slice(base.length + 1).indexOf('/') < 0) {
        family = candidate;
        id = decodeURIComponent(url.pathname.slice(base.length + 1));
      }
    }
    if (
      method === 'PUT' ||
      (!id && ['PATCH', 'DELETE'].includes(method)) ||
      (id && method === 'POST') ||
      (family === 'jobs' && !['GET', 'POST'].includes(method))
    )
      throw new SandboxHttpError(405, 'Unsupported Subsplash method/path');
  } else if (request.provider === 'soundcloud' && url.hostname === 'api.soundcloud.com') {
    const match = /^\/tracks(?:\/([^/]+)(\/streams)?)?$/.exec(url.pathname);
    if (match) {
      family = 'tracks';
      id = match[1] ? decodeURIComponent(match[1]) : undefined;
      streams = Boolean(match[2]);
    }
    if (method === 'PATCH' || (streams && method !== 'GET') || (!id && method !== 'POST') || (id && method === 'POST'))
      throw new SandboxHttpError(405, 'Unsupported SoundCloud method/path');
  }
  if (!family || (id && (id.length > 256 || /[\s/?#]/.test(id))))
    throw new SandboxHttpError(404, 'Unsupported sandbox endpoint');
  if (request.provider === 'soundcloud' && id && !/^(?:soundcloud:tracks:)?[0-9]+$/.test(id))
    throw new SandboxHttpError(400, 'Invalid SoundCloud track identity');
  if (request.provider === 'soundcloud' && url.search) throw new SandboxHttpError(400, 'Unsupported SoundCloud query');
  const allowed = new Set([
    'filter[app_key]',
    'filter[source_list]',
    'filter[media_series]',
    'filter[status]',
    'filter[unlisted]',
    'filter[type]',
    'filter[tag.id]',
    'filter[title]',
    'filter[audio]',
    'filter[speaker]',
    'filter[generated]',
    'page[size]',
    'page[number]',
    'sort',
    'include',
  ]);
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) throw new SandboxHttpError(400, 'Unsupported or duplicate provider query');
    seen.add(key);
    if (key === 'filter[app_key]' && value !== APP)
      throw new SandboxHttpError(403, 'Unknown simulated Subsplash account');
    if (key === 'filter[generated]' && !['true', 'false'].includes(value))
      throw new SandboxHttpError(400, 'Invalid generated filter');
    if (key === 'filter[unlisted]' && value !== 'include')
      throw new SandboxHttpError(400, 'Unsupported unlisted filter');
    if (key.startsWith('page[') && (!/^[1-9][0-9]{0,5}$/.test(value) || (key === 'page[size]' && Number(value) > 200)))
      throw new SandboxHttpError(400, 'Invalid pagination');
    if (key === 'sort' && !/^-?(position|title|created_at|updated_at)$/.test(value))
      throw new SandboxHttpError(400, 'Unsupported sorting');
    if (
      key === 'include' &&
      value
        .split(',')
        .some(
          (part) =>
            ![
              'audio',
              'audio-outputs',
              'audio.audio-outputs',
              'images',
              'image',
              'media-series',
              'media-item',
              'list-rows',
              'display-options',
              'tags',
            ].includes(part)
        )
    )
      throw new SandboxHttpError(400, 'Unsupported include');
    const requiredFamily: Record<string, string[]> = {
      'filter[source_list]': ['list-rows'],
      'filter[media_series]': ['media-items'],
      'filter[tag.id]': ['taggings'],
      'filter[type]': ['tags', 'lists'],
      'filter[title]': ['tags'],
      'filter[audio]': ['media-items'],
      'filter[speaker]': ['media-items'],
      'filter[generated]': ['lists'],
    };
    if (requiredFamily[key] && !requiredFamily[key].includes(family))
      throw new SandboxHttpError(400, 'Filter unsupported for this family');
  }
  return {
    url,
    family,
    id: request.provider === 'soundcloud' ? id?.replace(/^soundcloud:tracks:/, '') : id,
    streams,
    method,
  };
}
const TRACK_CREATE_FIELDS = new Set([
  'title',
  'description',
  'tag_list',
  'sharing',
  'downloadable',
  'embeddable_by',
  'purchase_url',
  'purchase_title',
  'release',
  'release_day',
  'release_month',
  'release_year',
  'genre',
  'license',
  'commentable',
  'streamable',
  'label_name',
  'release_date',
  'reveal_stats',
  'reveal_comments',
  'isrc',
  'artist',
]);
function validateTrackMetadata(metadata: Record<string, unknown>, update = false): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !(update ? ['title', 'description', 'tag_list'].includes(key) : TRACK_CREATE_FIELDS.has(key)) ||
      !['string', 'boolean', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && value.length > 64000)
    )
      throw new SandboxHttpError(400, 'Unsupported track metadata');
  }
  if (metadata.sharing !== undefined && !['public', 'private'].includes(String(metadata.sharing)))
    throw new SandboxHttpError(400, 'Invalid track sharing');
}
function fresh(
  provider: 'subsplash' | 'soundcloud',
  family: string,
  id: string,
  body: Record<string, any>,
  now: number
): SandboxResource {
  return {
    schemaVersion: 1,
    provider,
    family,
    id,
    revision: 1,
    deleted: false,
    body: { ...body, id, ...(provider === 'subsplash' ? { app_key: APP } : {}) },
    createdAtMillis: now,
    updatedAtMillis: now,
  };
}
async function newSubsplashId(store: SandboxTransaction, family: string): Promise<string> {
  const id = randomUUID();
  if (await store.hasIdentity('subsplash', family, id))
    throw new SandboxHttpError(409, 'Sandbox resource identity collision');
  return id;
}
function updated(resource: SandboxResource, body: Record<string, any>, now: number): SandboxResource {
  return { ...resource, body, revision: resource.revision + 1, updatedAtMillis: now };
}
async function validateRelations(store: SandboxTransaction, body: Record<string, any>): Promise<void> {
  if (body.app_key !== undefined && body.app_key !== APP)
    throw new SandboxHttpError(403, 'Invalid simulated app account');
  if (!body._embedded) return;
  for (const [relation, refs] of Object.entries(body._embedded)) {
    const family = FAMILY_RELATIONS[relation];
    if (!family) continue;
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      if (ref === null) continue;
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string')
        throw new SandboxHttpError(400, 'Invalid provider relation');
      await store.get('subsplash', family, ref.id);
    }
  }
}
function allocationUrl(profile: SandboxStoreProfile, id: string): string {
  return `https://provider-sandbox.invalid/${profile.profileId}/upload/${id}`;
}
function mediaUrl(profile: SandboxStoreProfile, family: string, id: string): string {
  return `https://provider-sandbox.invalid/${profile.profileId}/media/${family}/${id}`;
}
async function presented(
  store: SandboxTransaction,
  profile: SandboxStoreProfile,
  resource: SandboxResource
): Promise<Record<string, any>> {
  const body = JSON.parse(JSON.stringify(resource.body));
  if (resource.family === 'audios') {
    body._embedded = {
      ...body._embedded,
      'audio-outputs':
        resource.source &&
        typeof resource.source.durationSeconds === 'number' &&
        resource.source.durationSeconds > 0 &&
        store.now >= (resource.readyAtMillis ?? 0)
          ? [
              {
                uploaded_at: new Date(resource.updatedAtMillis).toISOString(),
                file_size: resource.source.size,
                duration: resource.source.durationSeconds,
                content_type: resource.source.contentType,
                _links: { download: { href: mediaUrl(profile, 'audios', resource.id) } },
              },
            ]
          : [],
    };
  }
  if (resource.family === 'jobs') body.status = store.now >= (resource.readyAtMillis ?? 0) ? 'complete' : 'processing';
  if (resource.family === 'tracks') {
    const encoded = Boolean(resource.source && store.now >= (resource.readyAtMillis ?? 0));
    body.streamable = body.streamable !== false && encoded;
    body.state = encoded ? 'finished' : 'processing';
  }
  if (resource.family === 'lists') {
    const rows = (await store.list('subsplash', 'list-rows', { 'body._embedded.source-list.id': resource.id }))
      .filter((row) => row.body._embedded?.['source-list']?.id === resource.id)
      .sort((a, b) => Number(a.body.position) - Number(b.body.position));
    body.list_rows_count = rows.length;
    body.max_item_count = 200;
    body._embedded = { ...body._embedded, 'list-rows': rows.map((row) => row.body) };
  }
  return body;
}
async function patchRows(store: SandboxTransaction, list: SandboxResource, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length > 200) throw new SandboxHttpError(422, 'List exceeds 200 rows');
  const previous = (await store.list('subsplash', 'list-rows', { 'body._embedded.source-list.id': list.id })).filter(
    (row) => row.body._embedded?.['source-list']?.id === list.id
  );
  const retained = new Set<string>(),
    positions = new Set<number>();
  for (const input of rows) {
    const row = object(input),
      existing = row.id ? await store.get('subsplash', 'list-rows', row.id) : undefined;
    if (existing && existing.body._embedded?.['source-list']?.id !== list.id)
      throw new SandboxHttpError(409, 'Row belongs to another list');
    if (!Number.isInteger(row.position) || row.position < 1 || positions.has(row.position))
      throw new SandboxHttpError(400, 'Invalid row ordering');
    positions.add(row.position);
    const body = {
      ...(existing?.body ?? {}),
      ...row,
      _embedded: { ...(existing?.body._embedded ?? {}), ...(row._embedded ?? {}), 'source-list': { id: list.id } },
    };
    await validateRelations(store, body);
    const id = existing?.id ?? (await newSubsplashId(store, 'list-rows'));
    if (retained.has(id)) throw new SandboxHttpError(409, 'Duplicate row identity');
    retained.add(id);
    store.put(
      existing ? updated(existing, { ...body, id }, store.now) : fresh('subsplash', 'list-rows', id, body, store.now)
    );
  }
  for (const old of previous)
    if (!retained.has(old.id)) store.put({ ...updated(old, old.body, store.now), deleted: true });
}
async function syncMediaTaggings(store: SandboxTransaction, media: SandboxResource): Promise<void> {
  const previous = (await store.list('subsplash', 'taggings', { 'body._embedded.media-item.id': media.id })).filter(
    (row) => row.body._embedded?.['media-item']?.id === media.id
  );
  const desired = new Set<string>();
  if (!media.deleted && media.body.tags !== undefined) {
    if (
      !Array.isArray(media.body.tags) ||
      media.body.tags.length > 32 ||
      media.body.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 512)
    )
      throw new SandboxHttpError(400, 'Invalid media tags');
    const catalog = await store.list('subsplash', 'tags');
    for (const label of media.body.tags as string[]) {
      const colon = label.indexOf(':'),
        type = colon < 0 ? 'topic' : label.slice(0, colon),
        title = colon < 0 ? label : label.slice(colon + 1);
      if (!['topic', 'speaker'].includes(type) || !title) throw new SandboxHttpError(400, 'Unsupported media tag');
      let tag = catalog.find((item) => item.body.type === type && item.body.title === title);
      if (!tag) {
        tag = fresh('subsplash', 'tags', await newSubsplashId(store, 'tags'), { type, title }, store.now);
        catalog.push(tag);
        store.put(tag);
      }
      const existing = previous.find((row) => row.body._embedded?.tag?.id === tag!.id);
      const taggingId = existing?.id ?? (await newSubsplashId(store, 'taggings'));
      desired.add(taggingId);
      if (!existing)
        store.put(
          fresh(
            'subsplash',
            'taggings',
            taggingId,
            {
              created_at: new Date(store.now).toISOString(),
              _embedded: { tag: { id: tag.id }, 'media-item': media.body },
            },
            store.now
          )
        );
      else
        store.put(
          updated(
            existing,
            { ...existing.body, _embedded: { ...existing.body._embedded, 'media-item': media.body } },
            store.now
          )
        );
    }
  } else if (!media.deleted) return;
  for (const row of previous)
    if (!desired.has(row.id)) store.put({ ...updated(row, row.body, store.now), deleted: true });
}
function matches(resource: SandboxResource, query: URLSearchParams): boolean {
  const body = resource.body;
  for (const [key, value] of query) {
    if (key === 'filter[source_list]' && body._embedded?.['source-list']?.id !== value) return false;
    if (key === 'filter[media_series]' && body._embedded?.['media-series']?.id !== value) return false;
    if (key === 'filter[tag.id]' && body._embedded?.tag?.id !== value) return false;
    if (key === 'filter[status]' && body.status !== value) return false;
    if (key === 'filter[type]' && body.type !== value) return false;
    if (key === 'filter[title]' && body.title !== value) return false;
    if (key === 'filter[audio]' && body._embedded?.audio?.id !== value) return false;
    if (key === 'filter[speaker]' && (!Array.isArray(body.tags) || !body.tags.includes('speaker:' + value)))
      return false;
    if (key === 'filter[generated]' && String(body.generated ?? false) !== value) return false;
  }
  return true;
}
export async function handleSandboxRequest(
  profile: SandboxStoreProfile,
  request: SandboxRequest
): Promise<SandboxResponse> {
  const route = parseSandboxRoute(request),
    { method, family, id, url } = route;
  if (!['GET', 'HEAD'].includes(method)) await assertSandboxAssetPreparation(profile, request.context);
  let source: SandboxAssetEvidence | undefined, origin: SandboxAssetEvidence | undefined;
  if (request.provider === 'subsplash' && family === 'jobs' && method === 'POST') {
    const payload = object(request.data);
    if (typeof payload.file_name !== 'string') throw new SandboxHttpError(400, 'Transcode source is required');
    source = await inspectStageAsset(profile, await resolveStageAsset(profile, payload.file_name));
    if (!/^audio\//.test(source.contentType)) throw new SandboxHttpError(415, 'Transcode source must be staging audio');
    if (!source.durationSeconds)
      throw new SandboxHttpError(
        422,
        'Processed staging audio requires measured duration metadata tied to its object generation'
      );
    origin = source;
    source = await copyStageAssetToSandbox(profile, origin, request.context);
  }
  return runSandboxOperation(
    profile,
    { provider: request.provider, method, path: url.pathname, context: request.context },
    async (store, fault) => {
      if (request.provider === 'soundcloud') {
        if (!id) throw new SandboxHttpError(400, 'SoundCloud creation requires structured staged assets');
        const track = (await store.get('soundcloud', 'tracks', id))!;
        if (method === 'GET') {
          const body = await presented(store, profile, track);
          if (route.streams)
            return response(
              track.source && store.now >= (track.readyAtMillis ?? 0)
                ? { hls_aac_160_url: mediaUrl(profile, 'tracks', id) }
                : {}
            );
          return response(body);
        }
        if (method === 'DELETE') {
          store.put({ ...updated(track, track.body, store.now), deleted: true });
          return response(undefined, 204);
        }
        const input = object(request.data),
          metadata = object(input.track);
        validateTrackMetadata(metadata, true);
        const body = {
          ...track.body,
          ...metadata,
          id: track.id,
          user: track.body.user,
          urn: track.body.urn,
          permalink_url: track.body.permalink_url,
        };
        store.put(updated(track, body, store.now));
        return response(body);
      }
      if (method === 'GET' && !id) {
        const indexedKeys: Record<string, string> = {
          'filter[source_list]': 'body._embedded.source-list.id',
          'filter[media_series]': 'body._embedded.media-series.id',
          'filter[audio]': 'body._embedded.audio.id',
          'filter[tag.id]': 'body._embedded.tag.id',
          'filter[type]': 'body.type',
          'filter[status]': 'body.status',
        };
        const indexedFilters = Object.fromEntries(
          [...url.searchParams].filter(([key]) => indexedKeys[key]).map(([key, value]) => [indexedKeys[key], value])
        );
        let rows = (await store.list('subsplash', family, indexedFilters)).filter((item) =>
          matches(item, url.searchParams)
        );
        const sort = url.searchParams.get('sort') ?? 'created_at',
          descending = sort.startsWith('-'),
          field = sort.replace(/^-/, '');
        rows.sort((a, b) => {
          const left = field === 'created_at' ? a.createdAtMillis : a.body[field] ?? '',
            right = field === 'created_at' ? b.createdAtMillis : b.body[field] ?? '';
          return (
            (typeof left === 'number' && typeof right === 'number'
              ? left - right
              : String(left).localeCompare(String(right))) * (descending ? -1 : 1) || a.id.localeCompare(b.id)
          );
        });
        const total = rows.length,
          pageSize = Number(url.searchParams.get('page[size]') ?? 100),
          page = Number(url.searchParams.get('page[number]') ?? 1);
        rows = rows.slice((page - 1) * pageSize, page * pageSize);
        const items = await Promise.all(rows.map((row) => presented(store, profile, row)));
        const next = new URL(url);
        next.searchParams.set('page[number]', String(page + 1));
        return response({
          total,
          count: items.length,
          _embedded: { [family]: items },
          _links: { self: { href: url.href }, ...(page * pageSize < total ? { next: { href: next.href } } : {}) },
        });
      }
      if (method === 'GET')
        return response(await presented(store, profile, (await store.get('subsplash', family, id!))!));
      if (method === 'DELETE') {
        const existing = (await store.get('subsplash', family, id!))!;
        const tombstone = { ...updated(existing, existing.body, store.now), deleted: true };
        if (family === 'media-items') await syncMediaTaggings(store, tombstone);
        store.put(tombstone);
        return response(undefined, 204);
      }
      const payload = object(request.data);
      if (payload.id !== undefined && payload.id !== id)
        throw new SandboxHttpError(409, 'Provider resource identity mismatch');
      if (method === 'POST') {
        const newId = await newSubsplashId(store, family);
        await validateRelations(store, payload);
        const record = fresh('subsplash', family, newId, payload, store.now);
        if (family === 'images') record.body._links = { presigned_upload_url: { href: allocationUrl(profile, newId) } };
        if (family === 'lists') {
          record.body.max_item_count = 200;
          record.body._embedded = { ...record.body._embedded, 'list-rows': [] };
        }
        if (family === 'media-items') {
          record.body.status ??= payload.auto_publish ? 'published' : 'draft';
          record.body.position ??= 1;
        }
        if (family === 'jobs') {
          const audioId = payload._embedded?.audio?.id;
          const audio = (await store.get('subsplash', 'audios', audioId))!;
          const readyAtMillis = store.now + delay(fault);
          record.source = source;
          record.origin = origin;
          record.readyAtMillis = readyAtMillis;
          record.body.status = 'processing';
          store.put({ ...updated(audio, audio.body, store.now), source, origin, readyAtMillis });
        }
        if (family === 'media-items') await syncMediaTaggings(store, record);
        store.put(record);
        return response(await presented(store, profile, record), 201);
      }
      const existing = (await store.get('subsplash', family, id!))!;
      await validateRelations(store, payload);
      if (family === 'media-series' && payload._embedded?.['media-items'] !== undefined) {
        const items = payload._embedded['media-items'];
        if (!Array.isArray(items) || items.length > 200)
          throw new SandboxHttpError(422, 'Series reorder exceeds bounded capacity');
        const seen = new Set<string>();
        for (const item of items) {
          if (
            !item ||
            typeof item.id !== 'string' ||
            seen.has(item.id) ||
            (item.position !== null && (!Number.isInteger(item.position) || item.position < 1))
          )
            throw new SandboxHttpError(400, 'Invalid series ordering');
          seen.add(item.id);
          const media = (await store.get('subsplash', 'media-items', item.id))!;
          if (media.body._embedded?.['media-series']?.id !== id)
            throw new SandboxHttpError(409, 'Media item belongs to another series');
          store.put(updated(media, { ...media.body, position: item.position }, store.now));
        }
      }
      if (family === 'lists' && payload._embedded?.['list-rows'] !== undefined)
        await patchRows(store, existing, payload._embedded['list-rows']);
      const body = {
        ...existing.body,
        ...payload,
        id: existing.id,
        app_key: APP,
        _embedded: { ...existing.body._embedded, ...payload._embedded },
      };
      const replacement = updated(existing, body, store.now);
      if (family === 'media-items') await syncMediaTaggings(store, replacement);
      store.put(replacement);
      return response(await presented(store, profile, replacement));
    }
  );
}
function stageAssetUrl(asset: StageAssetRef): string {
  return `https://storage.googleapis.com/${asset.bucket}/${asset.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?generation=${asset.generation}`;
}
function delay(fault?: SandboxFaultPlan): number {
  return fault?.fault === 'delayed-processing' ? Math.min(Math.max(fault.delayMillis ?? 15_000, 1_000), 120_000) : 500;
}
export async function createSandboxSoundCloudTrack(
  profile: SandboxStoreProfile,
  input: { trackId?: string; metadata: Record<string, unknown>; audio?: StageAssetRef; artwork?: StageAssetRef },
  context?: SandboxRequestContext
): Promise<SandboxResponse> {
  await assertSandboxAssetPreparation(profile, context);
  const metadata = object(input.metadata);
  validateTrackMetadata(metadata);
  if (!input.audio) throw new SandboxHttpError(400, 'An exact staging audio asset is required');
  const originalAudio = await inspectStageAsset(profile, input.audio);
  if (!/^audio\//.test(originalAudio.contentType)) throw new SandboxHttpError(415, 'SoundCloud source must be audio');
  const audio = await copyStageAssetToSandbox(profile, originalAudio, context);
  const artworkOrigin = input.artwork ? await inspectStageAsset(profile, input.artwork, 32 * 1024 * 1024) : undefined;
  if (artworkOrigin && !/^image\//.test(artworkOrigin.contentType))
    throw new SandboxHttpError(415, 'Artwork must be an image');
  const artwork = artworkOrigin ? await copyStageAssetToSandbox(profile, artworkOrigin, context) : undefined;
  return runSandboxOperation(
    profile,
    { provider: 'soundcloud', method: 'POST', path: '/tracks', context },
    async (store, fault) => {
      const id = String(8_000_000_000_000 + Number(BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 10))));
      if (await store.hasIdentity('soundcloud', 'tracks', id))
        throw new SandboxHttpError(409, 'Sandbox identifier collision');
      // Account identity is scoped to this sandbox catalog, never a production OAuth identity.
      const accounts = await store.list('soundcloud', 'accounts');
      if (accounts.length !== 1) throw new SandboxHttpError(409, 'Sandbox SoundCloud account catalog is incomplete');
      const body = {
        ...metadata,
        id,
        id_str: id,
        urn: `soundcloud:tracks:${id}`,
        user: accounts[0].body,
        ...(context?.jobId
          ? {
              permalink_url: `https://staging.uploader.upperroommedia.org/admin/simulation/${encodeURIComponent(
                context.jobId
              )}`,
            }
          : {}),
        ...(metadata.artist !== undefined ? { metadata_artist: metadata.artist } : {}),
        ...(artwork ? { artwork, artwork_url: stageAssetUrl(artwork) } : {}),
      };
      const resource = {
        ...fresh('soundcloud', 'tracks', id, body, store.now),
        source: audio,
        origin: originalAudio,
        readyAtMillis: store.now + delay(fault),
      };
      store.put(resource);
      return response(await presented(store, profile, resource), 201);
    }
  );
}
export async function updateSandboxSoundCloudTrack(
  profile: SandboxStoreProfile,
  input: { trackId?: string; metadata: Record<string, unknown>; audio?: StageAssetRef; artwork?: StageAssetRef },
  context?: SandboxRequestContext
): Promise<SandboxResponse> {
  await assertSandboxAssetPreparation(profile, context);
  if (!input.trackId || input.audio)
    throw new SandboxHttpError(400, 'Track update requires an identity and cannot replace audio');
  const metadata = object(input.metadata);
  validateTrackMetadata(metadata, true);
  const id = input.trackId.replace(/^soundcloud:tracks:/, '');
  if (!/^[0-9]+$/.test(id)) throw new SandboxHttpError(400, 'Invalid SoundCloud track identity');
  const artworkOrigin = input.artwork ? await inspectStageAsset(profile, input.artwork, 32 * 1024 * 1024) : undefined;
  if (artworkOrigin && !/^image\//.test(artworkOrigin.contentType))
    throw new SandboxHttpError(415, 'Artwork must be image media');
  const artwork = artworkOrigin ? await copyStageAssetToSandbox(profile, artworkOrigin, context) : undefined;
  return runSandboxOperation(
    profile,
    { provider: 'soundcloud', method: 'PUT', path: `/tracks/${encodeURIComponent(input.trackId)}`, context },
    async (store) => {
      const existing = (await store.get('soundcloud', 'tracks', id))!;
      const replacement = updated(
        existing,
        { ...existing.body, ...metadata, ...(artwork ? { artwork, artwork_url: stageAssetUrl(artwork) } : {}) },
        store.now
      );
      store.put(replacement);
      return response(await presented(store, profile, replacement));
    }
  );
}
export async function uploadSandboxAllocation(
  profile: SandboxStoreProfile,
  urlString: string,
  bytes: AsyncIterable<Uint8Array>,
  options: { contentType: string; contentLength?: number; maxBytes?: number },
  context?: SandboxRequestContext
): Promise<SandboxResponse> {
  await assertSandboxAssetPreparation(profile, context);
  const url = new URL(urlString),
    match = /^\/([^/]+)\/upload\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (
    url.username ||
    url.password ||
    url.origin !== 'https://provider-sandbox.invalid' ||
    url.search ||
    url.hash ||
    !match ||
    match[1] !== profile.profileId
  )
    throw new SandboxHttpError(400, 'Invalid virtual upload allocation');
  // Validate ownership before accepting bytes. Completion is separately revision fenced after the stream finishes.
  const expected = await runSandboxOperation(
    profile,
    { provider: 'subsplash', method: 'GET', path: `/files/v1/images/${match[2]}` },
    async (store) => (await store.get('subsplash', 'images', match[2]))!
  );
  if (expected.body.content_type && expected.body.content_type !== options.contentType)
    throw new SandboxHttpError(415, 'Allocation content type mismatch');
  if (expected.source) throw new SandboxHttpError(409, 'Image allocation is already completed');
  const evidence = await writeSandboxAllocation(profile, match[2], bytes, options, context);
  return runSandboxOperation(
    profile,
    { provider: 'subsplash', method: 'PUT', path: url.pathname, context },
    async (store) => {
      const current = (await store.get('subsplash', 'images', match[2]))!;
      if (current.revision !== expected.revision || current.source)
        throw new SandboxHttpError(409, 'Allocation changed during upload');
      const body = {
        ...current.body,
        uploaded_at: new Date(store.now).toISOString(),
        file_size: evidence.size,
        _links: { ...current.body._links, download: { href: mediaUrl(profile, 'images', current.id) } },
      };
      store.put({ ...updated(current, body, store.now), source: evidence });
      return response(undefined, 200);
    }
  );
}
export async function probeSandboxMedia(
  profile: SandboxStoreProfile,
  urlString: string,
  options: { maxBytes: number },
  _context?: SandboxRequestContext
): Promise<{ ok: boolean; contentType: string; size: number; sha256: string }> {
  const url = new URL(urlString),
    match = /^\/([^/]+)\/media\/(audios|images|tracks)\/([^/]+)$/.exec(url.pathname);
  if (
    url.username ||
    url.password ||
    url.origin !== 'https://provider-sandbox.invalid' ||
    url.search ||
    url.hash ||
    !match ||
    match[1] !== profile.profileId
  )
    throw new SandboxHttpError(400, 'Invalid virtual media URL');
  const resource = await runSandboxOperation(
    profile,
    { provider: match[2] === 'tracks' ? 'soundcloud' : 'subsplash', method: 'GET', path: url.pathname },
    async (store) => {
      const current = (await store.get(
        match[2] === 'tracks' ? 'soundcloud' : 'subsplash',
        match[2],
        decodeURIComponent(match[3])
      ))!;
      if (!current.source || store.now < (current.readyAtMillis ?? 0))
        throw new SandboxHttpError(409, 'Media is still processing');
      return current;
    }
  );
  return probeStageAsset(profile, resource.source!, options.maxBytes);
}
/** Request-shape digest is diagnostic only; it is never provider idempotency authority. */
export const sandboxRequestDigest = (request: Pick<SandboxRequest, 'provider' | 'method' | 'url'>): string =>
  createHash('sha256').update(JSON.stringify(request)).digest('hex');

/** Read-only evidence for an authenticated staging administrator. Never authorizes a receipt or mutation. */
export async function inspectSandboxJob(
  profile: SandboxStoreProfile,
  jobId: string
): Promise<import('./types').SandboxJobInspection> {
  const { default: admin } = await import('@upperroom/shared/firebase/firebaseAdmin');
  const { sandboxRoot, sandboxResourceKey } = await import('./store');
  const profileModule = await import('./profile');
  const assertMatchingSandboxProfile: typeof import('./profile').assertMatchingSandboxProfile =
    profileModule.assertMatchingSandboxProfile;
  const assertSandboxCatalogReady = profileModule.assertSandboxCatalogReady;
  const { DURABLE_COLLECTIONS } = await import('@upperroom/orchestration/job-store');
  if (!jobId || jobId.length > 256 || /[\s/?#]/.test(jobId)) throw new SandboxHttpError(400, 'Invalid sandbox job');
  const db = admin.firestore(),
    root = sandboxRoot(profile);
  return db.runTransaction(async (tx) => {
    const [marker, intentSnap, jobSnap, requestRows] = await Promise.all([
      tx.get(root),
      tx.get(db.collection(DURABLE_COLLECTIONS.intents).doc(jobId)),
      tx.get(db.collection(DURABLE_COLLECTIONS.jobs).doc(jobId)),
      tx.get(root.collection('requests').where('jobId', '==', jobId).limit(101)),
    ]);
    assertSandboxCatalogReady(profile, marker.data());
    const intent = intentSnap.data(),
      job = jobSnap.data();
    if (
      !intent ||
      !job ||
      intent.projectId !== profile.projectId ||
      job.projectId !== profile.projectId ||
      intent.jobId !== jobId ||
      job.jobId !== jobId ||
      intent.generation !== job.generation
    )
      throw new SandboxHttpError(404, 'Sandbox job provenance is unavailable');
    assertMatchingSandboxProfile(profile, intent.payload?.providerExecution);
    assertMatchingSandboxProfile(profile, job.providerExecution);
    if (intent.payload.providerExecution.scenario !== job.providerExecution.scenario)
      throw new SandboxHttpError(409, 'Sandbox job provenance changed');
    const referenceMap = new Map<string, { provider: 'subsplash' | 'soundcloud'; family: string; id: string }>();
    let resourceTruncated = false,
      referenceBudget = 200;
    const records = requestRows.docs.slice(0, 100).map((doc) => {
      const row = doc.data();
      if (
        row.schemaVersion !== 1 ||
        row.profileId !== profile.profileId ||
        row.jobId !== jobId ||
        !['subsplash', 'soundcloud'].includes(row.provider) ||
        !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(row.method) ||
        !Number.isSafeInteger(row.atMillis) ||
        !['acknowledged', 'rejected-before-effect', 'committed-response-lost'].includes(row.outcome) ||
        ![
          'success',
          'delayed-processing',
          'transient-failure',
          'permanent-failure',
          'commit-then-lost-response',
        ].includes(row.fault) ||
        !Array.isArray(row.resources)
      )
        throw new SandboxHttpError(409, 'Sandbox request journal is malformed');
      const keys: string[] = [];
      for (const ref of row.resources) {
        if (
          !['subsplash', 'soundcloud'].includes(ref.provider) ||
          !Object.values(ROUTES).concat(['tracks', 'accounts']).includes(ref.family) ||
          typeof ref.id !== 'string' ||
          !ref.id ||
          ref.id.length > 256 ||
          /[\s/?#]/.test(ref.id)
        )
          throw new SandboxHttpError(409, 'Sandbox request resource is malformed');
        if (referenceBudget === 0) {
          resourceTruncated = true;
          continue;
        }
        const key = sandboxResourceKey(ref.provider, ref.family, ref.id);
        referenceBudget -= 1;
        referenceMap.set(key, { provider: ref.provider, family: ref.family, id: ref.id });
        keys.push(key);
      }
      return {
        provider: row.provider as 'subsplash' | 'soundcloud',
        method: row.method as string,
        atMillis: row.atMillis as number,
        outcome: row.outcome as string,
        fault: row.fault as import('./types').SandboxFault,
        keys,
      };
    });
    const resources = new Map<string, import('./types').SandboxInspectedResource>();
    const entries = [...referenceMap.entries()];
    if (entries.length) {
      const snapshots = await tx.getAll(...entries.map(([key]) => root.collection('resources').doc(key)));
      for (let index = 0; index < entries.length; index += 1) {
        const [key, identity] = entries[index],
          data = snapshots[index].data() as SandboxResource | undefined;
        if (
          !data ||
          data.schemaVersion !== 1 ||
          data.provider !== identity.provider ||
          data.family !== identity.family ||
          data.id !== identity.id ||
          typeof data.deleted !== 'boolean'
        )
          throw new SandboxHttpError(409, 'Sandbox resource evidence is unavailable');
        resources.set(key, {
          ...identity,
          deleted: data.deleted,
          ...(typeof data.body.title === 'string' ? { title: data.body.title.slice(0, 128) } : {}),
          ...(typeof data.readyAtMillis === 'number' && Number.isSafeInteger(data.readyAtMillis)
            ? { readyAtMillis: data.readyAtMillis }
            : {}),
        });
      }
    }
    const result: import('./types').SandboxJobInspection = {
      profileId: profile.profileId,
      jobId,
      providerExecution: {
        mode: 'sandbox',
        profileId: profile.profileId,
        version: 1,
        scenario: job.providerExecution.scenario,
      },
      requests: records
        .sort((a, b) => a.atMillis - b.atMillis)
        .map(({ keys, ...row }) => ({ ...row, resourceRefs: keys.map((key) => resources.get(key)!) })),
      resources: [...resources.values()],
      truncated: { requests: requestRows.size > 100, resources: resourceTruncated },
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024)
      throw new SandboxHttpError(422, 'Sandbox inspection exceeds bounded response size');
    return result;
  });
}
