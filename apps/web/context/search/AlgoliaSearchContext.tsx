import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { SearchClient } from 'algoliasearch';
import { algoliasearch } from 'algoliasearch';
import useAuth from '../user/UserContext';
import { createFunction } from '../../utils/createFunction';
import type {
  GenerateSecuredApiKeyInputType,
  GenerateSecuredApiKeyOutputType,
} from '@upperroom/contracts/generateAlgoliaSecureApiKey';
import { isEmulatorMode } from '../../firebase/firebase';
import { createMockAlgoliaSearchClient } from '../../utils/mockAlgoliaSearchClient';
import {
  browserAlgoliaAppId,
  browserSearchUnavailableMessage,
  externalSearchDisabled,
} from '../../utils/algolia/browserSearch';

type AlgoliaSearchContextValue = {
  appId: string | null;
  searchClient: SearchClient | null;
  sharedSearchClient: SearchClient | null;
  loading: boolean;
  error: string | null;
  clearCache: () => Promise<void>;
  sermonSearchRevision: number;
  invalidateSermonSearch: () => Promise<void>;
};

const AlgoliaSearchContext = createContext<AlgoliaSearchContextValue | null>(null);

// Keep the client identity stable while renewing credentials so InstantSearch
// and selectors retain the user's current query and selection.
const rotatingClient = (initial: SearchClient) => {
  let current = initial;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return {
    client: new Proxy(initial, {
      get(_target, property) {
        const value = Reflect.get(current, property);
        if (typeof value !== 'function') return value;
        let method = methods.get(property);
        if (!method) {
          method = (...args) => Reflect.apply(Reflect.get(current, property), current, args);
          methods.set(property, method);
        }
        return method;
      },
    }),
    replace(next: SearchClient) {
      current = next;
    },
  };
};

const getCallableErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export const AlgoliaSearchProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const appId = browserAlgoliaAppId;
  const [credentials, setCredentials] = useState<{
    ownerUid: string;
    expiresAt: number;
    role: string | undefined;
    sermons: ReturnType<typeof rotatingClient>;
    shared: ReturnType<typeof rotatingClient>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(!isEmulatorMode && !appId ? browserSearchUnavailableMessage : null);
  const [sermonSearchRevision, setSermonSearchRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    if (isEmulatorMode || !appId || externalSearchDisabled || !user?.canUpload()) {
      setCredentials(null);
      setLoading(false);
      setError(!isEmulatorMode && (!appId || externalSearchDisabled) ? browserSearchUnavailableMessage : null);
      return;
    }
    const ownerUid = user.uid;
    const ownerRole = user.role;
    setLoading(true);
    setError(null);
    const init = async () => {
      try {
        const generate = createFunction<GenerateSecuredApiKeyInputType, GenerateSecuredApiKeyOutputType>(
          'generatesecuredapikey'
        );
        let result: GenerateSecuredApiKeyOutputType;
        try {
          result = await generate({});
        } catch (error) {
          if (getCallableErrorCode(error) !== 'functions/unauthenticated') throw error;
          await user.getIdToken(true);
          result = await generate({});
        }
        if (cancelled) return;
        if (
          !result.apiKey ||
          !result.sharedApiKey ||
          !Number.isFinite(result.expiresAt) ||
          result.expiresAt <= Date.now()
        ) {
          throw new Error('Search credentials are invalid or expired.');
        }
        const nextSermons = algoliasearch(appId, result.apiKey);
        const nextShared = algoliasearch(appId, result.sharedApiKey);
        setCredentials((previous) => {
          if (
            previous &&
            previous.ownerUid === ownerUid &&
            previous.role === ownerRole &&
            previous.expiresAt > Date.now()
          ) {
            previous.sermons.replace(nextSermons);
            previous.shared.replace(nextShared);
            return { ...previous, expiresAt: result.expiresAt };
          }
          return {
            ownerUid,
            role: ownerRole,
            expiresAt: result.expiresAt,
            sermons: rotatingClient(nextSermons),
            shared: rotatingClient(nextShared),
          };
        });
        refreshTimer = setTimeout(
          () => setRefreshRevision((n) => n + 1),
          Math.max(1000, result.expiresAt - Date.now() - 60_000)
        );
      } catch (error) {
        if (!cancelled) {
          setCredentials(null);
          setError(error instanceof Error ? error.message : 'Failed to initialize Algolia search.');
          refreshTimer = setTimeout(() => setRefreshRevision((n) => n + 1), 30_000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void init();
    const onForeground = () => {
      if (document.visibilityState === 'visible') setRefreshRevision((n) => n + 1);
    };
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, [appId, user, user?.role, refreshRevision]);

  // Renewal can be slow or stall. The previous key must still expire on time.
  useEffect(() => {
    if (!credentials) return;
    const timer = setTimeout(
      () => setCredentials((current) => (current === credentials ? null : current)),
      Math.max(0, credentials.expiresAt - Date.now())
    );
    return () => clearTimeout(timer);
  }, [credentials]);

  // Verified demo builds use the same real Firestore search adapter as development.
  const mockClient = useMemo(
    () =>
      isEmulatorMode && user?.canUpload()
        ? createMockAlgoliaSearchClient({ userId: user.uid, canSearchAllSermons: user.isAdmin() })
        : null,
    [user]
  );
  // Check the UID and role during render: logout and role changes cannot expose an old
  // client's cached results during the frame before effect cleanup runs.
  const active =
    credentials &&
    credentials.ownerUid === user?.uid &&
    credentials.role === user?.role &&
    user?.canUpload() &&
    credentials.expiresAt > Date.now()
      ? credentials
      : null;
  const searchClient = mockClient ?? active?.sermons.client ?? null;
  const sharedSearchClient = mockClient ?? active?.shared.client ?? null;

  const clearCache = useCallback(async () => {
    await Promise.all([searchClient, sharedSearchClient].map((client) => client?.clearCache()));
  }, [searchClient, sharedSearchClient]);

  const invalidateSermonSearch = useCallback(async () => {
    await clearCache();
    setSermonSearchRevision((currentRevision) => currentRevision + 1);
  }, [clearCache]);

  const value = useMemo<AlgoliaSearchContextValue>(
    () => ({
      appId,
      searchClient,
      sharedSearchClient,
      loading: loading && !searchClient,
      error,
      clearCache,
      sermonSearchRevision,
      invalidateSermonSearch,
    }),
    [appId, clearCache, error, invalidateSermonSearch, loading, searchClient, sharedSearchClient, sermonSearchRevision]
  );

  return <AlgoliaSearchContext.Provider value={value}>{children}</AlgoliaSearchContext.Provider>;
};

export const useAlgoliaSearch = (): AlgoliaSearchContextValue => {
  const context = useContext(AlgoliaSearchContext);

  if (!context) {
    throw new Error('useAlgoliaSearch must be used within an AlgoliaSearchProvider');
  }

  return context;
};
