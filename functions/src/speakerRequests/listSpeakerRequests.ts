import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import handleError from '../handleError';
import {
  ListSpeakerRequestsInputType,
  ListSpeakerRequestsOutputType,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUESTS_COLLECTION,
} from './speakerRequestTypes';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAGE_TOKEN_VERSION = 1;

interface SpeakerRequestCursor {
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

const encodeCursor = (cursor: SpeakerRequestCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (pageToken: unknown): SpeakerRequestCursor | null => {
  if (typeof pageToken !== 'string' || pageToken.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as Partial<SpeakerRequestCursor>;
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
  request: CallableRequest<ListSpeakerRequestsInputType>
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

export const listSpeakerRequestsHandler = async (
  request: CallableRequest<ListSpeakerRequestsInputType>
): Promise<ListSpeakerRequestsOutputType> => {
  try {
    const access = resolveTargetRequesterUid(request);
    if (!access) {
      return { status: 'error', error: 'Not Authorized' };
    }

    const limit = resolveLimit(request.data?.limit);
    const collection = firebaseAdmin.firestore().collection(SPEAKER_REQUESTS_COLLECTION);
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
            speakerRequests: [],
          },
        };
      }
      query = query.startAfter(cursorSnapshot);
    }

    const snapshot = await query.limit(limit + 1).get();
    const hasNextPage = snapshot.docs.length > limit;
    const selectedDocs = hasNextPage ? snapshot.docs.slice(0, limit) : snapshot.docs;
    const selectedDocuments = selectedDocs.map((doc) => ({
      id: doc.id,
      data: doc.data() as PersistedSpeakerRequestDocument & {
        confirmationNotification?: { attemptedAtMs?: number };
      },
    }));

    return {
      status: 'success',
      data: {
        speakerRequests: selectedDocuments.map(({ id, data }) => ({
          speakerRequestId: id,
          requesterUid: data.requesterUid,
          requesterEmail: data.requesterEmail,
          requesterDisplayName: data.requesterDisplayName,
          speakerName: data.speakerName,
          description: data.description,
          image: data.image,
          status: data.status,
          createdAtMs: data.createdAtMs,
          updatedAtMs: data.updatedAtMs,
          notificationStatus: data.notification.status,
          notificationAttemptedAtMs: data.notification.attemptedAtMs,
          resolvedAtMs: data.resolvedAtMs,
          resolvedByUid: data.resolvedByUid,
          resolvedByEmail: data.resolvedByEmail,
          declineMessage: data.declineMessage,
          speakerId: data.speakerId,
          speakerNameAtResolution: data.speakerNameAtResolution,
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
  } catch (error) {
    handleError(error, {
      alertCode: 'LIST_SPEAKER_REQUESTS_RUNTIME_FAILURE',
      summary: 'listSpeakerRequests failed while loading speaker request history.',
      request,
      context: {
        functionName: 'listSpeakerRequests',
        limit: request.data?.limit ?? null,
        requesterUid: request.data?.requesterUid ?? null,
      },
    });
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

const listspeakerrequests = onCall(listSpeakerRequestsHandler);

export default listspeakerrequests;
