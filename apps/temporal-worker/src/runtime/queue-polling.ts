/** Preserve traditional queue ownership; the independent Cloud Run search/email/images pools
 * own Activities only. Readiness and native registration must use this same
 * decision so a healthy Activity poller never requires a Workflow poller.
 */
export function queuePollsWorkflows(hosting: string, queue: string): boolean {
  return (
    !['urm-media', 'urm-controls'].includes(queue) &&
    !(hosting === 'cloud-run' && ['urm-search', 'urm-email', 'urm-images'].includes(queue))
  );
}
