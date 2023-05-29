'use client';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import { ChangeEvent, useEffect, useState } from 'react';
import SpeakerTable from '../../../components/SpeakerTable';
import { Order } from '../../../context/types';
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
} from '../../../firebase/firestore';
import { ISpeaker, speakerConverter } from '../../../types/Speaker';
import { fetchSpeakerResults } from '../../../utils/utils';

const SpeakersComponent = () => {
  const [speakerInput, setSpeakerInput] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [visitedPages, setVisitedPages] = useState<number[]>([0]);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [speakers, setSpeakers] = useState<ISpeaker[]>([]);
  const [timer, setTimer] = useState<NodeJS.Timeout>();
  const [speakersLoading, setSpeakersLoading] = useState<boolean>(false);
  const [queryState, setQueryState] = useState<Query<DocumentData>>();
  const [totalSpeakers, setTotalSpeakers] = useState<number>(0);

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
    // TODO: fix this
    if (result[0] && result[0].nbHits) {
      setTotalSpeakers(result[0].nbHits);
    }
    setSpeakersLoading(false);
    return result;
  };

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
    const g = async () => {
      await getSpeakersFirebase();
    };
    g();
  }, []);

  return (
    <Box style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center' }}>
      <p>Manage Speakers</p>
      <TextField
        placeholder="Search for a speaker"
        value={speakerInput}
        onChange={(e) => {
          setSpeakerInput(e.target.value);
          setSpeakersLoading(true);
          clearTimeout(timer);
          const newTimer = setTimeout(async () => {
            setSpeakers(await getSpeakersAlgolia(e.target.value));
          }, 300);
          setTimer(newTimer);
        }}
        style={{ paddingBottom: '1em', width: '100%' }}
      />
      {speakersLoading ? (
        <h2>loading...</h2>
      ) : speakers.length === 0 ? (
        <h2>No results</h2>
      ) : (
        <SpeakerTable
          speakers={speakers}
          setSpeakers={setSpeakers}
          rowsPerPage={rowsPerPage}
          page={page}
          setPage={setPage}
          totalSpeakers={totalSpeakers}
          setTotalSpeakers={setTotalSpeakers}
          handlePageChange={handlePageChange}
          handleChangeRowsPerPage={handleChangeRowsPerPage}
          handleSort={handleSort}
          sortOrder={sortOrder}
          setSortOrder={setSortOrder}
          sortProperty={sortProperty}
          setSortProperty={setSortProperty}
        />
      )}
    </Box>
  );
};

export default SpeakersComponent;
