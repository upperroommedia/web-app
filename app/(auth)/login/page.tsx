'use client';
import Box from '@mui/material/Box';
// import Button from '@mui/material/Button';
import { useState } from 'react';
import Login from './Login';
import PopUp from '../../../components/PopUp';
import Signup from '../signup/Signup';
import Button from '@mui/material/Button';

export default function LoginPage() {
  const [signupPopupOpen, setSignupPopupOpen] = useState<boolean>(false);

  return (
    <Box justifyContent="center" alignItems="center" display="flex" flexDirection="column">
      <Login />
      <Button onClick={() => setSignupPopupOpen(true)}>Sign Up</Button>
      <PopUp title="" open={signupPopupOpen} setOpen={setSignupPopupOpen}>
        <Signup />
      </PopUp>
    </Box>
  );
}
