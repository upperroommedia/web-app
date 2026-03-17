import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { ImageType } from '@upperroom/shared/types/Image';
import type { List } from '@upperroom/shared/types/List';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import {
  sermonStatusType,
  uploadStatus,
  type Sermon,
} from '@upperroom/shared/types/SermonTypes';
import type {
  GetListPublishedDriftOutputType,
  PublishedListDriftIssue,
  PublishedListDriftRemoteItem,
} from '../../../packages/contracts/getListPublishedDrift';
import type {
  ResolveListPublishedDriftOutputType,
  ResolveListPublishedDriftStrategy,
} from '../../../packages/contracts/resolveListPublishedDrift';
import {
  firestoreAdminImagesConverter,
  firestoreAdminListConverter,
  firestoreAdminSermonConverter,
} from '../firestoreDataConverter';
import { createAxiosConfig } from '../subsplashUtils';
import { getFullListRows } from './addToListHelpers';
import { getOverflowChainState } from './listOverflowChain';
import type { SubsplashImage, SubsplashListRow } from '../types/Subsplash';
import {
  listDebugLog,
  summarizeOverflowIssues,
  summarizeOverflowNodes,
  summarizeSubsplashRows,
} from './listDebugLogger';

const firestore = firebaseAdmin.firestore();

type RootProjectionItem = Sermon & {
  position?: number;
  uploadStatus?: {
    status: uploadStatus;
    listItemId?: string;
    reason?: string;
  };
  physicalPlacement?: {
    firestoreListId?: string;
    subsplashListId?: string;
    overflowDepth?: number;
    position?: number;
  };
};

type CanonicalListMembership = Pick<SermonList, 'uploadStatus'>;

type RemoteNodeSnapshot = {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  rows: SubsplashListRow[];
};

type SubsplashMediaItemDetails = {
  id: string;
  title?: string;
  subtitle?: string;
  summary?: string;
  date?: string;
  duration?: number;
  tags?: string[];
  audio_url?: string;
  _embedded?: {
    images?: SubsplashImage[];
  };
};

export interface PublishedListDriftState extends GetListPublishedDriftOutputType {
  localItems: RootProjectionItem[];
  remoteNodes: RemoteNodeSnapshot[];
}

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const chunkValues = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const sortRootProjectionItems = (items: RootProjectionItem[]): RootProjectionItem[] => {
  return [...items].sort((left, right) => {
    if (typeof left.position === 'number' && typeof right.position === 'number') {
      return left.position - right.position;
    }

    return (
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
      (left.createdAtMillis ?? 0) - (right.createdAtMillis ?? 0) ||
      left.title.localeCompare(right.title)
    );
  });
};

const isProjectionItemPublished = (item: RootProjectionItem): boolean => {
  if (item.uploadStatus?.status) {
    return item.uploadStatus.status === uploadStatus.UPLOADED;
  }

  if (normalizeString(item.physicalPlacement?.subsplashListId)) {
    return true;
  }

  return item.status?.subsplash === uploadStatus.UPLOADED;
};

const pushIssue = (
  issues: PublishedListDriftIssue[],
  nextIssue: PublishedListDriftIssue
) => {
  const exists = issues.some((issue) => {
    return (
      issue.code === nextIssue.code &&
      issue.sermonId === nextIssue.sermonId &&
      issue.mediaItemId === nextIssue.mediaItemId &&
      issue.firestoreListId === nextIssue.firestoreListId &&
      issue.subsplashListId === nextIssue.subsplashListId &&
      issue.message === nextIssue.message
    );
  });

  if (!exists) {
    issues.push(nextIssue);
  }
};

const getRemoteMediaItemId = (row: SubsplashListRow): string | undefined => {
  const embedded = row._embedded?.[row.type];
  return normalizeString(embedded?.id);
};

const loadRootProjectionItems = async (rootListId: string): Promise<RootProjectionItem[]> => {
  const snapshot = await firestore.collection('lists').doc(rootListId).collection('listItems').get();

  return sortRootProjectionItems(
    snapshot.docs.map((docSnapshot) => {
      const data = docSnapshot.data() as RootProjectionItem;
      return {
        ...data,
        id: docSnapshot.id,
      };
    })
  );
};

