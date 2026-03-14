import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import CreateSpeakerPopup, { CreateSpeakerFormValues } from '../../components/CreateSpeakerPopup';
import PopUp from '../../components/PopUp';
import SpeakerTable from '../../components/SpeakerTable';
import { Order } from '../../context/types';
import AppLayout from '../../layout/AppLayout';
import { ISpeaker } from '../../types/Speaker';
import useAuth from '../../context/user/UserContext';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  buildCreateSpeakerPayload,
  SPEAKER_LIST_SUCCESS_INSTRUCTION,
  SUBSPLASH_SPEAKER_LIST_LINK,
  shouldShowSpeakerListSuccess,
} from '../../utils/speakers/createSpeakerClient';
import { CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType } from '@upperroom/contracts/speakers/createSpeakerTypes';
import Box from '@mui/material/Box';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import { normalizeAlgoliaSpeakerHit, searchSpeakersIndex } from '../../utils/algolia/searchRecords';

const createSpeakerCallable = createFunctionV2<CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType>(
  'createspeaker'
);

const sortSpeakers = (speakers: ISpeaker[], sortProperty: keyof ISpeaker, sortOrder: Order): ISpeaker[] => {
  const sortedSpeakers = [...speakers];
  sortedSpeakers.sort((leftSpeaker, rightSpeaker) => {
    const leftValue = leftSpeaker[sortProperty];
    const rightValue = rightSpeaker[sortProperty];

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return sortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue;
    }

    const normalizedLeft = String(leftValue ?? '').toLowerCase();
    const normalizedRight = String(rightValue ?? '').toLowerCase();
    if (normalizedLeft === normalizedRight) {
      return 0;
    }

    const comparison = normalizedLeft.localeCompare(normalizedRight);
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  return sortedSpeakers;
};

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
  const [sortOrder, setSortOrder] = useState<Order>('desc');

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSpeakerInput(speakerInput);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [speakerInput]);

  useEffect(() => {
    if (!searchClient) {
      return;
    }

    let cancelled = false;

    const loadSpeakers = async () => {
      setSpeakersLoading(true);

      try {
        const response = await searchSpeakersIndex(searchClient, debouncedSpeakerInput, rowsPerPage, page);
        if (cancelled) {
          return;
        }

        setTotalSpeakers(response.nbHits ?? 0);
        setSpeakers(sortSpeakers(response.hits.map(normalizeAlgoliaSpeakerHit), sortProperty, sortOrder));
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
  }, [debouncedSpeakerInput, page, rowsPerPage, searchClient, sortOrder, sortProperty]);

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

  const handleCreateSpeaker = async (values: CreateSpeakerFormValues) => {
    const payload = buildCreateSpeakerPayload({
      name: values.name,
      images: values.images,
      shortDescription: values.shortDescription,
      description: values.description,
      createSpeakerList: values.createSpeakerList,
    });

    const response = await createSpeakerCallable(payload);
    await clearCache();
    setSpeakers((oldSpeakers) =>
      page === 0 && debouncedSpeakerInput === ''
        ? sortSpeakers(
            [response.speaker, ...oldSpeakers.filter((speaker) => speaker.id !== response.speaker.id)].slice(0, rowsPerPage),
            sortProperty,
            sortOrder
          )
        : oldSpeakers
    );
    setTotalSpeakers((oldTotalSpeakers) => oldTotalSpeakers + 1);
    setSpeakerInput('');
    setDebouncedSpeakerInput('');
    setPage(0);

    if (shouldShowSpeakerListSuccess(response)) {
      setSpeakerListSuccessPopupOpen(true);
    }
  };

  const isLoading = speakersLoading || searchClientLoading;
  const effectiveSpeakers = useMemo(() => speakers, [speakers]);

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <SpeakerTable
        speakers={effectiveSpeakers}
        rowsPerPage={rowsPerPage}
        page={page}
        totalSpeakers={totalSpeakers}
        handlePageChange={handlePageChange}
        handleChangeRowsPerPage={handleChangeRowsPerPage}
        handleSort={handleSort}
        sortOrder={sortOrder}
        setSortOrder={setSortOrder}
        sortProperty={sortProperty}
        setSortProperty={setSortProperty}
        searchValue={speakerInput}
        onSearchChange={handleSearchChange}
        onAddSpeaker={() => setCreateSpeakerPopupOpen(true)}
        loading={isLoading}
      />
      <CreateSpeakerPopup
        open={createSpeakerPopupOpen}
        setOpen={setCreateSpeakerPopupOpen}
        onSubmit={handleCreateSpeaker}
      />
      <PopUp title="Speaker list created" open={speakerListSuccessPopupOpen} setOpen={setSpeakerListSuccessPopupOpen}>
        <Box display="flex" flexDirection="column" gap={2} sx={{ py: 1 }}>
          <Typography>{SPEAKER_LIST_SUCCESS_INSTRUCTION}</Typography>
          <Link href={SUBSPLASH_SPEAKER_LIST_LINK} target="_blank" rel="noreferrer">
            Subsplash Speaker List
          </Link>
        </Box>
      </PopUp>
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
