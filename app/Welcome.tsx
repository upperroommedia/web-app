'use client';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useAuth } from '../auth/hooks';

export function Welcome() {
  const { tenant } = useAuth();

  return (
    <Stack justifyContent="center" alignItems="center">
      <Typography variant="h3">Welcome to Upper Room Media {tenant?.name}!</Typography>
    </Stack>
  );
}
