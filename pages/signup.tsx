/**
 * Page for Signing up the User
 */
// React
import { useState, useContext } from 'react';
import { useRouter } from 'next/router';

// Next
import type { GetServerSideProps, InferGetServerSidePropsType, GetServerSidePropsContext } from 'next';

// Auth
import UserContext from '../context/user/UserContext';

// 3rd Party
import { Button, TextField } from '@mui/material';

// Components
import ProtectedRoute from '../components/ProtectedRoute';
import PopUp from '../components/PopUp';
import AuthErrors from '../components/AuthErrors';

const Signup = (props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const router = useRouter();
  const { signup } = useContext(UserContext);

  const [data, setData] = useState({
    email: '',
    password: '',
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSignup = async (e: any) => {
    e.preventDefault();
    const res = await signup(data);
    const authResult = AuthErrors(res);
    if (authResult.authFailure) {
      setTitle(authResult.title);
      setErrorMessage(authResult.errorMessage);
      setOpen(true);
    }
    router.push(authResult.dest);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-around',
        alignItems: 'center',
      }}
    >
      <h1 className="text-center my-3 ">Signup</h1>
      <form style={{ height: '100%', width: '300px', margin: '20px' }} onSubmit={handleSignup}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <TextField
            fullWidth
            type="email"
            placeholder="Enter email"
            required
            onChange={(e: any) =>
              setData({
                ...data,
                email: e.target.value,
              })
            }
            value={data.email}
            size="small"
          />
          <TextField
            fullWidth
            type="password"
            placeholder="Password"
            required
            onChange={(e: any) =>
              setData({
                ...data,
                password: e.target.value,
              })
            }
            value={data.password}
            size="small"
          />
        </div>
        <Button fullWidth variant="contained" type="submit" style={{ marginTop: '30px' }} size="medium">
          SignUp
        </Button>
        <PopUp title={title} open={open} setOpen={() => setOpen(false)}>
          {errorMessage}
        </PopUp>
      </form>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (userCredentials.props.token) {
    return {
      redirect: {
        permanent: false,
        destination: '/uploader',
      },
      props: {},
    };
  } else {
    return { props: {} };
  }
};
export default Signup;
