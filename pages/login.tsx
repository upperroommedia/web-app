import Box from '@mui/system/Box';
import Login from '../components/Login';
// import Button from '@mui/material/Button';
// import PopUp from '../components/PopUp';
// import Signup from '../components/Signup';
// import { useState } from 'react';
import Head from 'next/head';
import Typography from '@mui/material/Typography';

export default function LoginPage() {
  // const [signupPopupOpen, setSignupPopupOpen] = useState<boolean>(false);
  return (
    <>
      <Head>
        <title>Login</title>
        <meta property="og:title" content="Login" key="title" />
      </Head>

      <Box justifyContent="center" alignItems="center" display="flex" flexDirection="column" padding={8}>
        <Typography variant="h6">Please login with one of the following:</Typography>
        <Login />
        {/* <Button onClick={() => setSignupPopupOpen(true)}>Sign Up</Button>
        <PopUp title="" open={signupPopupOpen} setOpen={setSignupPopupOpen}>
          <Signup />
        </PopUp> */}
      </Box>
    </>
  );
}
