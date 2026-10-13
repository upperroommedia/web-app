import { createHash } from 'node:crypto';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { PrivatePublishingIntent } from './types';
import type { PublishingEntityIntent } from './entityMutations';
import type { PublishingMutationPlan } from './durableOperationContext';
import type { ProviderMutationResource } from './providerMutationGuard';

type Data = Record<string, unknown>;
export interface MutationCanonicalDocument {
  path: string;
  id: string;
  data: Data;
}
/** An Admin-only reader. No provider lookups and no client supplied remote resource IDs. */
export interface MutationCanonicalReader {
  read(path: string): Promise<MutationCanonicalDocument | undefined>;
  collection(path: string): Promise<MutationCanonicalDocument[]>;
  find(collection: string, field: string, value: string): Promise<MutationCanonicalDocument[]>;
}
export interface ImmutableMutationResourcePlan extends PublishingMutationPlan {
  readonly graphFingerprint: string;
  readonly canonicalPaths: readonly string[];
}
interface SourceOptions {
  ref: DurableJobRef;
  db?: Firestore;
  reader?: MutationCanonicalReader;
  /** Server authenticated account, obtained with the actual mutation bearer token. */
  soundcloudAccount?: string;
}
const invalid = (reason: string): never => {
  throw new Error(reason);
};
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const identifier = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\s/?#]/.test(value))
    return invalid('PROVIDER_MUTATION_CANONICAL_ID_INVALID');
  return value;
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(identifier).filter((v): v is string => !!v) : [];
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if ('toMillis' in value && typeof value.toMillis === 'function') return value.toMillis();
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
};
const fingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

export function firestoreMutationCanonicalReader(db: Firestore): MutationCanonicalReader {
  const convert = (doc: QueryDocumentSnapshot): MutationCanonicalDocument => ({
    path: doc.ref.path,
    id: doc.id,
    data: doc.data(),
  });
  const all = async (query: Query): Promise<MutationCanonicalDocument[]> => {
    const result: MutationCanonicalDocument[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let next = query.orderBy('__name__').limit(400);
      if (cursor) next = next.startAfter(cursor);
      const page = await next.get();
      result.push(...page.docs.map(convert));
      if (page.size < 400) return result;
      cursor = page.docs[page.docs.length - 1];
    }
  };
  return {
    async read(path) {
      const doc = await db.doc(path).get();
      return doc.exists ? { path: doc.ref.path, id: doc.id, data: doc.data()! } : undefined;
    },
    collection: (path) => all(db.collection(path)),
    find: (path, field, value) => all(db.collection(path).where(field, '==', value)),
  };
}

