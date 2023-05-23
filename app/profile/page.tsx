/**
 * User profile page
 */
'use client';

// import Button, { ButtonProps } from '@mui/material/Button';
import Box from '@mui/system/Box';
import Typography from '@mui/material/Typography';
import UserAvatar from '../../components/UserAvatar';
import { useAuth } from '../../auth/hooks';
// import LoginPage from './old_login';
import Head from 'next/head';

// function MediumButton({ children, ...props }: ButtonProps) {
//   return (
//     <Button sx={{ width: 'min-content' }} size="medium" variant="contained" disableRipple color="primary" {...props}>
//       {children}
//     </Button>
//   );
// }

export default function Profile() {
  const { tenant } = useAuth();
  if (tenant) {
    return (
      <>
        <Head>
          <title>About</title>
          <meta property="og:title" content="About" key="title" />
          <meta
            name="description"
            content="Bringing the Word of God from a timeless faith into your hearts and minds anytime, anywhere.
Upper Room Media is a ministry of the Coptic Orthodox Church that brings to you rich & fresh spiritual resources including Sermons, Music, Videos, Blogs and much more!"
            key="description"
          />
        </Head>
        <Box display="flex" flexDirection="column" alignItems="center" gap="20px">
          <Typography align="center" variant="h2">
            Profile
          </Typography>
          <UserAvatar sx={{ width: 100, height: 100 }} tenant={tenant} />
          <Typography align="center" variant="body1">
            Display Name: {}
          </Typography>
          <Typography align="center" variant="body1">
            Email: {tenant.email}
          </Typography>
          <Typography align="center" variant="body1">
            Role: {tenant.customClaims.role ? tenant.customClaims.role : 'No role assigned'}
          </Typography>
          {/* <MediumButton onClick={() => logoutUser()}>Logout</MediumButton> */}
        </Box>
      </>
    );
  } else {
    return (
      <Box display="flex" flexDirection="column" alignItems="center">
        <Typography align="center" variant="h2">
          You are not logged in
        </Typography>
        {/* <LoginPage></LoginPage> */}
      </Box>
    );
  }
}
