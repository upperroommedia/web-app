/**
 * AppLayout - Main wrapper for authenticated pages
 * Handles auth checks and uses the sidebar navigation layout
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import { useRouter } from 'next/router';
import Head from 'next/head';
import useAuth from '../context/user/UserContext';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import LogoutIcon from '@mui/icons-material/Logout';
import RequestRoleChange from '../components/RequestUploadPrivalige';
import UserAvatar from '../components/UserAvatar';
import SidebarLayout from './SidebarLayout';

const MAIN_SCROLL_BOTTOM_INSET =
  'calc(var(--floating-player-offset, 0px) + env(safe-area-inset-bottom, 0px))';

const AppLayout = ({ children }: { children: React.ReactNode }) => {
  const { user, logoutUser } = useAuth();
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
          justifyContent: 'flex-start',
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
          <Card
            variant="outlined"
            sx={{
              p: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
              <UserAvatar user={user} sx={{ width: 44, height: 44 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary">
                  Logged in as
                </Typography>
                <Typography
                  variant="subtitle1"
                  color="text.primary"
                  sx={{
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.displayName || user.email || 'Unknown user'}
                </Typography>
                {user.email && user.displayName && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {user.email}
                  </Typography>
                )}
              </Box>
            </Stack>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<LogoutIcon fontSize="small" />}
              onClick={async () => {
                await logoutUser();
                await router.push('/login');
              }}
            >
              Log Out
            </Button>
          </Card>
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
            maxWidth: '100%',
            overflow: 'auto',
            scrollbarGutter: 'stable',
            // Keep all trailing content reachable above the fixed floating player.
            scrollPaddingBottom: MAIN_SCROLL_BOTTOM_INSET,
          }}
        >
          <Box
            sx={{
              px: { xs: 2, sm: 3, md: 4 },
              pt: { xs: 2, sm: 3, md: 4 },
              pb: {
                xs: `calc(16px + ${MAIN_SCROLL_BOTTOM_INSET})`,
                sm: `calc(24px + ${MAIN_SCROLL_BOTTOM_INSET})`,
                md: `calc(32px + ${MAIN_SCROLL_BOTTOM_INSET})`,
              },
              maxWidth: '100%',
            }}
          >
            {children}
          </Box>
        </Box>
      </SidebarLayout>
    </>
  );
};

export default AppLayout;
