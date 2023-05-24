'use client';
import Box from '@mui/material/Box';
import { usePathname } from 'next/navigation';
import Button from '@mui/material/Button';
import Link from 'next/link';
import Head from 'next/head';

const AdminLayoutComponent = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const pages = ['Sermons', 'Users', 'Speakers', 'Lists', 'Topics'];
  const isActive = (page: string) => {
    const path = `admin/${page.toLowerCase()}`;
    return (path === 'Home' && pathname === '/') || `/${path.toLowerCase()}` === pathname.toLocaleLowerCase();
  };
  return (
    <>
      <Head>
        <title>Admin</title>
        <meta property="og:title" content="Admin" key="title" />
      </Head>
      <Box>
        <Box display="flex" flexWrap={'wrap'} justifyContent="center">
          {pages.map((page) => (
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
          ))}
        </Box>
        {children}
      </Box>
    </>
  );
};

export default AdminLayoutComponent;
