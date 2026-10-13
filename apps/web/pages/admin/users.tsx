import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import UserTable from '../../components/UserTable';
import useAuth from '../../context/user/UserContext';
import {
  CreateInviteResultData,
  INVITE_ROLES,
  InviteLifecycleStatusType,
  InviteRoleType,
  InviteSummary,
  ListInvitesInputType,
  ListInvitesResultData,
  RevokeInviteInputType,
  RevokeInviteResultData,
} from '@upperroom/contracts/invites/inviteTypes';
import { ListUsersInputType, ListUsersOutputType } from '@upperroom/contracts/listUsers';
import {
  ListRoleRequestsInputType,
  ListRoleRequestsOutputType,
  RoleRequestSummary,
} from '@upperroom/contracts/roleRequests/roleRequestTypes';
import AppLayout from '../../layout/AppLayout';
import { DirectoryUserWithLoading } from '../../types/User';
import { createFunctionV2 } from '../../utils/createFunction';
import { submitDurableIntent } from '../../utils/durableJobs';
import { useVisibleJobs } from '../../hooks/useDurableJobs';
import JobStatusPanel from '../../components/jobs/JobStatusPanel';

type ListInvitesOutputType = { status: 'success'; data: ListInvitesResultData } | { status: 'error'; error: string };
type RevokeInviteOutputType = { status: 'success'; data: RevokeInviteResultData } | { status: 'error'; error: string };
type NoticeSeverity = 'success' | 'error' | 'warning' | 'info';

const formatInviteStatus = (status: InviteLifecycleStatusType): string =>
  status
    .split('_')
    .map((part) => `${part.charAt(0)}${part.slice(1).toLowerCase()}`)
    .join(' ');

const formatRequestStatus = (value: string): string =>
  value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let listUsersInFlight: Promise<DirectoryUserWithLoading[]> | null = null;

const fetchUsersWithDedupe = async (): Promise<DirectoryUserWithLoading[]> => {
  if (listUsersInFlight) {
    return listUsersInFlight;
  }

  const listUsers = createFunctionV2<ListUsersInputType, ListUsersOutputType>('listusers');
  listUsersInFlight = listUsers({})
    .then((listUsersOutput) => {
      if (listUsersOutput.status === 'error') {
        throw new Error(listUsersOutput.error);
      }
      return listUsersOutput.data.map((listUserOutput) => ({ ...listUserOutput, loading: false }));
    })
    .finally(() => {
      listUsersInFlight = null;
    });

  return listUsersInFlight;
};

