/**
 * Page for Logging in the User
 */
import { useState, useContext } from 'react';
import { useRouter } from 'next/router';
import { Button, Input, InputLabel, FormControl } from '@mui/material';
import UserContext from '../context/user/UserContext';
import PopUp from '../components/PopUp';

const Login = () => {
  const router = useRouter();
  //  const { user, login } = useAuth();
  const { login } = useContext(UserContext);

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

    switch (res) {
      case 'auth/user-not-found':
        setTitle('Wrong Credentials');
        setErrorMessage('Double Check your username and password');
        handleOpen();
        break;
      default:
        router.push('/uploader');
      // console.log(error);
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

export default Login;
