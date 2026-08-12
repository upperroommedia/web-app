/** Guards for the authenticated-browser PO-token recovery path. */
export function isYouTubeMedia403(message: string): boolean {
  return /unable to download video data:\s*http error 403/i.test(message);
}

export function isValidBrowserPoToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 100;
}

export function buildBrowserPoTokenExtractorArg(poToken: string): string {
  if (!isValidBrowserPoToken(poToken)) {
    throw new Error('Authenticated browser PO token broker returned an invalid token.');
  }
  return `youtube:po_token=mweb.gvs+${poToken}`;
}
