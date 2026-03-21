import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useDocumentData } from 'react-firebase-hooks/firestore';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Grid from '@mui/material/Grid';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CollectionsIcon from '@mui/icons-material/Collections';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SaveIcon from '@mui/icons-material/Save';
import AppLayout from '../../../layout/AppLayout';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import ImageViewer from '../../../components/ImageViewer';
import PopUp from '../../../components/PopUp';
import firestore, { doc } from '../../../firebase/firestore';
import useAuth from '../../../context/user/UserContext';
import { ImageSizeType, ImageType, isImageType } from '../../../types/Image';
import { listConverter } from '../../../types/List';
import { ISpeaker, speakerConverter } from '../../../types/Speaker';
import { createFunctionV2 } from '../../../utils/createFunction';
import {
  DeleteSpeakerCallableInputType,
  DeleteSpeakerCallableOutputType,
  UpdateSpeakerCallableInputType,
  UpdateSpeakerCallableOutputType,
} from '@upperroom/contracts/speakers/createSpeakerTypes';
import { buildUpdateSpeakerPayload } from '../../../utils/speakers/updateSpeakerClient';
import {
  SPEAKER_LIST_SUCCESS_INSTRUCTION,
  SUBSPLASH_SPEAKER_LIST_LINK,
  shouldShowSpeakerListSuccess,
} from '../../../utils/speakers/createSpeakerClient';
import { useAlgoliaSearch } from '../../../context/search/AlgoliaSearchContext';

const updateSpeakerCallable = createFunctionV2<UpdateSpeakerCallableInputType, UpdateSpeakerCallableOutputType>('updatespeaker');
const deleteSpeakerCallable = createFunctionV2<DeleteSpeakerCallableInputType, DeleteSpeakerCallableOutputType>('deletespeaker');

interface SpeakerFormState {
  name: string;
  shortDescription: string;
  description: string;
  images: ImageType[];
  createSpeakerList: boolean;
  deleteAssociatedList: boolean;
}

const buildInitialFormState = (speaker: ISpeaker): SpeakerFormState => ({
  name: speaker.name,
  shortDescription: speaker.shortDescription || '',
  description: speaker.description || '',
  images: speaker.images || [],
  createSpeakerList: false,
  deleteAssociatedList: false,
});

