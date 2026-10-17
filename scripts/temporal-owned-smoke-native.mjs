/** Exact original terminal email reads. Transport is supplied by the source/principal-pinned CLI. */
import { proofDigest } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('OWNED_SMOKE_' + code), { code: 'OWNED_SMOKE_' + code });
};
export async function readOriginalOwnedEmailNative({ request, historyToJSON, namespace }) {
  need(
    typeof request === 'function' && typeof historyToJSON === 'function' && namespace === incident.temporalNamespace,
    'NATIVE_READ_BINDING_REQUIRED'
  );
  const execution = { workflowId: incident.emailWorkflowId };
  const describe = () => request('describeWorkflowExecution', { namespace, execution });
  const valid = (d) =>
    d?.workflowExecutionInfo?.execution?.workflowId === incident.emailWorkflowId &&
    d.workflowExecutionInfo.execution.runId === incident.emailRunId &&
    d.workflowExecutionInfo.status === 3 &&
    (d.pendingActivities === undefined || (Array.isArray(d.pendingActivities) && d.pendingActivities.length === 0));
  need(valid(await describe()), 'ORIGINAL_TERMINAL_EMAIL_CHANGED');
  const events = [],
    seen = new Set();
  let token;
  for (let page = 0; ; page++) {
    need(page < 10, 'NATIVE_HISTORY_PAGE_BOUND');
    const response = await request('getWorkflowExecutionHistory', {
      namespace,
      execution: { ...execution, runId: incident.emailRunId },
      maximumPageSize: 1000,
      ...(token ? { nextPageToken: token } : {}),
    });
    need(response?.history, 'NATIVE_HISTORY_MISSING');
    const json = historyToJSON(response.history),
      parsed = typeof json === 'string' ? JSON.parse(json) : json;
    need(Array.isArray(parsed?.events) && parsed.events.length <= 1000, 'NATIVE_HISTORY_INVALID');
    events.push(...parsed.events);
    need(events.length <= 10000, 'NATIVE_HISTORY_BOUND');
    token = response.nextPageToken;
    need(token === undefined || token instanceof Uint8Array, 'NATIVE_HISTORY_TOKEN_INVALID');
    if (!token?.length) break;
    const key = Buffer.from(token).toString('base64');
    need(!seen.has(key), 'NATIVE_HISTORY_CURSOR_CHANGED');
    seen.add(key);
  }
  const terminal = events.at(-1);
  need(
    events.length === incident.emailEventCount &&
      proofDigest(events) === incident.emailHistoryDigest &&
      terminal?.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED' &&
      terminal.workflowExecutionFailedEventAttributes?.failure?.cause?.applicationFailureInfo?.type ===
        'EMAIL_STALE_JOB',
    'ORIGINAL_EMAIL_HISTORY_CHANGED'
  );
  need(valid(await describe()), 'ORIGINAL_TERMINAL_EMAIL_CHANGED');
  return Object.freeze({
    workflowId: incident.emailWorkflowId,
    runId: incident.emailRunId,
    latestRunId: incident.emailRunId,
    status: 'FAILED',
    failureType: 'EMAIL_STALE_JOB',
    pendingActivities: 0,
    terminalEventType: 'WORKFLOW_EXECUTION_FAILED',
    historyDigest: incident.emailHistoryDigest,
  });
}
