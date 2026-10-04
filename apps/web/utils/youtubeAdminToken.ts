import auth from '../firebase/auth';

// UserContext exposes a spread profile; Firebase's prototype methods remain on
// the original SDK User. Use the SDK instance for authenticated requests.
export const getYouTubeAdminToken = async (expectedUid: string, forceRefresh = false): Promise<string> => {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== expectedUid) throw new Error('Sign in again to continue.');
  return currentUser.getIdToken(forceRefresh);
};
