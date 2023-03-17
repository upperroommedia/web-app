import Box from '@mui/material/Box';
import { useRouter } from 'next/router';
import Button from '@mui/material/Button';

const AdminLayout = ({ children }: { children: React.ReactNode }) => {
  const pages = ['Sermons', 'Users', 'Speakers', 'Series', 'Topics'];
  const router = useRouter();
  const isActive = (page: string) => {
    const path = `admin/${page.toLowerCase()}`;
    return (
      (path === 'Home' && router.pathname === '/') || `/${path.toLowerCase()}` === router.pathname.toLocaleLowerCase()
    );
  };
  return (
    <Box>
      <Box display="flex" flexWrap={'wrap'} justifyContent="center">
        {pages.map((page) => (
          <Button
            key={page}
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
            onClick={() => router.push(`/admin/${page.toLowerCase()}`)}
          >
            {page}
          </Button>
        ))}
      </Box>
      {children}
    </Box>
  );
};

export default AdminLayout;
