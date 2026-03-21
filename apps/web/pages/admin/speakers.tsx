import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import CreateSpeakerPopup, { CreateSpeakerFormValues } from '../../components/CreateSpeakerPopup';
import PopUp from '../../components/PopUp';
import SpeakerTable from '../../components/SpeakerTable';
import { Order } from '../../context/types';
import AppLayout from '../../layout/AppLayout';
import { ISpeaker } from '../../types/Speaker';
import useAuth from '../../context/user/UserContext';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  SPEAKER_LIST_SUCCESS_INSTRUCTION,
  SUBSPLASH_SPEAKER_LIST_LINK,
  shouldShowSpeakerListSuccess,
} from '../../utils/speakers/createSpeakerClient';
import {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
} from '@upperroom/contracts/speakers/createSpeakerTypes';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import { normalizeAlgoliaSpeakerHit, searchSpeakersIndex } from '../../utils/algolia/searchRecords';
import { getDefaultSpeakerSortOrder } from '../../utils/algolia/speakerSorting';
import firestore, {
  QueryDocumentSnapshot,
  collection,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
} from '../../firebase/firestore';
import { speakerConverter } from '../../types/Speaker';
import {
  AcceptSpeakerRequestInputType,
  AcceptSpeakerRequestOutputType,
  DenySpeakerRequestInputType,
  DenySpeakerRequestOutputType,
  ListSpeakerRequestsInputType,
  ListSpeakerRequestsOutputType,
  SpeakerRequestSummary,
} from '@upperroom/contracts/speakerRequests/speakerRequestTypes';
import { buildCreateSpeakerPayload } from '../../utils/speakers/createSpeakerClient';

const createSpeakerCallable = createFunctionV2<CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType>(
  'createspeaker'
);
const listSpeakerRequestsCallable = createFunctionV2<ListSpeakerRequestsInputType, ListSpeakerRequestsOutputType>(
  'listspeakerrequests'
);
const acceptSpeakerRequestCallable = createFunctionV2<AcceptSpeakerRequestInputType, AcceptSpeakerRequestOutputType>(
  'acceptspeakerrequest'
);
const denySpeakerRequestCallable = createFunctionV2<DenySpeakerRequestInputType, DenySpeakerRequestOutputType>(
  'denyspeakerrequest'
);

