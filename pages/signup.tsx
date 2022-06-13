/**
 * Page for Signing up the User
 */
import { useState, useContext } from 'react';
import { useRouter } from 'next/router';
import UserContext from '../context/user/UserContext';
import { Button, Input, InputLabel, FormControl } from '@mui/material';
import PopUp from '../components/PopUp';

const Signup = () => {
  //  const { user, login } = useAuth();
  const router = useRouter();
  const { isAuthenticated, signup } = useContext(UserContext);

  //   console.log('User:' + user);
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

  const handleSignup = async (e: any) => {
    e.preventDefault();
    const res = await signup(data);
    switch (res) {
      case 'auth/weak-password':
        setTitle('Weak Password');
        setErrorMessage('Make a password with 6 or more characters');
        handleOpen();
        break;
      case 'auth/email-already-in-use':
        setTitle('Email Already in Use');
        handleOpen();
        setErrorMessage('The email you are using is Already in Use');
        break;
      default:
        if (isAuthenticated) {
          router.push('/uploader');
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
      <h1 className="text-center my-3 ">Signup</h1>
      <form style={{ height: '100%' }} onSubmit={handleSignup}>
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
          Signup
        </Button>

        <PopUp title={title} open={open} setOpen={handleClose}>
          {errorMessage}
        </PopUp>
      </form>
    </div>
  );
};

export default Signup;
