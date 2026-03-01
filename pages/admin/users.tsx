import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Slide from '@mui/material/Slide';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import UserTable from '../../components/UserTable';
import useAuth from '../../context/user/UserContext';
import { GetUserInputType, GetUserOutputType } from '../../functions/src/getUser';
import { CreateInviteInputType, CreateInviteResultData, INVITE_ROLES, InviteRoleType } from '../../functions/src/invites/inviteTypes';
import { ListUsersInputType, ListUsersOutputType } from '../../functions/src/listUsers';
import { SetUserRoleInputType, SetUserRoleOutputType } from '../../functions/src/setUserRole';
import AppLayout from '../../layout/AppLayout';
import { UserWithLoading } from '../../types/User';
import { createFunctionV2 } from '../../utils/createFunction';

type CreateInviteOutputType = { status: 'success'; data: CreateInviteResultData } | { status: 'error'; error: string };

let cachedUsers: UserWithLoading[] | null = null;
let listUsersInFlight: Promise<UserWithLoading[]> | null = null;

const fetchUsersWithDedupe = async (): Promise<UserWithLoading[]> => {
  if (cachedUsers) {
    return cachedUsers;
  }

  if (listUsersInFlight) {
    return listUsersInFlight;
  }

  const listUsers = createFunctionV2<ListUsersInputType, ListUsersOutputType>('listusers');
  listUsersInFlight = listUsers({})
    .then((listUsersOutput) => {
      if (listUsersOutput.status === 'error') {
        throw new Error(listUsersOutput.error);
      }
      const mappedUsers = listUsersOutput.data.map((listUserOutput) => ({ ...listUserOutput, loading: false }));
      cachedUsers = mappedUsers;
      return mappedUsers;
    })
    .finally(() => {
      listUsersInFlight = null;
    });

  return listUsersInFlight;
};

const AdminUsers = () => {
  const [usersWithLoading, setUsersWithLoading] = useState<UserWithLoading[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRoleType>('uploader');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState('');
  const [inviteExpiresAtMs, setInviteExpiresAtMs] = useState<number | null>(null);
  const [snackBarOpen, setSnackBarOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<{ status: 'success' | 'error'; message: string; id: number }>({
    status: 'success',
    message: '',
    id: new Date().getTime(),
  });

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const users = await fetchUsersWithDedupe();
      setUsersWithLoading(users);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load users';
      setMessage({ status: 'error', message, id: new Date().getTime() });
      setSnackBarOpen(true);
    } finally {
      setLoadingUsers(false);
    }
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
    setGeneratedInviteUrl('');
    setInviteExpiresAtMs(null);
  };

  const closeInviteDialog = () => {
    if (inviteLoading) {
      return;
    }
    setInviteDialogOpen(false);
  };

  const handleCreateInvite = async () => {
    setInviteLoading(true);
    setGeneratedInviteUrl('');
    setInviteExpiresAtMs(null);

    try {
      const createInvite = createFunctionV2<CreateInviteInputType, CreateInviteOutputType>('createinvite');
      const response = await createInvite({ email: inviteEmail, role: inviteRole });

      if (response.status === 'error') {
        throw new Error(response.error);
      }

      setGeneratedInviteUrl(response.data.inviteUrl);
      setInviteExpiresAtMs(response.data.expiresAtMs);
      setMessage({
        status: 'success',
        message: `Invite created for ${response.data.invitedEmail}.`,
        id: new Date().getTime(),
      });
      setSnackBarOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create invite.';
      setMessage({
        status: 'error',
        message,
        id: new Date().getTime(),
      });
      setSnackBarOpen(true);
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
      setMessage({
        status: 'success',
        message: 'Invite link copied to clipboard.',
        id: new Date().getTime(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to copy invite link.';
      setMessage({
        status: 'error',
        message,
        id: new Date().getTime(),
      });
    } finally {
      setSnackBarOpen(true);
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
        cachedUsers = updatedUsers;
        return updatedUsers;
      });
      setMessage({ status: 'success', message: setUserRoleResult.status, id: new Date().getTime() });
    } catch (error) {
      let message = '';
      if (error instanceof Error) {
        message = error.message;
      } else if (error instanceof Object && 'message' in error && typeof error.message === 'string') {
        message = error.message;
      } else {
        message = 'An unexpected error has occured';
      }
      setMessage({
        status: 'error',
        message,
        id: new Date().getTime(),
      });
    } finally {
      setSnackBarOpen(true);
      setUserLoading(uid, false);
    }
  };

  useEffect(() => {
    const g = async () => {
      await fetchUsers();
    };
    g();
  }, []);

  return (
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
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
      <Snackbar
        key={message.id}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        open={snackBarOpen}
        autoHideDuration={6000}
        TransitionProps={{ onExited: () => setMessage({ status: 'success', message: '', id: new Date().getTime() }) }}
        TransitionComponent={(props) => <Slide {...props} direction="right" />}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return;
          setSnackBarOpen(false);
        }}
      >
        <Alert severity={message.status} onClose={() => setSnackBarOpen(false)}>
          {message.message}
        </Alert>
      </Snackbar>
      <Dialog open={inviteDialogOpen} onClose={closeInviteDialog} fullWidth maxWidth="sm">
        <DialogTitle>Create Invite</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Invitee Email"
            type="email"
            fullWidth
            value={inviteEmail}
            disabled={inviteLoading}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <FormControl fullWidth margin="dense" disabled={inviteLoading}>
            <InputLabel id="invite-role-label">Role</InputLabel>
            <Select
              labelId="invite-role-label"
              value={inviteRole}
              label="Role"
              onChange={(event) => setInviteRole(event.target.value as InviteRoleType)}
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
              <Alert severity="success">
                Invite link ready.
                {inviteExpiresAtMs ? ` Expires ${new Date(inviteExpiresAtMs).toLocaleString()}.` : ''}
              </Alert>
              <TextField fullWidth value={generatedInviteUrl} InputProps={{ readOnly: true }} />
              <Stack direction="row" spacing={2} alignItems="center">
                <Button size="small" onClick={handleCopyInviteLink}>
                  Copy Link
                </Button>
                <Link href={generatedInviteUrl} target="_blank" rel="noopener noreferrer" underline="hover">
                  Open Link
                </Link>
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInviteDialog} disabled={inviteLoading}>
            Close
          </Button>
          <Button onClick={handleCreateInvite} disabled={inviteLoading || inviteEmail.trim().length === 0} variant="contained">
            Generate Invite
          </Button>
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
