import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCollectionData, useDocumentData } from 'react-firebase-hooks/firestore';
import firestore, { collection, doc } from '../firebase/firestore';
import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';
import { sermonListConverter } from '../types/SermonList';
import useAuth from '../context/user/UserContext';
import { isDevelopment } from '../firebase/firebase';
import { DurableAdmissionUnknownError, submitDurableIntent } from '../utils/durableJobs';
import { useDurableJob, useEntityJobs } from '../hooks/useDurableJobs';
import EntityJobHistory from './jobs/EntityJobHistory';
import { isDurableJobTerminal, type DurableAdmissionRequest } from '@upperroom/contracts/temporal';
import { buildSermonPublishIntent, hasPublishIntentChanges } from '../utils/sermonPublishIntent';

interface SermonPublishPanelProps {
  sermon: Sermon;
  onUpdate?: () => void;
  onRequestAddToSeries?: () => void;
  initialAdvancedOpen?: boolean;
}

function SermonPublishPanel({ sermon, initialAdvancedOpen = false, onRequestAddToSeries }: SermonPublishPanelProps) {
  const { user } = useAuth();
  const entity = useMemo(() => ({ type: 'sermon' as const, id: sermon.id }), [sermon.id]);
  const { jobs, loading: jobsLoading, error: jobsError, stale } = useEntityJobs(entity, sermon.activeDurableJobs);
  const listsRef = useMemo(
    () => collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(sermonListConverter),
    [sermon.id]
  );
  const [lists, listsLoading, listsError] = useCollectionData(listsRef);
  const seriesRef = useMemo(
    () => (sermon.seriesId ? doc(firestore, `series/${sermon.seriesId}/seriesItems`, sermon.id) : null),
    [sermon.id, sermon.seriesId]
  );
  const [seriesItem, seriesLoading, seriesError] = useDocumentData(seriesRef);
  const [advanced, setAdvanced] = useState(initialAdvancedOpen);
  // An explicit empty selection stays empty. Incoming snapshots never reset user choices.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [seriesChoice, setSeriesChoice] = useState<boolean | null>(null);
  const [soundcloudChoice, setSoundcloudChoice] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [acceptedJobId, setAcceptedJobId] = useState<string>();
  // The receipt may outlive the bounded history window. Observe its execution directly.
  const acceptedExecution = useDurableJob(acceptedJobId);
  const [uncertainIntent, setUncertainIntent] = useState<Omit<DurableAdmissionRequest, 'requestId'>>();
  const [notice, setNotice] = useState<{ severity: 'info' | 'error'; message: string } | null>(null);
  const items = lists ?? [];
  const selection = selectedIds ?? items.map((list) => list.id);
  const seriesPublished = seriesItem?.publishedToSubsplash === true;
  const soundcloudAccessLabel = sermon.soundCloudPublication
    ? !sermon.soundCloudPublication.streamable
      ? 'Published · streaming disabled'
      : sermon.soundCloudPublication.sharing === 'private'
      ? 'Published · private streaming'
      : 'Published · streaming available'
    : 'Published';
  const soundcloudPublished = sermon.status.soundCloud === uploadStatus.UPLOADED;
  const input = {
    lists: items,
    selectedListIds: selection,
    seriesId: sermon.seriesId,
    seriesSelected: seriesChoice ?? Boolean(sermon.seriesId),
    seriesPublished,
    soundcloudSelected: soundcloudChoice ?? !isDevelopment,
    soundcloudPublished,
  };
  const advancedPayload = buildSermonPublishIntent(input);
  const acceptedJob = acceptedExecution.job ?? jobs.find((job) => job.jobId === acceptedJobId);
  const acceptedRequestBusy = Boolean(acceptedJobId && (!acceptedJob || !isDurableJobTerminal(acceptedJob.state)));
  const busy = acceptedRequestBusy || jobs.some((job) => !isDurableJobTerminal(job.state));
  const unavailable =
    !user?.canPublish() ||
    submitting ||
    Boolean(uncertainIntent) ||
    busy ||
    jobsLoading ||
    listsLoading ||
    seriesLoading ||
    stale ||
    Boolean(jobsError || listsError || seriesError);
  const canPublish = sermon.status.audioStatus === sermonStatusType.PROCESSED || Boolean(sermon.subsplashId);
  const hasPublished =
    items.some((list) => list.uploadStatus?.status === uploadStatus.UPLOADED) || seriesPublished || soundcloudPublished;

  async function submit(mode: 'publish' | 'unpublish' | 'advanced') {
    setSubmitting(true);
    setNotice(null);
    try {
      const payload =
        mode === 'advanced'
          ? advancedPayload
          : mode === 'publish'
          ? buildSermonPublishIntent({
              ...input,
              selectedListIds: items.map((list) => list.id),
              seriesSelected: Boolean(sermon.seriesId),
              soundcloudSelected: !isDevelopment,
            })
          : {
              destinations: {
                listIds: items
                  .filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED)
                  .map((list) => list.id),
                ...(seriesPublished && sermon.seriesId ? { seriesId: sermon.seriesId } : {}),
                soundcloud: soundcloudPublished,
              },
            };
      const intent = {
        kind: mode === 'unpublish' ? ('sermon.unpublish' as const) : ('sermon.publish' as const),
        entity,
        payload,
      };
      setUncertainIntent(intent);
      const receipt = await submitDurableIntent(intent);
      setAcceptedJobId(receipt.jobId);
      setUncertainIntent(undefined);
      setNotice({
        severity: 'info',
        message: 'Request accepted. You can close this panel; progress stays available in Activity and on this sermon.',
      });
    } catch (error) {
      if (!(error instanceof DurableAdmissionUnknownError)) setUncertainIntent(undefined);
      setNotice({
        severity: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to confirm this request. Retry to resolve the same request safely.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function resolveAdmission() {
    if (!uncertainIntent) return;
    setSubmitting(true);
    try {
      const receipt = await submitDurableIntent(uncertainIntent);
      setAcceptedJobId(receipt.jobId);
      setUncertainIntent(undefined);
      setNotice({ severity: 'info', message: 'Request confirmed. Progress is available below and in Activity.' });
    } catch (error) {
      if (!(error instanceof DurableAdmissionUnknownError)) setUncertainIntent(undefined);
      setNotice({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Unable to confirm this request yet.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Publishing continues in the background. Each destination is confirmed separately, and completed destinations
        stay visible if another needs attention.
      </Typography>
      {notice && <Alert severity={notice.severity}>{notice.message}</Alert>}
      {acceptedExecution.error && (
        <Alert severity="warning">
          Unable to refresh the submitted request. Publishing stays paused until its outcome can be confirmed.
        </Alert>
      )}
      {uncertainIntent && (
        <Button disabled={submitting} onClick={() => void resolveAdmission()}>
          Check submitted request
        </Button>
      )}
      {(jobsError || listsError || seriesError) && (
        <Alert severity="error">
          Unable to load current publishing state. Actions are paused until the connection recovers.
        </Alert>
      )}
      {stale && <Alert severity="warning">Reconnecting. Displayed progress may be outdated.</Alert>}
      {busy && <Alert severity="info">A request is already in progress. Follow its steps below.</Alert>}
      <Stack spacing={1}>
        <Typography variant="subtitle1">Destinations</Typography>
        {items.map((list) => (
          <Stack key={list.id} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Typography variant="body2">{list.name}</Typography>
            <Chip
              size="small"
              label={
                list.uploadStatus?.status === uploadStatus.UPLOADED
                  ? 'Published'
                  : list.uploadStatus?.status === uploadStatus.ERROR
                  ? 'Needs attention'
                  : 'Not published'
              }
            />
          </Stack>
        ))}
        {sermon.seriesId ? (
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2">{sermon.seriesName || 'Series'}</Typography>
            <Chip size="small" label={seriesLoading ? 'Loading…' : seriesPublished ? 'Published' : 'Not published'} />
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No series assigned.{onRequestAddToSeries && <Button onClick={onRequestAddToSeries}>Add to series</Button>}
          </Typography>
        )}
        {!isDevelopment && (
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2">SoundCloud</Typography>
            <Chip size="small" label={soundcloudPublished ? soundcloudAccessLabel : 'Not published'} />
          </Stack>
        )}
      </Stack>
      {!canPublish && <Alert severity="info">Audio must finish processing before publishing.</Alert>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button
          variant="contained"
          disabled={
            unavailable ||
            !canPublish ||
            !hasPublishIntentChanges(
              buildSermonPublishIntent({
                ...input,
                selectedListIds: items.map((list) => list.id),
                seriesSelected: Boolean(sermon.seriesId),
                soundcloudSelected: !isDevelopment,
              })
            )
          }
          onClick={() => void submit('publish')}
        >
          {submitting ? 'Submitting…' : 'Publish everywhere'}
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={unavailable || !hasPublished}
          onClick={() => void submit('unpublish')}
        >
          Unpublish everywhere
        </Button>
        <Button onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          Choose destinations
        </Button>
      </Stack>
      <Collapse in={advanced}>
        <Stack spacing={1}>
          <Typography variant="body2">
            Selected destinations will be published. Deselecting a published destination will unpublish it.
          </Typography>
          {items.map((list) => (
            <FormControlLabel
              key={list.id}
              label={list.name}
              control={
                <Checkbox
                  disabled={unavailable}
                  checked={selection.includes(list.id)}
                  onChange={(event) =>
                    setSelectedIds(
                      event.target.checked ? [...selection, list.id] : selection.filter((id) => id !== list.id)
                    )
                  }
                />
              }
            />
          ))}
          {sermon.seriesId && (
            <FormControlLabel
              label={sermon.seriesName || 'Series'}
              control={
                <Checkbox
                  disabled={unavailable}
                  checked={input.seriesSelected}
                  onChange={(event) => setSeriesChoice(event.target.checked)}
                />
              }
            />
          )}
          {!isDevelopment && (
            <FormControlLabel
              label="SoundCloud"
              control={
                <Checkbox
                  disabled={unavailable}
                  checked={input.soundcloudSelected}
                  onChange={(event) => setSoundcloudChoice(event.target.checked)}
                />
              }
            />
          )}
          <Button
            variant="contained"
            disabled={
              unavailable ||
              !hasPublishIntentChanges(advancedPayload) ||
              (!canPublish &&
                (advancedPayload.destinations.listIds.length > 0 ||
                  Boolean(advancedPayload.destinations.seriesId) ||
                  advancedPayload.destinations.soundcloud))
            }
            onClick={() => void submit('advanced')}
          >
            Apply destination changes
          </Button>
        </Stack>
      </Collapse>
      <EntityJobHistory entity={entity} activeRefs={sermon.activeDurableJobs} />
    </Stack>
  );
}

/** Reset selection when navigating between sermons; never reset it on live updates. */
export default function KeyedSermonPublishPanel(props: SermonPublishPanelProps) {
  return <SermonPublishPanel key={props.sermon.id} {...props} />;
}
