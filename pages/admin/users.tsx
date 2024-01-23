import functions, { httpsCallable } from '../../firebase/functions';
import { useEffect, useState } from 'react';
import UserTable from '../../components/UserTable';
import AdminLayout from '../../layout/adminLayout';
import { createFunction } from '../../utils/createFunction';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Slide from '@mui/material/Slide';
import { User } from '../../types/User';
import useAuth from '../../context/user/UserContext';

const AdminUsers = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [snackBarOpen, setSnackBarOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<{ message: string; id: number }>({ message: '', id: new Date().getTime() });

  const fetchUsers = async () => {
    const getImage = createFunction<any, any>('listusers');
    const res = await getImage({});
    setUsers(res.result || []);
  };

  const setUserRole = httpsCallable(functions, 'setUserRole');

  const handleRoleChange = (uid: string, role: string) => {
    setUserRole({ uid, role }).then((result: any) => {
      if (result.data.status === 'Success!') {
        fetchUsers();
      }
      setMessage({ message: result.data.status, id: new Date().getTime() });
      setSnackBarOpen(true);
    });
  };
  useEffect(() => {
    const g = async () => {
      await fetchUsers();
    };
    g();
  }, []);

  return (
    <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
      <UserTable users={users} handleRoleChange={handleRoleChange} />
      <Snackbar
        key={message.id}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        open={snackBarOpen}
        autoHideDuration={6000}
        TransitionProps={{ onExited: () => setMessage({ message: '', id: new Date().getTime() }) }}
        // TODO: fade out on close
        TransitionComponent={(props) => <Slide {...props} direction="right" />}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return;
          setSnackBarOpen(false);
        }}
      >
        <Alert severity={message.message === 'Success!' ? 'success' : 'error'} onClose={() => setSnackBarOpen(false)}>
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
