import { useId, useMemo, useState } from 'react';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import { useProviderEnvironment } from '../context/provider/ProviderEnvironmentContext';
import { SIMULATION_SCENARIO_LABELS } from '../utils/providerSimulation';
import type { ProviderSimulationScenario } from '@upperroom/contracts/temporal';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Skeleton from '@mui/material/Skeleton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTheme } from '@mui/material/styles';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import StatusChip, {
  SoundCloudChipAvatar,
  ExternalDestinationLink,
  getSeriesAvatarImage,
} from './PublishDestinationChip';
import PlainJobStatus from './jobs/PlainJobStatus';
import { seriesConverter } from '../types/Series';
import type { SermonList } from '../types/SermonList';
import type { PublishDestinationState } from '../utils/sermonPublishingUi';
import { buildBasicPublishActionPlan, summarizeAdvancedSelectionChanges } from '../utils/sermonPublishActions';
import Checkbox from '@mui/material/Checkbox';
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
  showActivityHistory?: boolean;
}

function SermonPublishPanel({
  sermon,
  initialAdvancedOpen = false,
  showActivityHistory = true,
  onRequestAddToSeries: _onRequestAddToSeries,
}: SermonPublishPanelProps) {
  const { user } = useAuth();
  const theme = useTheme();
  const advancedConfigId = useId();
  const environment = useProviderEnvironment();
  const [scenario, setScenario] = useState<ProviderSimulationScenario>('success');
  const simulation = environment.status?.mode === 'sandbox';
  const modeUnavailable = environment.loading || environment.error || !environment.status?.ready;
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
  const metadataRef = useMemo(
    () => (sermon.seriesId ? doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter) : null),
    [sermon.seriesId]
  );
  const [series] = useDocumentData(metadataRef);
  const [advancedOpen, setAdvancedOpen] = useState(initialAdvancedOpen);
  // An explicit empty selection stays empty. Incoming snapshots never reset user choices.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [seriesChoice, setSeriesChoice] = useState<boolean | null>(null);
  const [soundcloudChoice, setSoundcloudChoice] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingMode, setSubmittingMode] = useState<'publish' | 'unpublish' | 'advanced' | 'checking'>();
  const [acceptedJobId, setAcceptedJobId] = useState<string>();
  // The receipt may outlive the bounded history window. Observe its execution directly.
  const acceptedExecution = useDurableJob(acceptedJobId);
  const acceptedStale = Boolean(acceptedJobId && acceptedExecution.stale);
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
    modeUnavailable ||
    submitting ||
    Boolean(uncertainIntent) ||
    acceptedStale ||
    busy ||
    jobsLoading ||
    listsLoading ||
    seriesLoading ||
    stale ||
    Boolean(jobsError || listsError || seriesError);
  const canPublish = sermon.status.audioStatus === sermonStatusType.PROCESSED || Boolean(sermon.subsplashId);

  async function submit(mode: 'publish' | 'unpublish' | 'advanced') {
    setSubmittingMode(mode);
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
        payload: {
          ...payload,
          ...(simulation && environment.status?.scenarioSelectionAllowed
            ? { providerSimulationScenario: scenario }
            : {}),
        },
      };
      setUncertainIntent(intent);
      const receipt = await submitDurableIntent(intent);
      setAcceptedJobId(receipt.jobId);
      setUncertainIntent(undefined);
      setNotice({
        severity: 'info',
        message: 'Request accepted. You can close this panel; progress stays available on this sermon.',
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
      setSubmittingMode(undefined);
    }
  }

  async function resolveAdmission() {
    if (!uncertainIntent) return;
    setSubmittingMode('checking');
    setSubmitting(true);
    try {
      const receipt = await submitDurableIntent(uncertainIntent);
      setAcceptedJobId(receipt.jobId);
      setUncertainIntent(undefined);
      setNotice({ severity: 'info', message: 'Request confirmed. Its current status is shown here.' });
    } catch (error) {
      if (!(error instanceof DurableAdmissionUnknownError)) setUncertainIntent(undefined);
      setNotice({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Unable to confirm this request yet.',
      });
    } finally {
      setSubmitting(false);
      setSubmittingMode(undefined);
    }
  }

  const currentJob =
    (acceptedJob && !isDurableJobTerminal(acceptedJob.state) ? acceptedJob : undefined) ??
    jobs.find((job) => !isDurableJobTerminal(job.state)) ??
    acceptedJob ??
    jobs.find((job) => job.kind === 'sermon.publish' || job.kind === 'sermon.unpublish');
  const listArray = items;
  const isListDataLoading = listsLoading;
  const listSkeletonCount = 3;
  const listError = listsError;
  const loading = listsLoading;
  const selectedListIds = new Set(selection);
  const selectedSeriesEnabled = input.seriesSelected;
  const selectedSoundCloudEnabled = input.soundcloudSelected;
  const isBusy = unavailable;
  const changing = currentJob && ['queued', 'running', 'retrying', 'reconciling'].includes(currentJob.state);
  const isRunningBasicPublish = Boolean(
    (submitting && submittingMode === 'publish') || (changing && currentJob.kind === 'sermon.publish')
  );
  const isRunningBasicUnpublish = Boolean(
    (submitting && submittingMode === 'unpublish') || (changing && currentJob.kind === 'sermon.unpublish')
  );
  const isApplyingAdvancedChanges = submitting && submittingMode === 'advanced';
  const basicActionPlan = buildBasicPublishActionPlan({
    lists: items,
    hasSeriesId: Boolean(sermon.seriesId),
    seriesPublished,
    canPublishToSeries: canPublish,
    isSoundCloudUploaded: soundcloudPublished,
    isDevelopment,
  });
  const advancedSummary = summarizeAdvancedSelectionChanges({
    publishListCount: advancedPayload.destinations.listIds.length,
    unpublishListCount: advancedPayload.removals.listIds.length,
    publishSeries: Boolean(advancedPayload.destinations.seriesId),
    unpublishSeries: Boolean(advancedPayload.removals.seriesId),
    publishSoundCloud: advancedPayload.destinations.soundcloud,
    unpublishSoundCloud: advancedPayload.removals.soundcloud,
  });
  const advancedActionPlan = {
    color: advancedSummary.isMixedDirection
      ? ('warning' as const)
      : advancedSummary.isPureUnpublish
      ? ('error' as const)
      : ('primary' as const),
    icon: advancedSummary.isMixedDirection ? (
      <RefreshIcon />
    ) : advancedSummary.isPureUnpublish ? (
      <CloudOffIcon />
    ) : (
      <CloudUploadIcon />
    ),
    run: () => submit('advanced'),
    disabled:
      unavailable ||
      !hasPublishIntentChanges(advancedPayload) ||
      (!canPublish &&
        (advancedPayload.destinations.listIds.length > 0 ||
          Boolean(advancedPayload.destinations.seriesId) ||
          advancedPayload.destinations.soundcloud)),
    pendingLabel: 'Applying changes…',
    label: advancedSummary.label,
  };
  const publishEverywhere = () => submit('publish');
  const unpublishEverywhere = () => submit('unpublish');
  // These are the last confirmed destination projections written by durable activities.
  // The independent live request summary above reports progress, uncertainty and attention.
  const getListChipStatus = (list: SermonList): PublishDestinationState =>
    stale || Boolean(jobsError || listsError) || listsLoading
      ? { state: 'checking', label: 'Checking status' }
      : list.uploadStatus?.status === uploadStatus.UPLOADED
      ? { state: 'published', label: 'Published' }
      : list.uploadStatus?.status === uploadStatus.ERROR
      ? { state: 'error', label: 'Needs attention', details: list.uploadStatus.reason }
      : { state: 'not_published', label: 'Not published' };
  const listChipTooltip = (list: SermonList) => getListChipStatus(list).details || getListChipStatus(list).label;
  const seriesStatus: PublishDestinationState =
    stale || Boolean(jobsError || seriesError) || seriesLoading
      ? { state: 'checking', label: 'Checking status' }
      : seriesPublished
      ? { state: 'published', label: 'Published' }
      : { state: 'not_published', label: 'Not published' };
  const seriesChipTooltip = seriesStatus.label;
  const soundCloudStatus: PublishDestinationState =
    stale || Boolean(jobsError)
      ? { state: 'checking', label: 'Checking status' }
      : sermon.status.soundCloud === uploadStatus.ERROR
      ? { state: 'error', label: 'Needs attention' }
      : soundcloudPublished
      ? { state: 'published', label: soundcloudAccessLabel }
      : { state: 'not_published', label: 'Not published' };
  const destinationErrors = { soundcloud: undefined };
  const soundCloudExternalUrl =
    !simulation && !modeUnavailable && soundcloudPublished && !stale ? sermon.soundCloudTrackUrl : undefined;
  const actionButtonSx = {
    minHeight: { xs: 34, sm: 40, md: 44 },
    px: { xs: 1.25, sm: 1.75 },
    py: { xs: 0.45, sm: 0.9 },
    fontSize: { xs: '0.76rem', sm: '0.9rem', md: '0.96rem' },
    '& .MuiButton-startIcon svg': {
      fontSize: { xs: '0.95rem', sm: '1.1rem', md: '1.2rem' },
    },
  };

  return (
    <Stack spacing={2.5}>
      {notice ? <Alert severity={notice.severity}>{notice.message}</Alert> : null}
      {modeUnavailable && (
        <Alert severity="warning">Publishing is paused until the server confirms the publishing mode.</Alert>
      )}
      {simulation && environment.status?.scenarioSelectionAllowed && (
        <Stack spacing={1}>
          <TextField
            select
            label="Scenario for the next simulated request"
            value={scenario}
            disabled={unavailable}
            onChange={(event) => setScenario(event.target.value as ProviderSimulationScenario)}
          >
            {Object.entries(SIMULATION_SCENARIO_LABELS).map(([value, label]) => (
              <MenuItem key={value} value={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            Applies to publish and unpublish requests. Retries keep the task’s original scenario. Missing staging
            catalog resources must be imported before testing.
          </Typography>
        </Stack>
      )}
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

      {currentJob ? (
        <PlainJobStatus job={currentJob} stale={stale || acceptedStale} />
      ) : acceptedJobId ? (
        <Typography variant="body2" role="status">
          Checking the accepted request’s current status…
        </Typography>
      ) : null}

      <Stack spacing={1.25}>
        <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
          >
            Lists
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {isListDataLoading
              ? Array.from({ length: listSkeletonCount }).map((_, index) => (
                  <Skeleton
                    key={`list-skeleton-${index}`}
                    variant="rounded"
                    width={index === 0 ? 132 : index === 1 ? 112 : 124}
                    height={32}
                    sx={{ borderRadius: 999 }}
                  />
                ))
              : listArray.map((list) => {
                  const chipStatus = getListChipStatus(list);
                  return (
                    <StatusChip
                      key={list.id}
                      label={
                        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                          <Box
                            component="span"
                            sx={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {list.name}
                          </Box>
                          {!simulation &&
                          !modeUnavailable &&
                          list.uploadStatus?.status === uploadStatus.UPLOADED &&
                          list.subsplashId ? (
                            <ExternalDestinationLink
                              href={`https://dashboard.subsplash.com/-d/#/library/lists/standard/${list.subsplashId}`}
                              label={`Open ${list.name} in Subsplash`}
                            />
                          ) : null}
                        </Stack>
                      }
                      status={chipStatus}
                      tooltip={listChipTooltip(list)}
                      avatar={
                        <AvatarWithDefaultImage
                          image={list.images?.find((image) => image.type === 'square')}
                          altName={list.name}
                          width={26}
                          height={26}
                          borderRadius={999}
                        />
                      }
                    />
                  );
                })}
          </Box>
        </Box>

        {sermon.seriesId ? (
          <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
            >
              Series
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <StatusChip
                label={
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                    <Box
                      component="span"
                      sx={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {series?.name || 'Series'}
                    </Box>
                    {!simulation && !modeUnavailable && seriesPublished === true && series?.subsplashId ? (
                      <ExternalDestinationLink
                        href={`https://dashboard.subsplash.com/-d/#/library/media/series/${series.subsplashId}`}
                        label={`Open ${series.name} in Subsplash`}
                      />
                    ) : null}
                  </Stack>
                }
                status={seriesStatus}
                tooltip={seriesChipTooltip}
                avatar={
                  <AvatarWithDefaultImage
                    image={getSeriesAvatarImage(series ?? null)}
                    altName={series?.name || 'Series'}
                    width={26}
                    height={26}
                    borderRadius={999}
                  />
                }
              />
            </Box>
          </Box>
        ) : null}

        <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
          >
            SoundCloud
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <StatusChip
              label={
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                  <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                    SoundCloud
                  </Box>
                  {soundCloudExternalUrl ? (
                    <ExternalDestinationLink href={soundCloudExternalUrl} label="Open SoundCloud track" />
                  ) : null}
                </Stack>
              }
              status={soundCloudStatus}
              tooltip={destinationErrors.soundcloud || soundCloudStatus.details}
              avatar={<SoundCloudChipAvatar />}
            />
          </Box>
        </Box>
      </Stack>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        spacing={1.5}
        alignItems={{ xs: 'stretch', sm: 'center' }}
      >
        <Button
          variant="text"
          size="small"
          endIcon={
            <ExpandMoreIcon
              sx={{ transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}
            />
          }
          aria-expanded={advancedOpen}
          aria-controls={advancedConfigId}
          onClick={() => setAdvancedOpen((previous) => !previous)}
          sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
        >
          {advancedOpen ? 'Hide advanced config' : 'Advanced publish config'}
        </Button>
        {!advancedOpen ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="flex-end">
            {basicActionPlan.showPublishButton ? (
              <Button
                variant="contained"
                size="large"
                color="primary"
                startIcon={isRunningBasicPublish ? <CircularProgress size={18} color="inherit" /> : <CloudUploadIcon />}
                onClick={() => {
                  void publishEverywhere();
                }}
                disabled={isBusy || !canPublish}
                sx={actionButtonSx}
              >
                {isRunningBasicPublish ? 'Publishing…' : basicActionPlan.publishLabel}
              </Button>
            ) : null}
            {basicActionPlan.showUnpublishButton ? (
              <Button
                variant="contained"
                size="large"
                color="error"
                startIcon={isRunningBasicUnpublish ? <CircularProgress size={18} color="inherit" /> : <CloudOffIcon />}
                onClick={() => {
                  void unpublishEverywhere();
                }}
                disabled={isBusy}
                sx={actionButtonSx}
              >
                {isRunningBasicUnpublish ? 'Unpublishing From Everywhere…' : 'Unpublish From Everywhere'}
              </Button>
            ) : null}
            {!basicActionPlan.showPublishButton && !basicActionPlan.showUnpublishButton ? (
              <Button
                variant="contained"
                size="large"
                color="primary"
                startIcon={<CloudUploadIcon />}
                disabled
                sx={actionButtonSx}
              >
                Nothing to publish
              </Button>
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      <Collapse id={advancedConfigId} in={advancedOpen} timeout="auto" unmountOnExit>
        <Stack spacing={2.5} sx={{ pt: 0.5 }}>
          <Divider />

          <Stack spacing={1.25}>
            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                Lists
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
                Uncheck any published list to unpublish it. Check any ready list to publish it.
              </Typography>
              {listError ? (
                <Alert severity="error">{listError.message}</Alert>
              ) : isListDataLoading ? (
                <Stack spacing={1}>
                  {Array.from({ length: listSkeletonCount }).map((_, index) => (
                    <Box
                      key={`advanced-list-skeleton-${index}`}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1.5,
                        p: 1,
                        borderRadius: 2,
                        border: `1px solid ${theme.palette.divider}`,
                      }}
                    >
                      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ flex: 1 }}>
                        <Skeleton variant="circular" width={34} height={34} />
                        <Skeleton
                          variant="text"
                          width={index === 0 ? '34%' : index === 1 ? '26%' : '30%'}
                          height={24}
                        />
                      </Stack>
                      <Skeleton variant="rounded" width={92} height={28} sx={{ borderRadius: 999 }} />
                    </Box>
                  ))}
                </Stack>
              ) : loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                  <CircularProgress />
                </Box>
              ) : listArray.length === 0 ? (
                <Alert severity="info">This sermon is not assigned to any publish lists.</Alert>
              ) : (
                <Stack spacing={1}>
                  {listArray.map((list) => {
                    const chipStatus = getListChipStatus(list);
                    return (
                      <Box
                        key={list.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 1.5,
                          p: 1,
                          borderRadius: 2,
                          border: `1px solid ${theme.palette.divider}`,
                        }}
                      >
                        <FormControlLabel
                          control={
                            <Checkbox
                              disabled={unavailable}
                              checked={selectedListIds.has(list.id)}
                              onChange={(event) => {
                                setSelectedIds(
                                  event.target.checked
                                    ? [...selection, list.id]
                                    : selection.filter((id) => id !== list.id)
                                );
                              }}
                            />
                          }
                          label={
                            <Stack direction="row" spacing={1.25} alignItems="center">
                              <AvatarWithDefaultImage
                                image={list.images?.find((image) => image.type === 'square')}
                                altName={list.name}
                                width={34}
                                height={34}
                                borderRadius={8}
                              />
                              <Typography variant="body2">{list.name}</Typography>
                            </Stack>
                          }
                          sx={{ m: 0, flex: 1 }}
                        />
                        <StatusChip label={chipStatus.label} status={chipStatus} tooltip={listChipTooltip(list)} />
                      </Box>
                    );
                  })}
                </Stack>
              )}
            </Box>

            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                Series
              </Typography>
              {!sermon.seriesId ? (
                <Alert severity="info">This sermon is not assigned to a series.</Alert>
              ) : (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    p: 1,
                    borderRadius: 2,
                    border: `1px solid ${theme.palette.divider}`,
                  }}
                >
                  <FormControlLabel
                    control={
                      <Checkbox
                        disabled={unavailable}
                        checked={selectedSeriesEnabled}
                        onChange={(event) => {
                          setSeriesChoice(event.target.checked);
                        }}
                      />
                    }
                    label={
                      <Stack direction="row" spacing={1.25} alignItems="center">
                        <AvatarWithDefaultImage
                          image={getSeriesAvatarImage(series ?? null)}
                          altName={series?.name || 'Series'}
                          width={34}
                          height={34}
                          borderRadius={8}
                        />
                        <Typography variant="body2">{series?.name || 'Series'}</Typography>
                      </Stack>
                    }
                    sx={{ m: 0, flex: 1 }}
                  />
                  <StatusChip
                    label={
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                          {seriesStatus.label}
                        </Box>
                        {!simulation && !modeUnavailable && seriesPublished === true && series?.subsplashId ? (
                          <ExternalDestinationLink
                            href={`https://dashboard.subsplash.com/-d/#/library/media/series/${series.subsplashId}`}
                            label={`Open ${series.name} in Subsplash`}
                          />
                        ) : null}
                      </Stack>
                    }
                    status={seriesStatus}
                    tooltip={seriesChipTooltip}
                  />
                </Box>
              )}
            </Box>

            <Box sx={{ borderLeft: 1, borderColor: 'divider', pl: 1.25 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.6, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                SoundCloud
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  p: 1,
                  borderRadius: 2,
                  border: `1px solid ${theme.palette.divider}`,
                }}
              >
                <FormControlLabel
                  control={
                    <Checkbox
                      disabled={unavailable}
                      checked={selectedSoundCloudEnabled}
                      onChange={(event) => {
                        setSoundcloudChoice(event.target.checked);
                      }}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <SoundCloudChipAvatar />
                      <Typography variant="body2">SoundCloud</Typography>
                    </Stack>
                  }
                  sx={{ m: 0, flex: 1 }}
                />
                <StatusChip
                  label={
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                      <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                        {soundCloudStatus.label}
                      </Box>
                      {soundCloudExternalUrl ? (
                        <ExternalDestinationLink href={soundCloudExternalUrl} label="Open SoundCloud track" />
                      ) : null}
                    </Stack>
                  }
                  status={soundCloudStatus}
                  tooltip={destinationErrors.soundcloud || soundCloudStatus.details}
                />
              </Box>
            </Box>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="flex-end">
            <Button
              variant="contained"
              size="large"
              color={advancedActionPlan.color}
              startIcon={
                isApplyingAdvancedChanges ? <CircularProgress size={18} color="inherit" /> : advancedActionPlan.icon
              }
              onClick={() => {
                void advancedActionPlan.run();
              }}
              disabled={advancedActionPlan.disabled}
              sx={actionButtonSx}
            >
              {isApplyingAdvancedChanges ? advancedActionPlan.pendingLabel : advancedActionPlan.label}
            </Button>
          </Stack>
        </Stack>
      </Collapse>
      {showActivityHistory && user?.isAdmin() && (
        <EntityJobHistory entity={entity} activeRefs={sermon.activeDurableJobs} />
      )}
    </Stack>
  );
}

/** Reset selection when navigating between sermons; never reset it on live updates. */
export default function KeyedSermonPublishPanel(props: SermonPublishPanelProps) {
  return <SermonPublishPanel key={props.sermon.id} {...props} />;
}
