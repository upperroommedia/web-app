import type {
  SubsplashListRow,
  SubsplashListRowEmbedded,
  SubsplashMediaType,
  SubsplashListRowMethod,
} from '../types/Subsplash';

const types = new Set<SubsplashMediaType>([
  'media-item',
  'media-series',
  'song',
  'link',
  'rss',
  'list',
  'album',
  'calendar',
  'event',
]);
const methods = new Set<SubsplashListRowMethod>(['static', 'most_recent', 'next_upcoming']);
const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/?#]/.test(value) ? value : undefined;
const invalid = (): never => {
  throw new Error('SUBSPLASH_MUTATION_ACK_INVALID');
};
export type SubsplashListPatchAck = { _embedded: { 'list-rows': SubsplashListRow[] } } | null;

/** The response is a mutation receipt, not a content cache. Keep only the fields
 * consumers need to resolve row identity and placement before persisting the ACK.
 */
export function normalizeSubsplashListPatchAck(raw: unknown, listId: string): SubsplashListPatchAck {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (raw as { _embedded?: { 'list-rows'?: unknown } })._embedded?.['list-rows'];
  if (!Array.isArray(rows)) return null;
  if (rows.length > 200 || !identifier(listId)) return invalid();
  const normalizedRows = rows.map((rawRow): SubsplashListRow => {
    if (!rawRow || typeof rawRow !== 'object') return invalid();
    const row = rawRow as Record<string, unknown>;
    const id = identifier(row.id);
    const type = row.type as SubsplashMediaType;
    const method = row.method as SubsplashListRowMethod;
    if (
      !id ||
      !types.has(type) ||
      !methods.has(method) ||
      row.app_key !== '9XTSHD' ||
      typeof row.position !== 'number' ||
      !Number.isSafeInteger(row.position) ||
      row.position < 1
    )
      return invalid();
    const embedded = row._embedded as Record<string, unknown> | undefined;
    const resource = embedded?.[type] as { id?: unknown } | undefined;
    const source = embedded?.['source-list'] as { id?: unknown } | undefined;
    const resourceId = identifier(resource?.id);
    const sourceId = identifier(source?.id);
    if (!resourceId || !sourceId) return invalid();
    const refs: SubsplashListRowEmbedded = { 'source-list': { id: sourceId }, [type]: { id: resourceId } };
    return { id, type, position: row.position, method, app_key: '9XTSHD', _embedded: refs };
  });
  const result: SubsplashListPatchAck = { _embedded: { 'list-rows': normalizedRows } };
  // Leave headroom for the private fact's scope, target, fingerprint and bookkeeping.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 96 * 1024) return invalid();
  return result;
}
