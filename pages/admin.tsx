import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { ChangeEvent, useEffect, useState } from 'react';
import functions, { httpsCallable } from '../firebase/functions';
import { ROLES } from '../context/types';
import ProtectedRoute from '../components/ProtectedRoute';
import { useCollection } from 'react-firebase-hooks/firestore';
import firestore, {
  collection,
  DocumentData,
  Query,
  getDocs,
  limit,
  orderBy,
  query,
  QueryDocumentSnapshot,
  startAfter,
} from '../firebase/firestore';
import { Sermon } from '../types/SermonTypes';
import SermonsList from '../components/SermonsList';
import PopUp from '../components/PopUp';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import { ISpeaker } from '../types/Speaker';
import SpeakerTable from '../components/SpeakerTable';
import { createFunction } from '../utils/createFunction';
import UserTable from '../components/UserTable';
import { fetchSpeakerResults } from './uploader';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

export type Order = 'asc' | 'desc';

const TabPanel = (props: TabPanelProps) => {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
};

export interface User {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  role: string;
}

const Admin: NextPage = (_props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const [tab, setTab] = useState<number>(0);
  const [email, setEmail] = useState<string>('');
  const [role, setRole] = useState<string>('user');
  const [message, setMessage] = useState<string>('');
  const [speakers, setSpeakers] = useState<ISpeaker[]>([]);
  const [timer, setTimer] = useState<NodeJS.Timeout>();
  const [speakersLoading, setSpeakersLoading] = useState<boolean>(false);
  const [users, setUsers] = useState<User[]>([]);
  const [showPopUp, setShowPopUp] = useState<boolean>(false);

  const [totalSpeakers, setTotalSpeakers] = useState<number>(0);
  const [lastSpeaker, setLastSpeaker] = useState<QueryDocumentSnapshot<DocumentData>>();
  const [sortProperty, setSortProperty] = useState<keyof ISpeaker>('sermonCount');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [page, setPage] = useState<number>(0);
  const [visitedPages, setVisitedPages] = useState<number[]>([0]);
  const [rowsPerPage, setRowsPerPage] = useState(5);
  const [speakerInput, setSpeakerInput] = useState<string>('');

  const [queryState, setQueryState] = useState<Query<DocumentData>>();

  const sermonsRef = collection(firestore, 'sermons');
  const q = query(sermonsRef);
  const [sermons, loading, error] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  const setUserRole = httpsCallable(functions, 'setUserRole');
  const handleRoleChange = (email: string, role: string) => {
    setUserRole({ email, role }).then((result: any) => {
      setMessage(result.data.status);
    });
  };

  const fetchUsers = async () => {
    const getImage = createFunction<any, any>('listusers');
    const res = await getImage({});
    setUsers(res.result);
  };

  const handlePageChange = async (newPage: number) => {
    if (visitedPages.includes(newPage)) {
      setPage(newPage);
      return;
    }
    setVisitedPages([...visitedPages, newPage]);
    setPage(newPage);
    if (speakerInput === '' && queryState) {
      const q =
        sortProperty && sortOrder
          ? query(
              collection(firestore, 'speakers'),
              limit(rowsPerPage),
              orderBy(sortProperty, sortOrder),
              startAfter(lastSpeaker)
            )
          : query(collection(firestore, 'speakers'), limit(rowsPerPage), startAfter(lastSpeaker));
      const querySnapshot = await getDocs(q);
      querySnapshot.forEach((doc) => {
        setSpeakers((oldSpeakers) => [...oldSpeakers, doc.data() as unknown as ISpeaker]);
      });
      setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
    } else {
      const result = await getSpeakersAlgolia(speakerInput, newPage);
      setSpeakers([...speakers, ...result]);
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
    );
    const querySnapshot = await getDocs(q);
    const res: ISpeaker[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data() as unknown as ISpeaker);
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

  const getSpeakersAlgolia = async (query: string, newPage?: number) => {
    const result = await fetchSpeakerResults(query, rowsPerPage, newPage || page);
    result?.nbHits && setTotalSpeakers(result.nbHits);
    setSpeakersLoading(false);
    const arr: ISpeaker[] = [];
    result?.hits.forEach((element: ISpeaker) => {
      arr.push(element);
    });
    return arr;
  };

  const getSpeakersFirebase = async () => {
    const q = lastSpeaker
      ? query(
          collection(firestore, 'speakers'),
          limit(rowsPerPage),
          orderBy('sermonCount', 'desc'),
          startAfter(lastSpeaker)
        )
      : query(collection(firestore, 'speakers'), limit(rowsPerPage), orderBy('sermonCount', 'desc'));
    setQueryState(q);
    const querySnapshot = await getDocs(q);
    querySnapshot.forEach((doc) => {
      setSpeakers((oldSpeakers) => [...oldSpeakers, doc.data() as unknown as ISpeaker]);
    });
    setLastSpeaker(querySnapshot.docs[querySnapshot.docs.length - 1]);
    const result = await fetchSpeakerResults('', 1, 0);
    result?.nbHits && setTotalSpeakers(result.nbHits);
  };

  const handleSort = async (property: keyof ISpeaker, order: 'asc' | 'desc') => {
    if (sortProperty !== property || sortOrder !== order) {
      setVisitedPages([]);
    }
    setLastSpeaker(undefined);
    setSortProperty(property);
    setSortOrder(order);
    setPage(0);
    const q = query(collection(firestore, 'speakers'), limit(rowsPerPage), orderBy(property, order));
    const querySnapshot = await getDocs(q);
    const res: ISpeaker[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data() as unknown as ISpeaker);
    });
    setQueryState(
      query(collection(firestore, 'speakers'), limit(rowsPerPage), orderBy(property, order), startAfter(lastSpeaker))
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
    <>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)} aria-label="basic tabs example">
          <Tab label="Sermons" />
          <Tab label="Users" />
          <Tab label="Speakers" />
          <Tab label="Topics" />
        </Tabs>
      </Box>
      <TabPanel value={tab} index={0}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <h2>Manage Sermons</h2>
          {error && <strong>Error: {JSON.stringify(error)}</strong>}
          {loading && <span>Collection: Loading...</span>}
          {sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data() as Sermon)} />}
        </div>
      </TabPanel>
      <TabPanel value={tab} index={1}>
        <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <button onClick={fetchUsers}>fetchusers</button>
          <UserTable users={users} handleRoleChange={handleRoleChange} />
          <Button variant="outlined" onClick={() => setShowPopUp(true)}>
            Set User Role
          </Button>
        </div>
      </TabPanel>
      <TabPanel value={tab} index={2}>
        <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center' }}>
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
        </div>
      </TabPanel>
      <TabPanel value={tab} index={3}>
        Manage Topics
      </TabPanel>
      <PopUp
        title="Set User Role"
        open={showPopUp}
        setOpen={() => setShowPopUp(false)}
        button={
          <Button variant="outlined" onClick={() => handleRoleChange(email, role)}>
            Submit
          </Button>
        }
      >
        <>
          <div style={{ display: 'flex', padding: '20px', gap: '10px' }}>
            <TextField
              fullWidth
              id="email-input"
              label="User Email"
              name="email"
              variant="outlined"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select
              labelId="demo-simple-select-label"
              id="demo-simple-select"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </Select>
          </div>
          {message}
        </>
      </PopUp>
    </>
  );
};

export default Admin;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || userCredentials.props.customClaims?.role !== 'admin') {
    return {
      redirect: {
        permanent: false,
        destination: '/',
      },
      props: {},
    };
  }
  return { props: {} };
};