const loadCanonicalMemberships = async (
  rootListId: string
): Promise<Map<string, CanonicalListMembership>> => {
  const snapshot = await firestore.collectionGroup('sermonLists').where('id', '==', rootListId).get();
  const canonicalMemberships = new Map<string, CanonicalListMembership>();

  snapshot.docs.forEach((docSnapshot) => {
    const sermonId = docSnapshot.ref.parent.parent?.id;
    if (!sermonId) {
      return;
    }

    canonicalMemberships.set(sermonId, docSnapshot.data() as CanonicalListMembership);
  });

  return canonicalMemberships;
};

const applyCanonicalMembershipsToRootProjectionItems = ({
  items,
  canonicalMemberships,
}: {
  items: RootProjectionItem[];
  canonicalMemberships: Map<string, CanonicalListMembership>;
}): RootProjectionItem[] =>
  items.map((item) => {
    const canonicalMembership = canonicalMemberships.get(item.id);
    if (!canonicalMembership?.uploadStatus) {
      return item;
    }

    return {
      ...item,
      uploadStatus: canonicalMembership.uploadStatus,
    };
  });

const loadRootList = async (rootListId: string): Promise<List> => {
  const snapshot = await firestore.collection('lists').doc(rootListId).withConverter(firestoreAdminListConverter).get();
  if (!snapshot.exists) {
    throw new Error(`List ${rootListId} not found.`);
  }

  return snapshot.data()!;
};

const getStoredSermonsBySubsplashIds = async (
  subsplashIds: string[]
): Promise<{
  sermonsBySubsplashId: Map<string, Sermon>;
  ambiguousSubsplashIds: Set<string>;
}> => {
  const sermonsBySubsplashId = new Map<string, Sermon>();
  const ambiguousSubsplashIds = new Set<string>();

  for (const chunk of chunkValues([...new Set(subsplashIds)], 10)) {
    if (chunk.length === 0) {
      continue;
    }

    const snapshot = await firestore.collection('sermons').where('subsplashId', 'in', chunk).withConverter(firestoreAdminSermonConverter).get();
    snapshot.docs.forEach((doc) => {
      const sermon = doc.data();
      const subsplashId = normalizeString(sermon.subsplashId);
      if (subsplashId) {
        if (sermonsBySubsplashId.has(subsplashId)) {
          ambiguousSubsplashIds.add(subsplashId);
        }
        sermonsBySubsplashId.set(subsplashId, { ...sermon, id: doc.id });
      }
    });
  }

  return {
    sermonsBySubsplashId,
    ambiguousSubsplashIds,
  };
};

const fetchRemoteNodes = async (rootListId: string, token: string): Promise<RemoteNodeSnapshot[]> => {
  const chainState = await getOverflowChainState(rootListId);
  const nodes = await Promise.all(
    chainState.nodes.map(async (node) => {
      const subsplashListId = normalizeString(node.subsplashId);
      if (!subsplashListId) {
        throw new Error(`List ${node.firestoreListId} is missing its Subsplash id.`);
      }

      return {
        firestoreListId: node.firestoreListId,
        subsplashListId,
        overflowDepth: node.depth,
        rows: await getFullListRows(subsplashListId, token),
      } satisfies RemoteNodeSnapshot;
    })
  );

  return nodes;
};

