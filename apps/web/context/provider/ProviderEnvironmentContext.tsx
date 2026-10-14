import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ProviderSandboxStatus } from '@upperroom/contracts/providerSandbox';
import useAuth from '../user/UserContext';
import { createFunctionV2 } from '../../utils/createFunction';
import { isProviderSandboxStatus } from '../../utils/providerSimulation';

type State = { identity: string; status?: ProviderSandboxStatus; loading: boolean; error: boolean };
const Context = createContext<{
  status?: ProviderSandboxStatus;
  loading: boolean;
  error: boolean;
  refresh: () => void;
}>({ loading: true, error: false, refresh: () => {} });
const getStatus = () => createFunctionV2<Record<string, never>, ProviderSandboxStatus>('getProviderSandboxStatus')({});

/** One authority read per signed-in identity, shared by the shell and all publish panels. */
export function ProviderEnvironmentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const identity = user ? `${user.uid}:${user.role ?? ''}` : '';
  const allowed = Boolean(user?.canUpload());
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<State>({ identity: '', loading: true, error: false });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!identity || !allowed) return;
    let cancelled = false;
    setState({ identity, loading: true, error: false });
    void getStatus()
      .then((status) => {
        if (!isProviderSandboxStatus(status)) throw new Error('Invalid publishing mode response');
        if (!cancelled) setState({ identity, status, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ identity, loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [identity, allowed, revision]);
  // Never expose a previous user's authority while a new effect is waiting to run.
  const current = identity && allowed && state.identity === identity ? state : { loading: true, error: false };
  return (
    <Context.Provider
      value={{
        status: 'status' in current ? current.status : undefined,
        loading: current.loading,
        error: current.error,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useProviderEnvironment = () => useContext(Context);
