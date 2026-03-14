import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Slide from '@mui/material/Slide';
import Snackbar from '@mui/material/Snackbar';
import AddIcon from '@mui/icons-material/Add';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppLayout from '../../layout/AppLayout';
import { formatLockBusyRetryMessage, parseLockBusyDetails } from '../../utils/callableConcurrency';
import SearchableAdminSermonList from '../../components/SearchableAdminSermonsList';
import { deleteSermonWithExternalCleanup } from '../../utils/deleteSermonWithExternalCleanup';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';

type DeleteToastState = {
  open: boolean;
  severity: 'info' | 'success' | 'error';
  message: string;
  id: number;
};

const getQueryString = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const getDeleteFailureMessage = (error: unknown): string => {
  const busyDetails = parseLockBusyDetails(error);
  if (busyDetails) {
    return formatLockBusyRetryMessage(
      'Failed to delete sermon because another cleanup is in progress.',
      busyDetails
    );
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Failed to delete sermon';
};

const AdminSermons = () => {
  const router = useRouter();
  const { clearCache } = useAlgoliaSearch();
  const processedDeleteIntentRef = useRef<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [deleteToast, setDeleteToast] = useState<DeleteToastState>({
    open: false,
    severity: 'info',
    message: '',
    id: Date.now(),
  });

  const clearDeleteIntentPayload = useCallback(async () => {
    const {
      deleteIntent,
      deleteSermonId,
      deleteSubsplashId,
      deleteSoundCloudTrackId,
      ...remainingQuery
    } = router.query;

    if (!deleteIntent && !deleteSermonId && !deleteSubsplashId && !deleteSoundCloudTrackId) {
      return;
    }

    await router.replace(
      {
        pathname: '/admin/sermons',
        query: remainingQuery,
      },
      undefined,
      { shallow: true }
    );
  }, [router]);

  const deleteIntentPayload = useMemo(() => {
    if (!router.isReady) {
      return null;
    }

    const deleteIntent = getQueryString(router.query.deleteIntent);
    const deleteSermonId = getQueryString(router.query.deleteSermonId);

    if (deleteIntent !== 'sermon' || !deleteSermonId) {
      return null;
    }

    return {
      sermonId: deleteSermonId,
      subsplashId: getQueryString(router.query.deleteSubsplashId),
      soundCloudTrackId: getQueryString(router.query.deleteSoundCloudTrackId),
    };
  }, [
    router.isReady,
    router.query.deleteIntent,
    router.query.deleteSermonId,
    router.query.deleteSubsplashId,
    router.query.deleteSoundCloudTrackId,
  ]);

  useEffect(() => {
    if (!deleteIntentPayload) {
      return;
    }

    const deleteAttemptKey = [
      deleteIntentPayload.sermonId,
      deleteIntentPayload.subsplashId || '',
      deleteIntentPayload.soundCloudTrackId || '',
    ].join(':');

    if (processedDeleteIntentRef.current === deleteAttemptKey) {
      return;
    }
    processedDeleteIntentRef.current = deleteAttemptKey;

    setDeleteToast({
      open: true,
      severity: 'info',
      message: 'Deleting sermon...',
      id: Date.now(),
    });

    const runDeleteIntent = async () => {
      try {
        await deleteSermonWithExternalCleanup(deleteIntentPayload);
        await clearCache();
        setRefreshNonce((currentNonce) => currentNonce + 1);
        setDeleteToast({
          open: true,
          severity: 'success',
          message: 'Sermon deleted successfully.',
          id: Date.now(),
        });
      } catch (error) {
        setDeleteToast({
          open: true,
          severity: 'error',
          message: getDeleteFailureMessage(error),
          id: Date.now(),
        });
      } finally {
        await clearDeleteIntentPayload();
      }
    };

    runDeleteIntent();
  }, [clearCache, clearDeleteIntentPayload, deleteIntentPayload]);

  return (
    <>
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

        <SearchableAdminSermonList refreshNonce={refreshNonce} />
      </Box>
      <Snackbar
        key={deleteToast.id}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        open={deleteToast.open}
        autoHideDuration={deleteToast.severity === 'info' ? undefined : 6000}
        TransitionComponent={(props) => <Slide {...props} direction="up" />}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return;
          setDeleteToast((previousToast) => ({ ...previousToast, open: false }));
        }}
      >
        <Alert
          severity={deleteToast.severity}
          onClose={() => setDeleteToast((previousToast) => ({ ...previousToast, open: false }))}
        >
          {deleteToast.message}
        </Alert>
      </Snackbar>
    </>
  );
};

AdminSermons.PageLayout = AppLayout;

export default AdminSermons;