const AdminUsers = () => {
  const isMountedRef = useRef(true);
  const { jobs, stale: jobsStale } = useVisibleJobs();
  const accountJobs = jobs.filter((job) =>
    ['invite.create', 'invite.resend', 'invite.claim', 'role.resolve', 'role.assign'].includes(job.kind)
  );
  const completedRevision = accountJobs
    .filter((job) => job.state === 'succeeded')
    .map((job) => `${job.jobId}:${job.revision}`)
    .join(',');
  const [usersWithLoading, setUsersWithLoading] = useState<DirectoryUserWithLoading[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [pageNotice, setPageNotice] = useState<{ severity: NoticeSeverity; text: string } | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRoleType>('uploader');
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<{ severity: NoticeSeverity; text: string } | null>(null);
  const [inviteDeliveryStatus, setInviteDeliveryStatus] = useState<CreateInviteResultData['emailStatus'] | null>(null);
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState('');
  const [inviteExpiresAtMs, setInviteExpiresAtMs] = useState<number | null>(null);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [inviteActionLoadingById, setInviteActionLoadingById] = useState<Record<string, boolean>>({});
  const [roleRequests, setRoleRequests] = useState<RoleRequestSummary[]>([]);
  const [loadingRoleRequests, setLoadingRoleRequests] = useState(false);
  const [roleRequestFilter, setRoleRequestFilter] = useState('');
  const [selectedRoleRequest, setSelectedRoleRequest] = useState<RoleRequestSummary | null>(null);
  const [resolveRoleRequestLoadingAction, setResolveRoleRequestLoadingAction] = useState<'accept' | 'deny' | null>(
    null
  );

  const fetchUsers = async () => {
    if (isMountedRef.current) {
      setLoadingUsers(true);
    }
    try {
      const users = await fetchUsersWithDedupe();
      if (isMountedRef.current) {
        setUsersWithLoading(users);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to load users';
      if (isMountedRef.current) {
        setPageNotice({ severity: 'error', text });
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingUsers(false);
      }
    }
  };

  const fetchInvites = async () => {
    if (isMountedRef.current) {
      setLoadingInvites(true);
    }
    try {
      const listInvites = createFunctionV2<ListInvitesInputType, ListInvitesOutputType>('listinvites');
      const response = await listInvites({ limit: 100 });
      if (response.status === 'error') {
        throw new Error(response.error);
      }
      if (isMountedRef.current) {
        setInvites(response.data.invites);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to load invites';
      if (isMountedRef.current) {
        setPageNotice({ severity: 'error', text });
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingInvites(false);
      }
    }
  };

  const fetchRoleRequests = async () => {
    if (isMountedRef.current) {
      setLoadingRoleRequests(true);
    }
    try {
      const listRoleRequests = createFunctionV2<ListRoleRequestsInputType, ListRoleRequestsOutputType>(
        'listrolerequests'
      );
      const response = await listRoleRequests({ limit: 100 });
      if (response.status === 'error') {
        throw new Error(response.error);
      }
      if (isMountedRef.current) {
        setRoleRequests(response.data.roleRequests.filter((roleRequest) => roleRequest.status === 'pending'));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to load role requests';
      if (isMountedRef.current) {
        setPageNotice({ severity: 'error', text });
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingRoleRequests(false);
      }
    }
  };

  const setInviteActionLoading = (inviteId: string, loading: boolean) => {
    setInviteActionLoadingById((previous) => ({ ...previous, [inviteId]: loading }));
  };

  const resetInviteResult = () => {
    setGeneratedInviteUrl('');
    setInviteExpiresAtMs(null);
    setInviteDeliveryStatus(null);
  };

  const setUserLoading = (uid: string, loading: boolean) => {
    setUsersWithLoading((usersWithLoading) =>
      usersWithLoading.map((userWithLoading) => {
        if (userWithLoading.uid === uid) {
          return { ...userWithLoading, loading };
        } else {
          return userWithLoading;
        }
      })
    );
  };

  const openInviteDialog = () => {
    setInviteDialogOpen(true);
    setInviteEmail('');
    setInviteRole('uploader');
    setInviteEmailError(null);
    setInviteNotice(null);
    resetInviteResult();
  };

  const closeInviteDialog = () => {
    if (inviteLoading) {
      return;
    }
    setInviteDialogOpen(false);
  };

  const handleCreateInvite = async () => {
    resetInviteResult();
    const normalizedEmail = inviteEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setInviteEmailError('Enter a valid email address.');
      setInviteNotice({
        severity: 'error',
        text: 'Invite not sent. Please fix the email and try again.',
      });
      return;
    }

    setInviteLoading(true);
    setInviteEmailError(null);
    setInviteNotice({
      severity: 'info',
      text: 'Submitting invite request...',
    });

    try {
      const receipt = await submitDurableIntent({
        kind: 'invite.create',
        entity: { type: 'user', id: 'new-invite' },
        payload: { email: normalizedEmail, role: inviteRole },
      });
      const result = (receipt as typeof receipt & { clientResult?: Record<string, unknown> }).clientResult;
      if (typeof result?.inviteUrl === 'string') setGeneratedInviteUrl(result.inviteUrl);
      if (typeof result?.expiresAtMs === 'number') setInviteExpiresAtMs(result.expiresAtMs);
      setInviteNotice({
        severity: 'info',
        text: 'Invite created. Email delivery is tracked in Activity; you can close this dialog.',
      });
      await fetchInvites();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to create invite.';
      setInviteNotice({
        severity: 'error',
        text,
      });
    } finally {
      setInviteLoading(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!generatedInviteUrl) {
      return;
    }

    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('Clipboard is unavailable in this browser.');
      }

      await navigator.clipboard.writeText(generatedInviteUrl);
      setInviteNotice({
        severity: 'success',
        text: 'Invite link copied to clipboard.',
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Unable to copy invite link.';
      setInviteNotice({
        severity: 'error',
        text,
      });
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setInviteActionLoading(inviteId, true);
    try {
      const revokeInvite = createFunctionV2<RevokeInviteInputType, RevokeInviteOutputType>('revokeinvite');
      const response = await revokeInvite({ inviteId });
      if (response.status === 'error') {
        throw new Error(response.error);
      }
      setPageNotice({ severity: 'success', text: `Invite ${inviteId} revoked.` });
      await fetchInvites();
    } catch (error) {
      setPageNotice({
        severity: 'error',
        text: error instanceof Error ? error.message : 'Failed to revoke invite.',
      });
    } finally {
      setInviteActionLoading(inviteId, false);
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    setInviteActionLoading(inviteId, true);
    try {
      const receipt = await submitDurableIntent({
        kind: 'invite.resend',
        entity: { type: 'user', id: inviteId },
        payload: { inviteId },
      });
      const result = (receipt as typeof receipt & { clientResult?: Record<string, unknown> }).clientResult;
      setInviteDialogOpen(true);
      if (typeof result?.inviteUrl === 'string') setGeneratedInviteUrl(result.inviteUrl);
      if (typeof result?.expiresAtMs === 'number') setInviteExpiresAtMs(result.expiresAtMs);
      if (typeof result?.invitedEmail === 'string') setInviteEmail(result.invitedEmail);
      if (INVITE_ROLES.includes(result?.invitedRole as InviteRoleType))
        setInviteRole(result!.invitedRole as InviteRoleType);
      setInviteDeliveryStatus(null);
      setInviteEmailError(null);
      setInviteNotice({ severity: 'info', text: 'Replacement invite created. Email delivery is tracked in Activity.' });
      await fetchInvites();
    } catch (error) {
      setPageNotice({
        severity: 'error',
        text: error instanceof Error ? error.message : 'Failed to resend invite.',
      });
    } finally {
      setInviteActionLoading(inviteId, false);
    }
  };

  const handleRoleChange = async (uid: string, role: string) => {
    setUserLoading(uid, true);
    try {
      await submitDurableIntent({ kind: 'role.assign', entity: { type: 'user', id: uid }, payload: { uid, role } });
      setPageNotice({
        severity: 'info',
        text: 'Role update accepted. Updated access and session changes are tracked in Activity.',
      });
    } catch (error) {
      let message = '';
      if (error instanceof Error) {
        message = error.message;
      } else if (error instanceof Object && 'message' in error && typeof error.message === 'string') {
        message = error.message;
      } else {
        message = 'An unexpected error has occured';
      }
      setPageNotice({
        severity: 'error',
        text: message,
      });
    } finally {
      setUserLoading(uid, false);
    }
  };

  const openResolveRoleRequestDialog = (roleRequest: RoleRequestSummary) => {
    setSelectedRoleRequest(roleRequest);
  };

  const closeResolveRoleRequestDialog = () => {
    if (resolveRoleRequestLoadingAction) {
      return;
    }
    setSelectedRoleRequest(null);
  };

  const handleResolveRoleRequest = async (action: 'accept' | 'deny') => {
    if (!selectedRoleRequest) {
      return;
    }

    setResolveRoleRequestLoadingAction(action);
    try {
      await submitDurableIntent({
        kind: 'role.resolve',
        entity: { type: 'user', id: selectedRoleRequest.requesterUid },
        payload: { requestId: selectedRoleRequest.roleRequestId, decision: action },
      });
      setPageNotice({
        severity: 'info',
        text: 'Request resolution accepted. Role changes and the outcome email are tracked in Activity.',
      });
      setSelectedRoleRequest(null);
    } catch (error) {
      setPageNotice({
        severity: 'error',
        text:
          error instanceof Error
            ? error.message
            : action === 'accept'
            ? 'Failed to accept role request.'
            : 'Failed to deny role request.',
      });
    } finally {
      setResolveRoleRequestLoadingAction(null);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;

    const g = async () => {
      await Promise.all([fetchUsers(), fetchInvites(), fetchRoleRequests()]);
    };
    g();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!completedRevision) return;
    void Promise.all([fetchUsers(), fetchInvites(), fetchRoleRequests()]);
    // Completion is observed from server-owned projections, not admission responses.
  }, [completedRevision]);

  const normalizedRoleRequestFilter = roleRequestFilter.trim().toLowerCase();
  const filteredRoleRequests =
    normalizedRoleRequestFilter.length === 0
      ? roleRequests
      : roleRequests.filter((roleRequest) =>
          [roleRequest.requesterEmail, roleRequest.requesterUid, roleRequest.requesterDisplayName ?? '']
            .join(' ')
            .toLowerCase()
            .includes(normalizedRoleRequestFilter)
        );
  const selectedRequesterUser = selectedRoleRequest
    ? usersWithLoading.find((userWithLoading) => userWithLoading.uid === selectedRoleRequest.requesterUid)
    : null;
  const selectedRequesterName =
    selectedRequesterUser?.displayName ?? selectedRoleRequest?.requesterDisplayName ?? 'Not available';
  const selectedRequesterEmail = selectedRequesterUser?.email ?? selectedRoleRequest?.requesterEmail ?? 'Not available';
  const selectedRequesterPhoto = selectedRequesterUser?.photoURL ?? null;
  const selectedRequesterInitial = selectedRequesterName.trim().charAt(0).toUpperCase() || '?';

  return (
    <Box sx={{ width: '100%', maxWidth: 'none', px: { xs: 1, md: 2 }, boxSizing: 'border-box' }}>
      {pageNotice && (
        <Alert sx={{ mb: 2 }} severity={pageNotice.severity} onClose={() => setPageNotice(null)}>
          {pageNotice.text}
        </Alert>
      )}
      {accountJobs.length > 0 && (
        <Stack spacing={1} sx={{ mb: 3 }} component="section" aria-label="Account activity">
          <Typography variant="h6">Account activity</Typography>
          {accountJobs.map((job) => (
            <JobStatusPanel key={job.jobId} job={job} compact stale={jobsStale} />
          ))}
        </Stack>
      )}
      <UserTable
        usersWithLoading={usersWithLoading.map((item) => ({
          ...item,
          loading:
            item.loading ||
            accountJobs.some(
              (job) =>
                job.entity.id === item.uid &&
                ['role.assign', 'role.resolve'].includes(job.kind) &&
                !['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)
            ),
        }))}
        handleRoleChange={handleRoleChange}
        loading={loadingUsers}
        toolbarActions={
          <Button variant="contained" onClick={openInviteDialog}>
            Issue Invite
          </Button>
        }
      />
      <Box sx={{ mt: 3, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Typography variant="h6">Invite History</Typography>
          <Button size="small" onClick={fetchInvites} disabled={loadingInvites}>
            Refresh
          </Button>
        </Stack>
        {loadingInvites ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : invites.length === 0 ? (
          <Typography color="text.secondary">No invites yet.</Typography>
        ) : (
          <Stack spacing={1}>
            {invites.map((invite) => {
              const busy =
                inviteActionLoadingById[invite.inviteId] === true ||
                accountJobs.some(
                  (job) =>
                    job.entity.id === invite.inviteId &&
                    !['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)
                );
              return (
                <Box
                  key={invite.inviteId}
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    p: 1.5,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '2fr 1fr 1fr auto' },
                    gap: 1.5,
                    alignItems: 'center',
                  }}
                >
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {invite.invitedEmail}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Created {new Date(invite.createdAtMs).toLocaleString()} • Expires{' '}
                      {new Date(invite.expiresAtMs).toLocaleString()}
                    </Typography>
                  </Box>
                  <Typography variant="body2">Role: {invite.invitedRole}</Typography>
                  <Typography variant="body2">Status: {formatInviteStatus(invite.lifecycleStatus)}</Typography>
                  <Stack direction="row" spacing={1} justifyContent={{ xs: 'flex-start', md: 'flex-end' }}>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={busy || !invite.canRevoke}
                      onClick={() => handleRevokeInvite(invite.inviteId)}
                    >
                      Revoke
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busy || !invite.canResend}
                      onClick={() => handleResendInvite(invite.inviteId)}
                    >
                      Resend
                    </Button>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
      <Box sx={{ mt: 3, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ sm: 'center' }}
          justifyContent="space-between"
          sx={{ mb: 2 }}
          gap={1.5}
        >
          <Typography variant="h6">Open Role Requests</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              placeholder="Filter by user"
              value={roleRequestFilter}
              onChange={(event) => setRoleRequestFilter(event.target.value)}
            />
            <Button size="small" onClick={fetchRoleRequests} disabled={loadingRoleRequests}>
              Refresh
            </Button>
          </Stack>
        </Stack>
        {loadingRoleRequests ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : filteredRoleRequests.length === 0 ? (
          <Typography color="text.secondary">No role requests found.</Typography>
        ) : (
          <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            <Table size="small" aria-label="open role requests">
              <TableHead>
                <TableRow>
                  <TableCell>Requester</TableCell>
                  <TableCell>Requested Role</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Submitted</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredRoleRequests.map((roleRequest) => (
                  <TableRow key={roleRequest.roleRequestId} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {roleRequest.requesterDisplayName || roleRequest.requesterEmail}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {roleRequest.requesterEmail}
                      </Typography>
                    </TableCell>
                    <TableCell>{roleRequest.requestedRole}</TableCell>
                    <TableCell>{formatRequestStatus(roleRequest.status)}</TableCell>
                    <TableCell>{new Date(roleRequest.createdAtMs).toLocaleString()}</TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-wrap', minWidth: 240 }}>{roleRequest.reason}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() => openResolveRoleRequestDialog(roleRequest)}
                        disabled={
                          resolveRoleRequestLoadingAction !== null ||
                          accountJobs.some(
                            (job) =>
                              job.entity.id === roleRequest.requesterUid &&
                              job.kind === 'role.resolve' &&
                              !['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.state)
                          )
                        }
                      >
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
      <Dialog open={Boolean(selectedRoleRequest)} onClose={closeResolveRoleRequestDialog} fullWidth maxWidth="sm">
        <DialogTitle sx={{ pr: 6 }}>
          Review Request
          <IconButton
            aria-label="Close dialog"
            onClick={closeResolveRoleRequestDialog}
            disabled={resolveRoleRequestLoadingAction !== null}
            sx={{ position: 'absolute', right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Choose whether to accept or deny this role request.
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Avatar src={selectedRequesterPhoto ?? undefined} sx={{ width: 56, height: 56 }}>
                {selectedRequesterPhoto ? undefined : selectedRequesterInitial}
              </Avatar>
              <Stack spacing={0.5}>
                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                  {selectedRequesterName}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {selectedRequesterEmail}
                </Typography>
              </Stack>
            </Stack>
            <Typography variant="body2">
              Requested Role: <strong>{selectedRoleRequest?.requestedRole ?? 'Not available'}</strong>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              An outcome email will be sent to this requester after confirmation.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeResolveRoleRequestDialog} disabled={resolveRoleRequestLoadingAction !== null}>
            Cancel
          </Button>
          <Button
            onClick={() => handleResolveRoleRequest('deny')}
            variant="outlined"
            color="error"
            disabled={resolveRoleRequestLoadingAction !== null}
          >
            {resolveRoleRequestLoadingAction === 'deny' ? 'Denying...' : 'Deny'}
          </Button>
          <Button
            onClick={() => handleResolveRoleRequest('accept')}
            variant="contained"
            color="primary"
            disabled={resolveRoleRequestLoadingAction !== null}
          >
            {resolveRoleRequestLoadingAction === 'accept' ? 'Applying...' : 'Accept'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={inviteDialogOpen} onClose={closeInviteDialog} fullWidth maxWidth="sm">
        <DialogTitle>Create Invite</DialogTitle>
        <DialogContent>
          {inviteNotice && (
            <Alert sx={{ mt: 1, mb: 1 }} severity={inviteNotice.severity}>
              {inviteNotice.text}
            </Alert>
          )}
          <TextField
            autoFocus
            margin="dense"
            label="Invitee Email"
            type="email"
            fullWidth
            value={inviteEmail}
            disabled={inviteLoading}
            error={Boolean(inviteEmailError)}
            helperText={inviteEmailError ?? ' '}
            onChange={(event) => {
              setInviteEmail(event.target.value);
              if (inviteEmailError) {
                setInviteEmailError(null);
              }
              setInviteNotice(null);
              resetInviteResult();
            }}
          />
          <FormControl fullWidth margin="dense" disabled={inviteLoading}>
            <InputLabel id="invite-role-label">Role</InputLabel>
            <Select
              labelId="invite-role-label"
              value={inviteRole}
              label="Role"
              onChange={(event) => {
                setInviteRole(event.target.value as InviteRoleType);
                setInviteNotice(null);
                resetInviteResult();
              }}
            >
              {INVITE_ROLES.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {generatedInviteUrl && (
            <Stack spacing={1} sx={{ mt: 2 }}>
              <Alert severity={inviteDeliveryStatus === 'QUEUED' ? 'success' : 'info'}>
                {inviteDeliveryStatus === 'QUEUED'
                  ? 'Email queued for delivery.'
                  : 'Invite link is available. See Activity for email delivery status.'}
                {inviteExpiresAtMs ? ` Expires ${new Date(inviteExpiresAtMs).toLocaleString()}.` : ''}
              </Alert>
              <TextField fullWidth value={generatedInviteUrl} InputProps={{ readOnly: true }} />
              <Stack direction="row" spacing={2} alignItems="center">
                <Button size="small" onClick={handleCopyInviteLink}>
                  Copy Link
                </Button>
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInviteDialog} disabled={inviteLoading}>
            Close
          </Button>
          {!generatedInviteUrl && (
            <Button
              onClick={handleCreateInvite}
              disabled={inviteLoading || inviteEmail.trim().length === 0}
              variant="contained"
            >
              {inviteLoading ? 'Submitting...' : 'Generate Invite'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
};

const ProtectedAdminUsers = () => {
  const { user } = useAuth();
  if (!user?.isAdmin()) {
    return null;
  } else {
    return <AdminUsers />;
  }
};

ProtectedAdminUsers.PageLayout = AppLayout;

export default ProtectedAdminUsers;
