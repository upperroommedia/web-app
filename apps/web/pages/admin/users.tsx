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
import { GetUserInputType, GetUserOutputType } from '@upperroom/contracts/getUser';
import {
  CreateInviteInputType,
  CreateInviteResultData,
  INVITE_ROLES,
  InviteLifecycleStatusType,
  InviteRoleType,
  InviteSummary,
  ListInvitesInputType,
  ListInvitesResultData,
  ResendInviteInputType,
  ResendInviteResultData,
  RevokeInviteInputType,
  RevokeInviteResultData,
} from '@upperroom/contracts/invites/inviteTypes';
import { ListUsersInputType, ListUsersOutputType } from '@upperroom/contracts/listUsers';
import {
  AcceptRoleRequestInputType,
  AcceptRoleRequestOutputType,
  DenyRoleRequestInputType,
  DenyRoleRequestOutputType,
  ListRoleRequestsInputType,
  ListRoleRequestsOutputType,
  RoleRequestSummary,
} from '@upperroom/contracts/roleRequests/roleRequestTypes';
import { SetUserRoleInputType, SetUserRoleOutputType } from '@upperroom/contracts/setUserRole';
import AppLayout from '../../layout/AppLayout';
import { DirectoryUserWithLoading } from '../../types/User';
import { createFunctionV2 } from '../../utils/createFunction';

type CreateInviteOutputType = { status: 'success'; data: CreateInviteResultData } | { status: 'error'; error: string };
type ListInvitesOutputType = { status: 'success'; data: ListInvitesResultData } | { status: 'error'; error: string };
type RevokeInviteOutputType = { status: 'success'; data: RevokeInviteResultData } | { status: 'error'; error: string };
type ResendInviteOutputType = { status: 'success'; data: ResendInviteResultData } | { status: 'error'; error: string };
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
  const [resolveRoleRequestLoadingAction, setResolveRoleRequestLoadingAction] = useState<'accept' | 'deny' | null>(null);

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
      const listRoleRequests = createFunctionV2<ListRoleRequestsInputType, ListRoleRequestsOutputType>('listrolerequests');
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
      text: 'Creating invite and queueing email...',
    });

    try {
      const createInvite = createFunctionV2<CreateInviteInputType, CreateInviteOutputType>('createinvite');
      const response = await createInvite({ email: normalizedEmail, role: inviteRole });

      if (response.status === 'error') {
        if (response.error.toLowerCase().includes('invalid invite email')) {
          setInviteEmailError('Enter a valid email address.');
        }
        throw new Error(response.error);
      }

      setGeneratedInviteUrl(response.data.inviteUrl);
      setInviteExpiresAtMs(response.data.expiresAtMs);
      setInviteDeliveryStatus(response.data.emailStatus);
      setInviteNotice(null);
      await fetchInvites();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to create invite.';
      setInviteNotice({
        severity: 'error',
        text: `Invite not sent. ${text}`,
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
      const resendInvite = createFunctionV2<ResendInviteInputType, ResendInviteOutputType>('resendinvite');
      const response = await resendInvite({ inviteId });
      if (response.status === 'error') {
        throw new Error(response.error);
      }

      setInviteDialogOpen(true);
      setGeneratedInviteUrl(response.data.inviteUrl);
      setInviteExpiresAtMs(response.data.expiresAtMs);
      setInviteEmail(response.data.invitedEmail);
      setInviteRole(response.data.invitedRole);
      setInviteDeliveryStatus(response.data.emailStatus);
      setInviteEmailError(null);
      setInviteNotice(null);

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
      const setUserRole = createFunctionV2<SetUserRoleInputType, SetUserRoleOutputType>('setuserrole');
      const setUserRoleResult = await setUserRole({ uid, role });
      if (setUserRoleResult.status === 'error') {
        throw new Error(setUserRoleResult.error);
      }

      const getUser = createFunctionV2<GetUserInputType, GetUserOutputType>('getuser');
      const getUserResponse = await getUser({ uid });
      if (getUserResponse.status === 'error') {
        throw new Error(getUserResponse.error);
      }
      setUsersWithLoading((previousUsersWithLoading) => {
        const updatedUsers = previousUsersWithLoading.map((previousUserWithLoading) => {
          if (previousUserWithLoading.uid === uid) {
            return { ...getUserResponse.data, loading: false };
          }
          return previousUserWithLoading;
        });
        return updatedUsers;
      });
      setPageNotice({
        severity: 'success',
        text: `Role updated for user ${uid}.`,
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
      const response =
        action === 'accept'
          ? await createFunctionV2<AcceptRoleRequestInputType, AcceptRoleRequestOutputType>('acceptrolerequest')({
            roleRequestId: selectedRoleRequest.roleRequestId,
          })
          : await createFunctionV2<DenyRoleRequestInputType, DenyRoleRequestOutputType>('denyrolerequest')({
            roleRequestId: selectedRoleRequest.roleRequestId,
          });
      if (response.status === 'error') {
        throw new Error(response.error);
      }

      if (action === 'accept') {
        await fetchUsers();
      }

      setRoleRequests((previousRoleRequests) =>
        previousRoleRequests.filter((roleRequest) => roleRequest.roleRequestId !== selectedRoleRequest.roleRequestId)
      );
      setPageNotice({
        severity: response.data.warning ? 'warning' : 'success',
        text:
          action === 'accept'
            ? response.data.warning
              ? `Accepted ${selectedRoleRequest.requesterEmail} request, but outcome email did not queue. ${response.data.warning.message}`
              : `Accepted ${selectedRoleRequest.requesterEmail} request and queued approval email.`
            : response.data.warning
              ? `Denied ${selectedRoleRequest.requesterEmail} request, but outcome email did not queue. ${response.data.warning.message}`
              : `Denied ${selectedRoleRequest.requesterEmail} request and queued denial email.`,
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
      <UserTable
        usersWithLoading={usersWithLoading}
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
              const busy = inviteActionLoadingById[invite.inviteId] === true;
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
                      Created {new Date(invite.createdAtMs).toLocaleString()} • Expires {new Date(invite.expiresAtMs).toLocaleString()}
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
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 2 }} gap={1.5}>
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
                        disabled={resolveRoleRequestLoadingAction !== null}
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
      <Dialog
        open={Boolean(selectedRoleRequest)}
        onClose={closeResolveRoleRequestDialog}
        fullWidth
        maxWidth="sm"
      >
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
              <Alert severity={inviteDeliveryStatus === 'QUEUED' ? 'success' : 'warning'}>
                {inviteDeliveryStatus === 'QUEUED'
                  ? 'Email queued for delivery.'
                  : 'Email was not queued. Share this link manually.'}
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
            <Button onClick={handleCreateInvite} disabled={inviteLoading || inviteEmail.trim().length === 0} variant="contained">
              {inviteLoading ? 'Sending...' : 'Generate Invite'}
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
