import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import type {
  GetListOverflowChainOutputType,
  GetListOverflowChainRemoteItem,
} from '../../../packages/contracts/getListOverflowChain';
import type { SubsplashListRow, SubsplashMediaType } from '../types/Subsplash';
import { getFullListRows } from './addToListHelpers';
import { getOverflowChainState } from './listOverflowChain';

const firestore = firebaseAdmin.firestore();

const MUTABLE_NON_SERMON_ROW_TYPES = new Set<SubsplashMediaType>([
  'media-series',
  'album',
  'link',
  'rss',
  'calendar',
  'song',
]);

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export const getRemoteRowResourceId = (row: SubsplashListRow): string | undefined => {
  const embedded = row._embedded?.[row.type];
  return normalizeString(embedded?.id);
};

export const getRemoteRowTitle = (row: SubsplashListRow): string | undefined => {
  const embedded = row._embedded?.[row.type];
  return normalizeString(embedded?.title);
};

export const getRemoteRowSubtitle = (row: SubsplashListRow): string | undefined => {
  const embedded = row._embedded?.[row.type];
  return normalizeString(embedded?.subtitle);
};

const getRemoteRowPrimaryImage = (
  row: SubsplashListRow
): { downloadLink?: string; type?: string; averageColorHex?: string } | undefined => {
  const embedded = row._embedded?.[row.type] as
    | {
        _embedded?: {
          images?: Array<{
            id: string;
            type?: string;
            average_color_hex?: string;
            _links?: {
              download?: { href?: string };
              related?: { href?: string };
            };
          }>;
        };
      }
    | undefined;

  const images = embedded?._embedded?.images;
  const image =
    images?.find((candidate) => candidate.type === 'square') ??
    images?.find((candidate) => candidate.type === 'wide') ??
    images?.find((candidate) => candidate.type === 'banner') ??
    images?.[0];
  if (!image) {
    return undefined;
  }

  return {
    downloadLink: normalizeString(image._links?.related?.href) ?? normalizeString(image._links?.download?.href),
    type: normalizeString(image.type),
    averageColorHex: normalizeString(image.average_color_hex),
  };
};

export const isKnownRemoteContentType = (rowType: string): rowType is SubsplashMediaType => {
  return [
    'media-item',
    'media-series',
    'song',
    'link',
    'rss',
    'list',
    'album',
    'calendar',
    'event',
  ].includes(rowType);
};

export const canReconstructRemoteRow = (row: SubsplashListRow): boolean => {
  if (row.type === 'event') {
    return false;
  }

  return Boolean(getRemoteRowResourceId(row));
};

const getTrackedRootListItemsBySubsplashId = async (
  rootListId: string
): Promise<Map<string, Sermon & { id: string }>> => {
  const result = new Map<string, Sermon & { id: string }>();
  const snapshot = await firestore.collection('lists').doc(rootListId).collection('listItems').get();
  snapshot.docs.forEach((doc) => {
    const data = doc.data() as Sermon;
    const subsplashId = normalizeString(data.subsplashId);
    if (!subsplashId || result.has(subsplashId)) {
      return;
    }

    result.set(subsplashId, {
      ...data,
      id: doc.id,
    });
  });

  return result;
};

export type RemoteNodeRows = {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  rows: SubsplashListRow[];
};

export const isContinuationLinkRow = ({
  row,
  rowIndex,
  rows,
  expectedNextSubsplashListId,
}: {
  row: SubsplashListRow;
  rowIndex: number;
  rows: SubsplashListRow[];
  expectedNextSubsplashListId?: string;
}): boolean => {
  if (row.type !== 'list' || !expectedNextSubsplashListId) {
    return false;
  }

  const targetListId = getRemoteRowResourceId(row);
  const isLastRow = rowIndex === rows.length - 1;

  return targetListId === expectedNextSubsplashListId && isLastRow;
};

export const getLogicalContentRows = ({
  rows,
  expectedNextSubsplashListId,
}: {
  rows: SubsplashListRow[];
  expectedNextSubsplashListId?: string;
}): SubsplashListRow[] =>
  rows.filter(
    (row, rowIndex) =>
      !isContinuationLinkRow({
        row,
        rowIndex,
        rows,
        expectedNextSubsplashListId,
      })
  );

