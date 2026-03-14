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
  buildCreateSpeakerPayload,
  SPEAKER_LIST_SUCCESS_INSTRUCTION,
  SUBSPLASH_SPEAKER_LIST_LINK,
  shouldShowSpeakerListSuccess,
} from '../../utils/speakers/createSpeakerClient';
import {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
} from '@upperroom/contracts/speakers/createSpeakerTypes';
import Box from '@mui/material/Box';
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

const createSpeakerCallable = createFunctionV2<CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType>(
  'createspeaker'
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
    setSpeakerInput('');
    setDebouncedSpeakerInput('');
    setPage(0);
    setRefreshNonce((currentValue) => currentValue + 1);

    if (shouldShowSpeakerListSuccess(response)) {
      setSpeakerListSuccessPopupOpen(true);
    }
  };

  const isLoading = speakersLoading || searchClientLoading;

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
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
