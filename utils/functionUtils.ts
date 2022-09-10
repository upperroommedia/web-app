import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/firebase';

export const createFunction = <T = any, R = any>(
  name: string
): ((data: T) => Promise<R>) => {
  const callable = httpsCallable(functions, name);
  return async (data: T) => (await callable(data)).data as R;
};
