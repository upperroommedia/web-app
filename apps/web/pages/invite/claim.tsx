import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/router';
import useAuth from '../../context/user/UserContext';
import auth from '../../firebase/auth';
import { submitDurableIntent } from '../../utils/durableJobs';
import { useDurableJob } from '../../hooks/useDurableJobs';
import JobStatusPanel from '../../components/jobs/JobStatusPanel';
import { getInviteClaimRequestId } from '../../utils/inviteClaimIntent';

/** The browser admits one claim; the worker owns claims, session revocation and cleanup. */
const InviteClaimPage = () => {
  const router = useRouter();
  const { user, loading } = useAuth();
  const token = typeof router.query.token === 'string' ? router.query.token.trim() : '';
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const { job, stale } = useDurableJob(jobId);
  const submittingRef = useRef(false);
  const completedRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!router.isReady || loading || !token) return;
    if (!user) {
      void router.replace(
        `/login?callbackurl=${encodeURIComponent(`/invite/claim?token=${encodeURIComponent(token)}`)}`
      );
      return;
    }
    if (jobId || submittingRef.current) return;
    submittingRef.current = true;
    const claimantUid = user.uid;
    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        const requestId = await getInviteClaimRequestId(user.uid, token);
        const receipt = await submitDurableIntent({
          requestId,
          kind: 'invite.claim',
          entity: { type: 'user', id: user.uid },
          payload: { token },
        });
        if (mountedRef.current && auth.currentUser?.uid === claimantUid) setJobId(receipt.jobId);
      } catch (failure) {
        if (mountedRef.current && auth.currentUser?.uid === claimantUid)
          setError(failure instanceof Error ? failure.message : 'Unable to check this invitation.');
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    })();
  }, [router, router.isReady, token, loading, user, jobId, attempt]);

  useEffect(() => {
    if (job?.state !== 'succeeded' || completedRef.current === job.jobId) return;
    completedRef.current = job.jobId;
    void (async () => {
      try {
        const current = auth.currentUser;
        if (!current) throw new Error('Invitation accepted. Sign in again to use your updated access.');
        const claims = await current.getIdTokenResult(true);
        const role = claims.claims.role;
        sessionStorage.removeItem('invite-claim-auth-meta');
        // The refreshed token triggers UserContext; destination uses the authoritative claims.
        await router.replace(role === 'admin' || role === 'publisher' ? '/admin/sermons' : '/');
      } catch {
        setError('Invitation accepted. Sign in again to use your updated access.');
      }
    })();
  }, [job, router]);

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 640, p: { xs: 3, sm: 4 } }}>
        <Stack spacing={2}>
          <Typography variant="h6">Accept invitation</Typography>
          {!token && router.isReady && (
            <Alert severity="error">Invite token is missing. Request a new invite link from an admin.</Alert>
          )}
          {user?.email && <Typography>Signed in as {user.email}</Typography>}
          {submitting && (
            <Typography role="status">
              Submitting your invitation. Please keep this page open until the request is accepted.
            </Typography>
          )}
          {job && (
            <>
              <JobStatusPanel job={job} stale={stale} />
              <Typography variant="body2">Your request is saved and continues if you leave this page.</Typography>
            </>
          )}
          {error && <Alert severity="warning">{error}</Alert>}
          {error && !jobId && (
            <Button onClick={() => setAttempt((value) => value + 1)}>Check the same invitation again</Button>
          )}
          {job?.state === 'succeeded' && error && (
            <Button
              href={`/login?callbackurl=${encodeURIComponent('/profile')}`}
              variant="contained"
              onClick={() => auth.signOut()}
            >
              Sign in again
            </Button>
          )}
          <Button onClick={() => router.push('/')} disabled={submitting}>
            Go home
          </Button>
          <Button
            disabled={submitting}
            onClick={async () => {
              await auth.signOut();
            }}
          >
            Use a different account
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
};
export default InviteClaimPage;