const AdminSpeakers = () => {
  const { searchClient, loading: searchClientLoading, clearCache } = useAlgoliaSearch();
  const [speakerInput, setSpeakerInput] = useState<string>('');
  const [debouncedSpeakerInput, setDebouncedSpeakerInput] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [speakers, setSpeakers] = useState<ISpeaker[]>([]);
  const [speakersLoading, setSpeakersLoading] = useState<boolean>(false);
  const [totalSpeakers, setTotalSpeakers] = useState<number>(0);
  const [createSpeakerPopupOpen, setCreateSpeakerPopupOpen] = useState<boolean>(false);
  const [speakerListSuccessPopupOpen, setSpeakerListSuccessPopupOpen] = useState<boolean>(false);
  const [sortProperty, setSortProperty] = useState<keyof ISpeaker>('sermonCount');
  const [sortOrder, setSortOrder] = useState<Order>(getDefaultSpeakerSortOrder('sermonCount'));
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const [speakerRequests, setSpeakerRequests] = useState<SpeakerRequestSummary[]>([]);
  const [speakerRequestsLoading, setSpeakerRequestsLoading] = useState(false);
  const [speakerRequestsExpanded, setSpeakerRequestsExpanded] = useState(false);
  const [speakerRequestNotice, setSpeakerRequestNotice] = useState<{ severity: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [selectedSpeakerRequest, setSelectedSpeakerRequest] = useState<SpeakerRequestSummary | null>(null);
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [declineMessage, setDeclineMessage] = useState('');
  const [speakerRequestActionLoading, setSpeakerRequestActionLoading] = useState<'accept' | 'deny' | null>(null);
  const speakerNamePageCursorsRef = useRef<Array<QueryDocumentSnapshot<ISpeaker> | null>>([]);

  const isBrowsingByName = useMemo(
    () => debouncedSpeakerInput.trim().length === 0 && sortProperty === 'name',
    [debouncedSpeakerInput, sortProperty]
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSpeakerInput(speakerInput);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [speakerInput]);

  useEffect(() => {
    speakerNamePageCursorsRef.current = [];
  }, [debouncedSpeakerInput, rowsPerPage, sortOrder, sortProperty]);

  useEffect(() => {
    if (!searchClient && !isBrowsingByName) {
      return;
    }

    let cancelled = false;

    const speakersCollection = collection(firestore, 'speakers').withConverter(speakerConverter);

    const getNameBrowseCursor = async (targetPage: number): Promise<QueryDocumentSnapshot<ISpeaker> | null> => {
      if (targetPage <= 0) {
        return null;
      }

      if (speakerNamePageCursorsRef.current[targetPage - 1] !== undefined) {
        return speakerNamePageCursorsRef.current[targetPage - 1] ?? null;
      }

      let nextPageToHydrate = speakerNamePageCursorsRef.current.length;
      let previousCursor =
        nextPageToHydrate > 0 ? speakerNamePageCursorsRef.current[nextPageToHydrate - 1] ?? null : null;

      while (nextPageToHydrate < targetPage) {
        const pageQuery = previousCursor
          ? query(speakersCollection, orderBy('name', sortOrder), startAfter(previousCursor), limit(rowsPerPage))
          : query(speakersCollection, orderBy('name', sortOrder), limit(rowsPerPage));
        const pageSnapshot = await getDocs(pageQuery);
        const lastVisibleDocument = pageSnapshot.docs.at(-1) ?? null;
        speakerNamePageCursorsRef.current[nextPageToHydrate] = lastVisibleDocument;
        previousCursor = lastVisibleDocument;
        nextPageToHydrate += 1;
      }

      return speakerNamePageCursorsRef.current[targetPage - 1] ?? null;
    };

    const loadSpeakers = async () => {
      setSpeakersLoading(true);

      try {
        if (isBrowsingByName) {
          const [countSnapshot, cursor] = await Promise.all([
            getCountFromServer(speakersCollection),
            getNameBrowseCursor(page),
          ]);
          const browseQuery = cursor
            ? query(speakersCollection, orderBy('name', sortOrder), startAfter(cursor), limit(rowsPerPage))
            : query(speakersCollection, orderBy('name', sortOrder), limit(rowsPerPage));
          const browseSnapshot = await getDocs(browseQuery);

          if (cancelled) {
            return;
          }

          speakerNamePageCursorsRef.current[page] = browseSnapshot.docs.at(-1) ?? null;
          setTotalSpeakers(countSnapshot.data().count);
          setSpeakers(browseSnapshot.docs.map((documentSnapshot) => documentSnapshot.data()));
          return;
        }

        if (!searchClient) {
          setSpeakers([]);
          setTotalSpeakers(0);
          return;
        }

        const response = await searchSpeakersIndex(searchClient, {
          query: debouncedSpeakerInput,
          hitsPerPage: rowsPerPage,
          page,
          sortProperty,
          sortOrder,
        });
        if (cancelled) {
          return;
        }

        setTotalSpeakers(response.nbHits ?? 0);
        setSpeakers(response.hits.map(normalizeAlgoliaSpeakerHit));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load speakers from Algolia', error);
          setSpeakers([]);
          setTotalSpeakers(0);
        }
      } finally {
        if (!cancelled) {
          setSpeakersLoading(false);
        }
      }
    };

    void loadSpeakers();

    return () => {
      cancelled = true;
    };
  }, [debouncedSpeakerInput, isBrowsingByName, page, refreshNonce, rowsPerPage, searchClient, sortOrder, sortProperty]);

  useEffect(() => {
    let cancelled = false;

    const loadSpeakerRequests = async () => {
      setSpeakerRequestsLoading(true);
      try {
        const response = await listSpeakerRequestsCallable({ limit: 100 });
        if (response.status === 'error') {
          throw new Error(response.error);
        }
        if (!cancelled) {
          const pendingRequests = response.data.speakerRequests.filter((request) => request.status === 'pending');
          setSpeakerRequests(pendingRequests);
          if (pendingRequests.length > 0) {
            setSpeakerRequestsExpanded(true);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSpeakerRequestNotice({
            severity: 'error',
            text: error instanceof Error ? error.message : 'Failed to load speaker requests.',
          });
        }
      } finally {
        if (!cancelled) {
          setSpeakerRequestsLoading(false);
        }
      }
    };

    void loadSpeakerRequests();

    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const handleSort = async (property: keyof ISpeaker, order: Order) => {
    setSortProperty(property);
    setSortOrder(order);
    setPage(0);
  };

  const handlePageChange = async (newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = async (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleSearchChange = (value: string) => {
    setSpeakerInput(value);
    setPage(0);
  };

  const refreshSpeakersAndRequests = async () => {
    await clearCache();
    setSpeakerInput('');
    setDebouncedSpeakerInput('');
    setPage(0);
    setRefreshNonce((currentValue) => currentValue + 1);
  };

  const handleCreateSpeaker = async (values: CreateSpeakerFormValues) => {
    if (selectedSpeakerRequest) {
      const response = await acceptSpeakerRequestCallable({
        speakerRequestId: selectedSpeakerRequest.speakerRequestId,
        speaker: {
          name: values.name.trim(),
          images: values.images,
          ...(values.shortDescription?.trim() ? { shortDescription: values.shortDescription.trim() } : {}),
          ...(values.description?.trim() ? { description: values.description.trim() } : {}),
        },
        createSpeakerList: values.createSpeakerList,
      });

      if (response.status === 'error') {
        throw new Error(response.error);
      }

      setSpeakerRequestNotice({
        severity: response.data.warning ? 'warning' : 'success',
        text: response.data.warning
          ? `${selectedSpeakerRequest.speakerName} was created, but the requester email could not be queued.`
          : `${selectedSpeakerRequest.speakerName} was created and the requester has been notified.`,
      });
      setSelectedSpeakerRequest(null);
      await refreshSpeakersAndRequests();
      return;
    }

    const payload = buildCreateSpeakerPayload({
      name: values.name,
      images: values.images,
      shortDescription: values.shortDescription,
      description: values.description,
      createSpeakerList: values.createSpeakerList,
    });

    const response = await createSpeakerCallable(payload);
    await refreshSpeakersAndRequests();

    if (shouldShowSpeakerListSuccess(response)) {
      setSpeakerListSuccessPopupOpen(true);
    }
  };

  const handleOpenCreateSpeakerFromRequest = (request: SpeakerRequestSummary) => {
    setSelectedSpeakerRequest(request);
    setSpeakerRequestActionLoading('accept');
    setCreateSpeakerPopupOpen(true);
  };

  const handleOpenDeclineDialog = (request: SpeakerRequestSummary) => {
    setSelectedSpeakerRequest(request);
    setDeclineMessage('');
    setDeclineDialogOpen(true);
  };

  const handleDeclineRequest = async () => {
    if (!selectedSpeakerRequest || !declineMessage.trim()) {
      return;
    }

    setSpeakerRequestActionLoading('deny');
    try {
      const response = await denySpeakerRequestCallable({
        speakerRequestId: selectedSpeakerRequest.speakerRequestId,
        message: declineMessage,
      });
      if (response.status === 'error') {
        throw new Error(response.error);
      }

      setSpeakerRequestNotice({
        severity: response.data.warning ? 'warning' : 'success',
        text: response.data.warning
          ? `Request for ${selectedSpeakerRequest.speakerName} was denied, but the requester email could not be queued.`
          : `Request for ${selectedSpeakerRequest.speakerName} was denied and the requester has been notified.`,
      });
      setDeclineDialogOpen(false);
      setSelectedSpeakerRequest(null);
      setDeclineMessage('');
      await refreshSpeakersAndRequests();
    } finally {
      setSpeakerRequestActionLoading(null);
    }
  };

  const isLoading = speakersLoading || searchClientLoading;
  const handleCloseCreateSpeakerPopup = (open: boolean) => {
    setCreateSpeakerPopupOpen(open);
    if (!open) {
      setSelectedSpeakerRequest(null);
      setSpeakerRequestActionLoading(null);
    }
  };

  const handleCloseDeclineDialog = () => {
    setDeclineDialogOpen(false);
    setDeclineMessage('');
    setSelectedSpeakerRequest(null);
  };

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      {speakerRequestNotice && (
        <Alert sx={{ mb: 2 }} severity={speakerRequestNotice.severity}>
          {speakerRequestNotice.text}
        </Alert>
      )}
      {speakerRequests.length > 0 && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => setSpeakerRequestsExpanded((currentValue) => !currentValue)}>
              {speakerRequestsExpanded ? 'Hide' : 'Show'}
            </Button>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {speakerRequests.length} pending speaker request{speakerRequests.length === 1 ? '' : 's'}
          </Typography>
        </Alert>
      )}
      <Collapse in={speakerRequestsExpanded && speakerRequests.length > 0} unmountOnExit>
        <Stack spacing={1.5} sx={{ mb: 3 }}>
          {speakerRequestsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            speakerRequests.map((request) => (
              <Box
                key={request.speakerRequestId}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 2,
                }}
              >
                <Stack spacing={1.5}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                    <Box
                      component="img"
                      src={request.image.downloadLink}
                      alt={request.speakerName}
                      sx={{
                        width: 72,
                        height: 72,
                        objectFit: 'contain',
                        borderRadius: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                        backgroundColor: 'background.default',
                      }}
                    />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="h6">{request.speakerName}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        Requested by {request.requesterDisplayName || request.requesterEmail} on{' '}
                        {new Date(request.createdAtMs).toLocaleString()}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {request.requesterEmail}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="contained"
                        onClick={() => handleOpenCreateSpeakerFromRequest(request)}
                        disabled={speakerRequestActionLoading !== null}
                      >
                        Create Speaker
                      </Button>
                      <Button
                        variant="outlined"
                        color="error"
                        onClick={() => handleOpenDeclineDialog(request)}
                        disabled={speakerRequestActionLoading !== null}
                      >
                        Decline
                      </Button>
                    </Stack>
                  </Stack>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {request.description}
                  </Typography>
                </Stack>
              </Box>
            ))
          )}
        </Stack>
      </Collapse>
      <SpeakerTable
        speakers={speakers}
        rowsPerPage={rowsPerPage}
        page={page}
        totalSpeakers={totalSpeakers}
        handlePageChange={handlePageChange}
        handleChangeRowsPerPage={handleChangeRowsPerPage}
        handleSort={handleSort}
        sortOrder={sortOrder}
        sortProperty={sortProperty}
        searchValue={speakerInput}
        onSearchChange={handleSearchChange}
        onAddSpeaker={() => {
          setSelectedSpeakerRequest(null);
          setSpeakerRequestActionLoading(null);
          setCreateSpeakerPopupOpen(true);
        }}
        loading={isLoading}
      />
      <CreateSpeakerPopup
        open={createSpeakerPopupOpen}
        setOpen={handleCloseCreateSpeakerPopup}
        onSubmit={handleCreateSpeaker}
        initialValues={
          selectedSpeakerRequest
            ? {
                name: selectedSpeakerRequest.speakerName,
                description: selectedSpeakerRequest.description,
              }
            : undefined
        }
        requestedImageAsset={selectedSpeakerRequest?.image}
        title={selectedSpeakerRequest ? 'Create Speaker From Request' : 'Add Speaker'}
        submitLabel={selectedSpeakerRequest ? 'Create Speaker' : 'Create Speaker'}
      />
      <PopUp title="Speaker list created" open={speakerListSuccessPopupOpen} setOpen={setSpeakerListSuccessPopupOpen}>
        <Box display="flex" flexDirection="column" gap={2} sx={{ py: 1 }}>
          <Typography>{SPEAKER_LIST_SUCCESS_INSTRUCTION}</Typography>
          <Link href={SUBSPLASH_SPEAKER_LIST_LINK} target="_blank" rel="noreferrer">
            Subsplash Speaker List
          </Link>
        </Box>
      </PopUp>
      <Dialog open={declineDialogOpen} onClose={handleCloseDeclineDialog} fullWidth maxWidth="sm">
        <DialogTitle>Decline Speaker Request</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              This message will be emailed back to the requester.
            </Typography>
            <TextField
              autoFocus
              label="Message"
              multiline
              minRows={4}
              value={declineMessage}
              onChange={(event) => setDeclineMessage(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDeclineDialog} disabled={speakerRequestActionLoading !== null}>
            Cancel
          </Button>
          <Button
            onClick={handleDeclineRequest}
            color="error"
            variant="contained"
            disabled={speakerRequestActionLoading !== null || declineMessage.trim().length === 0}
          >
            {speakerRequestActionLoading === 'deny' ? 'Declining...' : 'Decline Request'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

const ProtectedAdminSpeakers = () => {
  const { user } = useAuth();

  if (!user?.isAdmin()) {
    return null;
  } else {
    return <AdminSpeakers />;
  }
};

ProtectedAdminSpeakers.PageLayout = AppLayout;

export default ProtectedAdminSpeakers;
