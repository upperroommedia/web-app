import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  isDurableJobTerminal,
  type DurableEntityRef,
  type DurableJob,
  type DurableJobRef,
} from '@upperroom/contracts/temporal';
import firestore, {
  collection,
  doc,
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  startAfter,
} from '../firebase/firestore';
import firebase from '../firebase/firebase';
import useAuth from '../context/user/UserContext';
import { ACTIVITY_PAGE_SIZE, buildJobPage, compareJobCreationDescending, type JobPageCursor } from '../utils/jobPaging';
import { jobRegistry, type JobSnapshot, type JobSource } from '../context/jobs/jobRegistry';

const EMPTY: JobSnapshot = { jobs: [], loading: false, stale: true, error: null };
const JOB_COLLECTION = 'durableJobs';
const ACTIVE_STATES = [
  'awaiting_source',
  'queued',
  'running',
  'retrying',
  'waiting_for_auth',
  'cancel_requested',
  'reconciling',
  'needs_attention',
];
type JobFilter = {
  entity?: DurableEntityRef;
  summaryEntity?: DurableEntityRef;
  jobId?: string;
  jobIds?: string[];
  count?: number;
  enabled?: boolean;
  activeOnly?: boolean;
  attentionOnly?: boolean;
  cursor?: JobPageCursor;
};

function mergeWindows(windows: readonly (readonly DurableJob[])[]): DurableJob[] {
  const jobs = new Map<string, DurableJob>();
  windows.flat().forEach((job) => {
    if (!jobs.has(job.jobId) || jobs.get(job.jobId)!.revision < job.revision) jobs.set(job.jobId, job);
  });
  return [...jobs.values()].sort(compareJobCreationDescending);
}

