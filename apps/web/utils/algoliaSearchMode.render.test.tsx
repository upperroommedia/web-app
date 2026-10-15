import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let mockIsEmulatorMode = false;
let mockIsDevelopment = false;
let mockHasUser = true;
let mockCanUpload = true;
let mockAdmin = true;
let mockUid = 'media-browser-admin';
const mockLocalClient = { clearCache: jest.fn() };
const mockCreateLocalSearchClient = jest.fn((_options: unknown) => mockLocalClient);

// The Firebase boundary already validates demo configuration; this suite consumes its verified mode.
jest.mock('../firebase/firebase', () => ({
  get isDevelopment() {
    return mockIsDevelopment;
  },
  get isEmulatorMode() {
    return mockIsEmulatorMode;
  },
}));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({
    user: mockHasUser
      ? {
          uid: mockUid,
          role: mockAdmin ? 'admin' : 'uploader',
          canUpload: () => mockCanUpload,
          isAdmin: () => mockAdmin,
        }
      : undefined,
  }),
}));
// Exercise actual context selection while keeping SDK initialization and real catalog queries
// at their own boundaries (the latter is covered by mockAlgoliaPaging.test.ts).
jest.mock('../utils/mockAlgoliaSearchClient', () => ({
  createMockAlgoliaSearchClient: (options: unknown) => mockCreateLocalSearchClient(options),
}));
jest.mock('../utils/createFunction', () => ({ createFunction: jest.fn() }));
jest.mock('../utils/algolia/browserSearch', () => ({
  browserAlgoliaAppId: null,
  externalSearchDisabled: true,
  browserSearchUnavailableMessage: 'Search is not configured.',
}));

import { AlgoliaSearchProvider, useAlgoliaSearch } from '../context/search/AlgoliaSearchContext';
function Consumer() {
  const state = useAlgoliaSearch();
  return (
    <div
      data-client={state.searchClient?.clearCache === mockLocalClient.clearCache ? 'local' : 'absent'}
      data-shared={state.sharedSearchClient?.clearCache === mockLocalClient.clearCache ? 'local' : 'absent'}
    >
      {state.error ?? 'ready'}
    </div>
  );
}
function render() {
  return renderToStaticMarkup(
    <AlgoliaSearchProvider>
      <Consumer />
    </AlgoliaSearchProvider>
  );
}
beforeEach(() => {
  mockIsEmulatorMode = false;
  mockIsDevelopment = false;
  mockHasUser = true;
  mockCanUpload = true;
  mockAdmin = true;
  mockUid = 'media-browser-admin';
  mockCreateLocalSearchClient.mockClear();
});
it('uses the genuine Firestore adapter for a verified production demo without vendor configuration', () => {
  mockIsEmulatorMode = true;
  expect(render()).toContain('data-client="local" data-shared="local">ready');
  expect(mockCreateLocalSearchClient).toHaveBeenCalledWith({
    userId: 'media-browser-admin',
    canSearchAllSermons: true,
  });
});
it('preserves existing development search', () => {
  mockIsDevelopment = true;
  mockIsEmulatorMode = true;
  expect(render()).toContain('data-client="local" data-shared="local">ready');
});
it('keeps ordinary production without search configuration unavailable', () => {
  expect(render()).toContain('data-client="absent" data-shared="absent">Search is not configured.');
  expect(mockCreateLocalSearchClient).not.toHaveBeenCalled();
});
it('retains uploader ownership scope instead of granting admin search', () => {
  mockIsEmulatorMode = true;
  mockAdmin = false;
  mockUid = 'uploader-only';
  expect(render()).toContain('data-client="local"');
  expect(mockCreateLocalSearchClient).toHaveBeenCalledWith({ userId: 'uploader-only', canSearchAllSermons: false });
});
it.each(['logged out', 'upload permission removed'])('does not expose local search when %s', (condition) => {
  mockIsEmulatorMode = true;
  if (condition === 'logged out') mockHasUser = false;
  else mockCanUpload = false;
  expect(render()).toContain('data-client="absent" data-shared="absent"');
  expect(mockCreateLocalSearchClient).not.toHaveBeenCalled();
});
