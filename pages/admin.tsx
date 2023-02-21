import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { useEffect, useState } from 'react';
import functions, { httpsCallable } from '../firebase/functions';
import { ROLES } from '../context/types';
import ProtectedRoute from '../components/ProtectedRoute';
import { useCollection } from 'react-firebase-hooks/firestore';
import firestore, { collection, getDocs, query, updateDoc, doc, deleteDoc } from '../firebase/firestore';
import SermonsList from '../components/SermonsList';
import PopUp from '../components/PopUp';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import { Series, seriesConverter } from '../types/Series';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteEntityPopup from '../components/DeleteEntityPopup';

import { sermonConverter } from '../types/Sermon';

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

  const [showPopUp, setShowPopUp] = useState<boolean>(false);
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series>();
  const [newSeriesName, setNewSeriesName] = useState<string>('');
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);
  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });
  const [userHasTypedInSeries, setUserHasTypedInSeries] = useState<boolean>(false);

  const sermonsRef = collection(firestore, 'sermons');
  const q = query(sermonsRef.withConverter(sermonConverter));
  const [sermons] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });
  const setUserRole = httpsCallable(functions, 'setUserRole');
  const handleRoleChange = (email: string, role: string) => {
    setUserRole({ email, role }).then((result: any) => {
      setMessage(result.data.status);
    });
  };

  const handleSeriesDelete = async () => {
    if (selectedSeries) {
      await deleteDoc(doc(firestore, 'series', selectedSeries.id));
      selectedSeries.sermonIds.forEach(async (id) => {
        const sermonRef = doc(firestore, 'sermons', id).withConverter(sermonConverter);
        await updateDoc(sermonRef, {
          series: {},
        });
      });
      setSeries((oldSeries) => oldSeries.filter((series) => series.id !== selectedSeries.id));
    }
  };

  const fetchSeries = async () => {
    const seriesQuery = query(collection(firestore, 'series').withConverter(seriesConverter));
    const seriesQuerySnapshot = await getDocs(seriesQuery);
    seriesQuerySnapshot.docs.forEach((doc) => {
      setSeries((oldSeries) => [...oldSeries, doc.data()]);
    });
  };

  useEffect(() => {
    const g = async () => {
      await fetchSeries();
    };
    g();
  }, []);

  useEffect(() => {
    if (!userHasTypedInSeries) {
      setNewSeriesError({ error: false, message: '' });
      return;
    }

    if (newSeriesName === '') {
      setNewSeriesError({ error: true, message: 'Series cannot be empty' });
    } else if (series.map((series) => series.name.toLowerCase()).includes(newSeriesName.toLowerCase())) {
      setNewSeriesError({ error: true, message: 'Series already exists' });
    } else {
      setNewSeriesError({ error: false, message: '' });
    }
  }, [newSeriesName, userHasTypedInSeries, series]);

  return (
    <>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)} aria-label="basic tabs example">
          <Tab label="Sermons" />
          <Tab label="Users" />
          <Tab label="Speakers" />
          <Tab label="Series" />
          <Tab label="Topics" />
        </Tabs>
      </Box>

      <TabPanel value={tab} index={3}>
        <div>
          <h2>Manage Series</h2>
          {series.map((s) => {
            return (
              <Accordion key={s.id} onClick={() => setSelectedSeries(s)}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <p>{s.name}</p>
                </AccordionSummary>
                <AccordionDetails>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: '10px' }}>
                      <Button
                        color="info"
                        variant="contained"
                        size="small"
                        onClick={() => {
                          setEditSeriesPopup(true);
                          setNewSeriesName(s.name);
                        }}
                      >
                        <p>Edit Series</p>
                      </Button>
                      <div style={{ width: '5px' }} />
                      <Button color="error" variant="contained" size="small" onClick={() => setDeleteSeriesPopup(true)}>
                        <p>Delete Series</p>
                      </Button>
                    </div>
                    {sermons &&
                      s.sermonIds.map((sermonId) => {
                        return (
                          <div key={sermonId}>
                            <SermonsList
                              sermons={sermons.docs
                                .filter((doc) => doc.data().key === sermonId)
                                .map((doc) => doc.data())}
                              minimal={true}
                            />
                          </div>
                        );
                      })}
                  </div>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </div>
      </TabPanel>
      <TabPanel value={tab} index={4}>
        Manage Topics
      </TabPanel>
      <PopUp
        title="Set User Role"
        open={showPopUp}
        setOpen={setShowPopUp}
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
      <PopUp
        title="Edit Series"
        open={editSeriesPopup}
        setOpen={setEditSeriesPopup}
        onClose={() => {
          setUserHasTypedInSeries(false);
          setNewSeriesName('');
          setSelectedSeries(undefined);
        }}
        button={
          <Button
            variant="contained"
            disabled={
              newSeriesName === '' ||
              series.map((series) => series.name.toLowerCase()).includes(newSeriesName.toLowerCase())
            }
            onClick={async () => {
              try {
                const seriesRef = doc(firestore, 'series', selectedSeries!.id).withConverter(seriesConverter);
                await updateDoc(seriesRef, {
                  name: newSeriesName,
                });
                setSeries((oldSeries) =>
                  oldSeries.map((s) => {
                    if (s.name === selectedSeries?.name) {
                      return { ...s, name: newSeriesName };
                    }
                    return s;
                  })
                );
                selectedSeries?.sermonIds.forEach((id) => {
                  const sermonRef = doc(firestore, 'sermons', id).withConverter(sermonConverter);
                  updateDoc(sermonRef, {
                    series: { ...selectedSeries, name: newSeriesName },
                  });
                });
                setEditSeriesPopup(false);
              } catch (e) {
                alert(e);
              }
            }}
          >
            Submit
          </Button>
        }
      >
        <>
          <div style={{ display: 'flex', padding: '20px', gap: '10px' }}>
            <TextField
              value={newSeriesName}
              onChange={(e) => {
                setNewSeriesName(e.target.value);
                !userHasTypedInSeries && setUserHasTypedInSeries(true);
              }}
              error={newSeriesError.error}
              label={newSeriesError.error ? newSeriesError.message : 'Series'}
            />
          </div>
        </>
      </PopUp>
      <DeleteEntityPopup
        entityBeingDeleten="series"
        handleDelete={handleSeriesDelete}
        deleteConfirmationPopup={deleteSeriesPopup}
        setDeleteConfirmationPopup={setDeleteSeriesPopup}
      />
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
