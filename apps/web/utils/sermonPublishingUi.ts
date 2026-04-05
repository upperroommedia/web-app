import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';

export type PublishUiState =
  | 'published'
  | 'partial'
  | 'not_published'
  | 'checking'
  | 'publishing'
  | 'error'
  | 'blocked'
  | 'not_configured';

export interface PublishDestinationState {
  state: PublishUiState;
  label: string;
  details?: string;
  error?: string;
}

export interface PublishRunSummary {
  state: 'success' | 'partial' | 'error';
  message: string;
}

export const getListsDestinationState = (
  lists: SermonList[] | undefined,
  options?: { loading?: boolean; error?: string | null }
): PublishDestinationState => {
  if (options?.loading) {
    return {
      state: 'publishing',
      label: 'Loading lists',
    };
  }

  if (options?.error) {
    return {
      state: 'error',
      label: 'Could not load list status',
      error: options.error,
    };
  }

  const resolvedLists = lists ?? [];
  const totalCount = resolvedLists.length;
  const uploadedCount = resolvedLists.filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED).length;
  const errorCount = resolvedLists.filter((list) => list.uploadStatus?.status === uploadStatus.ERROR).length;

  if (totalCount === 0) {
    return {
      state: 'not_configured',
      label: 'No target lists',
      details: 'This sermon is not assigned to any publish lists.',
    };
  }

  if (uploadedCount === totalCount) {
    return {
      state: 'published',
      label: 'Published to all lists',
      details: `${uploadedCount} of ${totalCount} lists published`,
    };
  }

  if (uploadedCount > 0 || errorCount > 0) {
    return {
      state: 'partial',
      label: 'List publish needs attention',
      details: `${uploadedCount} of ${totalCount} lists published`,
      ...(errorCount > 0 ? { error: `${errorCount} list publish error${errorCount === 1 ? '' : 's'}` } : {}),
    };
  }

  return {
    state: 'not_published',
    label: 'Not published to lists',
    details: `${totalCount} target list${totalCount === 1 ? '' : 's'} ready`,
  };
};

export const summarizePublishRun = (results: PublishDestinationState[]): PublishRunSummary => {
  const actionableResults = results.filter((result) => result.state !== 'not_configured');
  const successfulCount = actionableResults.filter((result) => result.state === 'published').length;
  const issueCount = actionableResults.filter((result) => ['partial', 'error', 'blocked'].includes(result.state)).length;

  if (actionableResults.length === 0) {
    return {
      state: 'partial',
      message: 'There were no publish destinations configured for this sermon.',
    };
  }

  if (issueCount === 0 && successfulCount === actionableResults.length) {
    return {
      state: 'success',
      message: 'Publish everywhere completed successfully.',
    };
  }

  if (successfulCount > 0) {
    return {
      state: 'partial',
      message: 'Publish everywhere partially succeeded. Review the destination statuses below.',
    };
  }

  return {
    state: 'error',
    message: 'Publish everywhere failed. Review the destination statuses below.',
  };
};
