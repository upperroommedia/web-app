import Box from '@mui/material/Box';
import { useRouter } from 'next/router';
import Button from '@mui/material/Button';
import Link from 'next/link';
import Head from 'next/head';
import useAuth from '../context/user/UserContext';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import RequestRoleChange from '../components/RequestUploadPrivalige';

const AdminLayout = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const router = useRouter();
  if (!user) {
    router.push('/login?callbackurl=admin');
    return (
      <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
        <CircularProgress />
      </Stack>
    );
  } else if (!user.isUploader()) {
    return (
      <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
        <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
          <Typography variant="h2">You are not an admin.</Typography>
          <Typography>If you think you should have admin privilages, please request permission below.</Typography>
        </Stack>
        <RequestRoleChange />
      </Stack>
    );
  }

  const pages = ['Sermons', 'Users', 'Speakers', 'Lists', 'Topics'];
  const isActive = (page: string) => {
    const path = `admin/${page.toLowerCase()}`;
    return (
      (path === 'Home' && router.pathname === '/') || `/${path.toLowerCase()}` === router.pathname.toLocaleLowerCase()
    );
  };

  return (
    <>
      <Head>
        <title>Admin</title>
        <meta property="og:title" content="Admin" key="title" />
      </Head>
      <Box>
        <Box display="flex" flexWrap={'wrap'} justifyContent="center">
          {pages.map((page) => {
            if (page !== 'Sermons' && user.isUploader() && !user.isAdmin()) {
              return null;
            } else {
              return (
                <Link href={`/admin/${page.toLowerCase()}`} passHref key={page}>
                  <Button
                    disableRipple
                    sx={{
                      textTransform: 'capitalize',
                      '&:hover': {
                        bgcolor: 'rgb(55,65,81)',
                      },
                      bgcolor: isActive(page) ? 'rgb(17 24 39)' : 'rgb(31 41 55)',
                      color: isActive(page) ? 'rgb(209 213 219)' : 'rgb(156 163 175)',
                      marginY: '0.5rem',
                      marginX: { xs: '0.2rem', sm: '0.5rem' },
                      fontSize: { xs: '0.75rem', sm: '1rem' },
                    }}
                  >
                    {page}
                  </Button>
                </Link>
              );
            }
          })}
        </Box>
        {children}
      </Box>
    </>
  );
};

export default AdminLayout;
