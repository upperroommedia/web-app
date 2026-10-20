/** Preserve traditional queue ownership; the independent Cloud Run search pool
 * owns Activities only. Readiness and native registration must use this same
 * decision so a healthy Activity poller never requires a Workflow poller.
 */
export function queuePollsWorkflows(hosting: string, queue: string): boolean {
  return !['urm-media', 'urm-controls'].includes(queue) && !(hosting === 'cloud-run' && queue === 'urm-search');
}
