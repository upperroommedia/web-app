import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { useState } from 'react';
import functions, { httpsCallable } from '../firebase/functions';
import { ROLES } from '../context/types';
import ProtectedRoute from '../components/ProtectedRoute';
import { useCollection } from 'react-firebase-hooks/firestore';
import firestore, { collection, query } from '../firebase/firestore';
import { Sermon } from '../types/Sermon';
import SermonsList from '../components/SermonsList';
import PopUp from '../components/PopUp';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';

const Admin: NextPage = (_props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const [email, setEmail] = useState<string>('');
  const [role, setRole] = useState<string>(ROLES[0]);
  const [message, setMessage] = useState<string>('');
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

  return (
    <>
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
