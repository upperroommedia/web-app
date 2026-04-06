import Head from 'next/head';
import { useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import AppLayout from '../../layout/AppLayout';
import useAuth from '../../context/user/UserContext';

const SentrySmokePage = () => {
  const { user } = useAuth();
  const [eventId, setEventId] = useState<string | null>(null);

  if (!user?.isAdmin()) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">Admin access required.</Alert>
      </Box>
    );
  }

  const handleTrigger = () => {
    const event = new Error('Sentry smoke test error from web-app admin page');
    const id = Sentry.captureException(event, {
      tags: {
        area: 'sentry-smoke',
        surface: 'browser',
      },
      extra: {
        smokeTest: true,
      },
    });
    setEventId(id);
  };

  return (
    <>
      <Head>
        <title>Sentry Smoke Test | Upper Room Media</title>
      </Head>
      <Box sx={{ maxWidth: 720, mx: 'auto', py: 4, px: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h4">Sentry Smoke Test</Typography>
          <Typography color="text.secondary">
            Trigger a client-side Sentry event to verify the web-app project is receiving browser issues.
          </Typography>
          <Button variant="contained" onClick={handleTrigger}>
            Trigger Browser Sentry Error
          </Button>
          {eventId && (
            <Alert severity="success">
              Captured test event with id: {eventId}
            </Alert>
          )}
        </Stack>
      </Box>
    </>
  );
};

SentrySmokePage.PageLayout = AppLayout;

export default SentrySmokePage;
