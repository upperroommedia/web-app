/** The publishing destination is selected by the reviewed deployment project.
 * Runtime admission additionally verifies the initialized Firebase app and the
 * private sandbox catalog; this value alone never authorizes a provider call.
 */
export function providerRuntimeEnvironment(projectId) {
  if (projectId === 'urm-app-staging') return { STAGING_PROVIDER_MODE: 'sandbox' };
  if (projectId === 'urm-app') return {};
  throw new Error('Publishing deployment requires an explicit supported Firebase project');
}
