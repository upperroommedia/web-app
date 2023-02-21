import Box from '@mui/system/Box';
import Login from '../components/Login';
import Button from '@mui/material/Button';
import PopUp from '../components/PopUp';
import Signup from '../components/Signup';
import { useState } from 'react';

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
