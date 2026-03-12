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

const MAIN_SCROLL_BOTTOM_INSET =
  'calc(var(--floating-player-offset, 0px) + env(safe-area-inset-bottom, 0px))';

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
          alignItems: 'stretch',
          minHeight: '100vh',
          bgcolor: 'background.default',
          px: { xs: 2, sm: 3, md: 4 },
          py: { xs: 3, sm: 4, md: 6 },
        }}
      >
        <Stack
          sx={{
            width: '100%',
            maxWidth: 960,
            mx: 'auto',
            gap: 2,
          }}
        >
          <Stack alignItems="center" textAlign="center" spacing={1}>
            <Typography variant="h4" color="text.primary">
              Access Restricted
            </Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 680 }}>
              You don&apos;t have permission to access the admin area.
              If you think you should have admin privileges, please request permission below.
            </Typography>
          </Stack>
          <Box sx={{ mt: 2, width: '100%' }}>
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
          data-testid="main-content-scroll"
          sx={{
            flex: 1,
            px: { xs: 2, sm: 3, md: 4 },
            pt: { xs: 2, sm: 3, md: 4 },
            pb: {
              xs: `calc(16px + ${MAIN_SCROLL_BOTTOM_INSET})`,
              sm: `calc(24px + ${MAIN_SCROLL_BOTTOM_INSET})`,
              md: `calc(32px + ${MAIN_SCROLL_BOTTOM_INSET})`,
            },
            maxWidth: '100%',
            overflow: 'auto',
            // Keep all trailing content reachable above the fixed floating player.
            scrollPaddingBottom: MAIN_SCROLL_BOTTOM_INSET,
          }}
        >
          {children}
        </Box>
      </SidebarLayout>
    </>
  );
};

export default AppLayout;
