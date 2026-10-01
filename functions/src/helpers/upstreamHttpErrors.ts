type HttpErrorResponse = {
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
};

export const getHtmlEdgeBlock = (error: unknown): { requestId?: string } | null => {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return null;
  }

  const response = (error as { response?: HttpErrorResponse }).response;
  if (response?.status !== 403 || typeof response.data !== 'string' || !/^\s*<(?:!doctype|html)\b/i.test(response.data)) {
    return null;
  }

  const requestId = response.headers?.['x-amz-cf-id'] ?? response.headers?.['request-id'];
  return { requestId: typeof requestId === 'string' ? requestId : undefined };
};
