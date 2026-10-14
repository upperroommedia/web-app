import { isProviderSandboxJobInspection } from '../../../utils/providerSimulation';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import type { NextPage } from 'next';
import type { ProviderSandboxJobInspection } from '@upperroom/contracts/providerSandbox';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AppLayout from '../../../layout/AppLayout';
import useAuth from '../../../context/user/UserContext';
import { createFunctionV2 } from '../../../utils/createFunction';
import ProviderSandboxInspection from '../../../components/jobs/ProviderSandboxInspection';

const InspectionPage: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  const router = useRouter();
  const { user } = useAuth();
  const jobId = typeof router.query.jobId === 'string' ? router.query.jobId : undefined;
  const identity = user?.isAdmin() && jobId ? `${user.uid}:${jobId}` : '';
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    identity: string;
    data?: ProviderSandboxJobInspection;
    loading: boolean;
    error?: string;
  }>({ identity: '', loading: false });
  useEffect(() => {
    if (!identity || !jobId) return;
    let cancelled = false;
    setState({ identity, loading: true });
    const inspect = createFunctionV2<{ jobId: string }, ProviderSandboxJobInspection>('inspectProviderSandboxJob');
    void inspect({ jobId })
      .then((data) => {
        if (!isProviderSandboxJobInspection(data) || data.jobId !== jobId)
          throw new Error('Invalid inspection response');
        if (!cancelled) setState({ identity, data, loading: false });
      })
      .catch(() => {
        if (!cancelled)
          setState({
            identity,
            loading: false,
            error:
              'Unable to inspect this simulated task. Verify the current staging profile, catalog and task identity.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [identity, jobId, refresh]);
  const current = state.identity === identity ? state : undefined;
  return (
    <Stack spacing={2}>
      <Typography variant="h5">Inspect simulated destinations</Typography>
      {!user?.isAdmin() ? (
        <Alert severity="warning">Administrator access is required.</Alert>
      ) : (
        <>
          <Button
            variant="outlined"
            disabled={!identity || current?.loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh inspection
          </Button>
          {current?.loading && <Typography role="status">Reading simulated destination records…</Typography>}
          {current?.error && <Alert severity="error">{current.error}</Alert>}
          {current?.data && <ProviderSandboxInspection inspection={current.data} />}
        </>
      )}
    </Stack>
  );
};
InspectionPage.PageLayout = AppLayout;
export default InspectionPage;
