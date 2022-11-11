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

const Admin: NextPage = (_props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const [tab, setTab] = useState<number>(0);
  const [email, setEmail] = useState<string>('');
  const [role, setRole] = useState<string>(ROLES[0]);
  const [message, setMessage] = useState<string>('');
  const [speakers, setSpeakers] = useState<ISpeaker[]>([]);

  const sermonsRef = collection(firestore, 'sermons');
  const q = query(sermonsRef);
  const [sermons, loading, error] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  const setUserRole = httpsCallable(functions, 'setUserRole');
  const [showPopUp, setShowPopUp] = useState<boolean>(false);
  const handleSubmit = () => {
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

  return (
    <>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)} aria-label="basic tabs example">
          <Tab label="Users" />
          <Tab label="Speakers" />
          <Tab label="Topics" />
        </Tabs>
      </Box>
      <TabPanel value={tab} index={0}>
        <div style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <Button variant="outlined" onClick={() => setShowPopUp(true)}>
            Set User Role
          </Button>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
            {error && <strong>Error: {JSON.stringify(error)}</strong>}
            {loading && <span>Collection: Loading...</span>}
            {sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data() as Sermon)} />}
          </div>
        </div>
      </TabPanel>
      <TabPanel value={tab} index={1}>
        <div>
          <p>Manage Speakers</p>
          <button onClick={fetchSpeakers}>fetch speakers</button>
          <SpeakerTable speakers={speakers} />
        </div>
      </TabPanel>
      <TabPanel value={tab} index={2}>
        Manage Topics
      </TabPanel>

      <PopUp
        title="Set User Role"
        open={showPopUp}
        setOpen={() => setShowPopUp(false)}
        button={
          <Button variant="outlined" onClick={handleSubmit}>
            submit
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