export const countLogicalContentRows = ({
  rows,
  expectedNextSubsplashListId,
}: {
  rows: SubsplashListRow[];
  expectedNextSubsplashListId?: string;
}): number => getLogicalContentRows({ rows, expectedNextSubsplashListId }).length;

export const loadRemoteChainItems = async (
  rootListId: string,
  token: string,
  existingChainState?: GetListOverflowChainOutputType
): Promise<{
  chainState: GetListOverflowChainOutputType;
  remoteItems: GetListOverflowChainRemoteItem[];
  remoteNodes: RemoteNodeRows[];
}> => {
  const chainState = existingChainState ?? (await getOverflowChainState(rootListId));
  const remoteNodes = await Promise.all(
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
      };
    })
  );

  const sermonsBySubsplashId = await getTrackedRootListItemsBySubsplashId(chainState.rootListId);

  let logicalPosition = 1;
  const remoteItems = remoteNodes.flatMap<GetListOverflowChainRemoteItem>((node, nodeIndex) => {
    const expectedNextSubsplashListId = remoteNodes[nodeIndex + 1]?.subsplashListId;
    return node.rows.flatMap((row, rowIndex, rows) => {
      const linkedListId = row.type === 'list' ? getRemoteRowResourceId(row) : undefined;
      const isOverflowLink = isContinuationLinkRow({
        row,
        rowIndex,
        rows,
        expectedNextSubsplashListId,
      });
      if (isOverflowLink) {
        return [];
      }

      const rowId = normalizeString(row.id);
      if (!rowId) {
        return [];
      }

      const resourceId = getRemoteRowResourceId(row);
      const matchedSermon = row.type === 'media-item' && resourceId ? sermonsBySubsplashId.get(resourceId) : undefined;
      const reconstructible = canReconstructRemoteRow(row);
      const isTrackedInFirebase = Boolean(matchedSermon);
      const isSubsplashOnlyPlaceholder = row.type === 'media-item' && !matchedSermon;
      const canMutate =
        reconstructible &&
        row.type !== 'event' &&
        row.type !== 'list';
      const primaryImage = getRemoteRowPrimaryImage(row);

      const item: GetListOverflowChainRemoteItem = {
        rowId,
        rowType: row.type,
        rowMethod: row.method,
        logicalPosition,
        ...(resourceId ? { resourceId } : {}),
        isListRow: row.type === 'list',
        isOverflowLink,
        isOverflowCandidate: row.type === 'list' && Boolean(linkedListId),
        ...(linkedListId ? { linkedListId } : {}),
        ...(row.type === 'list' && getRemoteRowTitle(row) ? { linkedListTitle: getRemoteRowTitle(row) } : {}),
        ...(getRemoteRowTitle(row) ? { title: getRemoteRowTitle(row) } : {}),
        ...(getRemoteRowSubtitle(row) ? { subtitle: getRemoteRowSubtitle(row) } : {}),
        ...(primaryImage?.downloadLink ? { imageUrl: primaryImage.downloadLink } : {}),
        ...(primaryImage?.type ? { imageType: primaryImage.type } : {}),
        ...(primaryImage?.averageColorHex ? { imageAverageColorHex: primaryImage.averageColorHex } : {}),
        ...(matchedSermon?.id ? { matchedSermonId: matchedSermon.id } : {}),
        isTrackedInFirebase,
        isSubsplashOnlyPlaceholder,
        reconstructible,
        canEdit: Boolean(matchedSermon),
        canDelete: Boolean(matchedSermon),
        canRemove: canMutate && (row.type === 'media-item' || MUTABLE_NON_SERMON_ROW_TYPES.has(row.type)),
        placement: {
          firestoreListId: node.firestoreListId,
          subsplashListId: node.subsplashListId,
          overflowDepth: node.overflowDepth,
          position: row.position,
          ...(row.id ? { listItemId: row.id } : {}),
        },
      };

      logicalPosition += 1;
      return [item];
    });
  });

  return {
    chainState,
    remoteItems,
    remoteNodes,
  };
};