class Graph {
  private readonly evidence = new Map<string, unknown>();
  private readonly documents = new Map<string, MutationCanonicalDocument | undefined>();
  private readonly resources = new Map<string, ProviderMutationResource>();
  private readonly expanded = new Set<string>();
  private readonly chains = new Map<string, Set<string>>();
  constructor(
    private readonly reader: MutationCanonicalReader,
    private readonly soundcloudAccount?: string,
    private readonly includeSoundCloud = false
  ) {}
  async read(path: string, required = true): Promise<MutationCanonicalDocument | undefined> {
    if (!this.documents.has(path)) {
      const doc = await this.reader.read(path);
      if (doc && (doc.path !== path || doc.id !== path.split('/').pop()))
        invalid('PROVIDER_MUTATION_CANONICAL_SCOPE_INVALID');
      this.documents.set(path, doc);
      this.evidence.set(path, doc?.data ?? null);
    }
    const doc = this.documents.get(path);
    if (!doc && required) invalid('PROVIDER_MUTATION_CANONICAL_DOCUMENT_MISSING');
    return doc;
  }
  async rows(path: string): Promise<MutationCanonicalDocument[]> {
    const docs = (await this.reader.collection(path)).sort((a, b) => a.path.localeCompare(b.path));
    for (const doc of docs) {
      if (doc.path !== `${path}/${doc.id}` || !identifier(doc.id)) invalid('PROVIDER_MUTATION_CANONICAL_SCOPE_INVALID');
      this.evidence.set(doc.path, doc.data);
    }
    // Membership evidence detects both deletion and insertion during post-acquisition revalidation.
    this.evidence.set(
      `query:${path}`,
      docs.map((doc) => doc.path)
    );
    return docs;
  }
  resource(type: string, value: unknown, soundcloud = false): void {
    const id = identifier(value);
    if (!id) return;
    const account = soundcloud ? this.soundcloudAccount : 'app:9XTSHD';
    if (!account || (soundcloud && !/^soundcloud:users:[A-Za-z0-9_-]+$/.test(account)))
      invalid('PROVIDER_MUTATION_AUTHENTICATED_ACCOUNT_REQUIRED');
    const resource: ProviderMutationResource = {
      provider: soundcloud ? 'soundcloud' : 'subsplash',
      account: account!,
      resourceType: type,
      resourceId: id,
    };
    this.resources.set(JSON.stringify([resource.provider, resource.account, id]), resource);
  }
  async assets(data: Data): Promise<void> {
    for (const image of Array.isArray(data.images) ? data.images : []) {
      const id = identifier(object(image).id);
      if (!id) invalid('PROVIDER_MUTATION_CANONICAL_IMAGE_REQUIRED');
      await this.read(`images/${id}`);
    }
    for (const speaker of Array.isArray(data.speakers) ? data.speakers : []) {
      const id = identifier(object(speaker).id);
      if (!id) invalid('PROVIDER_MUTATION_CANONICAL_SPEAKER_REQUIRED');
      await this.read(`speakers/${id}`);
    }
  }
  async sermon(id: string, target = true, soundcloudTarget = false, references = false): Promise<Data> {
    const doc = await this.read(`sermons/${id}`);
    const data = doc!.data;
    if (target) this.resource('media', data.subsplashId);
    if (this.includeSoundCloud && soundcloudTarget) this.resource('track', data.soundCloudTrackId, true);
    if (references) await this.assets(data);
    return data;
  }
  async list(id: string): Promise<void> {
    const selected = await this.read(`lists/${id}`);
    const rootId = identifier(selected!.data.rootListId) ?? id;
    if (this.expanded.has(`list:${rootId}`)) {
      if (!this.chains.get(rootId)?.has(id)) invalid('PROVIDER_MUTATION_OVERFLOW_SELECTED_UNREACHABLE');
      return;
    }
    this.expanded.add(`list:${rootId}`);
    let doc = await this.read(`lists/${rootId}`);
    const visited = new Set<string>();
    this.chains.set(rootId, visited);
    while (doc) {
      if (visited.has(doc.id)) invalid('PROVIDER_MUTATION_OVERFLOW_CYCLE');
      visited.add(doc.id);
      if (doc.id !== rootId && identifier(doc.data.rootListId) !== rootId)
        invalid('PROVIDER_MUTATION_OVERFLOW_ROOT_MISMATCH');
      this.resource('list', doc.data.subsplashId);
      // List rows reference media, but their PATCH target is the physical parent list.
      // Seal membership/order without exclusively locking every referenced sermon.
      await this.rows(`${doc.path}/listItems`);
      const next = identifier(doc.data.moreSermonsRef);
      if (!next) break;
      const matches = await this.reader.find('lists', 'subsplashId', next);
      this.evidence.set(
        `query:lists:subsplashId:${next}`,
        matches.map((match) => [match.path, match.data]).sort(([a], [b]) => String(a).localeCompare(String(b)))
      );
      if (matches.length !== 1 || matches[0].path !== `lists/${matches[0].id}`)
        invalid('PROVIDER_MUTATION_OVERFLOW_MAPPING_AMBIGUOUS');
      doc = await this.read(matches[0].path);
    }
    if (!visited.has(id)) invalid('PROVIDER_MUTATION_OVERFLOW_SELECTED_UNREACHABLE');
  }
  async series(id: string, mutateMedia = true): Promise<void> {
    if (this.expanded.has(`series:${id}`)) return;
    this.expanded.add(`series:${id}`);
    const doc = await this.read(`series/${id}`);
    this.resource('series', doc!.data.subsplashId);
    if (!mutateMedia) return;
    for (const row of await this.rows(`series/${id}/seriesItems`)) {
      const published = row.data.publishedToSubsplash === true;
      if (published) this.resource('media', row.data.sermonSubsplashId);
      if (await this.read(`sermons/${row.id}`, false)) await this.sermon(row.id, published);
    }
  }
  async speaker(id: string, required = true): Promise<void> {
    const doc = await this.read(`speakers/${id}`, required);
    if (!doc) return;
    this.resource('tag', doc.data.tagId ?? doc.data.subsplashId);
    const listId = identifier(doc.data.listId);
    if (listId) await this.list(listId);
  }
  finish(operation: string, intent: unknown): ImmutableMutationResourcePlan {
    const resources = [...this.resources.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const evidence = [...this.evidence.entries()].sort(([a], [b]) => a.localeCompare(b));
    return Object.freeze({
      operation,
      resources: Object.freeze(
        resources.map((resource) => Object.freeze(resource))
      ) as unknown as ProviderMutationResource[],
      graphFingerprint: fingerprint({ intent, evidence, resources }),
      canonicalPaths: Object.freeze([...this.evidence.keys()].filter((path) => !path.startsWith('query:')).sort()),
    });
  }
}
const graph = (options: SourceOptions, includeSoundCloud = false): Graph =>
  new Graph(
    options.reader ??
      (options.db
        ? firestoreMutationCanonicalReader(options.db)
        : invalid('PROVIDER_MUTATION_CANONICAL_READER_REQUIRED')),
    options.soundcloudAccount,
    includeSoundCloud
  );
export type PublishingMutationLogicalStep =
  | 'lists'
  | 'series'
  | 'metadata'
  | 'publication'
  | 'audio'
  | 'delete'
  | 'soundcloud';
export async function buildPublishingMutationResourcePlan(
  options: SourceOptions & { intent: PrivatePublishingIntent; logicalStep: PublishingMutationLogicalStep }
): Promise<ImmutableMutationResourcePlan> {
  if (!['lists', 'series', 'metadata', 'publication', 'audio', 'delete', 'soundcloud'].includes(options.logicalStep))
    invalid('PROVIDER_MUTATION_LOGICAL_STEP_INVALID');
  const g = graph(options, ['metadata', 'delete', 'soundcloud', 'audio'].includes(options.logicalStep));
  const { intent } = options;
  const sermon = await g.sermon(intent.sermonId, !['lists', 'soundcloud'].includes(options.logicalStep), true);
  const removals = object(intent.payload.removals);
  if (options.logicalStep === 'lists') {
    const memberships = await g.rows(`sermons/${intent.sermonId}/sermonLists`);
    const selected = new Set([...intent.destinations.listIds, ...strings(removals.listIds)]);
    if (intent.action === 'delete') for (const row of memberships) selected.add(row.id);
    for (const id of selected) await g.list(id);
  }
  if (options.logicalStep === 'series') {
    for (const id of new Set(
      [
        identifier(sermon.seriesId),
        intent.destinations.seriesId,
        identifier(removals.seriesId),
        identifier(intent.payload.previousSeriesId),
        identifier(intent.payload.desiredSeriesId),
      ].filter((value): value is string => !!value)
    ))
      await g.series(id);
  }
  if (options.logicalStep === 'metadata') await g.assets({ ...sermon, ...object(intent.payload.patch) });
  return g.finish(`publishing:${options.ref.jobId}:${options.logicalStep}`, intent);
}
export async function buildEntityMutationResourcePlan(
  options: SourceOptions & { intent: PublishingEntityIntent }
): Promise<ImmutableMutationResourcePlan> {
  const g = graph(options);
  const { intent } = options;
  const input = object(intent.payload.input);
  const operation = identifier(intent.payload.operation) ?? intent.kind.split('.')[1];
  const entityId = identifier(intent.entity.id);
  if (!entityId) invalid('PROVIDER_MUTATION_ENTITY_ID_REQUIRED');
  const type = intent.kind.split('.')[0];
  if (intent.entity.type !== type || !['list', 'series', 'speaker'].includes(type))
    invalid('PROVIDER_MUTATION_ENTITY_TYPE_UNSUPPORTED');
  if (type === 'list') {
    if (operation === 'create') await g.read(`lists/${entityId}`, false);
    else await g.list(entityId!);
  }
  const seriesMediaMutation =
    type === 'series' && ['series.membership', 'series.publish', 'series.reorder'].includes(intent.kind);
  if (type === 'series') {
    if (operation === 'create') await g.read(`series/${entityId}`, false);
    else await g.series(entityId!, seriesMediaMutation);
  }
  if (type === 'speaker') await g.speaker(entityId!, operation !== 'create');
  for (const id of new Set(
    [
      ...strings(input.destinationListIds),
      ...strings(input.listIds),
      identifier(input.rootListId),
      identifier(input.physicalFirestoreListId),
      identifier(input.associatedListId),
      identifier(object(input.patch).associatedListId),
    ].filter((value): value is string => !!value)
  ))
    await g.list(id);
  for (const id of strings(input.sermonIds)) {
    const data = await g.sermon(id, seriesMediaMutation || operation === 'publish' || input.publishEligible === true);
    const previousSeries = identifier(data.seriesId);
    if (seriesMediaMutation && previousSeries && previousSeries !== entityId) await g.series(previousSeries);
  }
  await g.assets(input);
  await g.assets(object(input.patch));
  await g.assets(object(input.speaker));
  return g.finish(`entity:${options.ref.jobId}:${intent.kind}`, intent);
}
/** Call after acquiring the entire set, before the first mutation. Never expand a held plan. */
export async function assertMutationResourcePlanCurrent(
  plan: ImmutableMutationResourcePlan,
  rebuild: () => Promise<ImmutableMutationResourcePlan>
): Promise<void> {
  const current = await rebuild();
  if (
    current.operation !== plan.operation ||
    current.graphFingerprint !== plan.graphFingerprint ||
    fingerprint(current.resources) !== fingerprint(plan.resources)
  )
    invalid('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
}
