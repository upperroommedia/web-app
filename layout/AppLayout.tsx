/**
 * AppLayout - Main wrapper for authenticated pages
 * Handles auth checks and uses the sidebar navigation layout
 */
import Box from '@mui/material/Box';
import { useRouter } from 'next/router';
import Head from 'next/head';
import useAuth from '../context/user/UserContext';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import RequestRoleChange from '../components/RequestUploadPrivalige';
import SidebarLayout from './SidebarLayout';

const AppLayout = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const router = useRouter();

  if (!user) {
    router.push('/login?callbackurl=admin');
    return (
      <Stack
        sx={{
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress color="primary" />
      </Stack>
    );
  } else if (!user.canUpload()) {
    return (
      <Stack
        sx={{
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          bgcolor: 'background.default',
          p: 4,
        }}
      >
        <Stack
          sx={{
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
            gap: 2,
            maxWidth: 500,
          }}
        >
          <Typography variant="h4" color="text.primary">
            Access Restricted
          </Typography>
          <Typography color="text.secondary">
            You don&apos;t have permission to access the admin area.
            If you think you should have admin privileges, please request permission below.
          </Typography>
          <Box sx={{ mt: 2 }}>
            <RequestRoleChange />
          </Box>
        </Stack>
      </Stack>
    );
  }

  return (
    <>
      <Head>
        <title>Upper Room Media</title>
        <meta property="og:title" content="Upper Room Media" key="title" />
      </Head>
      <SidebarLayout>
        <Box
          sx={{
            flex: 1,
            p: { xs: 2, sm: 3, md: 4 },
            maxWidth: '100%',
            overflow: 'auto',
          }}
        >
          {children}
        </Box>
      </SidebarLayout>
    </>
  );
};

export default AppLayout;
