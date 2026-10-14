import {
  SIMULATION_SCENARIO_LABELS,
  hasConfirmedCapturedEmail,
  hasStagingEmailCaptureProfile,
} from '../../utils/providerSimulation';
import { useState } from 'react';
import Link from 'next/link';
import type { DurableAction, DurableJob } from '@upperroom/contracts/temporal';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { submitDurableCommand } from '../../utils/durableJobs';
import {
  entityHref,
  jobTitle,
  jobStateLabel,
  stoppedRepairMessage,
  measuredStepPercent,
  hasUnresolvedProviderMutation,
  hasUnsentProviderGraphChange,
  providerMutationReviewMessage,
} from '../../utils/durableJobPresentation';
import { useDurableJob } from '../../hooks/useDurableJobs';
import useAuth from '../../context/user/UserContext';

const ACTION_LABELS: Record<DurableAction, string> = {
  cancel: 'Request cancellation',
  retry: 'Retry failed work',
  resume: 'Resume task',
  resolve: 'Resolve outcome',
  resume_upload: 'Resume source upload',
};
interface Props {
  job: DurableJob;
  compact?: boolean;
  stale?: boolean;
  showEntityLink?: boolean;
}
export default function JobStatusPanel({ job, compact = false, stale = false, showEntityLink = true }: Props) {
  const { user } = useAuth();
  const canCommand = Boolean(user && (user.isAdmin() || user.uid === job.requestedBy));
  const canReview = Boolean(user?.isAdmin());
  const [submitting, setSubmitting] = useState<DurableAction | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string; scope: string } | null>(null);
  const [remoteId, setRemoteId] = useState('');
  const [knownResourceDecision, setKnownResourceDecision] = useState('retain_existing_resource');
  const [orphanDecision, setOrphanDecision] = useState('retain_orphan');
  const [emailDecision, setEmailDecision] = useState('confirm_accepted');
  const [evidence, setEvidence] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [retentionAcknowledged, setRetentionAcknowledged] = useState(false);
  const href = entityHref(job.entity);
  const sourceJobId =
    typeof job.result?.sourceJobId === 'string' &&
    job.result.sourceJobId.length <= 200 &&
    !job.result.sourceJobId.includes('/')
      ? job.result.sourceJobId
      : undefined;
  const blockingJobId =
    typeof job.result?.blockingJobId === 'string' &&
    job.result.blockingJobId.length <= 200 &&
    !job.result.blockingJobId.includes('/')
      ? job.result.blockingJobId
      : undefined;
  const childId =
    job.kind === 'upload.create' && typeof job.result?.mediaJobId === 'string' ? job.result.mediaJobId : undefined;
  const child = useDurableJob(childId);
  const stateLabel = jobStateLabel(job);
  const stoppedMessage = stoppedRepairMessage(job);
  const availableActions = stoppedMessage ? [] : job.actions;
  const mutationReview = hasUnresolvedProviderMutation(job);
  const graphChangedUnsent = hasUnsentProviderGraphChange(job);
  const mutationSessionId =
    mutationReview &&
    typeof job.result?.mutationSessionId === 'string' &&
    /^[a-f0-9]{64}$/.test(job.result.mutationSessionId)
      ? job.result.mutationSessionId
      : undefined;
  const accountSessionsReview =
    ['role.assign', 'role.resolve', 'invite.claim'].includes(job.kind) &&
    job.error?.code === 'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED';
  const accountClaimReview =
    ['role.assign', 'role.resolve', 'invite.claim'].includes(job.kind) &&
    job.error?.code === 'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED';
  const accountReview = accountClaimReview || accountSessionsReview;
  const criticalReview = job.attention?.resolutionKind === 'critical_repair';
  const criticalCertificate =
    criticalReview &&
    typeof job.attention?.certificateId === 'string' &&
    /^[a-f0-9]{64}$/.test(job.attention.certificateId) &&
    ['repair_confirmed_changes', 'complete_fixed_cleanup'].includes(job.attention.repairPurpose ?? '')
      ? job.attention.certificateId
      : undefined;
  const criticalCleanup = job.attention?.repairPurpose === 'complete_fixed_cleanup';
  const criticalRetention = criticalReview && job.attention?.requiresRetentionAcknowledgement === true;
  const knownResourceReview =
    job.attention?.resolutionKind === 'retain_existing_resource' &&
    Boolean(job.attention.receiptId && job.attention.remoteId);
  const orphanReview = Boolean(job.attention?.acknowledgementId);
  const resolutionIdentity = [
    job.jobId,
    String(job.generation),
    job.attention?.acknowledgementId,
    job.attention?.receiptId,
    job.attention?.remoteId,
    job.attention?.certificateId,
    job.attention?.repairPurpose,
    String(job.attention?.requiresRetentionAcknowledgement === true),
    JSON.stringify(job.attention?.resolutionDecisions),
    job.error?.code,
  ].join(':');
  const [reviewIdentity, setReviewIdentity] = useState(resolutionIdentity);
  if (reviewIdentity !== resolutionIdentity) {
    setReviewIdentity(resolutionIdentity);
    setNotice(null);
    setEvidence('');
    setReviewReason('');
    setDuplicateAcknowledged(false);
    setRetentionAcknowledged(false);
    setOrphanDecision('retain_orphan');
    setKnownResourceDecision('retain_existing_resource');
  }
  const cleanupAdoption = job.kind === 'image.delete' && job.result?.resolutionPurpose === 'cleanup';
  const perform = async (action: DurableAction, resolution?: Record<string, unknown>) => {
    setSubmitting(action);
    setNotice(null);
    try {
      await submitDurableCommand(job, action, resolution);
      setNotice({
        scope: resolutionIdentity,
        error: false,
        message:
          action === 'cancel'
            ? 'Cancellation was requested. Cleanup may still be in progress.'
            : 'Request accepted. The task status will update when work progresses.',
      });
    } catch (error) {
      setNotice({
        scope: resolutionIdentity,
        error: true,
        message:
          error instanceof Error
            ? error.message
            : 'The request could not be confirmed. Refresh status before trying again.',
      });
    } finally {
      setSubmitting(null);
    }
  };
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={`${jobTitle(job)} status`}
      sx={{ p: compact ? 1.5 : 2, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" justifyContent="space-between">
          <Typography variant="subtitle1" fontWeight={600}>
            {jobTitle(job)}
          </Typography>
          <Chip
            size="small"
            label={stateLabel}
            color={
              job.state === 'succeeded' && !stoppedMessage
                ? 'success'
                : ['needs_attention', 'failed', 'waiting_for_auth'].includes(job.state)
                ? 'warning'
                : 'default'
            }
          />
        </Stack>
        {hasConfirmedCapturedEmail(job) ? (
          <Alert severity="info">Email captured for staging. No external email was sent.</Alert>
        ) : hasStagingEmailCaptureProfile(job) ? (
          <Alert severity="info">
            External email delivery is disabled for this staging task. Capture is not confirmed.
          </Alert>
        ) : null}
        {job.providerExecution?.mode === 'sandbox' && (
          <Stack spacing={0.5}>
            <Chip size="small" color="info" label="Simulated Subsplash / SoundCloud" sx={{ alignSelf: 'flex-start' }} />
            {canReview && (
              <Button
                component={Link}
                href={`/admin/simulation/${encodeURIComponent(job.jobId)}`}
                sx={{ alignSelf: 'flex-start' }}
              >
                Inspect simulated destinations
              </Button>
            )}
            <Typography variant="caption" color="text.secondary">
              Scenario: {SIMULATION_SCENARIO_LABELS[job.providerExecution.scenario]}. Retries retain this scenario.{' '}
              Profile: {job.providerExecution.profileId} · version {job.providerExecution.version}.
            </Typography>
          </Stack>
        )}
        {job.entity.label && (
          <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
            {job.entity.label}
          </Typography>
        )}
        <Typography role="status" aria-live="polite" aria-atomic="true" variant="body2" color="text.secondary">
          {stateLabel}
          {job.steps.find((step) => ['running', 'retrying', 'waiting'].includes(step.state))
            ? ` · ${job.steps.find((step) => ['running', 'retrying', 'waiting'].includes(step.state))!.label}`
            : ''}
        </Typography>
        {stale && <Alert severity="info">Reconnecting. Displayed status may be outdated.</Alert>}
        {stoppedMessage && <Alert severity="warning">{stoppedMessage}</Alert>}
        {job.attention && <Alert severity="warning">{job.attention.message}</Alert>}
        {job.error && <Alert severity="error">{job.error.message}</Alert>}
        {mutationReview && <Alert severity="warning">{providerMutationReviewMessage(job)}</Alert>}
        {graphChangedUnsent && (
          <Alert severity="warning">
            The destination changed before any request was sent. Cancel this stopped attempt if cancellation is
            available, refresh the destination, then submit a new task. This attempt cannot resume.
          </Alert>
        )}
        {mutationSessionId && canReview && (
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            Provider change review: {mutationSessionId}
          </Typography>
        )}

        {job.kind === 'image.delete' && job.result?.status === 'remote_retained' && job.result?.deleted === false && (
          <Alert severity="info">Local cleanup finished. The remote image was retained.</Alert>
        )}
        {!compact && (
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {job.steps.map((step) => {
              const percent = measuredStepPercent(step);
              return (
                <Box component="li" key={step.id} sx={{ mb: 1.5 }}>
                  <Typography variant="body2" fontWeight={500}>
                    {step.label} — {step.state}
                  </Typography>
                  {step.state === 'running' && (
                    <LinearProgress
                      aria-label={step.label}
                      variant={percent === undefined ? 'indeterminate' : 'determinate'}
                      value={percent}
                      sx={{ my: 1 }}
                    />
                  )}
                  {percent !== undefined && <Typography variant="caption">{percent}% of this step</Typography>}
                  {step.attempt > 1 && (
                    <Typography variant="caption" display="block">
                      Attempt {step.attempt}
                    </Typography>
                  )}
                  {step.nextRetryAt && (
                    <Typography variant="caption" display="block">
                      Next attempt: {new Date(step.nextRetryAt).toLocaleString()}
                    </Typography>
                  )}
                  {step.error && (
                    <Typography variant="body2" color="error.main">
                      {step.error.message}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
        {job.destinations?.map((destination) => (
          <Typography key={destination.destination} variant="body2">
            {destination.destination === 'soundcloud'
              ? 'SoundCloud'
              : destination.destination.charAt(0).toUpperCase() + destination.destination.slice(1)}
            : {destination.state}
            {destination.message ? ` — ${destination.message}` : ''}
          </Typography>
        ))}
        {childId && child.loading && <Typography role="status">Loading audio processing status…</Typography>}
        {child.error && <Alert severity="warning">{child.error}</Alert>}
        {child.job && (
          <JobStatusPanel job={child.job} compact={compact} stale={child.stale} showEntityLink={showEntityLink} />
        )}
        {notice && notice.scope === resolutionIdentity && (
          <Alert severity={notice.error ? 'warning' : 'info'}>{notice.message}</Alert>
        )}
        {!compact &&
          canReview &&
          job.kind !== 'email.deliver' &&
          !accountReview &&
          !orphanReview &&
          !knownResourceReview &&
          !criticalReview &&
          !mutationReview &&
          !graphChangedUnsent &&
          availableActions.includes('resolve') &&
          job.attention?.receiptId && (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (remoteId.trim() && evidence.trim() && reviewReason.trim() && duplicateAcknowledged) {
                  void perform('resolve', {
                    receiptId: job.attention!.receiptId,
                    remoteId: remoteId.trim(),
                    decision: cleanupAdoption ? 'retain_existing_resource' : 'adopt_existing_resource',
                    duplicateRiskAcknowledged: true,
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                  });
                }
              }}
            >
              <Alert severity="warning">
                {cleanupAdoption
                  ? 'The original image allocation has an unknown outcome. Review provider records before selecting a compatible image to keep; another allocation may still exist.'
                  : 'The original provider request has an unknown outcome. Review provider records before adopting an existing item; another copy may already exist.'}
              </Alert>
              <Typography variant="body2">
                {cleanupAdoption
                  ? 'Choose a compatible existing image to retain. The server verifies account ownership and compatibility before permanently protecting it; this does not identify what happened to the original allocation.'
                  : 'Choose an existing destination item to use for this task. The server will verify account ownership and compatibility; this does not prove what happened to the original request.'}
              </Typography>
              {cleanupAdoption && (
                <Alert severity="warning">
                  This is an image cleanup review. Identifying the original item does not authorize deleting it. A
                  shared image can be kept, or its prior removal can be verified.
                </Alert>
              )}
              <TextField
                label="Existing destination item ID"
                value={remoteId}
                onChange={(event) => setRemoteId(event.target.value)}
                size="small"
                required
                inputProps={{ maxLength: 256 }}
              />
              <TextField
                label="Provider log or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
              />
              <TextField
                label="Review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={duplicateAcknowledged}
                    onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
                  />
                }
                label={
                  cleanupAdoption
                    ? 'I reviewed provider records and explicitly choose to keep this compatible image. The original allocation may still be unknown and another image may exist.'
                    : 'I reviewed provider records and understand adopting this item may leave a duplicate to clean up.'
                }
              />
              <Button
                type="submit"
                variant="outlined"
                disabled={
                  stale ||
                  submitting !== null ||
                  !remoteId.trim() ||
                  !evidence.trim() ||
                  !reviewReason.trim() ||
                  !duplicateAcknowledged
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                {cleanupAdoption ? 'Verify and keep selected image' : 'Verify and adopt existing item'}
              </Button>
            </Stack>
          )}
        {!compact &&
          canReview &&
          criticalReview &&
          availableActions.includes('resolve') &&
          (criticalCertificate ? (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !stale &&
                  submitting === null &&
                  evidence.trim() &&
                  reviewReason.trim() &&
                  (!criticalRetention || retentionAcknowledged)
                ) {
                  void perform('resolve', {
                    decision: 'continue_critical_repair',
                    certificateId: criticalCertificate,
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                    ...(criticalRetention ? { retentionAcknowledged: true } : {}),
                  });
                }
              }}
            >
              <Typography variant="subtitle2">
                {criticalRetention
                  ? 'Keep the existing SoundCloud track and finish saved cleanup'
                  : criticalCleanup
                  ? 'Finish removal of known records and repair tracking'
                  : 'Repair tracking for changes already confirmed'}
              </Typography>
              <Alert severity="warning">
                {criticalRetention
                  ? 'The original SoundCloud account cannot be verified. Keep the original track while finishing the saved cleanup and tracking repair. The track may remain online; this approval does not verify that it is absent or remove it.'
                  : criticalCleanup
                  ? 'This reviewed cleanup may remove only the original recorded resources pinned by this certificate. It cannot create or upload replacements, or replay the desired publishing operation.'
                  : 'This repair verifies confirmed changes and repairs their tracking. It cannot create or upload resources, or replay the desired publishing operation.'}
              </Alert>
              {criticalRetention && criticalCleanup && (
                <Alert severity="warning">
                  Saved cleanup may also remove other original recorded resources pinned by this certificate. The
                  original SoundCloud track will be kept.
                </Alert>
              )}
              <TextField
                label="Repair certificate"
                value={criticalCertificate}
                size="small"
                inputProps={{ readOnly: true }}
                helperText="This fixed certificate is supplied and verified by the server."
              />
              <TextField
                label="Repair review or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
              />
              <TextField
                label="Repair review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              {criticalRetention && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={retentionAcknowledged}
                      onChange={(event) => setRetentionAcknowledged(event.target.checked)}
                      disabled={stale || submitting !== null}
                      required
                    />
                  }
                  label="I agree to keep the original SoundCloud track; its content may remain online."
                />
              )}
              <Button
                type="submit"
                variant="outlined"
                disabled={
                  stale ||
                  submitting !== null ||
                  !evidence.trim() ||
                  !reviewReason.trim() ||
                  (criticalRetention && !retentionAcknowledged)
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                {criticalRetention
                  ? 'Keep track and finish saved cleanup'
                  : criticalCleanup
                  ? 'Continue reviewed cleanup'
                  : 'Continue reviewed tracking repair'}
              </Button>
            </Stack>
          ) : (
            <Alert severity="info">
              A verified repair certificate is not available. Refresh the task status or contact the operator before
              continuing.
            </Alert>
          ))}
        {!compact &&
          canReview &&
          !mutationReview &&
          !graphChangedUnsent &&
          knownResourceReview &&
          availableActions.includes('resolve') && (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (evidence.trim() && reviewReason.trim() && duplicateAcknowledged) {
                  void perform('resolve', {
                    receiptId: job.attention!.receiptId,
                    remoteId: job.attention!.remoteId,
                    decision: knownResourceDecision,
                    duplicateRiskAcknowledged: true,
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                  });
                }
              }}
            >
              <Alert severity="warning">
                The confirmed provider item requires a reviewed cleanup decision. Keeping it leaves this resource in
                place; verifying removal checks that it was already removed. Neither choice authorizes a delete.
              </Alert>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                Confirmed item: {job.attention!.remoteId}
              </Typography>
              <Typography variant="body2">
                This decision authorizes no deletion. The server verifies the exact confirmed receipt and records the
                retained reference before cleanup resumes.
              </Typography>
              <TextField
                label="Provider log or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
              />
              {job.attention?.resolutionDecisions?.includes('confirm_existing_resource_absent') && (
                <TextField
                  select
                  label="Shared resource decision"
                  value={knownResourceDecision}
                  onChange={(event) => {
                    setKnownResourceDecision(event.target.value);
                    setDuplicateAcknowledged(false);
                    setRetentionAcknowledged(false);
                  }}
                  size="small"
                >
                  <MenuItem value="retain_existing_resource">Keep this shared resource</MenuItem>
                  <MenuItem value="confirm_existing_resource_absent">Verify this resource was removed</MenuItem>
                </TextField>
              )}
              <TextField
                label="Resource review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={duplicateAcknowledged}
                    onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
                  />
                }
                label={
                  knownResourceDecision === 'retain_existing_resource'
                    ? 'I reviewed this confirmed item and explicitly choose to keep it. The provider resource will remain.'
                    : 'I reviewed provider evidence and understand this only verifies prior removal; it does not delete the shared resource.'
                }
              />
              <Button
                type="submit"
                variant="outlined"
                disabled={
                  stale || submitting !== null || !evidence.trim() || !reviewReason.trim() || !duplicateAcknowledged
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                {knownResourceDecision === 'retain_existing_resource'
                  ? 'Verify and keep this resource'
                  : 'Verify this resource already removed'}
              </Button>
            </Stack>
          )}
        {!compact &&
          canReview &&
          !mutationReview &&
          !graphChangedUnsent &&
          orphanReview &&
          availableActions.includes('resolve') && (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (evidence.trim() && reviewReason.trim() && duplicateAcknowledged) {
                  void perform('resolve', {
                    acknowledgementId: job.attention!.acknowledgementId,
                    decision: orphanDecision,
                    duplicateRiskAcknowledged: true,
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                  });
                }
              }}
            >
              <Alert severity="warning">
                The provider confirmed an additional item from the original request after another item was adopted. This
                task needs an explicit decision about that additional item.
              </Alert>
              <Typography variant="body2">
                Retaining keeps the additional provider item. Verifying removal checks that the exact original item is
                already absent. Neither decision deletes the adopted item or the additional item; the server verifies
                provider evidence before cleanup continues.
              </Typography>
              <TextField
                label="Provider log or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
              />
              <TextField
                select
                label="Additional item decision"
                value={orphanDecision}
                onChange={(event) => {
                  setOrphanDecision(event.target.value);
                  setDuplicateAcknowledged(false);
                  setRetentionAcknowledged(false);
                }}
                size="small"
              >
                <MenuItem value="retain_orphan">Keep the additional provider item</MenuItem>
                <MenuItem value="confirm_orphan_cleanup">Verify the additional item was removed</MenuItem>
              </TextField>
              <TextField
                label="Additional item review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={duplicateAcknowledged}
                    onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
                  />
                }
                label={
                  orphanDecision === 'retain_orphan'
                    ? 'I reviewed the confirmed additional allocation and explicitly choose to keep it. A duplicate provider item will remain.'
                    : 'I reviewed provider evidence and understand this verifies prior removal; it does not delete any item.'
                }
              />
              <Button
                type="submit"
                variant="outlined"
                disabled={
                  stale || submitting !== null || !evidence.trim() || !reviewReason.trim() || !duplicateAcknowledged
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                {orphanDecision === 'retain_orphan'
                  ? 'Verify and retain additional item'
                  : 'Verify additional item already removed'}
              </Button>
            </Stack>
          )}
        {!compact &&
          canReview &&
          !mutationReview &&
          !graphChangedUnsent &&
          accountReview &&
          availableActions.includes('resolve') && (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (evidence.trim() && reviewReason.trim()) {
                  void perform('resolve', {
                    decision: accountSessionsReview ? 'confirm_sessions_revoked' : 'confirm_access_applied',
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                  });
                }
              }}
            >
              <Alert severity="warning">
                {accountSessionsReview
                  ? 'Session revocation could not be confirmed. An operator must verify that the original execution has stopped before confirming sessions already revoked.'
                  : 'Account access could not be confirmed. An operator must verify that the original execution has stopped before confirming access already applied.'}
              </Alert>
              <Typography variant="body2">
                {accountSessionsReview
                  ? 'The server checks execution evidence and the account session cutoff. If either check fails, this task remains blocked; contact the operator to review it.'
                  : 'The server checks execution evidence and the exact saved access claims. If either check fails, this task remains blocked; contact the operator to review it.'}
              </Typography>
              <TextField
                label="Execution review or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
                helperText="Use a reference, never credentials or private account data."
              />
              <TextField
                label="Review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              <Button
                type="submit"
                variant="outlined"
                disabled={stale || submitting !== null || !evidence.trim() || !reviewReason.trim()}
                sx={{ alignSelf: 'flex-start' }}
              >
                {accountSessionsReview ? 'Verify sessions already revoked' : 'Verify access already applied'}
              </Button>
            </Stack>
          )}
        {!compact &&
          canReview &&
          !mutationReview &&
          !graphChangedUnsent &&
          job.kind === 'email.deliver' &&
          availableActions.includes('resolve') && (
            <Stack
              component="form"
              spacing={1}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  evidence.trim() &&
                  reviewReason.trim() &&
                  (emailDecision !== 'resend_after_review' || duplicateAcknowledged)
                ) {
                  void perform('resolve', {
                    receiptId: job.jobId,
                    decision: emailDecision,
                    evidenceReference: evidence.trim(),
                    reason: reviewReason.trim(),
                    ...(emailDecision === 'resend_after_review' ? { duplicateRiskAcknowledged: true } : {}),
                  });
                }
              }}
            >
              <Alert severity="warning">
                {hasStagingEmailCaptureProfile(job)
                  ? 'Staging email capture could not be confirmed. Review private capture records before deciding whether to try again.'
                  : 'Email delivery could not be confirmed. Review provider logs before deciding whether to send again.'}
              </Alert>
              <TextField
                select
                label="Reviewed outcome"
                value={emailDecision}
                onChange={(event) => {
                  setEmailDecision(event.target.value);
                  setDuplicateAcknowledged(false);
                  setRetentionAcknowledged(false);
                }}
                size="small"
              >
                <MenuItem value="confirm_accepted">Provider accepted the message</MenuItem>
                <MenuItem value="mark_failed_after_review">Close as failed after review</MenuItem>
                <MenuItem value="resend_after_review">Send again after review</MenuItem>
              </TextField>
              <TextField
                label="Provider log or support ticket reference"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                required
                size="small"
                inputProps={{ maxLength: 512 }}
                helperText="Use a reference, not the message body, addresses or credentials."
              />
              <TextField
                label="Review reason"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                required
                multiline
                minRows={2}
                inputProps={{ maxLength: 1000 }}
              />
              {emailDecision === 'resend_after_review' && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={duplicateAcknowledged}
                      onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
                    />
                  }
                  label="I reviewed the provider evidence and understand another send may create a duplicate."
                />
              )}
              <Button
                type="submit"
                variant="outlined"
                disabled={
                  stale ||
                  submitting !== null ||
                  !evidence.trim() ||
                  !reviewReason.trim() ||
                  (emailDecision === 'resend_after_review' && !duplicateAcknowledged)
                }
                sx={{ alignSelf: 'flex-start' }}
              >
                Apply reviewed outcome
              </Button>
            </Stack>
          )}
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {availableActions
            .filter(
              (action) =>
                canCommand &&
                job.kind !== 'provider.orphan_review' &&
                !criticalReview &&
                !mutationReview &&
                (!graphChangedUnsent || action === 'cancel') &&
                !['resolve', 'resume_upload'].includes(action) &&
                !(
                  job.kind === 'upload.create' &&
                  ['cancelled', 'failed', 'superseded'].includes(job.state) &&
                  action === 'retry'
                ) &&
                !(
                  (job.kind === 'email.deliver' || accountReview || orphanReview || knownResourceReview) &&
                  job.state === 'needs_attention' &&
                  ['resume', 'retry'].includes(action)
                )
            )
            .map((action) => (
              <Button
                key={action}
                size="small"
                variant="outlined"
                onClick={() => void perform(action)}
                disabled={stale || submitting !== null}
              >
                {submitting === action ? 'Submitting request…' : ACTION_LABELS[action]}
              </Button>
            ))}
          {!mutationReview &&
            !graphChangedUnsent &&
            availableActions.includes('resume_upload') &&
            user?.uid === job.requestedBy && (
              <Button component={Link} href={`/?resumeJob=${encodeURIComponent(job.jobId)}`} size="small">
                Resume source upload
              </Button>
            )}
          {job.attention?.kind === 'reconnect_provider' && job.attention.provider === 'youtube' && (
            <Button component={Link} href="/admin/youtube-auth" size="small">
              Reconnect YouTube
            </Button>
          )}
          {job.attention?.kind === 'reconnect_provider' && job.attention.provider === 'soundcloud' && canReview && (
            <Button component={Link} href="/admin/advanced" size="small">
              Reconnect SoundCloud
            </Button>
          )}
          {sourceJobId && canReview && (
            <Button component={Link} href={`/admin/activity/${encodeURIComponent(sourceJobId)}`} size="small">
              Related task
            </Button>
          )}
          {blockingJobId && canReview && (
            <Button component={Link} href={`/admin/activity/${encodeURIComponent(blockingJobId)}`} size="small">
              Review related publishing task
            </Button>
          )}
          {href && showEntityLink && (
            <Button component={Link} href={href} size="small">
              Open {job.entity.type}
            </Button>
          )}
          {compact && (
            <Button component={Link} href={`/admin/activity/${encodeURIComponent(job.jobId)}`} size="small">
              View task details
            </Button>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Requested {new Date(job.createdAt).toLocaleString()}
          {!compact ? ` · Updated ${new Date(job.updatedAt).toLocaleString()}` : ''}
        </Typography>
      </Stack>
    </Paper>
  );
}
