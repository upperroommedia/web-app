import { useEffect, useState } from 'react';
import UserTable from '../../components/UserTable';
import AdminLayout from '../../layout/adminLayout';
import { createFunctionV2 } from '../../utils/createFunction';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Slide from '@mui/material/Slide';
import useAuth from '../../context/user/UserContext';
import { ListUsersInputType, ListUsersOutputType } from '../../functions/src/listUsers';
import { GetUserInputType, GetUserOutputType } from '../../functions/src/getUser';
import { SetUserRoleInputType, SetUserRoleOutputType } from '../../functions/src/setUserRole';
import { UserWithLoading } from '../../types/User';

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
    const listUsers = createFunctionV2<ListUsersInputType, ListUsersOutputType>('listusers');

    const listUsersOutput = await listUsers({});
    if (listUsersOutput.status === 'error') {
      setMessage({ status: 'error', message: listUsersOutput.error, id: new Date().getTime() });
      setSnackBarOpen(true);
      return;
    }
    setUsersWithLoading(listUsersOutput.data.map((listUserOutput) => ({ ...listUserOutput, loading: false })));
    setLoadingUsers(false);
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
      setUsersWithLoading((previousUsersWithLoading) =>
        previousUsersWithLoading.map((previousUserWithLoading) => {
          if (previousUserWithLoading.uid === uid) {
            return { ...getUserResponse.data, loading: false };
          }
          return previousUserWithLoading;
        })
      );
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
    <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
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
    </div>
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

ProtectedAdminUsers.PageLayout = AdminLayout;

export default ProtectedAdminUsers;
