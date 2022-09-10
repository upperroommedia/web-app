/**
 * Page for Logging in the User
 */
// React
import { useState, useContext } from 'react';

// Next
import type {
  GetServerSideProps,
  InferGetServerSidePropsType,
  GetServerSidePropsContext,
} from 'next';
import { useRouter } from 'next/router';

// 3rd Party Components
import { Button, Input, InputLabel, FormControl } from '@mui/material';

// Auth
import UserContext from '../context/user/UserContext';

// Components
import ProtectedRoute from '../components/ProtectedRoute';
import AuthErrors from '../components/AuthErrors';
import PopUp from '../components/PopUp';

const Login = (
  _props: InferGetServerSidePropsType<typeof getServerSideProps>
) => {
  const router = useRouter();
  const { isAuthenticated, login } = useContext(UserContext);

  const [data, setData] = useState({
    email: '',
    password: '',
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleLogin = async (e: any) => {
    e.preventDefault();

    const res = await login(data);

    const authResult = AuthErrors(res);
    if (authResult.authFailure) {
      setTitle(authResult.title);
      setErrorMessage(authResult.errorMessage);
      handleOpen();
    } else {
      if (isAuthenticated) {
        router.push(authResult.dest);
      }
    }
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
      <h1 className="text-center my-3 ">Login</h1>
      <form style={{ height: '100%' }} onSubmit={handleLogin}>
        <div>
          <FormControl>
            <InputLabel>Email address</InputLabel>
            <Input
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
            />
          </FormControl>
        </div>
        <div>
          <FormControl>
            <InputLabel>Password</InputLabel>
            <Input
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
            />
          </FormControl>
        </div>
        <Button variant="contained" type="submit">
          Login
        </Button>
      </form>
      <PopUp title={title} open={open} setOpen={handleClose}>
        {errorMessage}
      </PopUp>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps = async (
  ctx: GetServerSidePropsContext
) => {
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

export default Login;
