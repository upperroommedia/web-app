import { Auth } from 'firebase/auth';

const logoutUser = async (auth: Auth) => {
  auth.signOut();
  await fetch('/api/logout', {
    method: 'GET',
  });
  window.location.reload();
};

export default logoutUser;
