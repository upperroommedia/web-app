/** Synthetic directory identity shared by the isolated media fixture producer and consumer. */
export const MEDIA_FIXTURE_UPLOADER = {
  uid: 'playwright-e2e',
  email: 'media-uploader@example.test',
  displayName: 'Media Fixture Uploader',
  role: 'uploader',
} as const;

// Synthetic Google-linked administrator selected only in the local Auth emulator UI.
export const MEDIA_FIXTURE_ADMIN = {
  uid: 'ci-player-admin',
  email: 'media-browser-admin@example.test',
  displayName: 'Media Browser Admin',
  providerUid: 'media-browser-admin-google',
  providerId: 'google.com',
  role: 'admin',
} as const;