const SpeakerImageSummary = ({ images }: { images: ImageType[] }) => {
  return (
    <Grid container spacing={2}>
      {(['square', 'wide', 'banner'] as const).map((type) => {
        const image = images.find((candidate) => candidate.type === type);
        return (
          <Grid size={{ xs: 12, md: 4 }} key={type}>
            <Card variant="outlined" sx={{ height: '100%' }}>
              <CardContent>
                <Stack spacing={1}>
                  <Typography variant="subtitle2" textTransform="capitalize">
                    {type} image
                  </Typography>
                  <Box
                    sx={{
                      width: '100%',
                      aspectRatio:
                        type === 'square' ? '1 / 1' : type === 'wide' ? '16 / 9' : '1920 / 692',
                      borderRadius: 2,
                      border: '1px solid',
                      borderColor: 'divider',
                      bgcolor: image?.averageColorHex || 'background.default',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={image.downloadLink}
                        alt={image.name}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        No {type} image
                      </Typography>
                    )}
                  </Box>
                  {image && (
                    <Typography variant="caption" color="text.secondary">
                      {image.name} • {image.width}x{image.height}
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        );
      })}
    </Grid>
  );
};

const SpeakerDetailsPage = () => {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { clearCache } = useAlgoliaSearch();
  const speakerId = router.query.speakerId as string;
  const [isEditing, setIsEditing] = useState(false);
  const [formState, setFormState] = useState<SpeakerFormState | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [savePending, setSavePending] = useState(false);
  const [deletePopup, setDeletePopup] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [speakerListSuccessPopupOpen, setSpeakerListSuccessPopupOpen] = useState(false);

  const [speaker, speakerLoading, speakerError] = useDocumentData(
    speakerId ? doc(firestore, 'speakers', speakerId).withConverter(speakerConverter) : null
  );
  const [speakerList] = useDocumentData(
    speaker?.listId ? doc(firestore, 'lists', speaker.listId).withConverter(listConverter) : null
  );

  useEffect(() => {
    if (speaker && !isEditing) {
      setFormState(buildInitialFormState(speaker));
      setNameTouched(false);
      setSubmitError('');
    }
  }, [speaker, isEditing]);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  const hasSquareImage = useMemo(
    () => Boolean(formState?.images.some((image) => image.type === 'square')),
    [formState]
  );

  const handleImageUpdate = useCallback((newImage: ImageType | ImageSizeType) => {
    setFormState((current) => {
      if (!current) {
        return current;
      }

      if (isImageType(newImage)) {
        const castImage = newImage as ImageType;
        const hasMatch = current.images.some((image) => image.type === castImage.type);
        return {
          ...current,
          images: hasMatch
            ? current.images.map((image) => (image.type === castImage.type ? castImage : image))
            : [...current.images, castImage],
        };
      }

      return {
        ...current,
        images: current.images.filter((image) => image.type !== newImage),
      };
    });
  }, []);

  const startEditing = () => {
    if (!speaker) {
      return;
    }
    setFormState(buildInitialFormState(speaker));
    setIsEditing(true);
    setSubmitError('');
    setNameTouched(false);
  };

  const cancelEditing = () => {
    if (speaker) {
      setFormState(buildInitialFormState(speaker));
    }
    setIsEditing(false);
    setSubmitError('');
    setNameTouched(false);
  };

  const handleDelete = async () => {
    if (!speaker || deletePending) {
      return;
    }

    setDeletePending(true);
    try {
      await deleteSpeakerCallable({
        speakerId: speaker.id,
        deleteAssociatedList: true,
      });
      await clearCache();
      await router.push('/admin/speakers');
    } finally {
      setDeletePending(false);
    }
  };

  const handleSave = async () => {
    if (!speaker || !formState || savePending) {
      return;
    }

    const normalizedName = formState.name.trim();
    if (!normalizedName || !hasSquareImage) {
      setNameTouched(true);
      return;
    }

    setSavePending(true);
    setSubmitError('');
    try {
      const response = await updateSpeakerCallable(
        buildUpdateSpeakerPayload({
          speakerId: speaker.id,
          name: normalizedName,
          images: formState.images,
          shortDescription: formState.shortDescription,
          description: formState.description,
          createSpeakerList: formState.createSpeakerList,
          deleteAssociatedList: formState.deleteAssociatedList,
        })
      );

      await clearCache();
      setIsEditing(false);
      setFormState(buildInitialFormState(response.speaker));
      if (shouldShowSpeakerListSuccess(response)) {
        setSpeakerListSuccessPopupOpen(true);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to update speaker.');
    } finally {
      setSavePending(false);
    }
  };

  if (loading || !user || speakerLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!user.isAdmin()) {
    return null;
  }

  if (speakerError) {
    return (
      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        <Alert severity="error">{speakerError.message}</Alert>
      </Box>
    );
  }

  if (!speaker || !formState) {
    return (
      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        <Alert severity="warning">Speaker not found.</Alert>
      </Box>
    );
  }

  const showingListAsRemoved = isEditing && formState.deleteAssociatedList;
  const canCreateList = !speaker.listId || showingListAsRemoved;

  return (
    <>
      <Head>
        <title>{speaker.name}</title>
      </Head>
      <Box sx={{ maxWidth: 1280, mx: 'auto', width: '100%', px: { xs: 1, sm: 2, md: 3 }, py: 3 }}>
        <Stack spacing={3}>
          <Box display="flex" justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }} flexDirection={{ xs: 'column', md: 'row' }} gap={2}>
            <Stack spacing={1}>
              <Breadcrumbs separator="›" aria-label="breadcrumb">
                <Link href="/admin/speakers" style={{ textDecoration: 'none' }}>
                  <MuiLink component="span" underline="hover" color="inherit">
                    Speakers
                  </MuiLink>
                </Link>
                <Typography color="text.primary">{speaker.name}</Typography>
              </Breadcrumbs>
              <Button
                variant="text"
                startIcon={<ArrowBackIcon />}
                onClick={() => router.push('/admin/speakers')}
                sx={{ width: 'fit-content', px: 0 }}
              >
                Back to speakers
              </Button>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              {isEditing ? (
                <>
                  <Button variant="outlined" onClick={cancelEditing}>
                    Cancel
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={savePending ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                    onClick={handleSave}
                    disabled={savePending}
                  >
                    Save changes
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outlined" startIcon={<EditIcon />} onClick={startEditing}>
                    Edit speaker
                  </Button>
                  <Button variant="contained" color="error" startIcon={<DeleteIcon />} onClick={() => setDeletePopup(true)}>
                    Delete speaker
                  </Button>
                </>
              )}
            </Stack>
          </Box>

          <Card>
            <CardContent>
              <Stack spacing={2}>
                <Box display="flex" justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }} flexDirection={{ xs: 'column', md: 'row' }} gap={2}>
                  <Box>
                    <Typography variant="h4">{speaker.name}</Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                      <Chip label={`${speaker.sermonCount || 0} sermons`} />
                      <Chip label={speaker.listId ? 'Has speaker list' : 'No speaker list'} color={speaker.listId ? 'success' : 'default'} variant="outlined" />
                      <Chip label={speaker.tagId ? 'Subsplash tag linked' : 'No tag'} color={speaker.tagId ? 'success' : 'default'} variant="outlined" />
                    </Stack>
                  </Box>
                  {speaker.tagId && (
                    <MuiLink
                      href={`https://dashboard.subsplash.com/-d/#/library/tags/speakers/${speaker.tagId}`}
                      target="_blank"
                      rel="noreferrer"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
                    >
                      <Typography variant="body2" fontWeight={600}>
                        Subsplash Tag
                      </Typography>
                      <OpenInNewIcon fontSize="small" />
                    </MuiLink>
                  )}
                </Box>

                <Divider />

                {isEditing ? (
                  <Stack spacing={2}>
                    <TextField
                      label={nameTouched && formState.name.trim().length === 0 ? 'Speaker name is required' : 'Speaker name'}
                      value={formState.name}
                      fullWidth
                      required
                      error={nameTouched && formState.name.trim().length === 0}
                      onBlur={() => setNameTouched(true)}
                      onChange={(event) => {
                        if (!nameTouched) {
                          setNameTouched(true);
                        }
                        setFormState((current) => (current ? { ...current, name: event.target.value } : current));
                      }}
                    />
                    <TextField
                      label="Short Description (optional)"
                      value={formState.shortDescription}
                      fullWidth
                      onChange={(event) =>
                        setFormState((current) => (current ? { ...current, shortDescription: event.target.value } : current))
                      }
                    />
                    <TextField
                      label="Description (optional)"
                      value={formState.description}
                      fullWidth
                      multiline
                      minRows={4}
                      onChange={(event) =>
                        setFormState((current) => (current ? { ...current, description: event.target.value } : current))
                      }
                    />
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Speaker Images
                      </Typography>
                      <ImageViewer
                        images={formState.images}
                        newImageCallback={handleImageUpdate}
                        speaker={speaker}
                        requiredTypes={['square']}
                      />
                    </Box>

                    {speakerList && !showingListAsRemoved && (
                      <Card variant="outlined">
                        <CardContent>
                          <Stack spacing={1.5}>
                            <Typography variant="subtitle1">Current speaker list</Typography>
                            <Link href={`/admin/lists/${speakerList.id}?count=${speakerList.count || 0}`} style={{ textDecoration: 'none' }}>
                              <MuiLink component="span" underline="hover">
                                {speakerList.name}
                              </MuiLink>
                            </Link>
                            <Typography variant="body2" color="text.secondary">
                              Saving speaker edits will also sync this list name and images in Subsplash.
                            </Typography>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  checked={formState.deleteAssociatedList}
                                  onChange={(event) =>
                                    setFormState((current) =>
                                      current
                                        ? {
                                            ...current,
                                            deleteAssociatedList: event.target.checked,
                                            createSpeakerList: event.target.checked ? false : current.createSpeakerList,
                                          }
                                        : current
                                    )
                                  }
                                />
                              }
                              label="Remove this associated speaker list when saving"
                            />
                          </Stack>
                        </CardContent>
                      </Card>
                    )}

                    {canCreateList && (
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={formState.createSpeakerList}
                            onChange={(event) =>
                              setFormState((current) =>
                                current ? { ...current, createSpeakerList: event.target.checked } : current
                              )
                            }
                          />
                        }
                        label={showingListAsRemoved ? 'Create a replacement speaker list' : 'Create and associate a speaker list'}
                      />
                    )}

                    {showingListAsRemoved && (
                      <Alert severity="warning">
                        The existing speaker list will be deleted from Subsplash and removed from Firebase when you save.
                      </Alert>
                    )}

                    {submitError && <Alert severity="error">{submitError}</Alert>}
                  </Stack>
                ) : (
                  <Grid container spacing={3}>
                    <Grid size={{ xs: 12, md: 6 }}>
                      <Stack spacing={2.5}>
                        <Box>
                          <Typography variant="overline" color="text.secondary">
                            Short Description
                          </Typography>
                          <Typography variant="body1">
                            {speaker.shortDescription || 'No short description provided.'}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="overline" color="text.secondary">
                            Description
                          </Typography>
                          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                            {speaker.description || 'No description provided.'}
                          </Typography>
                        </Box>
                      </Stack>
                    </Grid>
                    <Grid size={{ xs: 12, md: 6 }}>
                      <Card variant="outlined" sx={{ height: '100%' }}>
                        <CardContent>
                          <Stack spacing={1.5}>
                            <Box display="flex" alignItems="center" gap={1}>
                              <CollectionsIcon fontSize="small" />
                              <Typography variant="subtitle1">Speaker list</Typography>
                            </Box>
                            {speakerList ? (
                              <>
                                <Link href={`/admin/lists/${speakerList.id}?count=${speakerList.count || 0}`} style={{ textDecoration: 'none' }}>
                                  <MuiLink component="span" underline="hover">
                                    {speakerList.name}
                                  </MuiLink>
                                </Link>
                                <Typography variant="body2" color="text.secondary">
                                  Local list id: {speakerList.id}
                                </Typography>
                                {speakerList.subsplashId && (
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                    <Typography variant="body2" color="text.secondary">
                                      Subsplash list id:
                                    </Typography>
                                    <MuiLink
                                      href={`https://dashboard.subsplash.com/-d/#/library/lists/standard/${speakerList.subsplashId}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                                    >
                                      <Typography variant="body2">{speakerList.subsplashId}</Typography>
                                      <OpenInNewIcon fontSize="inherit" />
                                    </MuiLink>
                                  </Box>
                                )}
                              </>
                            ) : (
                              <Typography variant="body2" color="text.secondary">
                                This speaker does not currently have an associated speaker list.
                              </Typography>
                            )}
                          </Stack>
                        </CardContent>
                      </Card>
                    </Grid>
                  </Grid>
                )}
              </Stack>
            </CardContent>
          </Card>

          {!isEditing && (
            <Card>
              <CardContent>
                <Stack spacing={2}>
                  <Typography variant="h6">Images</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Read-only speaker image summary. Enter edit mode to make changes.
                  </Typography>
                  <SpeakerImageSummary images={speaker.images} />
                </Stack>
              </CardContent>
            </Card>
          )}
        </Stack>
      </Box>

      <DeleteEntityPopup
        entityBeingDeleted="speaker"
        handleDelete={handleDelete}
        deleteConfirmationPopup={deletePopup}
        setDeleteConfirmationPopup={setDeletePopup}
        isDeleting={deletePending}
      />

      <PopUp title="Speaker list created" open={speakerListSuccessPopupOpen} setOpen={setSpeakerListSuccessPopupOpen}>
        <Box display="flex" flexDirection="column" gap={2} sx={{ py: 1 }}>
          <Typography>{SPEAKER_LIST_SUCCESS_INSTRUCTION}</Typography>
          <MuiLink href={SUBSPLASH_SPEAKER_LIST_LINK} target="_blank" rel="noreferrer">
            Subsplash Speaker List
          </MuiLink>
        </Box>
      </PopUp>
    </>
  );
};

const ProtectedSpeakerDetailsPage = () => {
  return <SpeakerDetailsPage />;
};

ProtectedSpeakerDetailsPage.PageLayout = AppLayout;

export default ProtectedSpeakerDetailsPage;
