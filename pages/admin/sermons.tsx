import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import { useRouter } from 'next/router';
import AppLayout from '../../layout/AppLayout';
import SearchableAdminSermonList from '../../components/SearchableAdminSermonsList';

const AdminSermons = () => {
  const router = useRouter();
  
  return (
    <Box sx={{ maxWidth: 1400, mx: 'auto', width: '100%', px: { xs: 0.5, sm: 2, md: 3 } }}>
      {/* Header */}
      <Stack 
        direction="row" 
        justifyContent="space-between" 
        alignItems="center" 
        spacing={1}
        sx={{ mb: { xs: 0.5, sm: 2 }, pt: { xs: 0.5, sm: 2 }, px: { xs: 0.5, sm: 0 } }}
      >
        <Typography variant="h5" fontWeight={700} sx={{ fontSize: { xs: '1.25rem', sm: '1.5rem' } }}>
          Sermons
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push('/')}
          size="small"
          sx={{ 
            fontSize: { xs: '0.75rem', sm: '0.875rem' },
            px: { xs: 1.5, sm: 2 },
            whiteSpace: 'nowrap',
          }}
        >
          Upload Sermon
        </Button>
      </Stack>
      
      <SearchableAdminSermonList />
    </Box>
  );
};

AdminSermons.PageLayout = AppLayout;

export default AdminSermons;
