import { logger } from 'firebase-functions/v2';
import type { PublishedListDriftIssue } from '../../../packages/contracts/getListPublishedDrift';
import type { GetListOverflowChainIssue, GetListOverflowChainNode } from '../../../packages/contracts/getListOverflowChain';
import type { ReorderListItemsAssignment } from '../../../packages/contracts/reorderListItems';
import type { SubsplashListRow } from '../types/Subsplash';

const LIST_DEBUG_ENABLED = process.env.LIST_DEBUG_LOGS !== '0';

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export const summarizeSubsplashRow = (row: SubsplashListRow): Record<string, unknown> => ({
  id: row.id,
  type: row.type,
  position: row.position,
  embeddedId: normalizeString(row._embedded?.[row.type]?.id),
  sourceListId: normalizeString(row._embedded?.['source-list']?.id),
});

export const summarizeSubsplashRows = (rows: SubsplashListRow[]): Record<string, unknown> => ({
  total: rows.length,
  contentCount: rows.filter((row) => row.type !== 'list').length,
  linkCount: rows.filter((row) => row.type === 'list').length,
  rows: rows.map(summarizeSubsplashRow),
});

type SummarizableNode = Pick<GetListOverflowChainNode, 'firestoreListId' | 'subsplashId' | 'depth' | 'count' | 'nextSubsplashListId'> & {
  currentItemCount?: number;
};

export const summarizeOverflowNodes = (nodes: SummarizableNode[]): Record<string, unknown>[] =>
  nodes.map((node) => ({
    firestoreListId: node.firestoreListId,
    subsplashId: node.subsplashId,
    depth: node.depth,
    count: node.count,
    currentItemCount: node.currentItemCount,
    nextSubsplashListId: node.nextSubsplashListId,
  }));

export const summarizeOverflowIssues = (
  issues: Array<GetListOverflowChainIssue | PublishedListDriftIssue>
): Record<string, unknown>[] =>
  issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    firestoreListId: issue.firestoreListId,
    subsplashListId: issue.subsplashListId,
    sermonId: 'sermonId' in issue ? issue.sermonId : undefined,
    mediaItemId: 'mediaItemId' in issue ? issue.mediaItemId : undefined,
    localPosition: 'localPosition' in issue ? issue.localPosition : undefined,
    remotePosition: 'remotePosition' in issue ? issue.remotePosition : undefined,
    message: issue.message,
  }));

export const summarizeAssignments = (assignments: ReorderListItemsAssignment[]): Record<string, unknown>[] =>
  assignments.map((assignment) => ({
    mediaItemId: assignment.mediaItemId,
    firestoreListId: assignment.firestoreListId,
    subsplashListId: assignment.subsplashListId,
    overflowDepth: assignment.overflowDepth,
    position: assignment.position,
  }));

const toSerializable = (value: unknown): unknown => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toSerializable(entry)])
    );
  }

  return String(value);
};

export const listDebugLog = (event: string, payload?: Record<string, unknown>): void => {
  if (!LIST_DEBUG_ENABLED) {
    return;
  }

  logger.log(`[list-debug] ${event}`, toSerializable(payload ?? {}));
};

export const listDebugWarn = (event: string, payload?: Record<string, unknown>): void => {
  if (!LIST_DEBUG_ENABLED) {
    return;
  }

  logger.warn(`[list-debug] ${event}`, toSerializable(payload ?? {}));
};

export const listDebugError = (event: string, payload?: Record<string, unknown>): void => {
  if (!LIST_DEBUG_ENABLED) {
    return;
  }

  logger.error(`[list-debug] ${event}`, toSerializable(payload ?? {}));
};
