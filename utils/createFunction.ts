import functions, { httpsCallable, httpsCallableFromURL } from '../firebase/functions';
export const createFunction = <T = any, R = any>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallable<T, R>(functions, name);
  return async (data: T) => (await callable(data)).data;
};

export const createFunctionV2 = <T = any, R = any>(name: string): ((data: T) => Promise<R>) => {
  const callable = httpsCallableFromURL<T, R>(functions, `https://${name}-yshbijirxq-uc.a.run.app`);
  return async (data: T) => (await callable(data)).data;
};
