export interface MediaCleanupInput {
  operation: 'media_artifacts_cleanup';
  dryRun: boolean;
  retentionDays: number;
  maxPages: number;
}
export function normalizeMediaCleanupInput(value: Record<string, unknown>): MediaCleanupInput {
  const retentionDays = value.retentionDays ?? 90;
  const maxPages = value.maxPages ?? 20;
  if (
    value.operation !== 'media_artifacts_cleanup' ||
    typeof retentionDays !== 'number' ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 90 ||
    retentionDays > 3650 ||
    typeof maxPages !== 'number' ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100 ||
    (value.dryRun !== undefined && typeof value.dryRun !== 'boolean')
  )
    throw new Error('Invalid media retention request.');
  return { operation: 'media_artifacts_cleanup', dryRun: value.dryRun !== false, retentionDays, maxPages };
}
