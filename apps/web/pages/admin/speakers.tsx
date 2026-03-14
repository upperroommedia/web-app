import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { ChangeEvent, useEffect, useState } from 'react';
import CreateSpeakerPopup, { CreateSpeakerFormValues } from '../../components/CreateSpeakerPopup';
import PopUp from '../../components/PopUp';
import SpeakerTable from '../../components/SpeakerTable';
import { Order } from '../../context/types';
import firestore, {
  collection,
  DocumentData,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  Query,
  QueryDocumentSnapshot,
  startAfter,
} from '../../firebase/firestore';
import AppLayout from '../../layout/AppLayout';
import { ISpeaker, speakerConverter } from '../../types/Speaker';
import useAuth from '../../context/user/UserContext';
import { fetchSpeakerResults } from '../../components/uploaderComponents/SpeakerSelector';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  buildCreateSpeakerPayload,
  SPEAKER_LIST_SUCCESS_INSTRUCTION,
  SUBSPLASH_SPEAKER_LIST_LINK,
  shouldShowSpeakerListSuccess,
} from '../../utils/speakers/createSpeakerClient';
import { CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType } from '../../functions/src/speakers/createSpeakerTypes';

const createSpeakerCallable = createFunctionV2<CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType>(
  'createspeaker'
);
const AdminSpeakers = () => {
  const [speakerInput, setSpeakerInput] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [visitedPages, setVisitedPages] = useState<number[]>([0]);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [speakers, setSpeakers] = useState<ISpeaker[]>([]);
  const [timer, setTimer] = useState<NodeJS.Timeout>();
  const [speakersLoading, setSpeakersLoading] = useState<boolean>(false);
  const [queryState, setQueryState] = useState<Query<DocumentData>>();
  const [totalSpeakers, setTotalSpeakers] = useState<number>(0);
  const [createSpeakerPopupOpen, setCreateSpeakerPopupOpen] = useState<boolean>(false);
  const [speakerListSuccessPopupOpen, setSpeakerListSuccessPopupOpen] = useState<boolean>(false);

  const [lastSpeaker, setLastSpeaker] = useState<QueryDocumentSnapshot<DocumentData>>();
  const [sortProperty, setSortProperty] = useState<keyof ISpeaker>('sermonCount');
  const [sortOrder, setSortOrder] = useState<Order>('desc');

  const handleSort = async (property: keyof ISpeaker, order: Order) => {
    if (sortProperty !== property || sortOrder !== order) {
      setVisitedPages([]);
    }
    setLastSpeaker(undefined);
    setSortProperty(property);
    setSortOrder(order);
    setPage(0);
    const q = query(
      collection(firestore, 'speakers').withConverter(speakerConverter),
      limit(rowsPerPage),
      orderBy(property, order)
    );
    const querySnapshot = await getDocs(q);
    const res: ISpeaker[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data());
    });
    setQueryState(
      query(collection(firestore, 'speakers'), limit(rowsPerPage), orderBy(property, order), startAfter(lastSpeaker))
    );
    setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
    setSpeakers(res);
  };

  const handlePageChange = async (newPage: number) => {
    if (visitedPages.includes(newPage)) {
      setPage(newPage);
      return;
    }
    setVisitedPages([...visitedPages, newPage]);
    setPage(newPage);
    if (speakerInput === '' && queryState) {
      await getMoreSpeakersFirebase();
    } else {
      const result = await getSpeakersAlgolia(speakerInput, newPage);
      setSpeakers([...speakers, ...result]);
    }
  };

  const getSpeakersAlgolia = async (query: string, newPage?: number) => {
    const result = await fetchSpeakerResults(query, rowsPerPage, newPage || page);
    if (result[0] && result[0].nbHits) {
      setTotalSpeakers(result[0].nbHits);
    }
    setSpeakersLoading(false);
    return result;
  };

  const getMoreSpeakersFirebase = async () => {
    const q = query(
      collection(firestore, 'speakers'),
      limit(rowsPerPage),
      orderBy('sermonCount', 'desc'),
      startAfter(lastSpeaker)
    ).withConverter(speakerConverter);
    const querySnapshot = await getDocs(q);
    setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
    querySnapshot.forEach((doc) => {
      setSpeakers((oldSpeakers) => [...oldSpeakers, doc.data()]);
    });
    const result = await fetchSpeakerResults('', 1, 0);
    if (result[0] && result[0].nbHits) {
      setTotalSpeakers(result[0].nbHits);
    }
  };

  const handleChangeRowsPerPage = async (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setLastSpeaker(undefined);
    setPage(0);
    setSortProperty('sermonCount');
    setSortOrder('desc');
    const q = query(
      collection(firestore, 'speakers'),
      limit(parseInt(event.target.value, 10)),
      orderBy('sermonCount', 'desc')
    ).withConverter(speakerConverter);
    const querySnapshot = await getDocs(q);
    const res: ISpeaker[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data());
    });
    setQueryState(
      query(
        collection(firestore, 'speakers'),
        limit(rowsPerPage),
        orderBy('sermonCount', 'desc'),
        startAfter(lastSpeaker)
      )
    );
    setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
    setSpeakers(res);
  };

  useEffect(() => {
    const getSpeakersFirebase = async () => {
      const speakerCollection = collection(firestore, 'speakers').withConverter(speakerConverter);
      const speakersCount = (await getCountFromServer(speakerCollection)).data().count;
      setTotalSpeakers(speakersCount);

      const q = query(speakerCollection, limit(rowsPerPage), orderBy('sermonCount', 'desc'));
      setQueryState(q);
      const querySnapshot = await getDocs(q);
      const res: ISpeaker[] = [];
      querySnapshot.forEach((doc) => {
        res.push(doc.data());
      });
      setSpeakers(res);
      setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
      const result = await fetchSpeakerResults('', 1, 0);
      if (result[0] && result[0].nbHits) {
        setTotalSpeakers(result[0].nbHits);
      }
    };
    const g = async () => {
      await getSpeakersFirebase();
    };
    g();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearchChange = (value: string) => {
    setSpeakerInput(value);
    setSpeakersLoading(true);
    clearTimeout(timer);
    const newTimer = setTimeout(async () => {
      setSpeakers(await getSpeakersAlgolia(value));
    }, 300);
    setTimer(newTimer);
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
    setSpeakers((oldSpeakers) => [response.speaker, ...oldSpeakers.filter((speaker) => speaker.id !== response.speaker.id)]);
    setTotalSpeakers((oldTotalSpeakers) => oldTotalSpeakers + 1);
    setSpeakerInput('');
    setPage(0);
    setVisitedPages([0]);
    setLastSpeaker(undefined);

    if (shouldShowSpeakerListSuccess(response)) {
      setSpeakerListSuccessPopupOpen(true);
    }
  };

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
        setSortOrder={setSortOrder}
        sortProperty={sortProperty}
        setSortProperty={setSortProperty}
        searchValue={speakerInput}
        onSearchChange={handleSearchChange}
        onAddSpeaker={() => setCreateSpeakerPopupOpen(true)}
        loading={speakersLoading}
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
