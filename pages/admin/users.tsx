import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import UserTable from '../../components/UserTable';
import AppLayout from '../../layout/AppLayout';
import { createFunctionV2 } from '../../utils/createFunction';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Slide from '@mui/material/Slide';
import useAuth from '../../context/user/UserContext';
import { ListUsersInputType, ListUsersOutputType } from '../../functions/src/listUsers';
import { GetUserInputType, GetUserOutputType } from '../../functions/src/getUser';
import { SetUserRoleInputType, SetUserRoleOutputType } from '../../functions/src/setUserRole';
import { UserWithLoading } from '../../types/User';

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
      <UserTable usersWithLoading={usersWithLoading} handleRoleChange={handleRoleChange} loading={loadingUsers} />
      <Snackbar
        key={message.id}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        open={snackBarOpen}
        autoHideDuration={6000}
        TransitionProps={{ onExited: () => setMessage({ status: 'success', message: '', id: new Date().getTime() }) }}
        // TODO: fade out on close
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
    </Box>
  );
};

// export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
//   return adminProtected(ctx);
// };

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
