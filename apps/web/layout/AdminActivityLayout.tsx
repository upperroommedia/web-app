import type { ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import AppLayout from './AppLayout';
import useAuth from '../context/user/UserContext';

/** Keep operational pages unmounted unless the current user is an administrator. */
export default function AdminActivityLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <AppLayout>
      {user?.isAdmin() ? children : <Alert severity="warning">Only administrators can view Activity.</Alert>}
    </AppLayout>
  );
}
