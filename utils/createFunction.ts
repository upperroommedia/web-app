import functions, { httpsCallable, httpsCallableFromURL } from '../firebase/functions';
import { isDevelopment } from '../firebase/firebase';

export const createFunction = <T = any, R = any>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T) => (await callable(data)).data;
};

export const createFunctionV2 = <T = any, R = any>(name: string): ((data: T) => Promise<R>) => {
  const url = isDevelopment
    ? `http://127.0.0.1:5001/urm-app/us-central1/${name}`
    : `https://${name}-yshbijirxq-uc.a.run.app`;
  const callable = httpsCallableFromURL<T, R>(functions, url);
  return async (data: T) => (await callable(data)).data;
};