function useJobWindow({
  entity,
  summaryEntity,
  jobId,
  jobIds,
  count = 100,
  enabled = true,
  activeOnly = false,
  attentionOnly = false,
  cursor,
}: JobFilter = {}): JobSnapshot {
  const { user } = useAuth();
  const uid = user?.uid;
  const broad = Boolean(user?.isAdmin());
  const type = entity?.type;
  const id = entity?.id;
  const cursorTime = cursor?.createdAt;
  const cursorId = cursor?.jobId;
  const idsKey = jobIds?.join(',');
  const key =
    uid && enabled
      ? [
          firebase.options.projectId,
          uid,
          broad,
          type,
          id,
          jobId,
          idsKey,
          count,
          activeOnly,
          attentionOnly,
          cursorTime,
          cursorId,
        ].join(':')
      : '';
  const source = useMemo<JobSource>(
    () => (next, fail) => {
      if (!uid) return () => undefined;
      const failure = () => fail('Live activity could not be refreshed. Displayed status may be outdated.');
      if (jobId) {
        return onSnapshot(
          doc(firestore, JOB_COLLECTION, jobId),
          { includeMetadataChanges: true },
          (snapshot) => {
            next(snapshot.exists() ? [snapshot.data() as DurableJob] : [], snapshot.metadata.fromCache);
          },
          failure
        );
      }
      const filters = broad || (type === 'user' && id === uid) ? [] : [where('requestedBy', '==', uid)];
      if (idsKey) {
        const refsQuery = query(
          collection(firestore, JOB_COLLECTION),
          where(documentId(), 'in', idsKey.split(',')),
          limit(10)
        );
        return onSnapshot(
          refsQuery,
          { includeMetadataChanges: true },
          (snapshot) => {
            next(
              snapshot.docs.map((item) => item.data() as DurableJob),
              snapshot.metadata.fromCache
            );
          },
          failure
        );
      }
      if (type && id) filters.push(where('entity.type', '==', type), where('entity.id', '==', id));
      if (activeOnly || attentionOnly)
        filters.push(
          where('state', 'in', attentionOnly ? ['needs_attention', 'waiting_for_auth', 'failed'] : ACTIVE_STATES)
        );
      const jobsQuery = query(
        collection(firestore, JOB_COLLECTION),
        ...filters,
        orderBy('createdAt', 'desc'),
        orderBy(documentId(), 'desc'),
        ...(cursorTime !== undefined && cursorId ? [startAfter(cursorTime, cursorId)] : []),
        limit(count)
      );
      return onSnapshot(
        jobsQuery,
        { includeMetadataChanges: true },
        (snapshot) => {
          next(
            snapshot.docs.map((item) => item.data() as DurableJob),
            snapshot.metadata.fromCache
          );
        },
        failure
      );
    },
    [uid, broad, type, id, jobId, idsKey, count, activeOnly, attentionOnly, cursorTime, cursorId]
  );
  const subscribe = useCallback(
    (listener: () => void) => (key ? jobRegistry.subscribe(key, source, listener) : () => undefined),
    [key, source]
  );
  const summaryType = summaryEntity?.type;
  const summaryId = summaryEntity?.id;
  const snapshot = useCallback(
    () =>
      !key
        ? EMPTY
        : summaryType && summaryId
        ? jobRegistry.entitySnapshot(key, { type: summaryType, id: summaryId })
        : jobRegistry.snapshot(key),
    [key, summaryType, summaryId]
  );
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** Activity and all compact cards share this bounded, identity-scoped window. */
export function useVisibleJobs(activeOnly = false, attentionOnly = false): JobSnapshot {
  const { user } = useAuth();
  const actorJobs = useJobWindow({ activeOnly, attentionOnly });
  const subjectJobs = useJobWindow({
    activeOnly,
    attentionOnly,
    entity: { type: 'user', id: user?.uid ?? '' },
    enabled: Boolean(user && !user.isAdmin()),
  });
  const jobs = useMemo(
    () => mergeWindows([actorJobs.jobs, subjectJobs.jobs]).slice(0, 100),
    [actorJobs.jobs, subjectJobs.jobs]
  );
  const observesSubject = Boolean(user && !user.isAdmin());
  return {
    jobs,
    loading: actorJobs.loading || (observesSubject && subjectJobs.loading),
    stale: actorJobs.stale || (observesSubject && subjectJobs.stale),
    error: actorJobs.error ?? subjectJobs.error,
  };
}
/** Activity pages retain only one bounded live window, never an accumulated collection. */
export function useVisibleJobPage(filter: 'all' | 'active' | 'attention', cursor?: JobPageCursor) {
  const { user } = useAuth();
  const activeOnly = filter === 'active';
  const attentionOnly = filter === 'attention';
  const count = ACTIVITY_PAGE_SIZE + 1;
  const actorJobs = useJobWindow({ activeOnly, attentionOnly, count, cursor });
  const observesSubject = Boolean(user && !user.isAdmin());
  const subjectJobs = useJobWindow({
    activeOnly,
    attentionOnly,
    count,
    cursor,
    entity: { type: 'user', id: user?.uid ?? '' },
    enabled: observesSubject,
  });
  const page = useMemo(() => buildJobPage([actorJobs.jobs, subjectJobs.jobs]), [actorJobs.jobs, subjectJobs.jobs]);
  return {
    ...page,
    loading: actorJobs.loading || (observesSubject && subjectJobs.loading),
    stale: actorJobs.stale || (observesSubject && subjectJobs.stale),
    error: actorJobs.error ?? subjectJobs.error,
  };
}
export function useEntityJobs(
  entity: DurableEntityRef,
  activeRefs?: Record<string, DurableJobRef | undefined>
): JobSnapshot {
  const recent = useJobWindow({ entity, count: 25, enabled: Boolean(entity.id) });
  const ids = Object.values(activeRefs ?? {})
    .filter((ref): ref is DurableJobRef => Boolean(ref && ref.projectId === firebase.options.projectId))
    .map((ref) => ref.jobId)
    .filter((jobId) => !recent.jobs.some((job) => job.jobId === jobId))
    .sort();
  const active = useJobWindow({ jobIds: ids, enabled: ids.length > 0, count: 10 });
  const jobs = useMemo(() => mergeWindows([recent.jobs, active.jobs]), [recent.jobs, active.jobs]);
  return {
    jobs,
    loading: recent.loading || (ids.length > 0 && active.loading),
    stale: recent.stale || (ids.length > 0 && active.stale),
    error: recent.error ?? active.error,
  };
}
export function useDurableJob(jobId?: string) {
  const value = useJobWindow({ jobId, count: 1, enabled: Boolean(jobId) });
  return { ...value, job: jobId ? value.jobs.find((job) => job.jobId === jobId) : undefined };
}
export function useEntityJobSummary(entity: DurableEntityRef, activeRefs?: Record<string, DurableJobRef | undefined>) {
  // Select within the shared transport: unrelated task updates do not rerender every card.
  const { jobs, ...status } = useJobWindow({ summaryEntity: entity });
  const ids = Object.values(activeRefs ?? {})
    .filter((ref): ref is DurableJobRef => Boolean(ref && ref.projectId === firebase.options.projectId))
    .map((ref) => ref.jobId)
    .filter((jobId) => !jobs.some((job) => job.jobId === jobId))
    .sort();
  const outsideWindow = useJobWindow({ jobIds: ids, count: 10, enabled: ids.length > 0 });
  const entityJobs = [...outsideWindow.jobs, ...jobs]
    .filter((job) => job.entity.type === entity.type && job.entity.id === entity.id)
    .sort(compareJobCreationDescending);
  return {
    ...status,
    stale: status.stale || (ids.length > 0 && outsideWindow.stale),
    error: status.error ?? outsideWindow.error,
    job: entityJobs.find((job) => !isDurableJobTerminal(job.state)) ?? entityJobs[0],
  };
}
