import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { useState } from 'react';
import functions, { httpsCallable } from '../firebase/functions';
import { ROLES } from '../context/types';
import ProtectedRoute from '../components/ProtectedRoute';
import { useCollection } from 'react-firebase-hooks/firestore';
import firestore, { collection, getDocs, limit, query } from '../firebase/firestore';
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

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

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

  const fetchSpeakers = async () => {
    const q = query(collection(firestore, 'speakers'), limit(100));
    const querySnapshot = await getDocs(q);
    querySnapshot.forEach((doc) => {
      // doc.data() is never undefined for query doc snapshots
      setSpeakers((oldSpeakers) => [...oldSpeakers, doc.data() as unknown as ISpeaker]);
    });
  };

  const fetchSpeakerResults = async (query: string) => {
    if (process.env.NEXT_PUBLIC_ALGOLIA_API_KEY && process.env.NEXT_PUBLIC_ALGOLIA_APP_ID) {
      const url = `https://${process.env.NEXT_PUBLIC_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/speakers/query`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Algolia-API-Key': process.env.NEXT_PUBLIC_ALGOLIA_API_KEY,
          'X-Algolia-Application-Id': process.env.NEXT_PUBLIC_ALGOLIA_APP_ID,
        },
        body: JSON.stringify({ query: query }),
      });
      return response;
    }
  };

  const fetchUsers = async () => {
    const getImage = createFunction<any, any>('listusers');
    const res = await getImage({});
    setUsers(res.result);
  };

  return (
    <>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <button onClick={fetchUsers}>fetchusers</button>
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
          <Button variant="outlined" onClick={() => setShowPopUp(true)}>
            Set User Role
          </Button>
          <UserTable users={users} handleRoleChange={handleRoleChange} />
        </div>
      </TabPanel>
      <TabPanel value={tab} index={2}>
        <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <p>Manage Speakers</p>
          <button onClick={fetchSpeakers}>fetch speakers</button>
          <TextField
            placeholder="Search for a speaker"
            onChange={(e) => {
              setSpeakersLoading(true);
              clearTimeout(timer);
              const newTimer = setTimeout(async () => {
                fetchSpeakerResults(e.target.value)
                  .then((response) => response?.json())
                  .then((data) => {
                    const res: ISpeaker[] = [];
                    data.hits.forEach((element: ISpeaker) => {
                      res.push(element);
                    });
                    setSpeakers(res);
                    setSpeakersLoading(false);
                  });
              }, 300);
              setTimer(newTimer);
            }}
            style={{ paddingBottom: '1em', width: '100%' }}
          />
          {speakersLoading ? <h2>loading...</h2> : <SpeakerTable speakers={speakers} />}
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
