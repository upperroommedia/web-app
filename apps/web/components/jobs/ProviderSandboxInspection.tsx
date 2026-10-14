import type { ProviderSandboxJobInspection } from '@upperroom/contracts/providerSandbox';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { SIMULATION_SCENARIO_LABELS } from '../../utils/providerSimulation';

const time = (value: number) => new Date(value).toISOString();
export default function ProviderSandboxInspection({ inspection }: { inspection: ProviderSandboxJobInspection }) {
  return (
    <Stack spacing={2}>
      <Alert severity="info">
        These are simulated provider records. Inspecting them does not approve a result or complete the task. Copy a
        resource ID into the existing review workflow only after checking the evidence.
      </Alert>
      <Typography variant="body2">Task: {inspection.jobId}</Typography>
      <Typography variant="body2">
        Profile: {inspection.providerExecution.profileId} · Scenario:{' '}
        {SIMULATION_SCENARIO_LABELS[inspection.providerExecution.scenario]}
      </Typography>
      <Typography variant="caption">
        Observed {time(inspection.observedAtMillis)}. Resources may change as work continues.
      </Typography>
      {(inspection.truncated.requests || inspection.truncated.resources) && (
        <Alert severity="warning">
          This bounded view is incomplete. Do not infer that an item is absent or unique from this view.
        </Alert>
      )}
      <Typography variant="h6">Saved simulated resources</Typography>
      {!inspection.resources.length && (
        <Typography>
          No resource references were observed in this bounded task journal. This does not prove that no provider effect
          occurred.
        </Typography>
      )}
      {inspection.resources.map((resource) => (
        <Box
          key={JSON.stringify([resource.provider, resource.family, resource.id])}
          sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          <Stack spacing={0.75}>
            <Typography fontWeight={600}>{resource.title || resource.family}</Typography>
            <Typography variant="body2">
              {resource.provider} · {resource.family}
            </Typography>
            <Typography component="code" sx={{ overflowWrap: 'anywhere', userSelect: 'all' }}>
              {resource.id}
            </Typography>
            <Chip
              size="small"
              sx={{ alignSelf: 'flex-start' }}
              label={resource.deleted ? 'Deleted' : 'Saved in simulated account'}
            />
            {resource.readyAtMillis !== undefined && (
              <Typography variant="caption">
                Reported ready time: {time(resource.readyAtMillis)}. Use task progress to confirm processing.
              </Typography>
            )}
          </Stack>
        </Box>
      ))}
      <Typography variant="h6">Observed provider requests</Typography>
      <Typography variant="caption">
        At most 100 requests and 200 resource references are shown. This is not a complete or guaranteed latest-first
        history.
      </Typography>
      {!inspection.requests.length && <Typography>No requests were observed for this task.</Typography>}
      {inspection.requests.map((request, index) => (
        <Box
          key={`${request.provider}:${request.atMillis}:${index}`}
          sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          <Typography variant="body2">
            {request.provider} · {request.method} · {request.outcome}
          </Typography>
          <Typography variant="caption">
            {time(request.atMillis)} · {SIMULATION_SCENARIO_LABELS[request.fault]}
          </Typography>
          {request.resourceRefs.map((ref) => (
            <Typography
              key={JSON.stringify([ref.provider, ref.family, ref.id])}
              variant="body2"
              sx={{ overflowWrap: 'anywhere' }}
            >
              {ref.family}: {ref.id}
            </Typography>
          ))}
        </Box>
      ))}
    </Stack>
  );
}
