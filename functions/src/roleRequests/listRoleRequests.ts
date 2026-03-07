import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import {
  ListRoleRequestsInputType,
  ListRoleRequestsOutputType,
  PersistedRoleRequestDocument,
  ROLE_REQUESTS_COLLECTION,
} from './roleRequestTypes';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAGE_TOKEN_VERSION = 1;

interface RoleRequestCursor {
  v: number;
  requesterUid: string;
  lastDocId: string;
}

const resolveLimit = (rawLimit: unknown): number => {
  if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
    return DEFAULT_LIMIT;
  }
  const normalized = Math.floor(rawLimit);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > MAX_LIMIT) {
    return MAX_LIMIT;
  }
  return normalized;
};

const encodeCursor = (cursor: RoleRequestCursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (pageToken: unknown): RoleRequestCursor | null => {
  if (typeof pageToken !== 'string' || pageToken.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as Partial<RoleRequestCursor>;
    if (
      parsed.v !== PAGE_TOKEN_VERSION ||
      typeof parsed.requesterUid !== 'string' ||
      typeof parsed.lastDocId !== 'string' ||
      parsed.lastDocId.trim().length === 0
    ) {
      return null;
    }

    return {
      v: PAGE_TOKEN_VERSION,
      requesterUid: parsed.requesterUid,
      lastDocId: parsed.lastDocId,
    };
  } catch {
    return null;
  }
};

const resolveTargetRequesterUid = (
  request: CallableRequest<ListRoleRequestsInputType>
): { requesterUid: string; isAdmin: boolean } | null => {
  const authenticatedUid = request.auth?.uid;
  if (!authenticatedUid) {
    return null;
  }

  const isAdmin = request.auth?.token.role === 'admin';
  const requestedUid =
    typeof request.data?.requesterUid === 'string' && request.data.requesterUid.trim().length > 0
      ? request.data.requesterUid.trim()
      : null;

  if (isAdmin) {
    return {
      requesterUid: requestedUid ?? '',
      isAdmin: true,
    };
  }

  if (requestedUid && requestedUid !== authenticatedUid) {
    return null;
  }

  return {
    requesterUid: authenticatedUid,
    isAdmin: false,
  };
};

export const listRoleRequestsHandler = async (
  request: CallableRequest<ListRoleRequestsInputType>
): Promise<ListRoleRequestsOutputType> => {
  const access = resolveTargetRequesterUid(request);
  if (!access) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const limit = resolveLimit(request.data?.limit);
  const collection = firebaseAdmin.firestore().collection(ROLE_REQUESTS_COLLECTION);
  const requesterScope = access.requesterUid;
  const parsedCursor = decodeCursor(request.data?.pageToken);
  if (request.data?.pageToken && !parsedCursor) {
    return { status: 'error', error: 'Invalid page token.' };
  }
  if (parsedCursor && parsedCursor.requesterUid !== requesterScope) {
    return { status: 'error', error: 'Page token does not match request scope.' };
  }

  let query =
    access.isAdmin && requesterScope.length === 0
      ? collection.orderBy('createdAtMs', 'desc')
      : collection.where('requesterUid', '==', requesterScope).orderBy('createdAtMs', 'desc');

  if (parsedCursor) {
    const cursorSnapshot = await collection.doc(parsedCursor.lastDocId).get();
    if (!cursorSnapshot.exists) {
      return {
        status: 'success',
        data: {
          roleRequests: [],
        },
      };
    }
    query = query.startAfter(cursorSnapshot);
  }

  const snapshot = await query.limit(limit + 1).get();
  const hasNextPage = snapshot.docs.length > limit;
  const selectedDocs = hasNextPage ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const selectedDocuments = selectedDocs.map((doc) => ({ id: doc.id, data: doc.data() as PersistedRoleRequestDocument }));

  return {
    status: 'success',
    data: {
      roleRequests: selectedDocuments.map(({ id, data }) => ({
        roleRequestId: id,
        requesterUid: data.requesterUid,
        requesterEmail: data.requesterEmail,
        requesterDisplayName: data.requesterDisplayName,
        requestedRole: data.requestedRole,
        reason: data.reason,
        status: data.status,
        createdAtMs: data.createdAtMs,
        updatedAtMs: data.updatedAtMs,
        notificationStatus: data.notification.status,
        notificationAttemptedAtMs: data.notification.attemptedAtMs,
      })),
      ...(hasNextPage && selectedDocuments.length > 0
        ? {
            nextPageToken: encodeCursor({
              v: PAGE_TOKEN_VERSION,
              requesterUid: requesterScope,
              lastDocId: selectedDocuments[selectedDocuments.length - 1].id,
            }),
          }
        : {}),
    },
  };
};

const listrolerequests = onCall(listRoleRequestsHandler);

export default listrolerequests;
