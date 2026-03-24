import type { ReactNode } from 'react';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import { SOUNDCLOUD_ADVANCED_PATH, SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '../shared/soundcloudAuth';

type ErrorDetailsRecord = Record<string, unknown>;

const getErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return null;
};

const getErrorDetailsCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('details' in error)) {
    return null;
  }

  const details = (error as { details?: unknown }).details;
  if (typeof details === 'string') {
    return details;
  }

  if (typeof details === 'object' && details !== null && typeof (details as ErrorDetailsRecord).code === 'string') {
    return (details as ErrorDetailsRecord).code as string;
  }

  return null;
};

export const isSoundCloudReconnectRequiredClientError = (error: unknown): boolean => {
  if (getErrorDetailsCode(error) === SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE) {
    return true;
  }

  const message = getErrorMessage(error);
  return Boolean(message?.includes('SoundCloud authorization'));
};

export const getSoundCloudRecoveryMessage = (isAdmin: boolean): ReactNode => {
  if (isAdmin) {
    return (
      <>
        SoundCloud authorization needs to be refreshed. Please log in to SoundCloud from the{' '}
        <MuiLink component={Link} href={SOUNDCLOUD_ADVANCED_PATH} underline="hover">
          Advanced tab
        </MuiLink>
        .
      </>
    );
  }

  return 'SoundCloud authorization needs to be refreshed. An admin has been notified and will update the SoundCloud credentials.';
};
