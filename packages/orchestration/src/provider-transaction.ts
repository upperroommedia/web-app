import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  prepareProviderUsageChanges,
  type ProviderUsageChange,
  type ProviderUsageReservedProjectionAuthority,
} from './provider-usage';

type Ref = Parameters<Transaction['delete']>[0];
type Data = Record<string, unknown>;
interface Write {
  ref: Ref;
  method: 'set' | 'create' | 'update' | 'delete';
  args: unknown[];
}
const indexed = (path: string) =>
  path
    .split('/')
    .some(
      (part, index) =>
        index % 2 === 0 &&
        [
          'sermons',
          'lists',
          'series',
          'speakers',
          'images',
          'listItems',
          'sermonLists',
          'seriesItems',
          'durableJobIntents',
        ].includes(part)
    );
const removed = Symbol('provider-projection-removed-field');
const referenceKey =
  /^(?:subsplashId|subsplashAudioId|subsplashListId|subsplashSeriesId|sermonSubsplashId|moreSermonsRef|manualOverflowTargetSubsplashId|tagId|soundCloudTrackId|images|id)$/;
function plain(value: unknown): value is Data {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function concrete(value: unknown, key: string, before: unknown): unknown {
  if (value instanceof FieldValue) {
    if (value.isEqual(FieldValue.delete())) return removed;
    if (key.split('.').some((part) => referenceKey.test(part)) || !value.isEqual(FieldValue.serverTimestamp()))
      throw new Error('PROVIDER_REFERENCE_TRANSFORM_REQUIRES_CONCRETE_VALUE');
    // Only a publicly recognizable timestamp transform cannot hide new nested resource IDs.
    return before;
  }
  if (Array.isArray(value)) return value.map((item) => concrete(item, key, undefined));
  if (plain(value))
    return Object.fromEntries(
      Object.entries(value)
        .map(([child, item]) => [child, concrete(item, `${key}.${child}`, plain(before) ? before[child] : undefined)])
        .filter(([, item]) => item !== removed)
    );
  return clone(value);
}
function merge(before: Data, patch: Data): Data {
  const next = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    const projected =
      plain(value) && plain(next[key]) ? merge(next[key] as Data, value) : concrete(value, key, next[key]);
    if (projected === removed) delete next[key];
    else next[key] = projected;
  }
  return next;
}
function assignPath(target: Data, path: string, value: unknown): void {
  const parts = path.split('.');
  if (parts.some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)))
    throw new Error('PROVIDER_REFERENCE_FIELD_PATH_INVALID');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = plain(cursor[part]) ? { ...(cursor[part] as Data) } : {};
    cursor = cursor[part] as Data;
  }
  const key = parts.at(-1)!;
  const projected = concrete(value, path, cursor[key]);
  if (projected === removed) delete cursor[key];
  else cursor[key] = projected;
}
function project(before: Data | undefined, write: Write): Data | undefined {
  if (write.method === 'delete') return undefined;
  const raw = write.args[0];
  if (!plain(raw)) throw new Error('PROVIDER_REFERENCE_WRITE_REQUIRES_PLAIN_DATA');
  if (write.method === 'update') {
    const next = clone(before ?? {}) as Data;
    for (const [path, value] of Object.entries(raw)) assignPath(next, path, value);
    return next;
  }
  const options = write.args[1] as { merge?: boolean; mergeFields?: unknown[] } | undefined;
  if (options?.mergeFields) {
    const next = clone(before ?? {}) as Data;
    for (const path of options.mergeFields) {
      if (typeof path !== 'string') throw new Error('PROVIDER_REFERENCE_WRITE_REQUIRES_STRING_FIELD_PATH');
      let value: unknown = raw;
      for (const part of path.split('.')) value = plain(value) ? value[part] : undefined;
      assignPath(next, path, value);
    }
    return next;
  }
  return options?.merge ? merge(before ?? {}, raw) : (concrete(raw, '', before) as Data);
}
/** Buffers PUBLIC transaction writes, reads concrete canonical before-images, and prepares a
 * single batched index mutation before flushing. No SDK private fields or write introspection.
 * Callback reads observe original Firestore state, as in a normal transaction. */
export async function withProviderIndexedTransaction<T>(
  tx: Transaction,
  db: Firestore,
  projectId: string,
  callback: (recording: Transaction) => Promise<T>,
  options: {
    excludeCanonicalPaths?: readonly string[];
    reservedProjection?: ProviderUsageReservedProjectionAuthority;
    beforeCommit?: (tx: Transaction) => Promise<void>;
  } = {}
): Promise<T> {
  const writes: Write[] = [];
  let recording: Transaction;
  const record = (method: Write['method'], ref: Ref, args: unknown[]) => {
    if (method === 'update' && typeof args[0] === 'string') {
      if (args.length % 2) throw new Error('PROVIDER_REFERENCE_UPDATE_ARGUMENTS_INVALID');
      const data: Data = {};
      for (let index = 0; index < args.length; index += 2) {
        if (typeof args[index] !== 'string') throw new Error('PROVIDER_REFERENCE_WRITE_REQUIRES_STRING_FIELD_PATH');
        data[args[index] as string] = args[index + 1];
      }
      writes.push({ method, ref, args: [clone(data)] });
    } else writes.push({ method, ref, args: args.map(clone) });
    return recording;
  };
  recording = {
    get: tx.get.bind(tx),
    getAll: tx.getAll.bind(tx),
    set: (ref: Ref, ...args: unknown[]) => record('set', ref, args),
    create: (ref: Ref, ...args: unknown[]) => record('create', ref, args),
    update: (ref: Ref, ...args: unknown[]) => record('update', ref, args),
    delete: (ref: Ref, ...args: unknown[]) => record('delete', ref, args),
  } as unknown as Transaction;
  const result = await callback(recording);
  const groups = new Map<string, { ref: Ref; writes: Write[] }>();
  for (const write of writes)
    if (indexed(write.ref.path) && !options.excludeCanonicalPaths?.includes(write.ref.path)) {
      const group = groups.get(write.ref.path) ?? { ref: write.ref, writes: [] };
      group.writes.push(write);
      groups.set(write.ref.path, group);
    }
  const changes: ProviderUsageChange[] = [];
  for (const [canonicalPath, group] of groups) {
    const before = (await tx.get(group.ref)).data() as Data | undefined;
    const after = group.writes.reduce((value, write) => project(value, write), before);
    changes.push({ projectId, canonicalPath, before, after });
  }
  const commitIndex = await prepareProviderUsageChanges(tx, db, changes, options.reservedProjection);
  await options.beforeCommit?.(tx);
  commitIndex();
  for (const write of writes) {
    const method = tx[write.method] as unknown as (ref: Ref, ...args: unknown[]) => unknown;
    method.call(tx, write.ref, ...write.args);
  }
  return result;
}
