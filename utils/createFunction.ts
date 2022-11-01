import functions, { httpsCallable } from '../firebase/functions';

export const createFunction = <T = any, R = any>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T) => (await callable(data)).data;
};
