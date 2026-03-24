import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/router';
import useAuth from '../../context/user/UserContext';

const InviteSuccessPage = () => {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 560, p: { xs: 3, sm: 4 } }}>
        <Stack spacing={2}>
          <Typography variant="h5">Invite Accepted</Typography>
          <Alert severity="success">Your role invite was claimed successfully. Your updated permissions are now active.</Alert>
          <Typography color="text.secondary">
            If you had this app open in another tab, refresh it to load your new permissions.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            {user?.isAdmin() && (
              <Button variant="contained" onClick={() => router.push('/admin/users')}>
                Go to User Admin
              </Button>
            )}
            {!user?.isAdmin() && user?.canUpload() && (
              <Button variant="contained" onClick={() => router.push('/uploader')}>
                Go to Uploader
              </Button>
            )}
            <Button variant="outlined" onClick={() => router.push('/')}>
              Go Home
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
};

export default InviteSuccessPage;
