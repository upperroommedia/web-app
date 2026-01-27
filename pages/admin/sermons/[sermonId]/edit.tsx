/**
 * Edit Sermon Page
 * - Same functionality as EditSermonForm dialog but as a full page
 * - Only allows editing existing sermon data, not uploading new
 */
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import Link from 'next/link';

import AppLayout from '../../../../layout/AppLayout';
import firestore, { doc, getDoc, collection } from '../../../../firebase/firestore';
import { Sermon, uploadStatus } from '../../../../types/SermonTypes';
import { sermonConverter } from '../../../../types/Sermon';
import { listConverter, List } from '../../../../types/List';
import useAuth from '../../../../context/user/UserContext';
import VerifiedUserUploaderComponent from '../../../../components/uploaderComponents/VerifiedUserUploaderComponent';
import { getDownloadURL, getStorage, ref } from '../../../../firebase/storage';
import firebase from '../../../../firebase/firebase';
import { PROCESSED_SERMONS_BUCKET } from '../../../../constants/storage_constants';
import { showAudioTrimmerBoolean } from '../../../../components/uploaderComponents/utils';
import { useCollectionDataOnce } from 'react-firebase-hooks/firestore';
import { SermonURL } from '../../../../components/EditSermonForm';

const storage = getStorage(firebase);

const EditSermonPage = () => {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const sermonId = router.query.sermonId as string;

  const [sermon, setSermon] = useState<Sermon | null>(null);
  const [sermonUrl, setSermonUrl] = useState<SermonURL>({ url: undefined, status: 'loading' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch sermon lists
  const [sermonLists, listsLoading, listsError] = useCollectionDataOnce(
    sermonId ? collection(firestore, `sermons/${sermonId}/sermonLists`).withConverter(listConverter) : null
  );

  const canPublish = user?.canPublish() ?? false;

  // Check if audio trimmer should be shown (only if not published)
  const showAudioTrimmer = useMemo(() => {
    if (!sermon) return false;
    return showAudioTrimmerBoolean(sermon.status.soundCloud, sermon.status.subsplash);
  }, [sermon]);

  // Fetch sermon data
  const fetchSermonData = useCallback(async () => {
    if (!sermonId || !user) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch sermon
      const sermonDoc = await getDoc(doc(firestore, 'sermons', sermonId).withConverter(sermonConverter));
      if (!sermonDoc.exists()) {
        setError('Sermon not found');
        setLoading(false);
        return;
      }

      const sermonData = sermonDoc.data();
      
      // Check permissions
      const canEdit = canPublish || (
        user.canUpload() && 
        sermonData.status.subsplash !== uploadStatus.UPLOADED && 
        sermonData.status.soundCloud !== uploadStatus.UPLOADED
      );
      
      if (!canEdit) {
        setError('You do not have permission to edit this sermon');
        setLoading(false);
        return;
      }

      setSermon(sermonData);
    } catch (err: any) {
      console.error('Error fetching sermon:', err);
      setError(err.message || 'Failed to fetch sermon');
    }

    setLoading(false);
  }, [sermonId, user, canPublish]);

  // Fetch sermon audio URL for trimmer
  useEffect(() => {
    if (!sermon || !showAudioTrimmer) return;
    
    getDownloadURL(ref(storage, `${PROCESSED_SERMONS_BUCKET}/${sermon.id}`))
      .then((url) => {
        setSermonUrl({ url, status: 'success' });
      })
      .catch((err) => {
        setSermonUrl({ url: undefined, status: 'error' });
        console.error('Error fetching audio URL:', err);
      });
  }, [sermon, showAudioTrimmer]);

  useEffect(() => {
    if (!authLoading && user) {
      fetchSermonData();
    }
  }, [fetchSermonData, authLoading, user]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [user, authLoading, router]);

  // Handle close/cancel - navigate back to details
  const handleClose = () => {
    router.push(`/admin/sermons/${sermonId}`);
  };

  if (authLoading || loading || listsLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return null;
  }

  if (error || listsError || !sermon) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">{error || listsError?.message || 'Sermon not found'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push('/admin/sermons')}
          sx={{ mt: 2 }}
        >
          Back to Sermons
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Head>
        <title>Edit: {sermon.title} | Admin | Upper Room Media</title>
      </Head>

      <Box sx={{ maxWidth: 1200, mx: 'auto', py: 2, px: { xs: 2, sm: 3 } }}>
        {/* Breadcrumbs */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />}>
            <Link href="/admin/sermons" style={{ textDecoration: 'none' }}>
              <Typography sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}>
                Sermons
              </Typography>
            </Link>
            <Link href={`/admin/sermons/${sermonId}`} style={{ textDecoration: 'none' }}>
              <Typography sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}>
                {sermon.title}
              </Typography>
            </Link>
            <Typography color="text.primary" fontWeight={500}>
              Edit
            </Typography>
          </Breadcrumbs>
          <Button
            variant="outlined"
            size="small"
            onClick={handleClose}
          >
            Cancel
          </Button>
        </Box>

        {/* Uploader Component with existing sermon - same props as EditSermonForm */}
        <VerifiedUserUploaderComponent 
          existingSermon={sermon}
          existingList={sermonLists as List[] || []}
          existingSermonUrl={sermonUrl}
          setEditFormOpen={handleClose}
        />
      </Box>
    </>
  );
};

EditSermonPage.PageLayout = AppLayout;

export default EditSermonPage;
