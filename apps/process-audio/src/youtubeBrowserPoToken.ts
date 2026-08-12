/** Guards for the authenticated-browser PO-token recovery path. */
export function isYouTubeMedia403(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('http error 403') &&
    (lower.includes('unable to download video data') || /fragment \d+ not found/.test(lower))
  );
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

export function mergeBrowserPoTokenExtractorArg(baseExtractorArg: string, poToken: string): string {
  const tokenExtractorArg = buildBrowserPoTokenExtractorArg(poToken);
  if (!baseExtractorArg.startsWith('youtube:')) {
    throw new Error('Browser PO token can only be merged into YouTube extractor arguments.');
  }
  return `${baseExtractorArg};${tokenExtractorArg.slice('youtube:'.length)}`;
}
