/** The guarded controller supplies its existing token provider and native fetch.
 * An optional source-owned beforeSend fence runs AFTER credential acquisition,
 * immediately before HTTP. JSON descriptors cannot supply this function.
 */
export function createReleaseApi({ getAccessToken, request = globalThis.fetch }) {
  if (typeof getAccessToken !== 'function' || typeof request !== 'function')
    throw new Error('RELEASE_API_TRANSPORT_REQUIRED');
  return async (url, method = 'GET', body, beforeSend) => {
    if (beforeSend !== undefined && typeof beforeSend !== 'function')
      throw new Error('RELEASE_API_AUTHORIZATION_REQUIRED');
    const accessToken = await getAccessToken();
    if (beforeSend) await beforeSend();
    const response = await request(url, {
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw Object.assign(new Error(`Release API ${method} failed: HTTP${response.status}`), {
        status: response.status,
      });
    return response.json();
  };
}
