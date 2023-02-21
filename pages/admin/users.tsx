import functions, { httpsCallable } from '../../firebase/functions';
import { useEffect, useState } from 'react';
import UserTable from '../../components/UserTable';
import AdminLayout from '../../layout/adminLayout';
import { createFunction } from '../../utils/createFunction';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Slide from '@mui/material/Slide';

export interface User {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  role: string;
}
const AdminUsers = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [snackBarOpen, setSnackBarOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<{ message: string; key: number }>({ message: '', key: new Date().getTime() });
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
      setMessage({ message: result.data.status, key: new Date().getTime() });
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
        key={message.key}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        open={snackBarOpen}
        autoHideDuration={6000}
        TransitionProps={{ onExited: () => setMessage({ message: '', key: new Date().getTime() }) }}
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

AdminUsers.PageLayout = AdminLayout;

export default AdminUsers;
