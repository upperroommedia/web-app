import Box from '@mui/material/Box';
import { useRouter } from 'next/router';
import NavMenuItem from '../components/NavMenuItem';

const AdminLayout = ({ children }: { children: React.ReactNode }) => {
  const pages = ['Sermons', 'Users', 'Speakers', 'Series', 'Topics'];
  const router = useRouter();

  return (
    <Box>
      <Box display="flex" bgcolor="aliceblue" justifyContent="center">
        {pages.map((page) => (
          <NavMenuItem
            key={page}
            path={`admin/${page.toLowerCase()}`}
            onClick={() => router.push(`/admin/${page.toLowerCase()}`)}
          >
            {page}
          </NavMenuItem>
        ))}
      </Box>
      {children}
    </Box>
  );
};

export default AdminLayout;