const getSubsplashMediaItemDetails = async (
  mediaItemId: string,
  token: string
): Promise<SubsplashMediaItemDetails> => {
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`,
    token,
    'GET'
  );

  const response = await axios(config);
  return response.data as SubsplashMediaItemDetails;
};

const buildRemoteItems = (
  remoteNodes: RemoteNodeSnapshot[],
  localSermonsBySubsplashId: Map<string, Sermon>,
  ambiguousSubsplashIds: Set<string>,
  issues: PublishedListDriftIssue[]
): PublishedListDriftRemoteItem[] => {
  const remoteItems: PublishedListDriftRemoteItem[] = [];

  remoteNodes.forEach((node, index) => {
    const expectedNextSubsplashListId = remoteNodes[index + 1]?.subsplashListId;
    const linkRows = node.rows.filter((row) => row.type === 'list');
    const contentRows = node.rows.filter((row) => row.type !== 'list');

    if (expectedNextSubsplashListId) {
      if (linkRows.length !== 1) {
        pushIssue(issues, {
          code: 'CONTINUATION_ROW_INVALID',
          severity: 'blocking',
          message: `List ${node.firestoreListId} must end with exactly one continuation row.`,
          firestoreListId: node.firestoreListId,
          subsplashListId: node.subsplashListId,
        });
      } else {
        const linkRow = linkRows[0];
        const targetId = normalizeString(linkRow._embedded?.list?.id);
        const isLastRow = node.rows[node.rows.length - 1]?.id === linkRow.id;
        if (targetId !== expectedNextSubsplashListId || !isLastRow) {
          pushIssue(issues, {
            code: 'CONTINUATION_ROW_INVALID',
            severity: 'blocking',
            message: `Continuation row for ${node.firestoreListId} does not point to the expected next page or is not last.`,
            firestoreListId: node.firestoreListId,
            subsplashListId: node.subsplashListId,
          });
        }
      }
    } else if (linkRows.length > 0) {
      pushIssue(issues, {
        code: 'CONTINUATION_ROW_INVALID',
        severity: 'blocking',
        message: `Tail overflow page ${node.firestoreListId} should not contain a continuation row.`,
        firestoreListId: node.firestoreListId,
        subsplashListId: node.subsplashListId,
      });
    }

    contentRows.forEach((row, contentIndex) => {
      const mediaItemId = getRemoteMediaItemId(row);
      if (!mediaItemId) {
        return;
      }

      if (row.type !== 'media-item') {
        pushIssue(issues, {
          code: 'REMOTE_ONLY_UNSUPPORTED_TYPE',
          severity: 'blocking',
          message: `Remote row ${mediaItemId} has unsupported type ${row.type}.`,
          mediaItemId,
          mediaType: row.type,
          firestoreListId: node.firestoreListId,
          subsplashListId: node.subsplashListId,
          remotePosition: contentIndex + 1,
        });
      }

      const matchedSermon = ambiguousSubsplashIds.has(mediaItemId)
        ? undefined
        : localSermonsBySubsplashId.get(mediaItemId);
      remoteItems.push({
        mediaItemId,
        mediaType: row.type,
        title: matchedSermon?.title,
        matchedSermonId: matchedSermon?.id,
        placement: {
          firestoreListId: node.firestoreListId,
          subsplashListId: node.subsplashListId,
          overflowDepth: node.overflowDepth,
          position: contentIndex + 1,
          listItemId: row.id,
        },
      });
    });
  });

  return remoteItems;
};

export const auditPublishedListDrift = async (
  rootListId: string,
  token: string
): Promise<PublishedListDriftState> => {
  listDebugLog('publishedListDrift.audit.start', {
    rootListId,
  });
  const chainState = await getOverflowChainState(rootListId);
  const canonicalMemberships = await loadCanonicalMemberships(chainState.rootListId);
  const rootListItems = applyCanonicalMembershipsToRootProjectionItems({
    items: await loadRootProjectionItems(chainState.rootListId),
    canonicalMemberships,
  });
  const remoteNodes = await fetchRemoteNodes(chainState.rootListId, token);
  const issues: PublishedListDriftIssue[] = [];

  chainState.issues.forEach((issue) => {
    pushIssue(issues, {
      code: 'CHAIN_STRUCTURE_INVALID',
      severity: issue.severity === 'blocking' ? 'blocking' : 'warning',
      message: issue.message,
      firestoreListId: issue.firestoreListId,
      subsplashListId: issue.subsplashListId,
    });
  });

  const remoteMediaItemIds = remoteNodes.flatMap((node) =>
    node.rows
      .filter((row) => row.type !== 'list')
      .map((row) => getRemoteMediaItemId(row))
      .filter((value): value is string => Boolean(value))
  );
  const { sermonsBySubsplashId, ambiguousSubsplashIds } = await getStoredSermonsBySubsplashIds(remoteMediaItemIds);

  const localPublishedItems = rootListItems
    .filter((item) => isProjectionItemPublished(item))
    .map((item, index) => ({
      sermonId: item.id,
      mediaItemId: normalizeString(item.subsplashId),
      title: item.title,
      logicalPosition: typeof item.position === 'number' ? item.position : index + 1,
      published: true,
    }));

  const remotePublishedItems = buildRemoteItems(remoteNodes, sermonsBySubsplashId, ambiguousSubsplashIds, issues);

  const remoteMediaIds = new Set(remotePublishedItems.map((item) => item.mediaItemId));
  const localPublishedByMediaId = new Map(
    localPublishedItems
      .filter((item): item is typeof item & { mediaItemId: string } => Boolean(item.mediaItemId))
      .map((item) => [item.mediaItemId, item])
  );

  remotePublishedItems.forEach((item) => {
    if (item.mediaType !== 'media-item') {
      return;
    }

    if (ambiguousSubsplashIds.has(item.mediaItemId)) {
      pushIssue(issues, {
        code: 'REMOTE_ONLY_AMBIGUOUS_MATCH',
        severity: 'blocking',
        message: `Subsplash contains published sermon ${item.mediaItemId}, but multiple Firebase sermons share that Subsplash id.`,
        mediaItemId: item.mediaItemId,
        mediaType: item.mediaType,
        firestoreListId: item.placement.firestoreListId,
        subsplashListId: item.placement.subsplashListId,
        remotePosition: item.placement.position,
      });
      return;
    }

    const localPublishedItem = localPublishedByMediaId.get(item.mediaItemId);
    if (!localPublishedItem) {
      pushIssue(issues, {
        code: item.matchedSermonId ? 'REMOTE_ONLY_MATCHED' : 'REMOTE_ONLY_UNMATCHED',
        severity: 'blocking',
        message: item.matchedSermonId
          ? `Subsplash contains published sermon ${item.mediaItemId} that Firebase has not marked as published in this list.`
          : `Subsplash contains published sermon ${item.mediaItemId} with no matching Firebase sermon.`,
        sermonId: item.matchedSermonId,
        mediaItemId: item.mediaItemId,
        mediaType: item.mediaType,
        firestoreListId: item.placement.firestoreListId,
        subsplashListId: item.placement.subsplashListId,
        remotePosition: item.placement.position,
      });
    }
  });

  localPublishedItems.forEach((item) => {
    if (!item.mediaItemId || remoteMediaIds.has(item.mediaItemId)) {
      return;
    }

    pushIssue(issues, {
      code: 'LOCAL_ONLY_PUBLISHED',
      severity: 'blocking',
      message: `Firebase marks sermon ${item.sermonId} as published in this list, but Subsplash does not contain it.`,
      sermonId: item.sermonId,
      mediaItemId: item.mediaItemId,
      localPosition: item.logicalPosition,
      firestoreListId: chainState.rootListId,
    });
  });

  const sharedRemoteSequence = remotePublishedItems
    .filter(
      (item) =>
        item.mediaType === 'media-item' &&
        item.matchedSermonId &&
        localPublishedByMediaId.has(item.mediaItemId)
    )
    .map((item) => item.mediaItemId);
  const sharedLocalSequence = localPublishedItems
    .filter((item) => item.mediaItemId && sharedRemoteSequence.includes(item.mediaItemId))
    .map((item) => item.mediaItemId as string);

  if (
    sharedRemoteSequence.length > 0 &&
    sharedLocalSequence.length === sharedRemoteSequence.length &&
    sharedLocalSequence.some((mediaItemId, index) => mediaItemId !== sharedRemoteSequence[index])
  ) {
    pushIssue(issues, {
      code: 'ORDER_MISMATCH',
      severity: 'blocking',
      message: 'Published sermon order differs between Firebase and Subsplash.',
      firestoreListId: chainState.rootListId,
    });
  }

  if (
    issues.some((issue) =>
      ['REMOTE_ONLY_MATCHED', 'REMOTE_ONLY_UNMATCHED', 'LOCAL_ONLY_PUBLISHED'].includes(issue.code)
    )
  ) {
    pushIssue(issues, {
      code: 'MEMBERSHIP_MISMATCH',
      severity: 'blocking',
      message: 'Published sermon membership differs between Firebase and Subsplash.',
      firestoreListId: chainState.rootListId,
    });
  }

  if (issues.length === 0) {
    issues.push({
      code: 'IN_SYNC',
      severity: 'info',
      message: 'Published Firebase and Subsplash state are in sync for this list.',
      firestoreListId: chainState.rootListId,
    });
  }

  const hasMismatch = issues.some((issue) => issue.code !== 'IN_SYNC');
  const output: PublishedListDriftState = {
    requestedListId: rootListId,
    rootListId: chainState.rootListId,
    inSync: !hasMismatch,
    canReorder: !hasMismatch,
    canOverflowPublish: !hasMismatch,
    canDelete: true,
    canRemove: true,
    issues,
    localPublishedItems,
    remotePublishedItems,
    localItems: rootListItems,
    remoteNodes,
  };
  listDebugLog('publishedListDrift.audit.complete', {
    requestedListId: rootListId,
    rootListId: chainState.rootListId,
    inSync: output.inSync,
    localPublishedItems: output.localPublishedItems,
    remotePublishedItems: output.remotePublishedItems,
    localItemCount: rootListItems.length,
    remoteNodes: remoteNodes.map((node) => ({
      ...node,
      rows: summarizeSubsplashRows(node.rows),
    })),
    chainNodes: summarizeOverflowNodes(chainState.nodes),
    issues: summarizeOverflowIssues(issues),
  });
  return output;
};

export const ensureCanPerformStrictPublishedMutation = async (
  rootListId: string,
  token: string,
  action: 'reorder' | 'overflow-publish'
): Promise<PublishedListDriftState> => {
  listDebugLog('publishedListDrift.ensureStrict.start', {
    rootListId,
    action,
  });
  const driftState = await auditPublishedListDrift(rootListId, token);
  if (driftState.inSync) {
    listDebugLog('publishedListDrift.ensureStrict.allowed', {
      rootListId,
      action,
    });
    return driftState;
  }

  listDebugLog('publishedListDrift.ensureStrict.blocked', {
    rootListId,
    action,
    issues: summarizeOverflowIssues(driftState.issues),
  });
  throw new HttpsError(
    'failed-precondition',
    `Cannot ${action === 'reorder' ? 'reorder this list' : 'publish into overflow'} because the published Firebase and Subsplash state differ.`,
    {
      rootListId: driftState.rootListId,
      action,
      issues: driftState.issues,
    }
  );
};

const parseSpeakerTags = (tags: string[] | undefined): Sermon['speakers'] =>
  (tags ?? [])
    .filter((tag) => tag.startsWith('speaker:'))
    .map((tag) => tag.replace(/^speaker:/, '').trim())
    .filter(Boolean)
    .map((name, index) => ({
      id: `imported-speaker-${index}-${name}`,
      name,
      shortDescription: '',
      description: '',
      sermonCount: 0,
      images: [],
    }));

const parseTopicTags = (tags: string[] | undefined): string[] =>
  (tags ?? [])
    .filter((tag) => tag.startsWith('topic:'))
    .map((tag) => tag.replace(/^topic:/, '').trim())
    .filter(Boolean);

const resolveImportedImages = async (images: SubsplashImage[] | undefined): Promise<ImageType[]> => {
  if (!images || images.length === 0) {
    return [];
  }

  const resolvedImages: ImageType[] = [];

  for (const image of images) {
    const existingSnapshot = await firestore
      .collection('images')
      .where('subsplashId', '==', image.id)
      .where('type', '==', image.type)
      .withConverter(firestoreAdminImagesConverter)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      resolvedImages.push(existingSnapshot.docs[0].data());
      continue;
    }

    const imageRef = firestore.collection('images').doc();
    const importedImage: ImageType = {
      id: imageRef.id,
      size: 'original',
      type: image.type,
      height: image.height ?? 0,
      width: image.width ?? 0,
      downloadLink: image._links?.download?.href ?? image._links?.related?.href ?? '',
      name: `${image.id}-${image.type}`,
      dateAddedMillis: Date.now(),
      subsplashId: image.id,
      ...(image.average_color_hex ? { averageColorHex: image.average_color_hex } : {}),
      ...(image.vibrant_color_hex ? { vibrantColorHex: image.vibrant_color_hex } : {}),
    };

    await imageRef.withConverter(firestoreAdminImagesConverter).set(importedImage);
    resolvedImages.push(importedImage);
  }

  return resolvedImages;
};

const buildImportedSermon = async (
  mediaItemId: string,
  token: string
): Promise<Sermon> => {
  const details = await getSubsplashMediaItemDetails(mediaItemId, token);
  const sermonRef = firestore.collection('sermons').doc();
  const now = Date.now();
  const images = await resolveImportedImages(details._embedded?.images);

  return {
    id: sermonRef.id,
    title: details.title ?? `Imported ${mediaItemId}`,
    subtitle: details.subtitle ?? '',
    description: details.summary ?? '',
    dateMillis: details.date ? new Date(details.date).getTime() : now,
    sourceStartTime: 0,
    durationSeconds: details.duration ?? 0,
    speakers: parseSpeakerTags(details.tags),
    topics: parseTopicTags(details.tags),
    status: {
      soundCloud: uploadStatus.NOT_UPLOADED,
      subsplash: uploadStatus.UPLOADED,
      audioStatus: sermonStatusType.PROCESSED,
    },
    images,
    numberOfLists: 1,
    numberOfListsUploadedTo: 1,
    createdAtMillis: now,
    editedAtMillis: now,
    subsplashId: mediaItemId,
    audioSource: 'subsplash',
    subsplashAudioUrl: details.audio_url,
  };
};

const mergePublishedSubsetOrder = (
  currentItems: RootProjectionItem[],
  resolvedPublishedSermonIds: string[]
): string[] => {
  const publishedSlots = currentItems.filter((item) => isProjectionItemPublished(item)).length;
  const mergedIds: string[] = [];
  let publishedCursor = 0;

  currentItems.forEach((item) => {
    if (isProjectionItemPublished(item)) {
      if (publishedCursor < resolvedPublishedSermonIds.length) {
        mergedIds.push(resolvedPublishedSermonIds[publishedCursor]);
        publishedCursor += 1;
      }
      return;
    }

    mergedIds.push(item.id);
  });

  while (publishedCursor < resolvedPublishedSermonIds.length) {
    mergedIds.push(resolvedPublishedSermonIds[publishedCursor]);
    publishedCursor += 1;
  }

  // If all previous published slots were removed and no remote published sermons remain, keep untouched local order.
  if (resolvedPublishedSermonIds.length === 0 && publishedSlots === 0) {
    return currentItems.map((item) => item.id);
  }

  return mergedIds;
};

export const resolvePublishedListDrift = async ({
  listId,
  token,
  strategy,
}: {
  listId: string;
  token: string;
  strategy: ResolveListPublishedDriftStrategy;
}): Promise<ResolveListPublishedDriftOutputType> => {
  listDebugLog('publishedListDrift.resolve.start', {
    listId,
    strategy,
  });
  const driftState = await auditPublishedListDrift(listId, token);
  const untouchedUnpublishedSermonIds = driftState.localItems
    .filter((item) => item.uploadStatus?.status !== uploadStatus.UPLOADED)
    .map((item) => item.id);

  const unresolvableBlockingIssues = driftState.issues.filter((issue) =>
    ['REMOTE_ONLY_AMBIGUOUS_MATCH', 'REMOTE_ONLY_UNSUPPORTED_TYPE', 'CONTINUATION_ROW_INVALID', 'CHAIN_STRUCTURE_INVALID'].includes(
      issue.code
    )
  );

  if (strategy === 'IGNORE') {
    const output: ResolveListPublishedDriftOutputType = {
      status: 'ignored',
      rootListId: driftState.rootListId,
      updatedSermonIds: [],
      importedSermonIds: [],
      untouchedUnpublishedSermonIds,
    };
    listDebugLog('publishedListDrift.resolve.ignored', {
      listId,
      rootListId: driftState.rootListId,
      untouchedUnpublishedSermonIds,
    });
    return output;
  }

  if (unresolvableBlockingIssues.length > 0) {
    listDebugLog('publishedListDrift.resolve.blocked', {
      listId,
      rootListId: driftState.rootListId,
      strategy,
      issues: summarizeOverflowIssues(unresolvableBlockingIssues),
    });
    throw new HttpsError(
      'failed-precondition',
      'Cannot update Firebase from Subsplash until blocking published drift issues are resolved.',
      {
        rootListId: driftState.rootListId,
        issues: unresolvableBlockingIssues,
      }
    );
  }

  const rootList = await loadRootList(driftState.rootListId);
  const rootListDataWithoutCounters: Partial<List> = { ...rootList };
  delete (rootListDataWithoutCounters as Partial<List>).count;
  delete (rootListDataWithoutCounters as Partial<List>).updatedAtMillis;
  delete (rootListDataWithoutCounters as Partial<List>).logicalCount;
  delete (rootListDataWithoutCounters as Partial<List>).hasOverflowPages;

  const importedSermonIds: string[] = [];
  const updatedSermonIds = new Set<string>();
  const resolvedPublishedSermons: Sermon[] = [];
  const localById = new Map(driftState.localItems.map((item) => [item.id, item]));

  for (const remoteItem of driftState.remotePublishedItems) {
    if (remoteItem.mediaType !== 'media-item') {
      continue;
    }

    let sermon: Sermon | undefined;
    if (remoteItem.matchedSermonId) {
      const existingLocal = localById.get(remoteItem.matchedSermonId);
      if (existingLocal) {
        sermon = existingLocal;
      } else {
        const snapshot = await firestore
          .collection('sermons')
          .doc(remoteItem.matchedSermonId)
          .withConverter(firestoreAdminSermonConverter)
          .get();
        if (snapshot.exists) {
          sermon = snapshot.data()!;
        }
      }
    }

    if (!sermon) {
      sermon = await buildImportedSermon(remoteItem.mediaItemId, token);
      importedSermonIds.push(sermon.id);
      await firestore.collection('sermons').doc(sermon.id).withConverter(firestoreAdminSermonConverter).set(sermon);
    }

    resolvedPublishedSermons.push({
      ...sermon,
      status: {
        ...sermon.status,
        subsplash: uploadStatus.UPLOADED,
      },
    });
  }

  const mergedOrder = mergePublishedSubsetOrder(driftState.localItems, resolvedPublishedSermons.map((sermon) => sermon.id));
  const resolvedById = new Map(resolvedPublishedSermons.map((sermon) => [sermon.id, sermon]));
  const batch = firestore.batch();

  mergedOrder.forEach((sermonId, index) => {
    const resolvedRemoteItem = driftState.remotePublishedItems.find((item) => item.matchedSermonId === sermonId)
      ?? driftState.remotePublishedItems.find((item) => resolvedById.get(sermonId)?.subsplashId === item.mediaItemId);
    const sermon = resolvedById.get(sermonId) ?? localById.get(sermonId);
    if (!sermon) {
      return;
    }

    const isPublishedRemotely = Boolean(resolvedRemoteItem);
    const rootListItemRef = firestore.collection('lists').doc(driftState.rootListId).collection('listItems').doc(sermonId);
    const sermonListRef = firestore.collection('sermons').doc(sermonId).collection('sermonLists').doc(driftState.rootListId);

    batch.set(
      rootListItemRef,
      {
        ...sermon,
        position: index + 1,
        ...(isPublishedRemotely
          ? {
              uploadStatus: {
                status: uploadStatus.UPLOADED,
                listItemId: resolvedRemoteItem?.placement.listItemId,
              },
              physicalPlacement: resolvedRemoteItem?.placement,
            }
          : {
              uploadStatus: { status: uploadStatus.NOT_UPLOADED },
              physicalPlacement: FieldValue.delete(),
            }),
      } as Record<string, unknown>,
      { merge: true }
    );

    batch.set(
      sermonListRef,
      {
        ...rootListDataWithoutCounters,
        id: driftState.rootListId,
        ...(isPublishedRemotely
          ? {
              uploadStatus: {
                status: uploadStatus.UPLOADED,
                ...(resolvedRemoteItem?.placement.listItemId
                  ? { listItemId: resolvedRemoteItem.placement.listItemId }
                  : {}),
              },
            }
          : {
              uploadStatus: { status: uploadStatus.NOT_UPLOADED },
            }),
      } as Partial<SermonList>,
      { merge: true }
    );
    updatedSermonIds.add(sermonId);
  });

  const remotePublishedSermonIds = new Set(resolvedPublishedSermons.map((sermon) => sermon.id));
  driftState.localItems.forEach((item) => {
    if (!isProjectionItemPublished(item) || remotePublishedSermonIds.has(item.id)) {
      return;
    }

    const rootListItemRef = firestore.collection('lists').doc(driftState.rootListId).collection('listItems').doc(item.id);
    const sermonListRef = firestore.collection('sermons').doc(item.id).collection('sermonLists').doc(driftState.rootListId);
    batch.set(
      rootListItemRef,
      {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
        physicalPlacement: FieldValue.delete(),
      },
      { merge: true }
    );
    batch.set(
      sermonListRef,
      {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      },
      { merge: true }
    );
    updatedSermonIds.add(item.id);
  });

  await batch.commit();
  const output: ResolveListPublishedDriftOutputType = {
    status: 'success',
    rootListId: driftState.rootListId,
    updatedSermonIds: [...updatedSermonIds],
    importedSermonIds,
    untouchedUnpublishedSermonIds,
  };
  listDebugLog('publishedListDrift.resolve.complete', {
    listId,
    rootListId: driftState.rootListId,
    strategy,
    mergedOrder,
    updatedSermonIds: [...updatedSermonIds],
    importedSermonIds,
    untouchedUnpublishedSermonIds,
  });
  return output;
};
