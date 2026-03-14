/**
 * User profile page
 * Uses SidebarLayout for consistent navigation
 */
import type { NextPage } from 'next';
import useAuth from '../context/user/UserContext';
import Button, { ButtonProps } from '@mui/material/Button';
import Box from '@mui/system/Box';
import Typography from '@mui/material/Typography';
import UserAvatar from '../components/UserAvatar';
import Head from 'next/head';
import SidebarLayout from '../layout/SidebarLayout';
import Stack from '@mui/material/Stack';
import Link from 'next/link';
import LoginIcon from '@mui/icons-material/Login';

function MediumButton({ children, ...props }: ButtonProps) {
  return (
    <Button sx={{ width: 'min-content' }} size="medium" variant="contained" disableRipple color="primary" {...props}>
      {children}
    </Button>
  );
}

const Profile: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  const { user, logoutUser } = useAuth();
  
  if (!user) {
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
            gap: 3,
            maxWidth: 400,
          }}
        >
          <Typography variant="h4" color="text.primary">
            Not Logged In
          </Typography>
          <Typography color="text.secondary">
            Please log in to view your profile and access your account settings.
          </Typography>
          <Link href="/login?callbackUrl=profile" passHref>
            <Button
              variant="contained"
              size="large"
              startIcon={<LoginIcon />}
              sx={{ mt: 2 }}
            >
              Log In
            </Button>
          </Link>
        </Stack>
      </Stack>
    );
  }

  return (
    <>
      <Head>
        <title>Profile | Upper Room Media</title>
        <meta property="og:title" content="Profile | Upper Room Media" key="title" />
        <meta
          name="description"
          content="Your Upper Room Media profile and account settings."
          key="description"
        />
      </Head>
      <Box display="flex" flexDirection="column" alignItems="center" gap="20px" py={4}>
        <Typography align="center" variant="h4" color="text.primary">
          Profile
        </Typography>
        <UserAvatar sx={{ width: 100, height: 100 }} user={user} />
        <Typography align="center" variant="body1" color="text.primary">
          Display Name: {user.displayName}
        </Typography>
        <Typography align="center" variant="body1" color="text.primary">
          Email: {user.email}
        </Typography>
        <Typography align="center" variant="body1" color="text.primary">
          Role: {user.role ? user.role : 'No role assigned'}
        </Typography>
        <MediumButton onClick={() => logoutUser()}>Logout</MediumButton>
      </Box>
    </>
  );
};

// Use SidebarLayout for sidebar navigation when user is logged in
Profile.PageLayout = SidebarLayout;

export default Profile;
