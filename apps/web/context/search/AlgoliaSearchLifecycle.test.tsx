// Exercise effect setup/cleanup without a DOM or an external Firebase session.
const mockStates: unknown[] = [];
const mockEffects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
let mockStateCursor = 0;
let mockEffectCursor = 0;
let mockPendingEffects: Array<() => void> = [];
let mockUser:
  | { uid: string; role: string; canUpload: () => boolean; isAdmin: () => boolean; getIdToken: jest.Mock }
  | undefined;
const mockGenerate = jest.fn();
const mockVendor = jest.fn((_app: string, key: string) => ({
  key,
  search: jest.fn(function (this: { key: string }, request: unknown) {
    return { key: this.key, request };
  }),
  clearCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const slot = mockStateCursor++;
    if (!(slot in mockStates)) mockStates[slot] = initial;
    return [
      mockStates[slot],
      (next: unknown) => {
        mockStates[slot] = typeof next === 'function' ? next(mockStates[slot]) : next;
      },
    ];
  },
  useMemo: (get: () => unknown) => get(),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const slot = mockEffectCursor++;
    const old = mockEffects[slot];
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      mockPendingEffects.push(() => {
        old?.cleanup?.();
        mockEffects[slot] = { deps, cleanup: effect() };
      });
    }
  },
}));
jest.mock('algoliasearch', () => ({ algoliasearch: (...args: [string, string]) => mockVendor(...args) }));
jest.mock('../../firebase/firebase', () => ({ isDevelopment: false }));
jest.mock('../../utils/mockAlgoliaSearchClient', () => ({ createMockAlgoliaSearchClient: jest.fn() }));
jest.mock('../../utils/createFunction', () => ({ createFunction: () => mockGenerate }));
jest.mock('../user/UserContext', () => ({ __esModule: true, default: () => ({ user: mockUser }) }));

process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'test-app';
process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED = 'true';
import { AlgoliaSearchProvider } from './AlgoliaSearchContext';

const render = () => {
  mockStateCursor = 0;
  mockEffectCursor = 0;
  const element = AlgoliaSearchProvider({ children: null });
  const value = element.props.value;
  const effects = mockPendingEffects;
  mockPendingEffects = [];
  effects.forEach((run) => run());
  return value;
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return render();
};
const credentials = () => ({
  apiKey: 'sermon-secured',
  sharedApiKey: 'shared-secured',
  expiresAt: Date.now() + 5 * 60_000,
  sermonIndices: ['sermons'],
  sharedIndices: ['speakers'],
});

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00Z'));
  mockStates.length = 0;
  mockEffects.length = 0;
  mockPendingEffects = [];
  mockUser = {
    uid: 'real-user',
    role: 'admin',
    isAdmin: () => true,
    canUpload: () => true,
    getIdToken: jest.fn().mockResolvedValue('token'),
  };
  mockGenerate.mockReset().mockImplementation(async () => credentials());
  mockVendor.mockClear();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
});
afterEach(() => {
  mockEffects.forEach((effect) => effect.cleanup?.());
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

test('admin obtains both scoped clients through the authenticated callable with no caller UID', async () => {
  render();
  const state = await settle();
  expect(mockGenerate).toHaveBeenCalledWith({});
  expect(mockVendor.mock.calls).toEqual([
    ['test-app', 'sermon-secured'],
    ['test-app', 'shared-secured'],
  ]);
  expect(state.searchClient).toBeTruthy();
  expect(state.sharedSearchClient).toBeTruthy();
});

test('logout drops existing clients in the first render and ignores an in-flight key response', async () => {
  let resolve!: (value: ReturnType<typeof credentials>) => void;
  mockGenerate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  render();
  mockUser = undefined;
  expect(render().searchClient).toBeNull();
  resolve(credentials());
  expect((await settle()).sharedSearchClient).toBeNull();
  expect(mockVendor).not.toHaveBeenCalled();
});

test('logout and account switches synchronously discard already-issued clients', async () => {
  render();
  expect((await settle()).searchClient).toBeTruthy();
  mockUser = { ...mockUser!, uid: 'different-user' };
  expect(render().searchClient).toBeNull();
  await settle();
  mockUser = undefined;
  expect(render().sharedSearchClient).toBeNull();
  expect((await settle()).searchClient).toBeNull();
});

test('role change clears clients immediately, including mutation of the same user object', async () => {
  render();
  expect((await settle()).searchClient).toBeTruthy();
  mockUser!.role = 'user';
  mockUser!.canUpload = () => false;
  expect(render().searchClient).toBeNull();
  expect((await settle()).sharedSearchClient).toBeNull();
});

test('renews before expiry; refresh failure drops credentials and retries rather than reusing expired cache', async () => {
  render();
  expect((await settle()).searchClient).toBeTruthy();
  mockGenerate.mockRejectedValue(new Error('offline'));
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  render();
  const failed = await settle();
  expect(failed.searchClient).toBeNull();
  expect(failed.sharedSearchClient).toBeNull();
  expect(failed.error).toBe('offline');
  mockGenerate.mockImplementation(async () => credentials());
  await jest.advanceTimersByTimeAsync(30_000);
  render();
  expect((await settle()).searchClient).toBeTruthy();
  expect(mockGenerate).toHaveBeenCalledTimes(3);
});

test('rejects an already expired response and refreshes token once for an unauthenticated callable', async () => {
  mockGenerate
    .mockRejectedValueOnce({ code: 'functions/unauthenticated' })
    .mockResolvedValueOnce({ ...credentials(), expiresAt: Date.now() - 1 });
  render();
  const state = await settle();
  expect(mockUser!.getIdToken).toHaveBeenCalledWith(true);
  expect(state.searchClient).toBeNull();
  expect(state.error).toContain('expired');
});

test.each(['automatic', 'focus', 'visibility', 'auth-object'])(
  '%s renewal preserves the clients that own selector query/results and InstantSearch state',
  async (trigger) => {
    render();
    const initial = await settle();
    const originalClient = initial.sharedSearchClient;
    // Selectors reset on client identity changes. Retaining this reference keeps
    // their typed query/results and selection intact throughout key renewal.
    const { search } = originalClient;
    const request = { requests: [{ indexName: 'images', query: 'holy week' }] };
    let resolve!: (value: ReturnType<typeof credentials>) => void;
    mockGenerate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    if (trigger === 'automatic') await jest.advanceTimersByTimeAsync(4 * 60_000);
    if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
    if (trigger === 'visibility') document.dispatchEvent(new Event('visibilitychange'));
    if (trigger === 'auth-object') mockUser = { ...mockUser! };
    render();
    expect(render().sharedSearchClient).toBe(originalClient);
    expect(render().loading).toBe(false);
    expect(search(request)).toEqual({ key: 'shared-secured', request });
    resolve({ ...credentials(), apiKey: 'renewed-sermons', sharedApiKey: 'renewed-shared' });
    const renewed = await settle();
    expect(renewed.sharedSearchClient).toBe(originalClient);
    expect(renewed.searchClient).toBe(initial.searchClient);
    // Even a destructured method resolves the current key and binds its SDK client.
    expect(search(request)).toEqual({ key: 'renewed-shared', request });
  }
);

test('retained credentials expire while renewal is still pending', async () => {
  render();
  expect((await settle()).sharedSearchClient).toBeTruthy();
  mockGenerate.mockImplementationOnce(() => new Promise(() => {}));
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  render();
  expect(render().sharedSearchClient).toBeTruthy();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(render().sharedSearchClient).toBeNull();
});
