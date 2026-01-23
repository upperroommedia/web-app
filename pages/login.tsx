/**
 * Login Page - Standalone login screen without navbar/sidebar
 */
import Box from '@mui/system/Box';
import Login from '../components/Login';
import Head from 'next/head';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import Image from 'next/image';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>Login | Upper Room Media</title>
        <meta property="og:title" content="Login | Upper Room Media" key="title" />
      </Head>

      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          bgcolor: 'background.default',
          p: 2,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            p: { xs: 3, sm: 5 },
            maxWidth: 420,
            width: '100%',
            borderRadius: 3,
            bgcolor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Stack spacing={3} alignItems="center">
            {/* Logo and Title */}
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Avatar
                variant="square"
                sx={{
                  width: 48,
                  height: 48,
                  bgcolor: 'transparent',
                  position: 'relative',
                }}
              >
                <Image src="/URM_icon.png" alt="Upper Room Media Logo" fill sizes="48px" />
              </Avatar>
              <Box>
                <Typography
                  variant="h5"
                  sx={{
                    fontWeight: 700,
                    letterSpacing: '-0.01em',
                    color: 'text.primary',
                    lineHeight: 1.2,
                  }}
                >
                  Upper Room
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: 'primary.main',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontSize: '0.7rem',
                  }}
                >
                  Media Uploader
                </Typography>
              </Box>
            </Stack>

            {/* Welcome Message */}
            <Stack spacing={1} alignItems="center" textAlign="center">
              <Typography variant="h6" color="text.primary" fontWeight={600}>
                Welcome Back
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Sign in to upload and manage sermons
              </Typography>
            </Stack>

            {/* Login Buttons */}
            <Box sx={{ width: '100%' }}>
              <Login />
            </Box>
          </Stack>
        </Paper>
      </Box>
    </>
  );
}
