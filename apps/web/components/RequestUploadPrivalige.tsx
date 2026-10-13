import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { UserRole, UserRoleType } from '../types/User';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert, { AlertColor } from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { createFunctionV2 } from '../utils/createFunction';
import auth, { signOut } from '../firebase/auth';
import { useEntityJobs } from '../hooks/useDurableJobs';
import useAuth from '../context/user/UserContext';
import EntityJobHistory from './jobs/EntityJobHistory';
import {
  CreateRoleRequestInputType,
  CreateRoleRequestOutputType,
  ListRoleRequestsInputType,
  ListRoleRequestsOutputType,
  RoleRequestSummary,
} from '@upperroom/contracts/roleRequests/roleRequestTypes';

const formatStatus = (value: string): string =>
  value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');

const REQUESTABLE_ROLES: UserRoleType[] = [UserRole.UPLOADER, UserRole.PUBLISHER];

const RequestRoleChange = () => {
  const { user } = useAuth();
  const defaultValue = UserRole.UPLOADER;
  const [role, setRole] = useState<UserRoleType>(defaultValue);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [requests, setRequests] = useState<RoleRequestSummary[]>([]);
  const [feedback, setFeedback] = useState<{ severity: AlertColor; message: string } | null>(null);
  const { jobs: accountJobs } = useEntityJobs({ type: 'user', id: user?.uid ?? '' });
  const refreshedRoleJobs = useRef(new Set<string>());
  const completedRoleJob = accountJobs.find(
    (job) => ['role.resolve', 'role.assign'].includes(job.kind) && job.state === 'succeeded'
  );

  useEffect(() => {
    if (!completedRoleJob) return;
    const key = `${completedRoleJob.jobId}:${completedRoleJob.revision}`;
    if (refreshedRoleJobs.current.has(key)) return;
    refreshedRoleJobs.current.add(key);
    void auth.currentUser?.getIdToken(true).catch(async (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled'].includes(String(code))) {
        setFeedback({ severity: 'info', message: 'Your account role changed. Sign in again to continue.' });
        await signOut(auth);
      } else {
        setFeedback({
          severity: 'info',
          message: 'Your role update completed. Reconnect and refresh your account to continue.',
        });
      }
    });
  }, [completedRoleJob]);

  const fetchRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const listRoleRequests = createFunctionV2<ListRoleRequestsInputType, ListRoleRequestsOutputType>(
        'listrolerequests'
      );
      const response = await listRoleRequests({ limit: 25 });
      if (response.status === 'error') {
        throw new Error(response.error);
      }
      setRequests(response.data.roleRequests);
      if (response.data.roleRequests.some((request) => request.status === 'accepted')) {
        await auth.currentUser?.getIdToken(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load role requests.';
      setFeedback({ severity: 'error', message });
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests().catch(() => undefined);
  }, [fetchRequests]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);

    try {
      const createRoleRequest = createFunctionV2<CreateRoleRequestInputType, CreateRoleRequestOutputType>(
        'createrolerequest'
      );
      const response = await createRoleRequest({
        requestedRole: role,
        reason,
      });

      if (response.status === 'error') {
        throw new Error(response.error);
      }

      const warningText = response.data.warning ? ` ${response.data.warning.message}` : '';
      const message =
        response.data.requestStatus === 'existing'
          ? `A pending request for ${role} already exists.${warningText}`
          : `Your request for ${role} has been submitted.${warningText}`;

      setFeedback({
        severity: response.data.warning ? 'warning' : 'success',
        message,
      });
      if (response.data.requestStatus === 'created') {
        setReason('');
      }
      await fetchRequests();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit role request.';
      setFeedback({ severity: 'error', message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ width: 1, maxWidth: 900, mx: 'auto' }}>
      <FormControl component="form" onSubmit={handleSubmit} sx={{ display: 'flex', gap: 2, width: 1 }}>
        <InputLabel id="role-select-label">Role</InputLabel>
        <Select
          defaultValue={defaultValue}
          labelId="role-select-label"
          id="role-select"
          value={role}
          label="Role"
          disabled={submitting}
          onChange={(event) => setRole(event.target.value as UserRoleType)}
        >
          {REQUESTABLE_ROLES.map((role) => (
            <MenuItem key={role} value={role}>
              {role}
            </MenuItem>
          ))}
        </Select>
        <TextField
          fullWidth
          rows={4}
          id="reason-text"
          label="Reason"
          name="reason"
          placeholder="Please enter your reason for the specific role change."
          multiline
          value={reason}
          disabled={submitting}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button type="submit" variant="contained" disabled={submitting || reason.trim().length === 0}>
          {submitting ? <CircularProgress size={20} color="inherit" /> : 'Submit Request'}
        </Button>
      </FormControl>
      {feedback && <Alert severity={feedback.severity}>{feedback.message}</Alert>}
      {user && <EntityJobHistory entity={{ type: 'user', id: user.uid }} />}
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">Open Requests</Typography>
          <Button size="small" onClick={fetchRequests} disabled={loadingRequests || submitting} sx={{ minWidth: 76 }}>
            {loadingRequests ? <CircularProgress size={16} color="inherit" /> : 'Refresh'}
          </Button>
        </Stack>
        {requests.length === 0 ? (
          loadingRequests ? (
            <Box
              sx={{
                minHeight: 120,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CircularProgress size={20} />
            </Box>
          ) : (
            <Typography color="text.secondary">No requests submitted yet.</Typography>
          )
        ) : (
          <Box sx={{ position: 'relative' }}>
            {loadingRequests && (
              <LinearProgress
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  zIndex: 1,
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
              />
            )}
            <TableContainer
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                opacity: loadingRequests ? 0.7 : 1,
                transition: 'opacity 0.2s ease',
              }}
            >
              <Table size="small" aria-label="your-role-requests">
                <TableHead>
                  <TableRow>
                    <TableCell>Role</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Submitted</TableCell>
                    <TableCell>Reason</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {requests.map((request) => (
                    <TableRow key={request.roleRequestId}>
                      <TableCell>{request.requestedRole}</TableCell>
                      <TableCell>{formatStatus(request.status)}</TableCell>
                      <TableCell>{new Date(request.createdAtMs).toLocaleString()}</TableCell>
                      <TableCell sx={{ whiteSpace: 'pre-wrap' }}>{request.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
      </Stack>
    </Stack>
  );
};

export default RequestRoleChange;
